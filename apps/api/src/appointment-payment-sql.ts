/** Shared appointment↔payment SQL helpers (invoice + GoHighLevel orders). Extracted so dashboard + handlers stay in sync. */

import type { AgentFlowDb } from "@agentflow/db";
import { appointments, contacts, ghlPaymentOrders, invoices } from "@agentflow/db";
import { and, eq, exists, or, sql } from "drizzle-orm";

/** Predicate: GoHighLevel order `status` counts as capturing payment toward appointments. */
export function orderCountsAsPaidInSql() {
  const st = sql`trim(lower(coalesce(${ghlPaymentOrders.status}, '')))`;
  const fs = sql`trim(lower(coalesce(${ghlPaymentOrders.fulfillmentStatus}, '')))`;
  /** Avoid substring hacks on `status` — e.g. "unpaid" contains "paid". */
  return sql`(
    ${st} IN ('completed','paid','succeeded','successful','fully_paid','complete','paid_in_full')
    OR ${fs} IN ('fulfilled','complete','completed','paid','successful','processed')
  )`;
}

export function invoicePaidSignalSql() {
  return or(
    sql`lower(coalesce(${invoices.lastEventType}, '')) = 'invoicepaid'`,
    sql`lower(coalesce(${invoices.status}, '')) = 'paid'`,
    sql`(coalesce(${invoices.amountPaid}, 0) > 0 and coalesce(${invoices.total}, ${invoices.amountPaid}, 0) > 0 and ${invoices.amountPaid} >= coalesce(${invoices.total}, ${invoices.amountPaid}))`
  );
}

/** Normalize booking window: Postgres `x BETWEEN a AND b` matches nothing when a > b; GHL can send mismatched timestamps. */
function sqlPaymentTimestampInsideAppointmentBookingWindow(timestampExpr: ReturnType<typeof sql>) {
  const anchorLow = sql`least(coalesce(${appointments.dateAdded}, ${appointments.createdAt}), ${appointments.startTime})`;
  const anchorHigh = sql`greatest(coalesce(${appointments.dateAdded}, ${appointments.createdAt}), ${appointments.startTime})`;
  /** Deposits can clear well before anchor times; widen pre-window so dashboards match GHL "paid booking" totals. */
  return sql`${timestampExpr} >= (${anchorLow} - interval '35 days') AND ${timestampExpr} <= (${anchorHigh} + interval '180 days')`;
}

/** When GHL never sent a slot time, still allow matching a paid order to the booking row. */
function sqlPaymentAtOrAfterAppointmentBooking(timestampExpr: ReturnType<typeof sql>) {
  return sql`${timestampExpr} >= (coalesce(${appointments.dateAdded}, ${appointments.createdAt}) - interval '35 days')`;
}

/** Some webhooks stash status only under `appointment` in payload — mirror normalized paths we store in `raw`. */
function appointmentStatusNormalizedSql() {
  return sql`trim(lower(coalesce(
    ${appointments.status},
    ${appointments.raw}->'appointment'->>'appointmentStatus',
    ${appointments.raw}->'appointment'->>'status',
    ${appointments.raw}->>'appointmentStatus'
  , '')))`;
}

/**
 * Appointment webhooks omit `contact` at the envelope level sometimes, so `appointment.contact_id` stays null
 * even though payload JSON still carries GoHighLevel's contact identifier.
 */
function appointmentWebhookGhlContactIdFromRawSql() {
  return sql`nullif(trim(both '"' from trim(coalesce(
    ${appointments.raw}->'appointment'->>'contactId',
    ${appointments.raw}->>'contactId',
    ''
  ))), '')`;
}

/** Join payment rows to appointments when internal UUIDs mismatch or appointment row never received a FK backfill. */
function orderPaymentTouchesAppointmentPartySql() {
  return or(
    and(sql`${appointments.contactId} is not null`, eq(ghlPaymentOrders.contactId, appointments.contactId)),
    sql`(${appointmentWebhookGhlContactIdFromRawSql()}) is not null
        and exists (
          select 1
          from contacts payment_party_contact
          where payment_party_contact.id = ${ghlPaymentOrders.contactId}
          and payment_party_contact.location_id = ${appointments.locationId}
          and payment_party_contact.ghl_contact_id = ${appointmentWebhookGhlContactIdFromRawSql()}
        )`
  );
}

function invoicePaymentTouchesAppointmentPartySql() {
  return or(
    and(sql`${appointments.contactId} is not null`, eq(invoices.contactId, appointments.contactId)),
    sql`(${appointmentWebhookGhlContactIdFromRawSql()}) is not null
        and exists (
          select 1
          from contacts invoice_party_contact
          where invoice_party_contact.id = ${invoices.contactId}
          and invoice_party_contact.location_id = ${appointments.locationId}
          and invoice_party_contact.ghl_contact_id = ${appointmentWebhookGhlContactIdFromRawSql()}
        )`
  );
}

/** Rows GHL considers dead / withdrawn (same signals as skipping them in default lists). */
export function appointmentCancelledOnlySql() {
  const s = appointmentStatusNormalizedSql();
  return sql`(
    ${s} LIKE '%cancel%'
    OR ${s} IN ('deleted', 'declined', 'invalid', 'noshow')
    OR ${s} LIKE 'no-show%'
  )`;
}

/**
 * Appointment↔payment correlation (invoices + GHL orders). Keeps fragments in sync for list queries and /debug traces.
 *
 * Invoices use the anchor window when `start_time` exists; when webhooks omit it, the same loose booking-time path as
 * orders applies so paid invoice deposits still surface.
 */
export function buildAppointmentPaymentCorrelationParts(db: AgentFlowDb) {
  const invoiceTsSql = sql`coalesce(${invoices.ghlUpdatedAt}, ${invoices.issueDate}, ${invoices.dueDate}, ${invoices.updatedAt}, ${invoices.createdAt})`;

  const invoiceMatchWhere = and(
    eq(invoices.locationId, appointments.locationId),
    invoicePaymentTouchesAppointmentPartySql(),
    eq(invoices.isDeleted, false),
    sql`${appointments.startTime} is not null`,
    sqlPaymentTimestampInsideAppointmentBookingWindow(invoiceTsSql),
    invoicePaidSignalSql()
  );

  /** Parallel to `orderTemporalMatchNoStartTime` — some payloads omit `start_time` on the appointment row. */
  const invoiceMatchNoStartTime = and(
    eq(invoices.locationId, appointments.locationId),
    invoicePaymentTouchesAppointmentPartySql(),
    eq(invoices.isDeleted, false),
    sql`${appointments.startTime} is null`,
    sqlPaymentAtOrAfterAppointmentBooking(invoiceTsSql),
    sql`${invoiceTsSql} <= coalesce(${appointments.dateUpdated}, ${appointments.updatedAt}) + interval '366 days'`,
    invoicePaidSignalSql()
  );

  const invoiceSubq = db
    .select({ one: sql`1`.as("one") })
    .from(invoices)
    .where(or(invoiceMatchWhere, invoiceMatchNoStartTime));

  const orderCommon = and(
    eq(ghlPaymentOrders.locationId, appointments.locationId),
    eq(ghlPaymentOrders.isDeleted, false),
    orderCountsAsPaidInSql(),
    orderPaymentTouchesAppointmentPartySql()
  );

  const orderTsSql = sql`coalesce(${ghlPaymentOrders.ghlUpdatedAt}, ${ghlPaymentOrders.ghlCreatedAt}, ${ghlPaymentOrders.updatedAt}, ${ghlPaymentOrders.createdAt})`;

  const orderTemporalMatch = and(
    orderCommon,
    sql`${appointments.startTime} is not null`,
    sqlPaymentTimestampInsideAppointmentBookingWindow(orderTsSql)
  );

  /** start_time omitted in webhooks occasionally; correlate by contact/location once payment is captured. */
  const orderTemporalMatchNoStartTime = and(
    orderCommon,
    sql`${appointments.startTime} is null`,
    sqlPaymentAtOrAfterAppointmentBooking(orderTsSql),
    sql`${orderTsSql} <= coalesce(${appointments.dateUpdated}, ${appointments.updatedAt}) + interval '366 days'`
  );

  const orderAltAppointmentMatch = and(
    orderCommon,
    eq(ghlPaymentOrders.altId, appointments.ghlAppointmentId),
    sql`strpos(lower(trim(coalesce(${ghlPaymentOrders.altType}, ''))), 'appointment') > 0`
  );

  /** Same-location + appointment-linked order; skips contact FK match (fixes merged contact drift / NULL order contact). */
  const orderAltAppointmentMatchLooseContact = and(
    eq(ghlPaymentOrders.locationId, appointments.locationId),
    eq(ghlPaymentOrders.isDeleted, false),
    orderCountsAsPaidInSql(),
    eq(ghlPaymentOrders.altId, appointments.ghlAppointmentId),
    sql`strpos(lower(trim(coalesce(${ghlPaymentOrders.altType}, ''))), 'appointment') > 0`
  );

  const orderCombinedSubq = db
    .select({ one: sql`1`.as("one") })
    .from(ghlPaymentOrders)
    .where(
      or(orderTemporalMatch, orderTemporalMatchNoStartTime, orderAltAppointmentMatch, orderAltAppointmentMatchLooseContact)
    );

  return {
    invoicePaidExists: exists(invoiceSubq),
    /** Any order-based path matched (same as `(orderCombinedSubq)`). */
    orderPaidExists: exists(orderCombinedSubq),
    /** Order match only when start_time populated + temporal window holds. */
    orderTemporalPaidExists: exists(
      db.select({ one: sql`1`.as("one") }).from(ghlPaymentOrders).where(orderTemporalMatch)
    ),
    orderNoStartTimePaidExists: exists(
      db.select({ one: sql`1`.as("one") }).from(ghlPaymentOrders).where(orderTemporalMatchNoStartTime)
    ),
    /** Order altId = appointment GHL id and alt type references appointment — full contact predicates. */
    orderAltAppointmentLinkExists: exists(
      db.select({ one: sql`1`.as("one") }).from(ghlPaymentOrders).where(orderAltAppointmentMatch)
    ),
    orderAltAppointmentLinkLooseExists: exists(
      db.select({ one: sql`1`.as("one") }).from(ghlPaymentOrders).where(orderAltAppointmentMatchLooseContact)
    )
  };
}

export function buildAppointmentComputedPaidSql(db: AgentFlowDb) {
  const p = buildAppointmentPaymentCorrelationParts(db);
  return sql<boolean>`(${p.invoicePaidExists}) OR (${p.orderPaidExists})`;
}

/** Manual HighLevel payout overrides win over invoice/order correlation until cleared to inheriting computed state. */
export function buildAppointmentEffectivePaidSql(db: AgentFlowDb) {
  const computedPaid = buildAppointmentComputedPaidSql(db);
  return sql<boolean>`CASE
    WHEN ${appointments.manualPaymentOverride} = 'force_paid' THEN true
    WHEN ${appointments.manualPaymentOverride} = 'force_unpaid' THEN false
    ELSE (${computedPaid})
  END`;
}
