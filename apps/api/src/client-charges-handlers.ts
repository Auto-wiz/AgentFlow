import {
  agencies,
  clientResultChargeEvents,
  clientResultCharges,
  createDb,
  locationBillingConfig,
  locations
} from "@agentflow/db";
import { AUDIT_ACTION_KINDS } from "@agentflow/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Context } from "hono";

import { createGhlSubaccountWalletCharge, type ClientChargeGhlEnv } from "./client-charges-ghl.js";
import {
  clientChargeIdempotencyKey,
  isChargeRetryable,
  normalizeChargeAmount
} from "./client-charges-logic.js";
import {
  getClientChargeCandidateByAppointment,
  listClientChargeCandidates,
  type ClientChargeCandidate
} from "./client-charges-sql.js";
import { resolveDashboardBounds } from "./dashboard-handlers.js";
import {
  canWorkspaceAccessLocationUuid,
  getHiddenLocationIdsForPolicy,
  jwtWorkspaceAllowedLocationUuidList,
  resolveAccessPolicy,
  resolveSessionUser,
  type WorkspaceJwtEnv
} from "./workspace-access.js";
import { insertWorkspaceAuditLog } from "./workspace-audit.js";

export type ClientChargesEnv = WorkspaceJwtEnv & ClientChargeGhlEnv;
type Bindings = { Bindings: ClientChargesEnv };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value: string) {
  return UUID_RE.test(value.trim());
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function deepError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const parts = [error.message];
  let cause: unknown = error.cause;
  for (let i = 0; i < 4 && cause instanceof Error; i++) {
    parts.push(`cause: ${cause.message}`);
    cause = cause.cause;
  }
  return parts.join(" | ");
}

async function policyLocationScope(c: Context<Bindings>) {
  const policy = await resolveAccessPolicy(c, c.env);
  if (!policy) return null;
  const db = createDb(c.env.DATABASE_URL);
  return {
    policy,
    db,
    allowedLocationIds: await jwtWorkspaceAllowedLocationUuidList(db, policy),
    hiddenLocationIds:
      policy.kind === "legacy" ? await getHiddenLocationIdsForPolicy(db, policy) : ([] as string[])
  };
}

export async function getWorkspaceClientChargesHandler(c: Context<Bindings>) {
  try {
    const scoped = await policyLocationScope(c);
    if (!scoped) return c.json({ error: "unauthorized" }, 401);
    const bounds = resolveDashboardBounds(c.req.query("from"), c.req.query("to"));
    if ("error" in bounds) return c.json({ error: bounds.error }, 400);

    const pageRaw = Number.parseInt(c.req.query("page") ?? "1", 10);
    const limitRaw = Number.parseInt(c.req.query("limit") ?? "50", 10);
    const statusRaw = (c.req.query("status") ?? "all").trim().toLowerCase();
    const status =
      statusRaw === "unbilled" ||
      statusRaw === "pending" ||
      statusRaw === "succeeded" ||
      statusRaw === "failed"
        ? statusRaw
        : "all";

    const result = await listClientChargeCandidates(scoped.db, {
      from: bounds.from,
      toExclusive: bounds.toExclusive,
      allowedLocationIds: scoped.allowedLocationIds,
      hiddenLocationIds: scoped.hiddenLocationIds,
      query: c.req.query("q") ?? "",
      status,
      page: Number.isFinite(pageRaw) ? pageRaw : 1,
      pageSize: Number.isFinite(limitRaw) ? limitRaw : 50
    });

    c.header("Cache-Control", "private, no-store, max-age=0");
    return c.json({
      fromInclusive: bounds.from.toISOString(),
      toExclusive: bounds.toExclusive.toISOString(),
      ...result
    });
  } catch (error) {
    console.error("[client_charges.list]", error);
    return c.json({ error: "client_charges_list_failed", message: deepError(error) }, 500);
  }
}

function chargePublicRow(row: typeof clientResultCharges.$inferSelect) {
  return {
    id: row.id,
    appointmentId: row.appointmentId,
    locationId: row.locationId,
    status: row.status,
    depositSourceKind: row.depositSourceKind,
    paymentOrderId: row.paymentOrderId,
    invoiceId: row.invoiceId,
    depositAmount: row.depositAmount,
    depositCurrency: row.depositCurrency,
    chargeAmount: row.chargeAmount,
    chargeCurrency: row.chargeCurrency,
    attemptCount: row.attemptCount,
    ghlReferenceId: row.ghlReferenceId,
    ghlTransactionId: row.ghlTransactionId,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    succeededAt: row.succeededAt?.toISOString() ?? null,
    failedAt: row.failedAt?.toISOString() ?? null
  };
}

async function writeChargeOutcome(params: {
  c: Context<Bindings>;
  candidate: ClientChargeCandidate;
  charge: typeof clientResultCharges.$inferSelect;
  actorId: string;
  isRetry: boolean;
}) {
  const { c, candidate, charge, actorId, isRetry } = params;
  const db = createDb(c.env.DATABASE_URL);
  const [locationRow] = await db
    .select({
      ghlLocationId: locations.ghlLocationId,
      companyId: agencies.ghlAgencyId,
      meterId: locationBillingConfig.ghlMeterId,
      enabled: locationBillingConfig.enabled,
      configCurrency: locationBillingConfig.currency
    })
    .from(locations)
    .innerJoin(agencies, eq(locations.agencyId, agencies.id))
    .innerJoin(locationBillingConfig, eq(locationBillingConfig.locationId, locations.id))
    .where(eq(locations.id, candidate.locationId))
    .limit(1);

  if (!locationRow?.enabled) {
    throw new Error("location_client_charges_disabled");
  }
  const currency = candidate.deposit.currency.toUpperCase();
  if (currency !== locationRow.configCurrency.trim().toUpperCase()) {
    throw new Error(
      `currency_mismatch: deposit=${currency}, location_config=${locationRow.configCurrency.trim().toUpperCase()}`
    );
  }

  const attemptNumber = charge.attemptCount;
  await db.insert(clientResultChargeEvents).values({
    chargeId: charge.id,
    eventType: "request_sent",
    attemptNumber,
    actorWorkspaceUserId: actorId,
    payload: {
      eventId: charge.idempotencyKey,
      amount: charge.chargeAmount,
      currency: charge.chargeCurrency,
      retry: isRetry
    }
  });

  const result = await createGhlSubaccountWalletCharge(c.env, db, {
    locationId: locationRow.ghlLocationId,
    companyId: locationRow.companyId,
    meterId: locationRow.meterId,
    eventId: charge.idempotencyKey,
    description: `Result billing for appointment ${candidate.ghlAppointmentId}`,
    amount: charge.chargeAmount,
    currency: charge.chargeCurrency,
    eventTime: new Date(candidate.deposit.paidAt ?? candidate.appointmentBookedAt)
  });

  const now = new Date();
  if (result.ok) {
    const [updated] = await db
      .update(clientResultCharges)
      .set({
        status: "succeeded",
        requestSnapshot: result.request,
        responseSnapshot: result.response,
        ghlReferenceId: result.externalReferenceId ?? charge.idempotencyKey,
        ghlTransactionId: result.transactionId,
        lastError: null,
        succeededAt: now,
        failedAt: null,
        updatedAt: now
      })
      .where(eq(clientResultCharges.id, charge.id))
      .returning();

    await db.insert(clientResultChargeEvents).values({
      chargeId: charge.id,
      eventType: "succeeded",
      attemptNumber,
      actorWorkspaceUserId: actorId,
      payload: { status: result.status, response: result.response }
    });
    await insertWorkspaceAuditLog(db, {
      actorWorkspaceUserId: actorId,
      actionKind: AUDIT_ACTION_KINDS.CLIENT_CHARGE_SUCCEEDED,
      entityType: "client_result_charge",
      entityId: charge.id,
      locationId: candidate.locationId,
      summary: `Charged ${charge.chargeAmount} ${charge.chargeCurrency} for paid appointment`,
      details: {
        appointmentId: candidate.appointmentId,
        canonicalDeposit: candidate.deposit,
        ghlReferenceId: result.externalReferenceId,
        ghlTransactionId: result.transactionId
      }
    });
    return { status: 200 as const, body: { ok: true as const, charge: chargePublicRow(updated!) } };
  }

  const nextStatus = result.ambiguous ? "pending" : "failed";
  const errorMessage = result.ambiguous
    ? `Ambiguous GHL outcome — do not retry until reconciled: ${result.error}`
    : result.error;
  const [updated] = await db
    .update(clientResultCharges)
    .set({
      status: nextStatus,
      requestSnapshot: result.request,
      responseSnapshot: result.response,
      lastError: errorMessage,
      failedAt: result.ambiguous ? null : now,
      updatedAt: now
    })
    .where(eq(clientResultCharges.id, charge.id))
    .returning();
  await db.insert(clientResultChargeEvents).values({
    chargeId: charge.id,
    eventType: "failed",
    attemptNumber,
    actorWorkspaceUserId: actorId,
    payload: {
      ambiguous: result.ambiguous,
      status: result.status,
      error: result.error,
      response: result.response
    }
  });
  await insertWorkspaceAuditLog(db, {
    actorWorkspaceUserId: actorId,
    actionKind: AUDIT_ACTION_KINDS.CLIENT_CHARGE_FAILED,
    entityType: "client_result_charge",
    entityId: charge.id,
    locationId: candidate.locationId,
    summary: `${result.ambiguous ? "Ambiguous" : "Failed"} client charge (${charge.chargeAmount} ${charge.chargeCurrency})`,
    details: {
      appointmentId: candidate.appointmentId,
      ambiguous: result.ambiguous,
      error: result.error,
      status: result.status
    }
  });

  return {
    status: result.ambiguous ? (202 as const) : (422 as const),
    body: {
      ok: false as const,
      ambiguous: result.ambiguous,
      error: result.ambiguous ? "charge_outcome_ambiguous" : "charge_failed",
      message: errorMessage,
      charge: chargePublicRow(updated!)
    }
  };
}

async function chargeOrRetryHandler(c: Context<Bindings>, isRetry: boolean) {
  const me = await resolveSessionUser(c, c.env);
  if (!me) return c.json({ error: "unauthorized" }, 401);
  if (me.role !== "admin") return c.json({ error: "admin_required" }, 403);
  const policy = await resolveAccessPolicy(c, c.env);
  if (!policy) return c.json({ error: "unauthorized" }, 401);

  const appointmentId = (c.req.param("appointmentId") ?? "").trim();
  if (!isUuid(appointmentId)) return c.json({ error: "invalid_appointment_id" }, 400);
  const db = createDb(c.env.DATABASE_URL);
  const candidate = await getClientChargeCandidateByAppointment(db, {
    appointmentId,
    allowedLocationIds: await jwtWorkspaceAllowedLocationUuidList(db, policy),
    hiddenLocationIds:
      policy.kind === "legacy" ? await getHiddenLocationIdsForPolicy(db, policy) : []
  });
  if (!candidate) return c.json({ error: "billable_result_not_found" }, 404);

  if (isRetry) {
    if (!candidate.charge) return c.json({ error: "charge_not_created" }, 404);
    if (!isChargeRetryable(candidate.charge.status)) {
      return c.json(
        {
          error: "charge_not_retryable",
          message: "Only definitive failed charges can be retried; pending may already have charged the wallet."
        },
        409
      );
    }
    const [claimed] = await db
      .update(clientResultCharges)
      .set({
        status: "pending",
        attemptCount: sql`${clientResultCharges.attemptCount} + 1`,
        lastError: null,
        updatedAt: new Date()
      })
      .where(and(eq(clientResultCharges.id, candidate.charge.id), eq(clientResultCharges.status, "failed")))
      .returning();
    if (!claimed) return c.json({ error: "charge_claim_conflict" }, 409);
    await db.insert(clientResultChargeEvents).values({
      chargeId: claimed.id,
      eventType: "claimed",
      attemptNumber: claimed.attemptCount,
      actorWorkspaceUserId: me.id,
      payload: { retry: true }
    });
    await insertWorkspaceAuditLog(db, {
      actorWorkspaceUserId: me.id,
      actionKind: AUDIT_ACTION_KINDS.CLIENT_CHARGE_RETRIED,
      entityType: "client_result_charge",
      entityId: claimed.id,
      locationId: candidate.locationId,
      summary: `Retried client charge for appointment ${candidate.ghlAppointmentId}`,
      details: { appointmentId, attemptNumber: claimed.attemptCount }
    });
    const result = await writeChargeOutcome({ c, candidate, charge: claimed, actorId: me.id, isRetry: true });
    return c.json(result.body, result.status);
  }

  if (candidate.charge) {
    return c.json(
      {
        ok: candidate.charge.status === "succeeded",
        idempotent: true,
        charge: candidate.charge,
        message:
          candidate.charge.status === "pending"
            ? "A charge is already pending; it may already have reached GHL."
            : "This appointment already has a client charge ledger entry."
      },
      candidate.charge.status === "succeeded" ? 200 : 409
    );
  }

  const now = new Date();
  const amount = normalizeChargeAmount(candidate.deposit.amount);
  if (amount == null) {
    return c.json({ error: "invalid_deposit_amount", message: "Canonical deposit amount must be positive." }, 400);
  }
  const idempotencyKey = clientChargeIdempotencyKey(candidate.appointmentId);
  const [claimed] = await db
    .insert(clientResultCharges)
    .values({
      locationId: candidate.locationId,
      appointmentId: candidate.appointmentId,
      depositSourceKind: candidate.deposit.kind,
      paymentOrderId: candidate.deposit.kind === "payment_order" ? candidate.deposit.id : null,
      invoiceId: candidate.deposit.kind === "invoice" ? candidate.deposit.id : null,
      depositAmount: amount,
      depositCurrency: candidate.deposit.currency,
      chargeAmount: amount,
      chargeCurrency: candidate.deposit.currency,
      status: "pending",
      idempotencyKey,
      requestSnapshot: {
        candidate: candidate.deposit,
        appointmentId: candidate.appointmentId,
        ghlAppointmentId: candidate.ghlAppointmentId
      },
      responseSnapshot: {},
      attemptCount: 1,
      createdByWorkspaceUserId: me.id,
      createdAt: now,
      updatedAt: now
    })
    .onConflictDoNothing()
    .returning();

  if (!claimed) {
    const [existing] = await db
      .select()
      .from(clientResultCharges)
      .where(eq(clientResultCharges.appointmentId, candidate.appointmentId))
      .limit(1);
    return c.json(
      {
        error: "charge_claim_conflict",
        message: "Another request already claimed this appointment.",
        charge: existing ? chargePublicRow(existing) : null
      },
      409
    );
  }

  await db.insert(clientResultChargeEvents).values({
    chargeId: claimed.id,
    eventType: "claimed",
    attemptNumber: 1,
    actorWorkspaceUserId: me.id,
    payload: { canonicalDeposit: candidate.deposit }
  });
  await insertWorkspaceAuditLog(db, {
    actorWorkspaceUserId: me.id,
    actionKind: AUDIT_ACTION_KINDS.CLIENT_CHARGE_REQUESTED,
    entityType: "client_result_charge",
    entityId: claimed.id,
    locationId: candidate.locationId,
    summary: `Requested ${claimed.chargeAmount} ${claimed.chargeCurrency} client charge`,
    details: { appointmentId, canonicalDeposit: candidate.deposit }
  });

  const result = await writeChargeOutcome({ c, candidate, charge: claimed, actorId: me.id, isRetry: false });
  return c.json(result.body, result.status);
}

export async function postWorkspaceClientChargeHandler(c: Context<Bindings>) {
  try {
    return await chargeOrRetryHandler(c, false);
  } catch (error) {
    console.error("[client_charges.charge]", error);
    return c.json({ error: "client_charge_failed", message: deepError(error) }, 500);
  }
}

export async function postWorkspaceClientChargeRetryHandler(c: Context<Bindings>) {
  try {
    return await chargeOrRetryHandler(c, true);
  } catch (error) {
    console.error("[client_charges.retry]", error);
    return c.json({ error: "client_charge_retry_failed", message: deepError(error) }, 500);
  }
}

export async function getAdminClientChargeLocationsHandler(c: Context<Bindings>) {
  const me = await resolveSessionUser(c, c.env);
  if (!me || me.role !== "admin") return c.json({ error: "forbidden" }, 403);
  const policy = await resolveAccessPolicy(c, c.env);
  if (!policy) return c.json({ error: "unauthorized" }, 401);
  const db = createDb(c.env.DATABASE_URL);
  const allowed = await jwtWorkspaceAllowedLocationUuidList(db, policy);
  const filters = allowed === null ? undefined : allowed.length ? inArray(locations.id, allowed) : sql`false`;
  const rows = await db
    .select({
      locationId: locations.id,
      ghlLocationId: locations.ghlLocationId,
      locationName: locations.name,
      enabled: locationBillingConfig.enabled,
      currency: locationBillingConfig.currency,
      meterId: locationBillingConfig.ghlMeterId,
      updatedAt: locationBillingConfig.updatedAt
    })
    .from(locations)
    .leftJoin(locationBillingConfig, eq(locationBillingConfig.locationId, locations.id))
    .where(filters)
    .orderBy(asc(locations.name), asc(locations.ghlLocationId));
  return c.json({
    locations: rows.map((row) => ({
      ...row,
      enabled: row.enabled ?? false,
      currency: row.currency ?? "USD",
      meterId: row.meterId ?? null,
      updatedAt: row.updatedAt?.toISOString() ?? null
    }))
  });
}

export async function patchAdminClientChargeLocationHandler(c: Context<Bindings>) {
  try {
    const me = await resolveSessionUser(c, c.env);
    if (!me || me.role !== "admin") return c.json({ error: "forbidden" }, 403);
    const policy = await resolveAccessPolicy(c, c.env);
    if (!policy) return c.json({ error: "unauthorized" }, 401);
    const locationId = (c.req.param("locationId") ?? "").trim();
    if (!isUuid(locationId)) return c.json({ error: "invalid_location_id" }, 400);
    const db = createDb(c.env.DATABASE_URL);
    if (!(await canWorkspaceAccessLocationUuid(db, policy, locationId))) {
      return c.json({ error: "forbidden_location" }, 403);
    }
    const body = asRecord(await c.req.json().catch(() => ({})));
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: "invalid_body", message: "enabled boolean is required" }, 400);
    }
    const currency =
      typeof body.currency === "string" && /^[A-Za-z]{3}$/.test(body.currency.trim())
        ? body.currency.trim().toUpperCase()
        : "USD";
    const meterId =
      typeof body.meterId === "string" && body.meterId.trim() ? body.meterId.trim() : null;
    const now = new Date();
    const [row] = await db
      .insert(locationBillingConfig)
      .values({
        locationId,
        enabled: body.enabled,
        currency,
        ghlMeterId: meterId,
        updatedByWorkspaceUserId: me.id,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: locationBillingConfig.locationId,
        set: {
          enabled: body.enabled,
          currency,
          ghlMeterId: meterId,
          updatedByWorkspaceUserId: me.id,
          updatedAt: now
        }
      })
      .returning();
    await insertWorkspaceAuditLog(db, {
      actorWorkspaceUserId: me.id,
      actionKind: AUDIT_ACTION_KINDS.CLIENT_CHARGES_CONFIG_UPDATED,
      entityType: "location_billing_config",
      locationId,
      summary: `${body.enabled ? "Enabled" : "Disabled"} Client Charges for subaccount`,
      details: { enabled: body.enabled, currency, meterId }
    });
    return c.json({
      config: {
        locationId: row!.locationId,
        enabled: row!.enabled,
        currency: row!.currency,
        meterId: row!.ghlMeterId,
        updatedAt: row!.updatedAt.toISOString()
      }
    });
  } catch (error) {
    console.error("[client_charges.config_patch]", error);
    return c.json({ error: "client_charges_config_failed", message: deepError(error) }, 500);
  }
}
