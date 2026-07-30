import { createDb, locationBillingConfig, locations } from "@agentflow/db";
import { canAccessClientCharges } from "@agentflow/shared";
import { and, eq, ne } from "drizzle-orm";
import type { Context } from "hono";

import { normalizeStripeConnectAccountId } from "./client-charges-logic.js";
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
      chargesEnabled: null
    });
  } catch {
    return c.json({ configured: false, platformAccountMasked: null, chargesEnabled: null });
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
  if (!connectedAccountId || !billing) {
    return c.json(
      { error: "connect_required", message: "Link a Stripe Connect account id (acct_…) first." },
      400
    );
  }

  const stripeAccount = { stripeAccount: connectedAccountId };

  let customerId = billing.stripeCustomerId?.trim() ?? "";
  if (!customerId) {
    const customer = await stripe.customers.create(
      {
        name: loc.name?.trim() || loc.ghlLocationId,
        metadata: {
          agentflow_location_id: locationId,
          stripe_connect_account_id: connectedAccountId
        }
      },
      stripeAccount
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
    stripeAccount
  );

  if (!session.url) return c.json({ error: "checkout_session_failed" }, 500);
  return c.json({ url: session.url });
}
