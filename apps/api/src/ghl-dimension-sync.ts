import type { AgentFlowDb } from "@agentflow/db";
import { ghlPaymentOrders, locationCalendars, paymentSources } from "@agentflow/db";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { SQL } from "drizzle-orm";

export type ParsedOrderPaymentSource = {
  type: string;
  subType: string;
  externalId: string;
  name: string;
  meta: Record<string, unknown>;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

/** OrderCreate / OrderStatusUpdate payloads expose payment metadata on `source`. */
export function parsePaymentSourceFromOrderPayload(root: Record<string, unknown>): ParsedOrderPaymentSource | null {
  const src = root.source;
  const s = asRecord(src);
  if (!s) {
    return null;
  }
  const type = typeof s.type === "string" ? s.type : "";
  const subType = typeof s.subType === "string" ? s.subType : "";
  const externalId = typeof s.id === "string" ? s.id : "";
  const nameRaw = typeof s.name === "string" ? s.name.trim() : "";
  const name = nameRaw !== "" ? nameRaw : "Payment source";
  let meta: Record<string, unknown> = {};
  if (s.meta && typeof s.meta === "object" && !Array.isArray(s.meta)) {
    meta = s.meta as Record<string, unknown>;
  }
  return { type, subType, externalId, name, meta };
}

export function deriveAppointmentCalendarDisplayName(
  appointmentRawRoot: Record<string, unknown>,
  titleFallback: string | null | undefined
): string | null {
  const apt = asRecord(appointmentRawRoot.appointment) ?? appointmentRawRoot;

  const direct = apt.calendarName ?? apt.calendar_name;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }

  const calWrap = asRecord(apt.calendar);
  const nestedName = calWrap?.name;
  if (typeof nestedName === "string" && nestedName.trim()) {
    return nestedName.trim();
  }

  const rootCal = asRecord(appointmentRawRoot.calendar);
  const rootName = rootCal?.name;
  if (typeof rootName === "string" && rootName.trim()) {
    return rootName.trim();
  }

  const t = typeof titleFallback === "string" ? titleFallback.trim() : "";
  return t || null;
}

export async function upsertLocationCalendarRow(
  db: AgentFlowDb,
  params: { locationId: string; ghlCalendarId: string; displayName: string; now: Date }
): Promise<void> {
  const { locationId, ghlCalendarId, displayName, now } = params;
  await db
    .insert(locationCalendars)
    .values({
      locationId,
      ghlCalendarId,
      name: displayName,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: [locationCalendars.locationId, locationCalendars.ghlCalendarId],
      set: {
        name: sql`COALESCE(NULLIF(trim(EXCLUDED.name), ''), ${locationCalendars.name})`,
        updatedAt: now
      }
    });
}

/** Authoritative calendar label from GET /calendars — overwrites heuristic webhook/title guesses. */
export async function upsertLocationCalendarCanonicalNameFromGhlApi(
  db: AgentFlowDb,
  params: { locationId: string; ghlCalendarId: string; canonicalName: string; now: Date }
): Promise<void> {
  const name = params.canonicalName.trim();
  if (!name) {
    return;
  }
  await db
    .insert(locationCalendars)
    .values({
      locationId: params.locationId,
      ghlCalendarId: params.ghlCalendarId,
      name,
      updatedAt: params.now
    })
    .onConflictDoUpdate({
      target: [locationCalendars.locationId, locationCalendars.ghlCalendarId],
      set: {
        name,
        updatedAt: params.now
      }
    });
}

export async function upsertPaymentSourceFromOrder(
  db: AgentFlowDb,
  locationId: string,
  parsed: ParsedOrderPaymentSource,
  now: Date
): Promise<string> {
  const [row] = await db
    .insert(paymentSources)
    .values({
      locationId,
      sourceType: parsed.type,
      sourceSubType: parsed.subType,
      externalId: parsed.externalId,
      displayName: parsed.name,
      meta: parsed.meta,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: [
        paymentSources.locationId,
        paymentSources.sourceType,
        paymentSources.sourceSubType,
        paymentSources.externalId
      ],
      set: {
        displayName: sql`COALESCE(NULLIF(trim(EXCLUDED.display_name), ''), ${paymentSources.displayName})`,
        meta: sql`EXCLUDED.meta`,
        updatedAt: now
      }
    })
    .returning({ id: paymentSources.id });

  if (!row) {
    throw new Error("payment source upsert failed");
  }
  return row.id;
}

/** Paid orders stored before migration 0013, or rows never re-processed, may lack `payment_source_id` while `raw.source` exists. */
export function wherePaymentOrderRowMissingPaymentSourceLink(): SQL {
  return and(
    isNull(ghlPaymentOrders.paymentSourceId),
    sql`jsonb_typeof(${ghlPaymentOrders.raw}->'source') = 'object'`
  )!;
}

export async function linkStoredPaymentOrderToPaymentSource(
  db: AgentFlowDb,
  params: { orderId: string; locationId: string; raw: unknown; now?: Date }
): Promise<"linked" | "no_source_in_raw" | "failed"> {
  const root = asRecord(params.raw);
  if (!root) {
    return "no_source_in_raw";
  }
  const parsed = parsePaymentSourceFromOrderPayload(root);
  if (!parsed) {
    return "no_source_in_raw";
  }
  const now = params.now ?? new Date();
  try {
    const paymentSourceId = await upsertPaymentSourceFromOrder(db, params.locationId, parsed, now);
    await db
      .update(ghlPaymentOrders)
      .set({ paymentSourceId, updatedAt: now })
      .where(eq(ghlPaymentOrders.id, params.orderId));
    return "linked";
  } catch {
    return "failed";
  }
}

/**
 * Backfill `payment_sources` + `ghl_payment_orders.payment_source_id` from stored order webhook JSON (`raw.source`).
 * No outbound GHL calls — safe to run in larger batches than calendar catalog hydrate.
 */
export async function hydratePaymentSourcesFromStoredOrdersBatch(
  db: AgentFlowDb,
  requestedLimit: number,
  requestedConcurrency: number
) {
  const batchLimit = Number.isFinite(requestedLimit)
    ? Math.min(200, Math.max(1, Math.floor(requestedLimit)))
    : 50;
  const concurrency = Number.isFinite(requestedConcurrency)
    ? Math.min(8, Math.max(1, Math.floor(requestedConcurrency)))
    : 4;

  const missingLink = wherePaymentOrderRowMissingPaymentSourceLink();

  const [backlogPeek, candidates] = await Promise.all([
    db.select({ backlog: sql<number>`count(*)::int` }).from(ghlPaymentOrders).where(missingLink),
    db
      .select({
        orderId: ghlPaymentOrders.id,
        locationId: ghlPaymentOrders.locationId,
        raw: ghlPaymentOrders.raw
      })
      .from(ghlPaymentOrders)
      .where(missingLink)
      .orderBy(asc(ghlPaymentOrders.locationId), asc(ghlPaymentOrders.id))
      .limit(batchLimit)
  ]);

  const backlogBefore = backlogPeek[0]?.backlog ?? 0;

  if (candidates.length === 0) {
    return {
      ok: true as const,
      message: "no_orders_needing_payment_source_link" as const,
      batchLimit,
      concurrency,
      backlogRemaining: backlogBefore,
      ordersAttemptedInBatch: 0,
      ordersLinkedInBatch: 0,
      ordersFailedInBatch: 0,
      rerunHint:
        backlogBefore <= 0
          ? "All orders with raw.source appear linked to payment_sources."
          : "No rows picked in batch scope; POST again immediately (race)."
    };
  }

  let ordersLinkedInBatch = 0;
  let ordersFailedInBatch = 0;

  for (let offset = 0; offset < candidates.length; offset += concurrency) {
    const slice = candidates.slice(offset, offset + concurrency);
    const outcomes = await Promise.all(
      slice.map((row) =>
        linkStoredPaymentOrderToPaymentSource(db, {
          orderId: row.orderId,
          locationId: row.locationId,
          raw: row.raw
        })
      )
    );
    for (const outcome of outcomes) {
      if (outcome === "linked") {
        ordersLinkedInBatch += 1;
      } else if (outcome === "failed") {
        ordersFailedInBatch += 1;
      }
    }
  }

  const backlogRemaining = Math.max(0, backlogBefore - ordersLinkedInBatch);

  return {
    ok: true as const,
    batchLimit,
    concurrency,
    candidatesQueued: candidates.length,
    backlogBeforeOrders: backlogBefore,
    ordersAttemptedInBatch: candidates.length,
    ordersLinkedInBatch,
    ordersFailedInBatch,
    backlogRemaining,
    backlogMeasure: "estimated_from_successful_links" as const,
    rerunHint:
      backlogRemaining > 0 || candidates.length >= batchLimit
        ? "POST again until backlogRemaining is 0 and candidatesQueued stays below batch limit."
        : "Backfill pass complete for scoped backlog (per estimate)."
  };
}
