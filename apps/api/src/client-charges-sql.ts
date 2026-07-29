import {
  appointments,
  clientResultCharges,
  contacts,
  createDb,
  locationBillingConfig,
  locations
} from "@agentflow/db";
import { and, asc, eq, gte, inArray, lt, not, notInArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import { appointmentCancelledOnlySql, buildAppointmentEffectivePaidSql } from "./appointment-payment-sql.js";

type Db = ReturnType<typeof createDb>;

export type CanonicalDepositEvidence = {
  kind: "payment_order" | "invoice";
  id: string;
  externalId: string;
  amount: number;
  currency: string;
  matchedBy: "direct_appointment_order" | "correlated_order" | "correlated_invoice";
  paidAt: string | null;
};

export type ClientChargeCandidate = {
  appointmentId: string;
  ghlAppointmentId: string;
  appointmentTitle: string | null;
  appointmentStartTime: string | null;
  appointmentBookedAt: string;
  locationId: string;
  ghlLocationId: string;
  locationName: string | null;
  contactId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  deposit: CanonicalDepositEvidence;
  charge: {
    id: string;
    status: string;
    amount: number;
    currency: string;
    attemptCount: number;
    ghlReferenceId: string | null;
    ghlTransactionId: string | null;
    lastError: string | null;
    createdAt: string;
    updatedAt: string;
    succeededAt: string | null;
    failedAt: string | null;
  } | null;
};

export type ClientChargeListResult = {
  rows: ClientChargeCandidate[];
  totals: {
    eligibleCount: number;
    chargedCount: number;
    unbilledCount: number;
    pendingCount: number;
    failedCount: number;
    chargedAmount: number;
    unbilledAmount: number;
    currency: string | null;
    mixedCurrencies: boolean;
  };
  pagination: {
    page: number;
    pageSize: number;
    totalRows: number;
    totalPages: number;
  };
};

function canonicalDepositSql(): SQL<CanonicalDepositEvidence | null> {
  /*
   * The three scalar subqueries deliberately encode the confirmed precedence. They select only one row,
   * so an order mirrored as an invoice cannot be summed twice for one appointment.
   */
  return sql<CanonicalDepositEvidence | null>`coalesce(
    (
      select jsonb_build_object(
        'kind', 'payment_order',
        'id', direct_order.id,
        'externalId', direct_order.ghl_order_id,
        'amount', direct_order.amount,
        'currency', upper(coalesce(nullif(trim(direct_order.currency), ''), ${locationBillingConfig.currency}, 'USD')),
        'matchedBy', 'direct_appointment_order',
        'paidAt', coalesce(direct_order.ghl_updated_at, direct_order.ghl_created_at, direct_order.updated_at, direct_order.created_at)
      )
      from ghl_payment_orders direct_order
      where direct_order.location_id = ${appointments.locationId}
        and direct_order.is_deleted = false
        and coalesce(direct_order.amount, 0) > 0
        and direct_order.alt_id = ${appointments.ghlAppointmentId}
        and strpos(lower(trim(coalesce(direct_order.alt_type, ''))), 'appointment') > 0
        and (
          trim(lower(coalesce(direct_order.status, ''))) in ('completed','paid','succeeded','successful','fully_paid','complete','paid_in_full')
          or trim(lower(coalesce(direct_order.fulfillment_status, ''))) in ('fulfilled','complete','completed','paid','successful','processed')
        )
      order by coalesce(direct_order.ghl_updated_at, direct_order.ghl_created_at, direct_order.updated_at, direct_order.created_at) desc,
        direct_order.id desc
      limit 1
    ),
    (
      select jsonb_build_object(
        'kind', 'payment_order',
        'id', correlated_order.id,
        'externalId', correlated_order.ghl_order_id,
        'amount', correlated_order.amount,
        'currency', upper(coalesce(nullif(trim(correlated_order.currency), ''), ${locationBillingConfig.currency}, 'USD')),
        'matchedBy', 'correlated_order',
        'paidAt', coalesce(correlated_order.ghl_updated_at, correlated_order.ghl_created_at, correlated_order.updated_at, correlated_order.created_at)
      )
      from ghl_payment_orders correlated_order
      left join contacts correlated_order_contact on correlated_order_contact.id = correlated_order.contact_id
      where correlated_order.location_id = ${appointments.locationId}
        and correlated_order.is_deleted = false
        and coalesce(correlated_order.amount, 0) > 0
        and (
          trim(lower(coalesce(correlated_order.status, ''))) in ('completed','paid','succeeded','successful','fully_paid','complete','paid_in_full')
          or trim(lower(coalesce(correlated_order.fulfillment_status, ''))) in ('fulfilled','complete','completed','paid','successful','processed')
        )
        and (
          (${appointments.contactId} is not null and correlated_order.contact_id = ${appointments.contactId})
          or (
            nullif(trim(coalesce(
              ${appointments.raw}->'appointment'->>'contactId',
              ${appointments.raw}->>'contactId',
              ''
            )), '') is not null
            and correlated_order_contact.location_id = ${appointments.locationId}
            and correlated_order_contact.ghl_contact_id = nullif(trim(coalesce(
              ${appointments.raw}->'appointment'->>'contactId',
              ${appointments.raw}->>'contactId',
              ''
            )), '')
          )
        )
        and (
          (
            ${appointments.startTime} is not null
            and coalesce(correlated_order.ghl_updated_at, correlated_order.ghl_created_at, correlated_order.updated_at, correlated_order.created_at)
              >= least(coalesce(${appointments.dateAdded}, ${appointments.createdAt}), ${appointments.startTime}) - interval '35 days'
            and coalesce(correlated_order.ghl_updated_at, correlated_order.ghl_created_at, correlated_order.updated_at, correlated_order.created_at)
              <= greatest(coalesce(${appointments.dateAdded}, ${appointments.createdAt}), ${appointments.startTime}) + interval '180 days'
          )
          or (
            ${appointments.startTime} is null
            and coalesce(correlated_order.ghl_updated_at, correlated_order.ghl_created_at, correlated_order.updated_at, correlated_order.created_at)
              >= coalesce(${appointments.dateAdded}, ${appointments.createdAt}) - interval '35 days'
            and coalesce(correlated_order.ghl_updated_at, correlated_order.ghl_created_at, correlated_order.updated_at, correlated_order.created_at)
              <= coalesce(${appointments.dateUpdated}, ${appointments.updatedAt}) + interval '366 days'
          )
        )
      order by coalesce(correlated_order.ghl_updated_at, correlated_order.ghl_created_at, correlated_order.updated_at, correlated_order.created_at) desc,
        correlated_order.id desc
      limit 1
    ),
    (
      select jsonb_build_object(
        'kind', 'invoice',
        'id', correlated_invoice.id,
        'externalId', correlated_invoice.ghl_invoice_id,
        'amount', correlated_invoice.amount_paid,
        'currency', upper(coalesce(nullif(trim(correlated_invoice.currency), ''), ${locationBillingConfig.currency}, 'USD')),
        'matchedBy', 'correlated_invoice',
        'paidAt', coalesce(correlated_invoice.ghl_updated_at, correlated_invoice.issue_date, correlated_invoice.due_date, correlated_invoice.updated_at, correlated_invoice.created_at)
      )
      from invoices correlated_invoice
      left join contacts correlated_invoice_contact on correlated_invoice_contact.id = correlated_invoice.contact_id
      where correlated_invoice.location_id = ${appointments.locationId}
        and correlated_invoice.is_deleted = false
        and coalesce(correlated_invoice.amount_paid, 0) > 0
        and (
          lower(coalesce(correlated_invoice.last_event_type, '')) = 'invoicepaid'
          or lower(coalesce(correlated_invoice.status, '')) = 'paid'
          or (
            coalesce(correlated_invoice.amount_paid, 0) > 0
            and coalesce(correlated_invoice.total, correlated_invoice.amount_paid, 0) > 0
            and correlated_invoice.amount_paid >= coalesce(correlated_invoice.total, correlated_invoice.amount_paid)
          )
        )
        and (
          (${appointments.contactId} is not null and correlated_invoice.contact_id = ${appointments.contactId})
          or (
            nullif(trim(coalesce(
              ${appointments.raw}->'appointment'->>'contactId',
              ${appointments.raw}->>'contactId',
              ''
            )), '') is not null
            and correlated_invoice_contact.location_id = ${appointments.locationId}
            and correlated_invoice_contact.ghl_contact_id = nullif(trim(coalesce(
              ${appointments.raw}->'appointment'->>'contactId',
              ${appointments.raw}->>'contactId',
              ''
            )), '')
          )
        )
        and (
          (
            ${appointments.startTime} is not null
            and coalesce(correlated_invoice.ghl_updated_at, correlated_invoice.issue_date, correlated_invoice.due_date, correlated_invoice.updated_at, correlated_invoice.created_at)
              >= least(coalesce(${appointments.dateAdded}, ${appointments.createdAt}), ${appointments.startTime}) - interval '35 days'
            and coalesce(correlated_invoice.ghl_updated_at, correlated_invoice.issue_date, correlated_invoice.due_date, correlated_invoice.updated_at, correlated_invoice.created_at)
              <= greatest(coalesce(${appointments.dateAdded}, ${appointments.createdAt}), ${appointments.startTime}) + interval '180 days'
          )
          or (
            ${appointments.startTime} is null
            and coalesce(correlated_invoice.ghl_updated_at, correlated_invoice.issue_date, correlated_invoice.due_date, correlated_invoice.updated_at, correlated_invoice.created_at)
              >= coalesce(${appointments.dateAdded}, ${appointments.createdAt}) - interval '35 days'
            and coalesce(correlated_invoice.ghl_updated_at, correlated_invoice.issue_date, correlated_invoice.due_date, correlated_invoice.updated_at, correlated_invoice.created_at)
              <= coalesce(${appointments.dateUpdated}, ${appointments.updatedAt}) + interval '366 days'
          )
        )
      order by coalesce(correlated_invoice.ghl_updated_at, correlated_invoice.issue_date, correlated_invoice.due_date, correlated_invoice.updated_at, correlated_invoice.created_at) desc,
        correlated_invoice.id desc
      limit 1
    )
  )`;
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function normalizeEvidence(value: CanonicalDepositEvidence | null): CanonicalDepositEvidence | null {
  if (!value || (value.kind !== "payment_order" && value.kind !== "invoice")) return null;
  const amount = Number(value.amount);
  if (!value.id || !Number.isFinite(amount) || amount <= 0) return null;
  return {
    ...value,
    amount,
    currency: String(value.currency || "USD").trim().toUpperCase() || "USD",
    paidAt: iso(value.paidAt)
  };
}

export async function listClientChargeCandidates(
  db: Db,
  params: {
    from: Date;
    toExclusive: Date;
    allowedLocationIds: string[] | null;
    hiddenLocationIds?: string[];
    appointmentId?: string;
    query?: string;
    status?: "all" | "unbilled" | "pending" | "succeeded" | "failed";
    page: number;
    pageSize: number;
  }
): Promise<ClientChargeListResult> {
  const bookingCapturedAt = sql<Date>`coalesce(${appointments.dateAdded}, ${appointments.createdAt})`;
  const filters: SQL[] = [
    eq(locationBillingConfig.enabled, true),
    eq(appointments.hiddenFromUi, false),
    not(appointmentCancelledOnlySql()),
    buildAppointmentEffectivePaidSql(db),
    gte(bookingCapturedAt, params.from),
    lt(bookingCapturedAt, params.toExclusive)
  ];
  if (params.allowedLocationIds !== null) {
    filters.push(
      params.allowedLocationIds.length === 0
        ? sql`false`
        : inArray(appointments.locationId, params.allowedLocationIds)
    );
  }
  if (params.hiddenLocationIds?.length) {
    filters.push(notInArray(appointments.locationId, params.hiddenLocationIds));
  }
  if (params.appointmentId) {
    filters.push(eq(appointments.id, params.appointmentId));
  }

  const depositExpr = canonicalDepositSql();
  const rawRows = await db
    .select({
      appointmentId: appointments.id,
      ghlAppointmentId: appointments.ghlAppointmentId,
      appointmentTitle: appointments.title,
      appointmentStartTime: appointments.startTime,
      appointmentBookedAt: bookingCapturedAt,
      locationId: locations.id,
      ghlLocationId: locations.ghlLocationId,
      locationName: locations.name,
      contactId: contacts.id,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      contactEmail: contacts.email,
      deposit: depositExpr,
      chargeId: clientResultCharges.id,
      chargeStatus: clientResultCharges.status,
      chargeAmount: clientResultCharges.chargeAmount,
      chargeCurrency: clientResultCharges.chargeCurrency,
      chargeAttemptCount: clientResultCharges.attemptCount,
      chargeGhlReferenceId: clientResultCharges.ghlReferenceId,
      chargeGhlTransactionId: clientResultCharges.ghlTransactionId,
      chargeLastError: clientResultCharges.lastError,
      chargeCreatedAt: clientResultCharges.createdAt,
      chargeUpdatedAt: clientResultCharges.updatedAt,
      chargeSucceededAt: clientResultCharges.succeededAt,
      chargeFailedAt: clientResultCharges.failedAt
    })
    .from(appointments)
    .innerJoin(locations, eq(appointments.locationId, locations.id))
    .innerJoin(locationBillingConfig, eq(locationBillingConfig.locationId, appointments.locationId))
    .leftJoin(contacts, eq(appointments.contactId, contacts.id))
    .leftJoin(clientResultCharges, eq(clientResultCharges.appointmentId, appointments.id))
    .where(and(...filters))
    .orderBy(asc(bookingCapturedAt), asc(appointments.id));

  const query = (params.query ?? "").trim().toLowerCase();
  const status = params.status ?? "all";
  const normalized: ClientChargeCandidate[] = [];

  for (const row of rawRows) {
    const deposit = normalizeEvidence(row.deposit);
    if (!deposit) continue;

    const contactName = [row.contactFirstName, row.contactLastName]
      .map((v) => (v ?? "").trim())
      .filter(Boolean)
      .join(" ") || null;
    const charge = row.chargeId
      ? {
          id: row.chargeId,
          status: row.chargeStatus ?? "pending",
          amount: Number(row.chargeAmount ?? 0),
          currency: row.chargeCurrency ?? deposit.currency,
          attemptCount: Number(row.chargeAttemptCount ?? 0),
          ghlReferenceId: row.chargeGhlReferenceId,
          ghlTransactionId: row.chargeGhlTransactionId,
          lastError: row.chargeLastError,
          createdAt: iso(row.chargeCreatedAt)!,
          updatedAt: iso(row.chargeUpdatedAt)!,
          succeededAt: iso(row.chargeSucceededAt),
          failedAt: iso(row.chargeFailedAt)
        }
      : null;

    const candidate: ClientChargeCandidate = {
      appointmentId: row.appointmentId,
      ghlAppointmentId: row.ghlAppointmentId,
      appointmentTitle: row.appointmentTitle,
      appointmentStartTime: iso(row.appointmentStartTime),
      appointmentBookedAt: iso(row.appointmentBookedAt)!,
      locationId: row.locationId,
      ghlLocationId: row.ghlLocationId,
      locationName: row.locationName,
      contactId: row.contactId,
      contactName,
      contactEmail: row.contactEmail,
      deposit,
      charge
    };

    if (query) {
      const haystack = [
        candidate.locationName,
        candidate.ghlLocationId,
        candidate.appointmentTitle,
        candidate.ghlAppointmentId,
        candidate.contactName,
        candidate.contactEmail,
        candidate.deposit.externalId
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(query)) continue;
    }
    if (status === "unbilled" && charge) continue;
    if (status !== "all" && status !== "unbilled" && charge?.status !== status) continue;
    normalized.push(candidate);
  }

  normalized.sort((a, b) => b.appointmentBookedAt.localeCompare(a.appointmentBookedAt));
  const currencies = new Set(normalized.map((row) => row.deposit.currency));
  const totals = {
    eligibleCount: normalized.length,
    chargedCount: normalized.filter((row) => row.charge?.status === "succeeded").length,
    unbilledCount: normalized.filter((row) => row.charge === null).length,
    pendingCount: normalized.filter((row) => row.charge?.status === "pending").length,
    failedCount: normalized.filter((row) => row.charge?.status === "failed").length,
    chargedAmount: normalized.reduce(
      (sum, row) => sum + (row.charge?.status === "succeeded" ? row.charge.amount : 0),
      0
    ),
    unbilledAmount: normalized.reduce((sum, row) => sum + (row.charge === null ? row.deposit.amount : 0), 0),
    currency: currencies.size === 1 ? ([...currencies][0] ?? null) : null,
    mixedCurrencies: currencies.size > 1
  };

  const pageSize = Math.min(100, Math.max(1, Math.floor(params.pageSize)));
  const totalRows = normalized.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
  const page = Math.min(Math.max(1, Math.floor(params.page)), totalPages);
  const start = (page - 1) * pageSize;

  return {
    rows: normalized.slice(start, start + pageSize),
    totals,
    pagination: { page, pageSize, totalRows, totalPages }
  };
}

export async function getClientChargeCandidateByAppointment(
  db: Db,
  params: {
    appointmentId: string;
    allowedLocationIds: string[] | null;
    hiddenLocationIds?: string[];
  }
): Promise<ClientChargeCandidate | null> {
  const broadFrom = new Date(0);
  const broadTo = new Date("9999-12-31T00:00:00.000Z");
  const result = await listClientChargeCandidates(db, {
    from: broadFrom,
    toExclusive: broadTo,
    allowedLocationIds: params.allowedLocationIds,
    hiddenLocationIds: params.hiddenLocationIds,
    appointmentId: params.appointmentId,
    page: 1,
    pageSize: 1
  });
  return result.rows[0] ?? null;
}
