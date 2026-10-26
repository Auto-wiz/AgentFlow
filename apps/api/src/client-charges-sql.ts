import {
  clientResultCharges,
  contacts,
  createDb,
  ghlPaymentOrders,
  invoices,
  locationBillingConfig,
  locations,
  paymentSources
} from "@agentflow/db";
import { and, eq, gte, inArray, lt, notInArray, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

import {
  chargeActorDisplayName,
  COLLECTED_PAYMENT_MIRROR_WINDOW_SECONDS,
  emptyOverviewAccountRow,
  overviewAccountMatchesView,
  type OverviewAccountView
} from "./client-charges-logic.js";
import { COLLECTED_TRANSACTION_STATUSES } from "./ghl-payment-transaction-amount.js";

type Db = ReturnType<typeof createDb>;

export type CanonicalDepositEvidence = {
  kind: "payment_order" | "invoice";
  id: string;
  externalId: string;
  amount: number;
  currency: string;
  matchedBy: "collected_order" | "collected_invoice";
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
    chargedBy: string | null;
  } | null;
};

export type ClientChargeListResult = {
  rows: ClientChargeCandidate[];
  totals: ClientChargeTotals;
  pagination: {
    page: number;
    pageSize: number;
    totalRows: number;
    totalPages: number;
  };
};

export type ClientChargeTotals = {
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

export type ClientChargeOverviewRow = {
  locationId: string;
  ghlLocationId: string;
  locationName: string | null;
  eligibleCount: number;
  unbilledCount: number;
  unbilledAmount: number;
  chargedCount: number;
  chargedAmount: number;
  pendingCount: number;
  failedCount: number;
  currency: string | null;
  mixedCurrencies: boolean;
  hasStripeCustomer?: boolean;
  stripeBillingReady?: boolean;
};

export type ClientChargeOverviewResult = {
  subaccounts: ClientChargeOverviewRow[];
  totals: ClientChargeTotals;
  pagination: {
    page: number;
    pageSize: number;
    totalSubaccounts: number;
    totalPages: number;
    query?: string;
  };
};

export type ClientChargeFetchParams = {
  from: Date;
  toExclusive: Date;
  allowedLocationIds: string[] | null;
  hiddenLocationIds?: string[];
  locationId?: string;
  appointmentId?: string;
  query?: string;
  status?: "all" | "unbilled" | "pending" | "succeeded" | "failed";
  /** Overview search: match location name/id only (not payment fields). */
  subaccountQueryOnly?: boolean;
};

function computeChargeTotals(candidates: ClientChargeCandidate[]): ClientChargeTotals {
  const currencies = new Set(candidates.map((row) => row.deposit.currency));
  return {
    eligibleCount: candidates.length,
    chargedCount: candidates.filter((row) => row.charge?.status === "succeeded").length,
    unbilledCount: candidates.filter((row) => row.charge === null).length,
    pendingCount: candidates.filter((row) => row.charge?.status === "pending").length,
    failedCount: candidates.filter((row) => row.charge?.status === "failed").length,
    chargedAmount: candidates.reduce(
      (sum, row) => sum + (row.charge?.status === "succeeded" ? row.charge.amount : 0),
      0
    ),
    unbilledAmount: candidates.reduce(
      (sum, row) => sum + (row.charge === null ? row.deposit.amount : 0),
      0
    ),
    currency: currencies.size === 1 ? ([...currencies][0] ?? null) : null,
    mixedCurrencies: currencies.size > 1
  };
}

function aggregateOverviewRow(
  locationId: string,
  ghlLocationId: string,
  locationName: string | null,
  rows: ClientChargeCandidate[]
): ClientChargeOverviewRow {
  const totals = computeChargeTotals(rows);
  return {
    locationId,
    ghlLocationId,
    locationName,
    eligibleCount: totals.eligibleCount,
    unbilledCount: totals.unbilledCount,
    unbilledAmount: totals.unbilledAmount,
    chargedCount: totals.chargedCount,
    chargedAmount: totals.chargedAmount,
    pendingCount: totals.pendingCount,
    failedCount: totals.failedCount,
    currency: totals.currency,
    mixedCurrencies: totals.mixedCurrencies
  };
}

function matchesSubaccountQuery(
  row: Pick<ClientChargeCandidate, "locationName" | "ghlLocationId" | "locationId">,
  needle: string
) {
  if (!needle) return true;
  const haystack = [row.locationName, row.ghlLocationId, row.locationId]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(needle);
}

/** Net collected amount for one order. Zero means nothing entered the account. */
function collectedAmountSql(orderId: SQL): SQL {
  const statuses = COLLECTED_TRANSACTION_STATUSES.map((status) => sql`${status}`);
  return sql`(
    select coalesce(sum(greatest(coalesce(paid_tx.amount, 0) - coalesce(paid_tx.amount_refunded, 0), 0)), 0)::int
    from ghl_payment_transactions paid_tx
    where paid_tx.order_id = ${orderId}
      and lower(trim(coalesce(paid_tx.status, ''))) in (${sql.join(statuses, sql`, `)})
  )`;
}

function collectedAmountForAlias(alias: "ghl_payment_orders" | "mirror_order" | "closer_order"): SQL {
  return collectedAmountSql(sql.raw(`${alias}.id`));
}

/**
 * Money that entered the account. Uses collected transactions, and falls back to the
 * order total when HighLevel marks a manual payment succeeded but stores the transaction at 0.
 */
function billableAmountForAlias(alias: "ghl_payment_orders" | "mirror_order" | "closer_order"): SQL {
  const collected = collectedAmountForAlias(alias);
  const order = sql.raw(alias);
  return sql`greatest(
    ${collected},
    case
      when ${collected} = 0
        and exists (
          select 1
          from ghl_payment_transactions paid_marker
          where paid_marker.order_id = ${order}.id
            and lower(trim(coalesce(paid_marker.status, ''))) in (${sql.join(
              COLLECTED_TRANSACTION_STATUSES.map((status) => sql`${status}`),
              sql`, `
            )})
        )
        and lower(trim(coalesce(${order}.status, ''))) in ('completed', 'complete', 'paid', 'succeeded', 'successful')
        and coalesce(${order}.amount, 0) > 0
      then ${order}.amount
      else 0
    end
  )`;
}

/** Same contact and amount within 48h, or explicit cross-ids, means one payment stored twice. */
function orderMirrorsInvoiceSql(orderAlias: "ghl_payment_orders" | "mirror_order" | "closer_order", invoiceAlias: "invoices" | "mirrored_invoice"): SQL {
  const order = sql.raw(orderAlias);
  const invoice = sql.raw(invoiceAlias);
  const orderPaid = sql`coalesce(${order}.ghl_created_at, ${order}.created_at)`;
  const invoicePaid = sql`coalesce(${invoice}.ghl_updated_at, ${invoice}.issue_date, ${invoice}.ghl_created_at, ${invoice}.created_at)`;
  return sql`(
    ${order}.location_id = ${invoice}.location_id
    and (
      (
        nullif(trim(coalesce(${order}.alt_id, '')), '') is not null
        and ${order}.alt_id = ${invoice}.ghl_invoice_id
      )
      or (
        nullif(trim(coalesce(${invoice}.alt_id, '')), '') is not null
        and ${invoice}.alt_id = ${order}.ghl_order_id
      )
      or (
        ${invoice}.contact_id is not null
        and ${order}.contact_id = ${invoice}.contact_id
        and ${billableAmountForAlias(orderAlias)} = ${invoice}.amount_paid
        and abs(extract(epoch from (${orderPaid} - ${invoicePaid}))) <= ${COLLECTED_PAYMENT_MIRROR_WINDOW_SECONDS}
      )
    )
  )`;
}

const NOT_CANCELLED = sql`('cancelled', 'canceled', 'void', 'voided')`;

function chargeJsonSql(where: SQL): SQL {
  return sql`(
    select jsonb_build_object(
      'id', ch.id,
      'status', ch.status,
      'amount', ch.charge_amount,
      'currency', ch.charge_currency,
      'attemptCount', ch.attempt_count,
      'ghlReferenceId', ch.ghl_reference_id,
      'ghlTransactionId', ch.ghl_transaction_id,
      'lastError', ch.last_error,
      'createdAt', ch.created_at,
      'updatedAt', ch.updated_at,
      'succeededAt', ch.succeeded_at,
      'failedAt', ch.failed_at,
      'chargedByName', wu.display_name,
      'chargedByEmail', wu.email
    )
    from client_result_charges ch
    left join workspace_users wu on wu.id = ch.created_by_workspace_user_id
    where ${where}
    order by case lower(coalesce(ch.status, ''))
      when 'succeeded' then 0
      when 'pending' then 1
      when 'failed' then 2
      else 3
    end,
    ch.updated_at desc
    limit 1
  )`;
}

function orderChargeSql(): SQL {
  const invoicePaid = sql`coalesce(mirrored_invoice.ghl_updated_at, mirrored_invoice.issue_date, mirrored_invoice.ghl_created_at, mirrored_invoice.created_at)`;
  const orderPaid = sql`coalesce(${ghlPaymentOrders.ghlCreatedAt}, ${ghlPaymentOrders.createdAt})`;
  return chargeJsonSql(sql`
    ch.payment_order_id = ${ghlPaymentOrders.id}
    or (
      ch.invoice_id is not null
      and ch.payment_order_id is null
      and exists (
        select 1
        from invoices mirrored_invoice
        where mirrored_invoice.id = ch.invoice_id
          and ${orderMirrorsInvoiceSql("ghl_payment_orders", "mirrored_invoice")}
          and not exists (
            select 1
            from ghl_payment_orders closer_order
            where closer_order.id <> ${ghlPaymentOrders.id}
              and closer_order.is_deleted = false
              and lower(trim(coalesce(closer_order.status, ''))) not in ${NOT_CANCELLED}
              and ${billableAmountForAlias("closer_order")} > 0
              and ${orderMirrorsInvoiceSql("closer_order", "mirrored_invoice")}
              and (
                abs(extract(epoch from (coalesce(closer_order.ghl_created_at, closer_order.created_at) - ${invoicePaid})))
                  < abs(extract(epoch from (${orderPaid} - ${invoicePaid})))
                or (
                  abs(extract(epoch from (coalesce(closer_order.ghl_created_at, closer_order.created_at) - ${invoicePaid})))
                    = abs(extract(epoch from (${orderPaid} - ${invoicePaid})))
                  and closer_order.id < ${ghlPaymentOrders.id}
                )
              )
          )
      )
    )
  `);
}

function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

function moneyCurrency(rowCurrency: string | null | undefined, configCurrency: string | null | undefined): string {
  const raw = rowCurrency?.trim() || configCurrency?.trim() || "USD";
  return raw.toUpperCase();
}

type ChargeJson = {
  id?: string;
  status?: string;
  amount?: number | string;
  currency?: string;
  attemptCount?: number | string;
  ghlReferenceId?: string | null;
  ghlTransactionId?: string | null;
  lastError?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
  succeededAt?: string | null;
  failedAt?: string | null;
  chargedByName?: string | null;
  chargedByEmail?: string | null;
};

function mapCharge(value: unknown, fallbackCurrency: string): ClientChargeCandidate["charge"] {
  const row =
    value && typeof value === "object"
      ? (value as ChargeJson)
      : typeof value === "string" && value.trim().startsWith("{")
        ? (JSON.parse(value) as ChargeJson)
        : null;
  if (!row?.id) return null;
  return {
    id: row.id,
    status: row.status || "pending",
    amount: Number(row.amount ?? 0),
    currency: row.currency?.trim() || fallbackCurrency,
    attemptCount: Number(row.attemptCount ?? 0),
    ghlReferenceId: row.ghlReferenceId ?? null,
    ghlTransactionId: row.ghlTransactionId ?? null,
    lastError: row.lastError ?? null,
    createdAt: iso(row.createdAt) ?? new Date(0).toISOString(),
    updatedAt: iso(row.updatedAt) ?? new Date(0).toISOString(),
    succeededAt: iso(row.succeededAt),
    failedAt: iso(row.failedAt),
    chargedBy: chargeActorDisplayName(row.chargedByName, row.chargedByEmail)
  };
}

type PaymentCandidateRow = {
  targetId: string;
  externalId: string;
  sourceLabel: string | null;
  paidAt: Date | string;
  locationId: string;
  ghlLocationId: string;
  locationName: string | null;
  contactId: string | null;
  contactFirstName: string | null;
  contactLastName: string | null;
  contactEmail: string | null;
  amount: unknown;
  currency: string | null;
  configCurrency: string;
  charge: unknown;
};

function mapPaymentRow(row: PaymentCandidateRow, kind: CanonicalDepositEvidence["kind"]): ClientChargeCandidate | null {
  const amount = Number(row.amount);
  if (!row.targetId || !Number.isFinite(amount) || amount <= 0) return null;
  const currency = moneyCurrency(row.currency, row.configCurrency);
  const paidAt = iso(row.paidAt);
  if (!paidAt) return null;
  const contactName =
    [row.contactFirstName, row.contactLastName]
      .map((value) => (value ?? "").trim())
      .filter(Boolean)
      .join(" ") || null;
  return {
    appointmentId: row.targetId,
    ghlAppointmentId: row.externalId,
    appointmentTitle: row.sourceLabel?.trim() || null,
    appointmentStartTime: null,
    appointmentBookedAt: paidAt,
    locationId: row.locationId,
    ghlLocationId: row.ghlLocationId,
    locationName: row.locationName,
    contactId: row.contactId,
    contactName,
    contactEmail: row.contactEmail,
    deposit: {
      kind,
      id: row.targetId,
      externalId: row.externalId,
      amount,
      currency,
      matchedBy: kind === "invoice" ? "collected_invoice" : "collected_order",
      paidAt
    },
    charge: mapCharge(row.charge, currency)
  };
}

function scopeFilters(params: ClientChargeFetchParams): SQL[] {
  const filters: SQL[] = [eq(locationBillingConfig.enabled, true)];
  if (params.allowedLocationIds !== null) {
    filters.push(
      params.allowedLocationIds.length === 0 ? sql`false` : inArray(locations.id, params.allowedLocationIds)
    );
  }
  if (params.hiddenLocationIds?.length) {
    filters.push(notInArray(locations.id, params.hiddenLocationIds));
  }
  if (params.locationId) filters.push(eq(locations.id, params.locationId));
  return filters;
}

function candidateMatches(candidate: ClientChargeCandidate, params: ClientChargeFetchParams): boolean {
  const query = (params.query ?? "").trim().toLowerCase();
  const status = params.status ?? "all";
  if (params.subaccountQueryOnly) {
    if (!matchesSubaccountQuery(candidate, query)) return false;
  } else if (query) {
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
    if (!haystack.includes(query)) return false;
  }
  if (status === "unbilled" && candidate.charge) return false;
  if (status !== "all" && status !== "unbilled" && candidate.charge?.status !== status) return false;
  return true;
}

async function resolveChargeTarget(
  db: Db,
  id: string
): Promise<{ orderId: string | null; invoiceId: string | null }> {
  const [linked] = await db
    .select({
      paymentOrderId: clientResultCharges.paymentOrderId,
      invoiceId: clientResultCharges.invoiceId
    })
    .from(clientResultCharges)
    .where(eq(clientResultCharges.appointmentId, id))
    .limit(1);
  if (linked && (linked.paymentOrderId || linked.invoiceId)) {
    return { orderId: linked.paymentOrderId, invoiceId: linked.invoiceId };
  }
  return { orderId: id, invoiceId: id };
}

export async function fetchClientChargeCandidates(
  db: Db,
  params: ClientChargeFetchParams
): Promise<ClientChargeCandidate[]> {
  const target = params.appointmentId ? await resolveChargeTarget(db, params.appointmentId) : null;
  const orderPaidAt = sql<Date>`coalesce(${ghlPaymentOrders.ghlCreatedAt}, ${ghlPaymentOrders.createdAt})`;
  const invoicePaidAt = sql<Date>`coalesce(${invoices.ghlUpdatedAt}, ${invoices.issueDate}, ${invoices.ghlCreatedAt}, ${invoices.createdAt})`;

  const orderFilters: SQL[] = [
    ...scopeFilters(params),
    eq(ghlPaymentOrders.isDeleted, false),
    sql`lower(trim(coalesce(${ghlPaymentOrders.status}, ''))) not in ${NOT_CANCELLED}`,
    sql`${billableAmountForAlias("ghl_payment_orders")} > 0`
  ];
  if (target) {
    orderFilters.push(target.orderId ? eq(ghlPaymentOrders.id, target.orderId) : sql`false`);
  } else {
    orderFilters.push(gte(orderPaidAt, params.from), lt(orderPaidAt, params.toExclusive));
  }

  const invoiceFilters: SQL[] = [
    ...scopeFilters(params),
    eq(invoices.isDeleted, false),
    sql`lower(trim(coalesce(${invoices.status}, ''))) not in ${NOT_CANCELLED}`,
    sql`coalesce(${invoices.amountPaid}, 0) > 0`
  ];
  if (target) {
    invoiceFilters.push(target.invoiceId ? eq(invoices.id, target.invoiceId) : sql`false`);
  } else {
    invoiceFilters.push(gte(invoicePaidAt, params.from), lt(invoicePaidAt, params.toExclusive));
    invoiceFilters.push(sql`not exists (
      select 1
      from ghl_payment_orders mirror_order
      where mirror_order.is_deleted = false
        and lower(trim(coalesce(mirror_order.status, ''))) not in ${NOT_CANCELLED}
        and ${billableAmountForAlias("mirror_order")} > 0
        and ${orderMirrorsInvoiceSql("mirror_order", "invoices")}
    )`);
  }

  const orderRows = await db
    .select({
      targetId: ghlPaymentOrders.id,
      externalId: ghlPaymentOrders.ghlOrderId,
      sourceLabel: sql<string | null>`coalesce(nullif(trim(${paymentSources.displayName}), ''), nullif(trim(${ghlPaymentOrders.raw}->'source'->>'name'), ''))`,
      paidAt: orderPaidAt,
      locationId: locations.id,
      ghlLocationId: locations.ghlLocationId,
      locationName: locations.name,
      contactId: contacts.id,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      contactEmail: contacts.email,
      amount: billableAmountForAlias("ghl_payment_orders"),
      currency: ghlPaymentOrders.currency,
      configCurrency: locationBillingConfig.currency,
      charge: orderChargeSql()
    })
    .from(ghlPaymentOrders)
    .innerJoin(locations, eq(ghlPaymentOrders.locationId, locations.id))
    .innerJoin(locationBillingConfig, eq(locationBillingConfig.locationId, ghlPaymentOrders.locationId))
    .leftJoin(contacts, eq(ghlPaymentOrders.contactId, contacts.id))
    .leftJoin(paymentSources, eq(ghlPaymentOrders.paymentSourceId, paymentSources.id))
    .where(and(...orderFilters));

  const invoiceRows = await db
    .select({
      targetId: invoices.id,
      externalId: invoices.ghlInvoiceId,
      sourceLabel: sql<string | null>`coalesce(nullif(trim(${invoices.name}), ''), nullif(trim(${invoices.title}), ''), nullif(trim(${invoices.invoiceNumber}), ''))`,
      paidAt: invoicePaidAt,
      locationId: locations.id,
      ghlLocationId: locations.ghlLocationId,
      locationName: locations.name,
      contactId: contacts.id,
      contactFirstName: contacts.firstName,
      contactLastName: contacts.lastName,
      contactEmail: contacts.email,
      amount: invoices.amountPaid,
      currency: invoices.currency,
      configCurrency: locationBillingConfig.currency,
      charge: chargeJsonSql(sql`ch.invoice_id = ${invoices.id}`)
    })
    .from(invoices)
    .innerJoin(locations, eq(invoices.locationId, locations.id))
    .innerJoin(locationBillingConfig, eq(locationBillingConfig.locationId, invoices.locationId))
    .leftJoin(contacts, eq(invoices.contactId, contacts.id))
    .where(and(...invoiceFilters));

  const normalized: ClientChargeCandidate[] = [];
  for (const row of orderRows) {
    const candidate = mapPaymentRow(row, "payment_order");
    if (candidate && candidateMatches(candidate, params)) normalized.push(candidate);
  }
  for (const row of invoiceRows) {
    const candidate = mapPaymentRow(row as PaymentCandidateRow, "invoice");
    if (candidate && candidateMatches(candidate, params)) normalized.push(candidate);
  }
  normalized.sort((a, b) => b.appointmentBookedAt.localeCompare(a.appointmentBookedAt) || a.appointmentId.localeCompare(b.appointmentId));
  return normalized;
}

async function listEnabledChargeLocations(
  db: Db,
  params: Pick<ClientChargeFetchParams, "allowedLocationIds" | "hiddenLocationIds">
): Promise<Array<{ locationId: string; ghlLocationId: string; locationName: string | null }>> {
  const filters: SQL[] = [eq(locationBillingConfig.enabled, true)];
  if (params.allowedLocationIds !== null) {
    filters.push(
      params.allowedLocationIds.length === 0
        ? sql`false`
        : inArray(locations.id, params.allowedLocationIds)
    );
  }
  if (params.hiddenLocationIds?.length) {
    filters.push(notInArray(locations.id, params.hiddenLocationIds));
  }
  return db
    .select({
      locationId: locations.id,
      ghlLocationId: locations.ghlLocationId,
      locationName: locations.name
    })
    .from(locations)
    .innerJoin(locationBillingConfig, eq(locationBillingConfig.locationId, locations.id))
    .where(and(...filters));
}

export async function listClientChargeOverview(
  db: Db,
  params: ClientChargeFetchParams & {
    page: number;
    pageSize: number;
    sortColumn?: "subaccount" | "unbilled" | "charged" | "eligible";
    sortDirection?: "asc" | "desc";
    accountView?: OverviewAccountView;
  }
): Promise<ClientChargeOverviewResult> {
  const candidates = await fetchClientChargeCandidates(db, {
    ...params,
    status: "all",
    subaccountQueryOnly: true,
    locationId: undefined,
    appointmentId: undefined
  });

  const byLocation = new Map<string, ClientChargeCandidate[]>();
  for (const row of candidates) {
    const bucket = byLocation.get(row.locationId) ?? [];
    bucket.push(row);
    byLocation.set(row.locationId, bucket);
  }

  const enabledLocations = await listEnabledChargeLocations(db, params);
  const needle = (params.query ?? "").trim().toLowerCase();
  let subaccounts: ClientChargeOverviewRow[] = [];
  for (const loc of enabledLocations) {
    if (!matchesSubaccountQuery(loc, needle)) continue;
    const rows = byLocation.get(loc.locationId) ?? [];
    subaccounts.push(
      rows.length > 0
        ? aggregateOverviewRow(loc.locationId, loc.ghlLocationId, loc.locationName, rows)
        : emptyOverviewAccountRow(loc)
    );
  }

  const accountView = params.accountView ?? "all";
  subaccounts = subaccounts.filter((row) => overviewAccountMatchesView(row, accountView));

  const sortColumn = params.sortColumn ?? "unbilled";
  const sortDirection = params.sortDirection ?? "desc";
  const dir = sortDirection === "asc" ? 1 : -1;
  subaccounts.sort((a, b) => {
    let cmp = 0;
    if (sortColumn === "subaccount") {
      const na = (a.locationName ?? a.ghlLocationId).toLowerCase();
      const nb = (b.locationName ?? b.ghlLocationId).toLowerCase();
      cmp = na.localeCompare(nb);
    } else if (sortColumn === "charged") {
      cmp = a.chargedCount - b.chargedCount || a.chargedAmount - b.chargedAmount;
    } else if (sortColumn === "eligible") {
      cmp = a.eligibleCount - b.eligibleCount;
    } else {
      cmp = a.unbilledCount - b.unbilledCount || a.unbilledAmount - b.unbilledAmount;
    }
    return cmp * dir;
  });

  const totals = computeChargeTotals(candidates);
  const pageSize = Math.min(100, Math.max(1, Math.floor(params.pageSize)));
  const totalSubaccounts = subaccounts.length;
  const totalPages = Math.max(1, Math.ceil(totalSubaccounts / pageSize));
  const page = Math.min(Math.max(1, Math.floor(params.page)), totalPages);
  const start = (page - 1) * pageSize;

  return {
    subaccounts: subaccounts.slice(start, start + pageSize),
    totals,
    pagination: {
      page,
      pageSize,
      totalSubaccounts,
      totalPages,
      query: params.query?.trim() || undefined
    }
  };
}

export async function listClientChargeCandidates(
  db: Db,
  params: ClientChargeFetchParams & {
    page: number;
    pageSize: number;
  }
): Promise<ClientChargeListResult> {
  const normalized = await fetchClientChargeCandidates(db, params);
  const totals = computeChargeTotals(normalized);

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
