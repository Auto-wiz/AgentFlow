import { createDb, appointments } from "@agentflow/db";
import { AUDIT_ACTION_KINDS } from "@agentflow/shared";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";

import {
  resolveAccessPolicy,
  resolveSessionUser,
  canWorkspaceAccessLocationUuid,
  type WorkspaceJwtEnv
} from "./workspace-access.js";
import { insertWorkspaceAuditLog } from "./workspace-audit.js";

type HonoBindings = { Bindings: WorkspaceJwtEnv & { DATABASE_URL: string } };

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

type ManualOverrideInput = "inherit" | "force_paid" | "force_unpaid";

function parseManualOverride(raw: unknown): ManualOverrideInput | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  if (raw === "inherit") {
    return "inherit";
  }
  if (raw === "force_paid" || raw === "force_unpaid") {
    return raw;
  }
  return null;
}

/** Authenticated workspace JWT only; requires access to appointment's location UUID. */
export async function putWorkspaceAppointmentOverridesHandler(c: Context<HonoBindings>) {
  const me = await resolveSessionUser(c, c.env);
  if (!me) {
    return c.json(
      {
        error: "unauthorized",
        hint: "Appointment overrides require JWT workspace sign-in (Configure JWT_SECRET and sign in)."
      },
      401
    );
  }

  const policy = await resolveAccessPolicy(c, c.env);
  if (!policy) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const id = c.req.param("id")?.trim() ?? "";
  if (!isUuid(id)) {
    return c.json({ error: "invalid_appointment_id" }, 400);
  }

  const body = asRecord(await c.req.json().catch(() => ({})));
  const paymentRaw = parseManualOverride(body.manualPaymentOverride);
  if (paymentRaw === null) {
    return c.json(
      { error: "invalid_body", hint: "manualPaymentOverride must be inherit | force_paid | force_unpaid" },
      400
    );
  }

  if (typeof body.hiddenFromUi !== "boolean") {
    return c.json({ error: "invalid_body", hint: "hiddenFromUi boolean required" }, 400);
  }
  const hiddenFromUi = body.hiddenFromUi;

  const db = createDb(c.env.DATABASE_URL);

  const [row] = await db
    .select({
      id: appointments.id,
      locationId: appointments.locationId,
      manualPaymentOverride: appointments.manualPaymentOverride,
      hiddenFromUi: appointments.hiddenFromUi
    })
    .from(appointments)
    .where(eq(appointments.id, id))
    .limit(1);

  if (!row) {
    return c.json({ error: "not_found" }, 404);
  }

  const canAccess = await canWorkspaceAccessLocationUuid(db, policy, row.locationId);
  if (!canAccess) {
    return c.json({ error: "forbidden_location" }, 403);
  }

  const prevPayment = row.manualPaymentOverride ?? "inherit";
  const prevHidden = row.hiddenFromUi;

  const nextManual =
    paymentRaw === "inherit" ? null : paymentRaw === "force_paid" ? "force_paid" : "force_unpaid";

  const now = new Date();

  await db
    .update(appointments)
    .set({
      manualPaymentOverride: nextManual,
      hiddenFromUi,
      appointmentOverrideUpdatedAt: now,
      appointmentOverrideWorkspaceUserId: me.id,
      updatedAt: now
    })
    .where(and(eq(appointments.id, id)));

  await insertWorkspaceAuditLog(db, {
    actorWorkspaceUserId: me.id,
    actionKind: AUDIT_ACTION_KINDS.APPOINTMENT_MANUAL_OVERRIDE,
    entityType: "appointment",
    entityId: id,
    locationId: row.locationId,
    summary: `Appointment overrides (${paymentRaw}${hiddenFromUi ? ", hidden list" : ", visible list"})`,
    details: {
      appointmentId: id,
      manualPaymentBefore: prevPayment === "inherit" ? null : prevPayment,
      manualPaymentAfter: nextManual,
      hiddenBefore: prevHidden,
      hiddenAfter: hiddenFromUi,
      workspaceUserEmail: me.email,
      workspaceUserDisplayName: me.displayName
    }
  });

  return c.json({
    ok: true as const,
    appointmentId: id,
    manualPaymentOverride: paymentRaw === "inherit" ? null : nextManual,
    hiddenFromUi,
    appointmentOverrideUpdatedAt: now.toISOString()
  });
}
