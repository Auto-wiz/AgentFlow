import { createDb, locationBillingConfig, locations, agencies } from "@agentflow/db";
import { canAccessClientCharges } from "@agentflow/shared";
import { and, asc, eq, inArray, ne, sql } from "drizzle-orm";
import type { Context } from "hono";

import {
  isClientChargesChargingEnabled,
  normalizeStripeConnectAccountId,
  normalizeStripeCustomerId
} from "./client-charges-logic.js";
import { createStripeClient } from "./client-charges-stripe.js";
import { syncLocationStripeFromGhlSaas } from "./client-charges-ghl-stripe-sync.js";
import { syncGhlSaasCatalogPage } from "./ghl-saas-catalog-sync.js";
import { syncStripeActiveSubscriptionsPage } from "./stripe-subscriptions-catalog-sync.js";
import { refreshStripeCustomerProfilesPage } from "./stripe-customer-profile-sync.js";
import { GHL_SAAS_FETCH_BULK_OPTS } from "./ghl-saas-subscription.js";
import {
  applyStripeAccountSnapshot,
  ensureLocationBillingConfigRow,
  isLocationBillingReady,
  maskStripeAccountId,
  maskStripeCustomerId,
  type LocationBillingStripeRow
} from "./location-billing-stripe.js";
import { applyPlatformStripeCustomerToLocation } from "./stripe-platform-customer.js";
import {
  canWorkspaceAccessLocationUuid,
  jwtWorkspaceAllowedLocationUuidList,
  resolveAccessPolicy,
  resolveSessionUser,
  type WorkspaceJwtEnv
} from "./workspace-access.js";
import type { GhlOAuthTokenEnv } from "./ghl-oauth-location-token.js";

export type StripeConnectEnv = WorkspaceJwtEnv &
  GhlOAuthTokenEnv & {
  STRIPE_SECRET_KEY?: string;
  FRONTEND_BASE_URL?: string;
  GHL_CLIENT_ID?: string;
  GHL_CLIENT_SECRET?: string;
  CLIENT_CHARGES_CHARGING_ENABLED?: string;
};

type Bindings = { Bindings: StripeConnectEnv };

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value.trim()
  );
}

async function assertAdminClientCharges(c: Context<Bindings>) {
  const me = await resolveSessionUser(c, c.env);
  if (!me) return null;
  if (!canAccessClientCharges(me.email) || me.role !== "admin") return null;
  const policy = await resolveAccessPolicy(c, c.env);
  if (!policy) return null;
  return { me, policy };
}

function billingCheckoutUrls(env: StripeConnectEnv, locationId: string) {
  const base = (env.FRONTEND_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
  return {
    billingSuccess: `${base}/dashboard/client-charges?stripe=billing_ok&locationId=${encodeURIComponent(locationId)}`,
    billingCancel: `${base}/dashboard/client-charges?stripe=billing_cancel&locationId=${encodeURIComponent(locationId)}`
  };
}

function serializeBillingRow(row: LocationBillingStripeRow | null | undefined, locationId: string) {
  const billingReady = row ? isLocationBillingReady(row) : false;
  return {
    locationId,
    billingReady,
    stripeAccountMasked: maskStripeAccountId(row?.stripeAccountId ?? null),
    stripeAccountId: row?.stripeAccountId ?? null,
    stripeCustomerMasked: maskStripeCustomerId(row?.stripeCustomerId ?? null),
    stripeCustomerName: row?.stripeCustomerName?.trim() || null,
    stripeCustomerEmail: row?.stripeCustomerEmail?.trim() || null,
    connectOnboardingStatus: row?.connectOnboardingStatus ?? null,
    connectDetailsSubmitted: row?.connectDetailsSubmitted ?? false,
    connectChargesEnabled: row?.connectChargesEnabled ?? false,
    connectPayoutsEnabled: row?.connectPayoutsEnabled ?? false,
    hasPaymentMethod: Boolean(row?.stripeDefaultPaymentMethodId?.trim()),
    hasStripeCustomer: Boolean(row?.stripeCustomerId?.trim()),
    billingReadyAt: row?.billingReadyAt?.toISOString() ?? null
  };
}

async function loadBillingStripeRow(db: ReturnType<typeof createDb>, locationId: string) {
  const [row] = await db
    .select({
      locationId: locationBillingConfig.locationId,
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
      billingReadyAt: locationBillingConfig.billingReadyAt
    })
    .from(locationBillingConfig)
    .where(eq(locationBillingConfig.locationId, locationId))
    .limit(1);
  return row ?? null;
}

export async function getAdminStripePlatformStatusHandler(c: Context<Bindings>) {
  const auth = await assertAdminClientCharges(c);
  if (!auth) return c.json({ error: "forbidden" }, 403);

  const stripe = createStripeClient(c.env);
  if (!stripe) {
    return c.json({ configured: false, platformAccountMasked: null });
  }

  try {
    await stripe.balance.retrieve();
    return c.json({
      configured: true,
      platformAccountMasked: null,
      chargesEnabled: null,
      clientChargesChargingEnabled: isClientChargesChargingEnabled(c.env)
    });
  } catch {
    return c.json({
      configured: false,
      platformAccountMasked: null,
      chargesEnabled: null,
      clientChargesChargingEnabled: isClientChargesChargingEnabled(c.env)
    });
  }
}

export async function patchAdminLocationStripeLinkHandler(c: Context<Bindings>) {
  const auth = await assertAdminClientCharges(c);
  if (!auth) return c.json({ error: "forbidden" }, 403);
  const locationId = (c.req.param("locationId") ?? "").trim();
  if (!isUuid(locationId)) return c.json({ error: "invalid_location_id" }, 400);

  let body: { stripeAccountId?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const stripeAccountId = normalizeStripeConnectAccountId(body.stripeAccountId);
  if (!stripeAccountId) {
    return c.json(
      { error: "invalid_stripe_account_id", message: "Use a Stripe Connect account id (acct_…)." },
      400
    );
  }

  const db = createDb(c.env.DATABASE_URL);
  if (!(await canWorkspaceAccessLocationUuid(db, auth.policy, locationId))) {
    return c.json({ error: "forbidden_location" }, 403);
  }

  const [existingLink] = await db
    .select({ locationId: locationBillingConfig.locationId })
    .from(locationBillingConfig)
    .where(
      and(
        eq(locationBillingConfig.stripeAccountId, stripeAccountId),
        ne(locationBillingConfig.locationId, locationId)
      )
    )
    .limit(1);
  if (existingLink) {
    return c.json(
      {
        error: "stripe_account_in_use",
        message: "That Stripe account is already linked to another subaccount."
      },
      409
    );
  }

  const stripe = createStripeClient(c.env);
  if (!stripe) return c.json({ error: "stripe_not_configured" }, 500);

  let account;
  try {
    account = await stripe.accounts.retrieve(stripeAccountId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: "stripe_account_not_found", message }, 404);
  }

  await ensureLocationBillingConfigRow(db, locationId);
  await applyStripeAccountSnapshot(db, locationId, account);

  const billing = await loadBillingStripeRow(db, locationId);
  return c.json(serializeBillingRow(billing, locationId));
}

export async function getAdminLocationStripeStatusHandler(c: Context<Bindings>) {
  const auth = await assertAdminClientCharges(c);
  if (!auth) return c.json({ error: "forbidden" }, 403);
  const locationId = (c.req.param("locationId") ?? "").trim();
  if (!isUuid(locationId)) return c.json({ error: "invalid_location_id" }, 400);

  const db = createDb(c.env.DATABASE_URL);
  if (!(await canWorkspaceAccessLocationUuid(db, auth.policy, locationId))) {
    return c.json({ error: "forbidden_location" }, 403);
  }

  let billing = await loadBillingStripeRow(db, locationId);
  const stripe = createStripeClient(c.env);
  const accountId = billing?.stripeAccountId?.trim();
  if (stripe && accountId) {
    const account = await stripe.accounts.retrieve(accountId);
    await applyStripeAccountSnapshot(db, locationId, account);
    billing = await loadBillingStripeRow(db, locationId);
  }

  return c.json(serializeBillingRow(billing, locationId));
}

export async function postAdminLocationStripeBillingSetupHandler(c: Context<Bindings>) {
  const auth = await assertAdminClientCharges(c);
  if (!auth) return c.json({ error: "forbidden" }, 403);
  const locationId = (c.req.param("locationId") ?? "").trim();
  if (!isUuid(locationId)) return c.json({ error: "invalid_location_id" }, 400);

  const db = createDb(c.env.DATABASE_URL);
  if (!(await canWorkspaceAccessLocationUuid(db, auth.policy, locationId))) {
    return c.json({ error: "forbidden_location" }, 403);
  }

  const stripe = createStripeClient(c.env);
  if (!stripe) return c.json({ error: "stripe_not_configured" }, 500);

  await ensureLocationBillingConfigRow(db, locationId);
  const [loc] = await db
    .select({ name: locations.name, ghlLocationId: locations.ghlLocationId })
    .from(locations)
    .where(eq(locations.id, locationId))
    .limit(1);
  if (!loc) return c.json({ error: "location_not_found" }, 404);

  let billing = await loadBillingStripeRow(db, locationId);
  const connectedAccountId = billing?.stripeAccountId?.trim() ?? "";
  if (!connectedAccountId && !billing?.stripeCustomerId?.trim()) {
    return c.json(
      {
        error: "customer_required",
        message: "Sync Stripe customer from GHL SaaS or link a cus_… before adding a payment method."
      },
      400
    );
  }

  const stripeAccountOpts = connectedAccountId ? { stripeAccount: connectedAccountId } : undefined;

  let customerId = billing?.stripeCustomerId?.trim() ?? "";
  if (!customerId) {
    const customer = await stripe.customers.create(
      {
        name: loc.name?.trim() || loc.ghlLocationId,
        metadata: {
          agentflow_location_id: locationId,
          ...(connectedAccountId ? { stripe_connect_account_id: connectedAccountId } : {})
        }
      },
      stripeAccountOpts
    );
    customerId = customer.id;
    await db
      .update(locationBillingConfig)
      .set({ stripeCustomerId: customerId, updatedAt: new Date() })
      .where(eq(locationBillingConfig.locationId, locationId));
  }

  const urls = billingCheckoutUrls(c.env, locationId);
  const session = await stripe.checkout.sessions.create(
    {
      mode: "setup",
      customer: customerId,
      payment_method_types: ["card"],
      success_url: urls.billingSuccess,
      cancel_url: urls.billingCancel,
      metadata: { agentflow_location_id: locationId }
    },
    stripeAccountOpts
  );

  if (!session.url) return c.json({ error: "checkout_session_failed" }, 500);
  return c.json({ url: session.url });
}

export async function postAdminLocationStripeSyncFromGhlHandler(c: Context<Bindings>) {
  const auth = await assertAdminClientCharges(c);
  if (!auth) return c.json({ error: "forbidden" }, 403);
  const locationId = (c.req.param("locationId") ?? "").trim();
  if (!isUuid(locationId)) return c.json({ error: "invalid_location_id" }, 400);

  const db = createDb(c.env.DATABASE_URL);
  if (!(await canWorkspaceAccessLocationUuid(db, auth.policy, locationId))) {
    return c.json({ error: "forbidden_location" }, 403);
  }

  const [loc] = await db
    .select({ ghlLocationId: locations.ghlLocationId })
    .from(locations)
    .where(eq(locations.id, locationId))
    .limit(1);
  if (!loc) return c.json({ error: "location_not_found" }, 404);

  const result = await syncLocationStripeFromGhlSaas(c.env, db, locationId, loc.ghlLocationId);
  if (!result.ok) {
    const errStatus =
      result.status === 400 ||
      result.status === 403 ||
      result.status === 404 ||
      result.status === 409 ||
      result.status === 500
        ? result.status
        : 502;
    return c.json(
      {
        error: result.code,
        message: result.error,
        ...("payloadShape" in result && result.payloadShape != null
          ? { payloadShape: result.payloadShape }
          : {}),
        ...("ghlApiMessage" in result && result.ghlApiMessage
          ? { ghlApiMessage: result.ghlApiMessage }
          : {}),
        ...("oauthScopeOnFile" in result ? { oauthScopeOnFile: result.oauthScopeOnFile ?? null } : {})
      },
      errStatus
    );
  }

  const billing = await loadBillingStripeRow(db, locationId);
  return c.json({
    ...serializeBillingRow(billing, locationId),
    ...result,
    source: "ghl_saas"
  });
}

export async function postAdminClientChargesStripeSyncAllFromGhlHandler(c: Context<Bindings>) {
  const auth = await assertAdminClientCharges(c);
  if (!auth) return c.json({ error: "forbidden" }, 403);

  const db = createDb(c.env.DATABASE_URL);
  const allowed = await jwtWorkspaceAllowedLocationUuidList(db, auth.policy);
  const filters =
    allowed === null ? undefined : allowed.length ? inArray(locations.id, allowed) : sql`false`;

  const limitRaw = Number.parseInt(c.req.query("limit") ?? "5", 10);
  const limit = Math.min(5, Math.max(1, Number.isFinite(limitRaw) ? limitRaw : 5));

  const locRows = await db
    .select({ locationId: locations.id, ghlLocationId: locations.ghlLocationId, name: locations.name })
    .from(locations)
    .where(filters)
    .orderBy(asc(locations.name), asc(locations.ghlLocationId))
    .limit(limit);

  const results: Array<{
    locationId: string;
    ghlLocationId: string;
    locationName: string | null;
    ok: boolean;
    billingReady?: boolean;
    stripeCustomerMasked?: string | null;
    error?: string;
    code?: string;
  }> = [];

  for (const loc of locRows) {
    const synced = await syncLocationStripeFromGhlSaas(
      c.env,
      db,
      loc.locationId,
      loc.ghlLocationId,
      GHL_SAAS_FETCH_BULK_OPTS
    );
    if (synced.ok) {
      results.push({
        locationId: loc.locationId,
        ghlLocationId: loc.ghlLocationId,
        locationName: loc.name,
        ok: true,
        billingReady: synced.billingReady,
        stripeCustomerMasked: synced.stripeCustomerMasked
      });
    } else {
      results.push({
        locationId: loc.locationId,
        ghlLocationId: loc.ghlLocationId,
        locationName: loc.name,
        ok: false,
        error: synced.error,
        code: synced.code,
        ...("payloadShape" in synced && synced.payloadShape != null
          ? { payloadShape: synced.payloadShape as unknown }
          : {})
      });
    }
  }

  const syncedCount = results.filter((r) => r.ok).length;
  const readyCount = results.filter((r) => r.ok && r.billingReady).length;

  return c.json({
    processed: results.length,
    syncedCount,
    billingReadyCount: readyCount,
    failedCount: results.length - syncedCount,
    limit,
    note: "Bulk sync is capped per request to stay within Cloudflare Worker subrequest limits. Run again to process more subaccounts.",
    results
  });
}

export async function postAdminClientChargesStripeSyncSaasCatalogFromGhlHandler(c: Context<Bindings>) {
  const auth = await assertAdminClientCharges(c);
  if (!auth) return c.json({ error: "forbidden" }, 403);

  const db = createDb(c.env.DATABASE_URL);
  const companyIdRaw = (c.req.query("companyId") ?? c.req.query("ghlCompanyId") ?? "").trim();
  let ghlCompanyId = companyIdRaw;

  if (!ghlCompanyId) {
    const [agency] = await db
      .select({ ghlAgencyId: agencies.ghlAgencyId })
      .from(agencies)
      .orderBy(asc(agencies.ghlAgencyId))
      .limit(1);
    ghlCompanyId = agency?.ghlAgencyId?.trim() ?? "";
  }

  if (!ghlCompanyId) {
    return c.json(
      {
        error: "company_id_missing",
        message: "Pass ?companyId=GHL_COMPANY_ID or connect an agency with OAuth first."
      },
      400
    );
  }

  const pageRaw = Number.parseInt(c.req.query("page") ?? "1", 10);
  const offsetRaw = Number.parseInt(c.req.query("offset") ?? c.req.query("pageOffset") ?? "0", 10);
  const limitRaw = Number.parseInt(c.req.query("limit") ?? "8", 10);
  const page = Number.isFinite(pageRaw) ? Math.max(1, pageRaw) : 1;
  const pageOffset = Number.isFinite(offsetRaw) ? Math.max(0, offsetRaw) : 0;
  const maxLocations = Number.isFinite(limitRaw) ? Math.min(12, Math.max(1, limitRaw)) : 8;

  const result = await syncGhlSaasCatalogPage(c.env, db, {
    ghlCompanyId,
    page,
    pageOffset,
    maxLocations
  });

  if ("code" in result && "error" in result && !("processed" in result)) {
    const fail = result as { code: string; error: string };
    const status =
      fail.code === "company_oauth_token_missing" || fail.code === "ghl_saas_list_failed"
        ? 502
        : fail.code === "stripe_not_configured"
          ? 500
          : 400;
    return c.json({ error: fail.code, message: fail.error }, status);
  }

  return c.json(result);
}

export async function postAdminClientChargesStripeSyncFromStripeSubscriptionsHandler(c: Context<Bindings>) {
  const auth = await assertAdminClientCharges(c);
  if (!auth) return c.json({ error: "forbidden" }, 403);

  const db = createDb(c.env.DATABASE_URL);
  const companyIdRaw = (c.req.query("companyId") ?? c.req.query("ghlCompanyId") ?? "").trim();
  let ghlCompanyId = companyIdRaw;

  if (!ghlCompanyId) {
    const [agency] = await db
      .select({ ghlAgencyId: agencies.ghlAgencyId })
      .from(agencies)
      .orderBy(asc(agencies.ghlAgencyId))
      .limit(1);
    ghlCompanyId = agency?.ghlAgencyId?.trim() ?? "";
  }

  if (!ghlCompanyId) {
    return c.json(
      {
        error: "company_id_missing",
        message: "Pass ?companyId=GHL_COMPANY_ID or connect an agency with OAuth first."
      },
      400
    );
  }

  const limitRaw = Number.parseInt(c.req.query("limit") ?? "8", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(10, Math.max(1, limitRaw)) : 8;
  const startingAfter = (c.req.query("starting_after") ?? c.req.query("startingAfter") ?? "").trim() || null;

  const result = await syncStripeActiveSubscriptionsPage(c.env, db, {
    ghlCompanyId,
    limit,
    startingAfter
  });

  if ("code" in result && "error" in result && !("processed" in result)) {
    const fail = result as { code: string; error: string };
    const status =
      fail.code === "stripe_subscriptions_list_failed"
        ? 502
        : fail.code === "stripe_not_configured"
          ? 500
          : 400;
    return c.json({ error: fail.code, message: fail.error }, status);
  }

  return c.json(result);
}

export async function postAdminRefreshStripeCustomerProfilesHandler(c: Context<Bindings>) {
  const auth = await assertAdminClientCharges(c);
  if (!auth) return c.json({ error: "forbidden" }, 403);

  const db = createDb(c.env.DATABASE_URL);
  const limitRaw = Number.parseInt(c.req.query("limit") ?? "10", 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(15, Math.max(1, limitRaw)) : 10;
  const after = (c.req.query("after") ?? c.req.query("afterLocationId") ?? "").trim() || null;

  const result = await refreshStripeCustomerProfilesPage(c.env, db, {
    limit,
    afterLocationId: after
  });

  if ("code" in result && "error" in result && !("processed" in result)) {
    const fail = result as { code: string; error: string };
    return c.json({ error: fail.code, message: fail.error }, fail.code === "stripe_not_configured" ? 500 : 400);
  }

  return c.json(result);
}

export async function patchAdminLocationStripeCustomerLinkHandler(c: Context<Bindings>) {
  const auth = await assertAdminClientCharges(c);
  if (!auth) return c.json({ error: "forbidden" }, 403);
  const locationId = (c.req.param("locationId") ?? "").trim();
  if (!isUuid(locationId)) return c.json({ error: "invalid_location_id" }, 400);

  let body: { stripeCustomerId?: unknown };
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "invalid_json" }, 400);
  }

  const stripeCustomerId = normalizeStripeCustomerId(body.stripeCustomerId);
  if (!stripeCustomerId) {
    return c.json(
      { error: "invalid_stripe_customer_id", message: "Use a Stripe customer id (cus_…)." },
      400
    );
  }

  const db = createDb(c.env.DATABASE_URL);
  if (!(await canWorkspaceAccessLocationUuid(db, auth.policy, locationId))) {
    return c.json({ error: "forbidden_location" }, 403);
  }

  const stripe = createStripeClient(c.env);
  if (!stripe) return c.json({ error: "stripe_not_configured" }, 500);

  await ensureLocationBillingConfigRow(db, locationId);
  const applied = await applyPlatformStripeCustomerToLocation(stripe, db, locationId, stripeCustomerId);
  if (!applied.ok) {
    return c.json(
      { error: applied.code, message: applied.error },
      applied.code === "stripe_customer_in_use" ? 409 : 400
    );
  }

  const billing = await loadBillingStripeRow(db, locationId);
  return c.json({
    ...serializeBillingRow(billing, locationId),
    source: "manual",
    stripeCustomerMasked: maskStripeCustomerId(applied.stripeCustomerId),
    customerEmail: applied.customerEmail,
    customerName: applied.customerName
  });
}
