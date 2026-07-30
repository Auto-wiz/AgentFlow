import { createDb, locationBillingConfig, locations } from "@agentflow/db";
import { canAccessClientCharges } from "@agentflow/shared";
import { eq } from "drizzle-orm";
import type { Context } from "hono";

import { createStripeClient } from "./client-charges-stripe.js";
import {
  applyStripeAccountSnapshot,
  ensureLocationBillingConfigRow,
  isLocationBillingReady,
  maskStripeAccountId,
  type LocationBillingStripeRow
} from "./location-billing-stripe.js";
import {
  canWorkspaceAccessLocationUuid,
  resolveAccessPolicy,
  resolveSessionUser,
  type WorkspaceJwtEnv
} from "./workspace-access.js";

export type StripeConnectEnv = WorkspaceJwtEnv & {
  STRIPE_SECRET_KEY?: string;
  STRIPE_CONNECT_RETURN_URL?: string;
  STRIPE_CONNECT_REFRESH_URL?: string;
  FRONTEND_BASE_URL?: string;
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

function connectUrls(env: StripeConnectEnv, locationId: string) {
  const base = (env.FRONTEND_BASE_URL ?? "http://localhost:3000").replace(/\/$/, "");
  const fallbackReturn = `${base}/dashboard/client-charges?stripe=return&locationId=${encodeURIComponent(locationId)}`;
  const fallbackRefresh = `${base}/dashboard/client-charges?stripe=refresh&locationId=${encodeURIComponent(locationId)}`;
  return {
    returnUrl: env.STRIPE_CONNECT_RETURN_URL?.trim() || fallbackReturn,
    refreshUrl: env.STRIPE_CONNECT_REFRESH_URL?.trim() || fallbackRefresh,
    billingSuccess: `${base}/dashboard/client-charges?stripe=billing_ok&locationId=${encodeURIComponent(locationId)}`,
    billingCancel: `${base}/dashboard/client-charges?stripe=billing_cancel&locationId=${encodeURIComponent(locationId)}`
  };
}

function serializeBillingRow(row: LocationBillingStripeRow | null | undefined, locationId: string) {
  const billingReady = row
    ? isLocationBillingReady(row)
    : false;
  return {
    locationId,
    billingReady,
    stripeAccountMasked: maskStripeAccountId(row?.stripeAccountId ?? null),
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

export async function postAdminLocationStripeConnectHandler(c: Context<Bindings>) {
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
  let accountId = billing?.stripeAccountId?.trim() ?? "";

  if (!accountId) {
    const account = await stripe.accounts.create({
      type: "express",
      country: "US",
      capabilities: {
        card_payments: { requested: true },
        transfers: { requested: true }
      },
      metadata: {
        agentflow_location_id: locationId,
        ghl_location_id: loc.ghlLocationId
      },
      business_profile: {
        name: loc.name?.trim() || loc.ghlLocationId
      }
    });
    accountId = account.id;
    const now = new Date();
    await db
      .update(locationBillingConfig)
      .set({
        stripeAccountId: accountId,
        connectOnboardingStatus: "created",
        updatedAt: now
      })
      .where(eq(locationBillingConfig.locationId, locationId));
  }

  const urls = connectUrls(c.env, locationId);
  const link = await stripe.accountLinks.create({
    account: accountId,
    refresh_url: urls.refreshUrl,
    return_url: urls.returnUrl,
    type: "account_onboarding"
  });

  return c.json({ url: link.url, expiresAt: link.expires_at });
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
  if (!billing?.stripeAccountId?.trim()) {
    return c.json(
      { error: "connect_required", message: "Complete Stripe Connect onboarding first." },
      400
    );
  }

  let customerId = billing.stripeCustomerId?.trim() ?? "";
  if (!customerId) {
    const customer = await stripe.customers.create({
      name: loc.name?.trim() || loc.ghlLocationId,
      metadata: {
        agentflow_location_id: locationId,
        stripe_connect_account_id: billing.stripeAccountId
      }
    });
    customerId = customer.id;
    await db
      .update(locationBillingConfig)
      .set({ stripeCustomerId: customerId, updatedAt: new Date() })
      .where(eq(locationBillingConfig.locationId, locationId));
  }

  const urls = connectUrls(c.env, locationId);
  const session = await stripe.checkout.sessions.create({
    mode: "setup",
    customer: customerId,
    payment_method_types: ["card"],
    success_url: urls.billingSuccess,
    cancel_url: urls.billingCancel,
    metadata: { agentflow_location_id: locationId }
  });

  if (!session.url) return c.json({ error: "checkout_session_failed" }, 500);
  return c.json({ url: session.url });
}
