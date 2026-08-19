import {
  clientResultChargeEvents,
  clientResultCharges,
  createDb,
  locationBillingConfig,
  locations
} from "@agentflow/db";
import { AUDIT_ACTION_KINDS, canAccessClientCharges } from "@agentflow/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { Context } from "hono";

import { createStripeClientCharge, type ClientChargeStripeEnv } from "./client-charges-stripe.js";
import {
  chargeActorDisplayName,
  clientChargeIdempotencyKey,
  isChargeRetryable,
  isClientChargesChargingEnabled,
  normalizeChargeAmount
} from "./client-charges-logic.js";
import {
  getClientChargeCandidateByAppointment,
  listClientChargeCandidates,
  listClientChargeOverview,
  type ClientChargeCandidate
} from "./client-charges-sql.js";
import { resolveDashboardBounds } from "./dashboard-handlers.js";
import {
  isLocationBillingReady,
  maskStripeAccountId,
  maskStripeCustomerId
} from "./location-billing-stripe.js";
import {
  canWorkspaceAccessLocationUuid,
  getHiddenLocationIdsForPolicy,
  jwtWorkspaceAllowedLocationUuidList,
  resolveAccessPolicy,
  resolveSessionUser,
  type WorkspaceJwtEnv
} from "./workspace-access.js";
import { insertWorkspaceAuditLog } from "./workspace-audit.js";

export type ClientChargesEnv = WorkspaceJwtEnv & ClientChargeStripeEnv;
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

async function requireClientChargesAccess(c: Context<Bindings>) {
  const me = await resolveSessionUser(c, c.env);
  if (!me) return c.json({ error: "unauthorized" }, 401);
  if (!canAccessClientCharges(me.email)) return c.json({ error: "forbidden" }, 403);
  return me;
}

function parseClientChargeOverviewSort(
  raw: string | undefined
): "subaccount" | "unbilled" | "charged" | "eligible" {
  const v = (raw ?? "").trim().toLowerCase();
  if (v === "subaccount") return "subaccount";
  if (v === "charged") return "charged";
  if (v === "eligible") return "eligible";
  return "unbilled";
}

function parseClientChargeStatus(raw: string | undefined) {
  const statusRaw = (raw ?? "all").trim().toLowerCase();
  return statusRaw === "unbilled" ||
    statusRaw === "pending" ||
    statusRaw === "succeeded" ||
    statusRaw === "failed"
    ? statusRaw
    : "all";
}

export async function getWorkspaceClientChargesOverviewHandler(c: Context<Bindings>) {
  try {
    const access = await requireClientChargesAccess(c);
    if (access instanceof Response) return access;
    const scoped = await policyLocationScope(c);
    if (!scoped) return c.json({ error: "unauthorized" }, 401);
    const bounds = resolveDashboardBounds(c.req.query("from"), c.req.query("to"));
    if ("error" in bounds) return c.json({ error: bounds.error }, 400);

    const pageRaw = Number.parseInt(c.req.query("page") ?? "1", 10);
    const limitRaw = Number.parseInt(c.req.query("limit") ?? "50", 10);
    const sortColumn = parseClientChargeOverviewSort(c.req.query("sort"));
    const sortDirection = c.req.query("order")?.trim().toLowerCase() === "asc" ? "asc" : "desc";

    const result = await listClientChargeOverview(scoped.db, {
      from: bounds.from,
      toExclusive: bounds.toExclusive,
      allowedLocationIds: scoped.allowedLocationIds,
      hiddenLocationIds: scoped.hiddenLocationIds,
      query: c.req.query("q") ?? "",
      page: Number.isFinite(pageRaw) ? pageRaw : 1,
      pageSize: Number.isFinite(limitRaw) ? limitRaw : 50,
      sortColumn,
      sortDirection
    });

    const overviewLocationIds = result.subaccounts.map((row) => row.locationId);
    if (overviewLocationIds.length > 0) {
      const billingRows = await scoped.db
        .select({
          locationId: locationBillingConfig.locationId,
          stripeAccountId: locationBillingConfig.stripeAccountId,
          stripeCustomerId: locationBillingConfig.stripeCustomerId,
          stripeDefaultPaymentMethodId: locationBillingConfig.stripeDefaultPaymentMethodId,
          connectChargesEnabled: locationBillingConfig.connectChargesEnabled
        })
        .from(locationBillingConfig)
        .where(inArray(locationBillingConfig.locationId, overviewLocationIds));
      const billingByLocation = new Map(billingRows.map((row) => [row.locationId, row]));
      result.subaccounts = result.subaccounts.map((row) => {
        const billing = billingByLocation.get(row.locationId);
        const hasStripeCustomer = Boolean(billing?.stripeCustomerId?.trim());
        const stripeBillingReady = billing
          ? isLocationBillingReady({
              stripeAccountId: billing.stripeAccountId,
              stripeCustomerId: billing.stripeCustomerId,
              stripeDefaultPaymentMethodId: billing.stripeDefaultPaymentMethodId,
              connectChargesEnabled: billing.connectChargesEnabled ?? false
            })
          : false;
        return { ...row, hasStripeCustomer, stripeBillingReady };
      });
    }

    c.header("Cache-Control", "private, no-store, max-age=0");
    return c.json({
      fromInclusive: bounds.from.toISOString(),
      toExclusive: bounds.toExclusive.toISOString(),
      ...result
    });
  } catch (error) {
    console.error("[client_charges.overview]", error);
    return c.json({ error: "client_charges_overview_failed", message: deepError(error) }, 500);
  }
}

export async function getWorkspaceClientChargesHandler(c: Context<Bindings>) {
  try {
    const access = await requireClientChargesAccess(c);
    if (access instanceof Response) return access;
    const scoped = await policyLocationScope(c);
    if (!scoped) return c.json({ error: "unauthorized" }, 401);
    const bounds = resolveDashboardBounds(c.req.query("from"), c.req.query("to"));
    if ("error" in bounds) return c.json({ error: bounds.error }, 400);

    const pageRaw = Number.parseInt(c.req.query("page") ?? "1", 10);
    const limitRaw = Number.parseInt(c.req.query("limit") ?? "50", 10);
    const status = parseClientChargeStatus(c.req.query("status"));
    const locationIdRaw = (c.req.query("locationId") ?? "").trim();
    const locationId = locationIdRaw ? locationIdRaw : undefined;
    if (locationId && !isUuid(locationId)) {
      return c.json({ error: "invalid_location_id" }, 400);
    }

    const result = await listClientChargeCandidates(scoped.db, {
      from: bounds.from,
      toExclusive: bounds.toExclusive,
      allowedLocationIds: scoped.allowedLocationIds,
      hiddenLocationIds: scoped.hiddenLocationIds,
      locationId,
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

function chargePublicRow(
  row: typeof clientResultCharges.$inferSelect,
  chargedByOverride?: string | null
) {
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
    stripePaymentIntentId: row.stripePaymentIntentId,
    stripeChargeId: row.stripeChargeId,
    ghlReferenceId: row.ghlReferenceId,
    ghlTransactionId: row.ghlTransactionId,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    succeededAt: row.succeededAt?.toISOString() ?? null,
    failedAt: row.failedAt?.toISOString() ?? null,
    chargedBy: chargedByOverride ?? null
  };
}

async function writeChargeOutcome(params: {
  c: Context<Bindings>;
  candidate: ClientChargeCandidate;
  charge: typeof clientResultCharges.$inferSelect;
  actorId: string;
  actorChargedBy: string | null;
  isRetry: boolean;
}) {
  const { c, candidate, charge, actorId, actorChargedBy, isRetry } = params;
  const db = createDb(c.env.DATABASE_URL);
  const [locationRow] = await db
    .select({
      ghlLocationId: locations.ghlLocationId,
      enabled: locationBillingConfig.enabled,
      configCurrency: locationBillingConfig.currency,
      stripeAccountId: locationBillingConfig.stripeAccountId,
      stripeCustomerId: locationBillingConfig.stripeCustomerId,
      stripeDefaultPaymentMethodId: locationBillingConfig.stripeDefaultPaymentMethodId,
      connectChargesEnabled: locationBillingConfig.connectChargesEnabled
    })
    .from(locations)
    .innerJoin(locationBillingConfig, eq(locationBillingConfig.locationId, locations.id))
    .where(eq(locations.id, candidate.locationId))
    .limit(1);

  if (!locationRow?.enabled) {
    throw new Error("location_client_charges_disabled");
  }
  if (
    !isLocationBillingReady({
      stripeAccountId: locationRow.stripeAccountId,
      stripeCustomerId: locationRow.stripeCustomerId,
      stripeDefaultPaymentMethodId: locationRow.stripeDefaultPaymentMethodId,
      connectChargesEnabled: locationRow.connectChargesEnabled
    })
  ) {
    throw new Error("billing_not_ready");
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
      idempotencyKey: charge.idempotencyKey,
      amount: charge.chargeAmount,
      currency: charge.chargeCurrency,
      retry: isRetry,
      provider: "stripe"
    }
  });

  const result = await createStripeClientCharge(c.env, {
    connectedAccountId: locationRow.stripeAccountId,
    customerId: locationRow.stripeCustomerId!.trim(),
    paymentMethodId: locationRow.stripeDefaultPaymentMethodId!.trim(),
    amountMajor: charge.chargeAmount,
    currency: charge.chargeCurrency,
    idempotencyKey: charge.idempotencyKey,
    description: `Result billing for appointment ${candidate.ghlAppointmentId}`,
    metadata: {
      appointmentId: candidate.appointmentId,
      locationId: candidate.locationId,
      ghlAppointmentId: candidate.ghlAppointmentId,
      ghlLocationId: locationRow.ghlLocationId
    }
  });

  const now = new Date();
  if (result.ok) {
    const [updated] = await db
      .update(clientResultCharges)
      .set({
        status: "succeeded",
        requestSnapshot: result.request,
        responseSnapshot: result.response,
        stripePaymentIntentId: result.paymentIntentId,
        stripeChargeId: result.chargeId,
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
      payload: { status: result.status, response: result.response, provider: "stripe" }
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
        stripePaymentIntentId: result.paymentIntentId,
        stripeChargeId: result.chargeId
      }
    });
    return { status: 200 as const, body: { ok: true as const, charge: chargePublicRow(updated!, actorChargedBy) } };
  }

  const nextStatus = result.ambiguous ? "pending" : "failed";
  const errorMessage = result.ambiguous
    ? `Ambiguous Stripe outcome — do not retry until reconciled: ${result.error}`
    : result.error;
  const [updated] = await db
    .update(clientResultCharges)
    .set({
      status: nextStatus,
      requestSnapshot: result.request,
      responseSnapshot: result.response,
      stripePaymentIntentId:
        typeof result.response.id === "string" ? result.response.id : charge.stripePaymentIntentId,
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
      response: result.response,
      provider: "stripe"
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
      charge: chargePublicRow(updated!, actorChargedBy)
    }
  };
}

async function chargeOrRetryHandler(c: Context<Bindings>, isRetry: boolean) {
  const me = await resolveSessionUser(c, c.env);
  if (!me) return c.json({ error: "unauthorized" }, 401);
  if (!canAccessClientCharges(me.email)) return c.json({ error: "forbidden" }, 403);
  if (me.role !== "admin") return c.json({ error: "admin_required" }, 403);
  if (!isClientChargesChargingEnabled(c.env)) {
    return c.json(
      {
        error: "charging_disabled",
        message:
          "Stripe client charges are disabled on the API. GHL sync and billing setup still work. Set CLIENT_CHARGES_CHARGING_ENABLED=true on the Worker to allow charges."
      },
      503
    );
  }
  const policy = await resolveAccessPolicy(c, c.env);
  if (!policy) return c.json({ error: "unauthorized" }, 401);

  const actorChargedBy = chargeActorDisplayName(me.displayName, me.email);

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
          message: "Only definitive failed charges can be retried; pending may already have reached Stripe."
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
    const result = await writeChargeOutcome({
      c,
      candidate,
      charge: claimed,
      actorId: me.id,
      actorChargedBy,
      isRetry: true
    });
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
            ? "A charge is already pending; it may already have reached Stripe."
            : "This appointment already has a client charge ledger entry."
      },
      candidate.charge.status === "succeeded" ? 200 : 409
    );
  }

  const now = new Date();
  const chargeAmount = normalizeChargeAmount(candidate.deposit.amount);
  if (chargeAmount == null) {
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
      depositAmount: chargeAmount,
      depositCurrency: candidate.deposit.currency,
      chargeAmount,
      chargeCurrency: candidate.deposit.currency,
      status: "pending",
      idempotencyKey,
      requestSnapshot: {
        canonicalDeposit: candidate.deposit,
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

  const result = await writeChargeOutcome({
    c,
    candidate,
    charge: claimed,
    actorId: me.id,
    actorChargedBy,
    isRetry: false
  });
  return c.json(result.body, result.status);
}

export async function postWorkspaceClientChargeHandler(c: Context<Bindings>) {
  try {
    return await chargeOrRetryHandler(c, false);
  } catch (error) {
    console.error("[client_charges.charge]", error);
    const message = deepError(error);
    if (message.includes("billing_not_ready")) {
      return c.json(
        {
          error: "billing_not_ready",
          message: "Stripe Connect and a saved payment method are required for this subaccount."
        },
        402
      );
    }
    return c.json({ error: "client_charge_failed", message }, 500);
  }
}

export async function postWorkspaceClientChargeRetryHandler(c: Context<Bindings>) {
  try {
    return await chargeOrRetryHandler(c, true);
  } catch (error) {
    console.error("[client_charges.retry]", error);
    const message = deepError(error);
    if (message.includes("billing_not_ready")) {
      return c.json(
        {
          error: "billing_not_ready",
          message: "Stripe Connect and a saved payment method are required for this subaccount."
        },
        402
      );
    }
    return c.json({ error: "client_charge_retry_failed", message }, 500);
  }
}

export async function getAdminClientChargeLocationsHandler(c: Context<Bindings>) {
  const me = await resolveSessionUser(c, c.env);
  if (!me) return c.json({ error: "unauthorized" }, 401);
  if (!canAccessClientCharges(me.email)) return c.json({ error: "forbidden" }, 403);
  if (me.role !== "admin") return c.json({ error: "forbidden" }, 403);
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
      stripeAccountId: locationBillingConfig.stripeAccountId,
      stripeCustomerId: locationBillingConfig.stripeCustomerId,
      stripeCustomerName: locationBillingConfig.stripeCustomerName,
      stripeCustomerEmail: locationBillingConfig.stripeCustomerEmail,
      stripeDefaultPaymentMethodId: locationBillingConfig.stripeDefaultPaymentMethodId,
      connectChargesEnabled: locationBillingConfig.connectChargesEnabled,
      connectPayoutsEnabled: locationBillingConfig.connectPayoutsEnabled,
      connectOnboardingStatus: locationBillingConfig.connectOnboardingStatus,
      connectDetailsSubmitted: locationBillingConfig.connectDetailsSubmitted,
      billingReadyAt: locationBillingConfig.billingReadyAt,
      updatedAt: locationBillingConfig.updatedAt
    })
    .from(locations)
    .leftJoin(locationBillingConfig, eq(locationBillingConfig.locationId, locations.id))
    .where(filters)
    .orderBy(asc(locations.name), asc(locations.ghlLocationId));
  return c.json({
    locations: rows.map((row) => {
      const billingReady = isLocationBillingReady({
        stripeAccountId: row.stripeAccountId,
        stripeCustomerId: row.stripeCustomerId,
        stripeDefaultPaymentMethodId: row.stripeDefaultPaymentMethodId,
        connectChargesEnabled: row.connectChargesEnabled ?? false
      });
      return {
        locationId: row.locationId,
        ghlLocationId: row.ghlLocationId,
        locationName: row.locationName,
        enabled: row.enabled ?? false,
        currency: row.currency ?? "USD",
        billingReady,
        stripeAccountMasked: maskStripeAccountId(row.stripeAccountId),
        stripeCustomerMasked: maskStripeCustomerId(row.stripeCustomerId),
        stripeCustomerName: row.stripeCustomerName?.trim() || null,
        stripeCustomerEmail: row.stripeCustomerEmail?.trim() || null,
        hasStripeCustomer: Boolean(row.stripeCustomerId?.trim()),
        stripeAccountId: row.stripeAccountId ?? null,
        connectOnboardingStatus: row.connectOnboardingStatus ?? null,
        connectDetailsSubmitted: row.connectDetailsSubmitted ?? false,
        connectChargesEnabled: row.connectChargesEnabled ?? false,
        connectPayoutsEnabled: row.connectPayoutsEnabled ?? false,
        hasPaymentMethod: Boolean(row.stripeDefaultPaymentMethodId?.trim()),
        billingReadyAt: row.billingReadyAt?.toISOString() ?? null,
        updatedAt: row.updatedAt?.toISOString() ?? null
      };
    })
  });
}

export async function patchAdminClientChargeLocationHandler(c: Context<Bindings>) {
  try {
    const me = await resolveSessionUser(c, c.env);
    if (!me) return c.json({ error: "unauthorized" }, 401);
    if (!canAccessClientCharges(me.email)) return c.json({ error: "forbidden" }, 403);
    if (me.role !== "admin") return c.json({ error: "forbidden" }, 403);
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

    if (body.enabled) {
      const [check] = await db
        .select({
          stripeAccountId: locationBillingConfig.stripeAccountId,
          stripeCustomerId: locationBillingConfig.stripeCustomerId,
          stripeDefaultPaymentMethodId: locationBillingConfig.stripeDefaultPaymentMethodId,
          connectChargesEnabled: locationBillingConfig.connectChargesEnabled
        })
        .from(locationBillingConfig)
        .where(eq(locationBillingConfig.locationId, locationId))
        .limit(1);
      if (
        !check ||
        !isLocationBillingReady({
          stripeAccountId: check.stripeAccountId,
          stripeCustomerId: check.stripeCustomerId,
          stripeDefaultPaymentMethodId: check.stripeDefaultPaymentMethodId,
          connectChargesEnabled: check.connectChargesEnabled ?? false
        })
      ) {
        return c.json(
          {
            error: "billing_not_ready",
            message: "Link Stripe Connect, add a payment method, and verify charges are enabled before enabling."
          },
          400
        );
      }
    }

    const now = new Date();
    const [row] = await db
      .insert(locationBillingConfig)
      .values({
        locationId,
        enabled: body.enabled,
        currency,
        updatedByWorkspaceUserId: me.id,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: locationBillingConfig.locationId,
        set: {
          enabled: body.enabled,
          currency,
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
      details: { enabled: body.enabled, currency, provider: "stripe" }
    });
    return c.json({
      config: {
        locationId: row!.locationId,
        enabled: row!.enabled,
        currency: row!.currency,
        updatedAt: row!.updatedAt.toISOString()
      }
    });
  } catch (error) {
    console.error("[client_charges.config_patch]", error);
    return c.json({ error: "client_charges_config_failed", message: deepError(error) }, 500);
  }
}
