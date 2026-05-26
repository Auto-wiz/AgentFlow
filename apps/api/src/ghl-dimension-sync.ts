import type { AgentFlowDb } from "@agentflow/db";
import { locationCalendars, paymentSources } from "@agentflow/db";
import { sql } from "drizzle-orm";

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
