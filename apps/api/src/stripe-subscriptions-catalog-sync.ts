import type Stripe from "stripe";

import { createDb, locationBillingConfig, locations } from "@agentflow/db";
import { eq } from "drizzle-orm";

import {
  extractGhlCompanyIdFromStripeMetadata,
  extractGhlLocationIdFromStripeMetadata,
  normalizeStripeCustomerId
} from "./client-charges-logic.js";
import { createStripeClient, type ClientChargeStripeEnv } from "./client-charges-stripe.js";
import { fetchGhlLocationIdsForStripeBilling } from "./ghl-saas-stripe-location-lookup.js";
import { upsertAgencyLocationFromGhl } from "./ghl-saas-catalog-sync.js";
import { maskStripeCustomerId } from "./location-billing-stripe.js";
import {
  applyPlatformStripeCustomerToLocation,
  refreshStripeCustomerProfileOnLocation
} from "./stripe-platform-customer.js";

export type AgentFlowDb = ReturnType<typeof createDb>;

export type StripeSubscriptionsSyncRowResult = {
  subscriptionId: string;
  ghlLocationId: string | null;
  locationId: string;
  locationName: string | null;
  stripeCustomerMasked: string | null;
  billingReady: boolean;
  ok: boolean;
  code?: string;
  error?: string;
  lookupSource?: string;
};

export type StripeSubscriptionsSyncPageResult = {
  ghlCompanyId: string;
  processed: number;
  hasMore: boolean;
  nextStartingAfter: string | null;
  summary: {
    linkedOk: number;
    billingReady: number;
    refreshedExisting: number;
    skipped: number;
    failed: number;
  };
  results: StripeSubscriptionsSyncRowResult[];
  note: string;
};

async function resolveStripeCustomer(
  stripe: Stripe,
  customer: string | Stripe.Customer | Stripe.DeletedCustomer
): Promise<Stripe.Customer | null> {
  if (typeof customer === "string") {
    const retrieved = await stripe.customers.retrieve(customer);
    if (retrieved.deleted) return null;
    return retrieved;
  }
  if ("deleted" in customer && customer.deleted) return null;
  return customer;
}

function pickGhlLocationId(subscription: Stripe.Subscription, customer: Stripe.Customer): string | null {
  return (
    extractGhlLocationIdFromStripeMetadata(subscription.metadata) ??
    extractGhlLocationIdFromStripeMetadata(customer.metadata)
  );
}

function pickGhlCompanyId(
  subscription: Stripe.Subscription,
  customer: Stripe.Customer,
  fallbackCompanyId: string
): string {
  return (
    extractGhlCompanyIdFromStripeMetadata(subscription.metadata) ??
    extractGhlCompanyIdFromStripeMetadata(customer.metadata) ??
    fallbackCompanyId
  ).trim();
}

async function findLinkedLocationByStripeCustomerId(db: AgentFlowDb, stripeCustomerId: string) {
  const [row] = await db
    .select({
      locationId: locationBillingConfig.locationId,
      ghlLocationId: locations.ghlLocationId,
      locationName: locations.name
    })
    .from(locationBillingConfig)
    .innerJoin(locations, eq(locations.id, locationBillingConfig.locationId))
    .where(eq(locationBillingConfig.stripeCustomerId, stripeCustomerId))
    .limit(1);
  return row ?? null;
}

export async function syncStripeActiveSubscriptionsPage(
  env: ClientChargeStripeEnv,
  db: AgentFlowDb,
  opts: {
    ghlCompanyId: string;
    limit?: number;
    startingAfter?: string | null;
  }
): Promise<StripeSubscriptionsSyncPageResult | { ok: false; code: string; error: string }> {
  const ghlCompanyId = opts.ghlCompanyId.trim();
  if (!ghlCompanyId) {
    return { ok: false, code: "missing_company_id", error: "ghlCompanyId is required" };
  }

  const stripe = createStripeClient(env);
  if (!stripe) {
    return { ok: false, code: "stripe_not_configured", error: "STRIPE_SECRET_KEY is not configured on the Worker" };
  }

  const limit = Math.min(10, Math.max(1, Math.floor(opts.limit ?? 8)));
  const startingAfter = opts.startingAfter?.trim() || undefined;

  let subscriptions: Stripe.ApiList<Stripe.Subscription>;
  try {
    subscriptions = await stripe.subscriptions.list({
      status: "active",
      limit,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
      expand: ["data.customer"]
    });
  } catch (err) {
    return {
      ok: false,
      code: "stripe_subscriptions_list_failed",
      error: err instanceof Error ? err.message : String(err)
    };
  }

  const now = new Date();
  const results: StripeSubscriptionsSyncRowResult[] = [];

  for (const subscription of subscriptions.data) {
    const customerId = normalizeStripeCustomerId(
      typeof subscription.customer === "string" ? subscription.customer : subscription.customer?.id
    );
    if (!customerId) {
      results.push({
        subscriptionId: subscription.id,
        ghlLocationId: null,
        locationId: "",
        locationName: null,
        stripeCustomerMasked: null,
        billingReady: false,
        ok: false,
        code: "missing_customer_id",
        error: "Subscription has no Stripe customer id"
      });
      continue;
    }

    let customer: Stripe.Customer | null = null;
    try {
      customer = await resolveStripeCustomer(stripe, subscription.customer);
    } catch (err) {
      results.push({
        subscriptionId: subscription.id,
        ghlLocationId: null,
        locationId: "",
        locationName: null,
        stripeCustomerMasked: maskStripeCustomerId(customerId),
        billingReady: false,
        ok: false,
        code: "stripe_customer_retrieve_failed",
        error: err instanceof Error ? err.message : String(err)
      });
      continue;
    }

    if (!customer) {
      results.push({
        subscriptionId: subscription.id,
        ghlLocationId: null,
        locationId: "",
        locationName: null,
        stripeCustomerMasked: maskStripeCustomerId(customerId),
        billingReady: false,
        ok: false,
        code: "customer_deleted",
        error: "Stripe customer was deleted"
      });
      continue;
    }

    const existingLink = await findLinkedLocationByStripeCustomerId(db, customerId);
    if (existingLink) {
      const refreshed = await refreshStripeCustomerProfileOnLocation(
        stripe,
        db,
        existingLink.locationId,
        customerId
      );
      if (refreshed.ok) {
        results.push({
          subscriptionId: subscription.id,
          ghlLocationId: existingLink.ghlLocationId,
          locationId: existingLink.locationId,
          locationName: existingLink.locationName,
          stripeCustomerMasked: maskStripeCustomerId(refreshed.stripeCustomerId),
          billingReady: false,
          ok: true,
          lookupSource: "existing_db_link",
          code: "refreshed_existing"
        });
      } else {
        results.push({
          subscriptionId: subscription.id,
          ghlLocationId: existingLink.ghlLocationId,
          locationId: existingLink.locationId,
          locationName: existingLink.locationName,
          stripeCustomerMasked: maskStripeCustomerId(customerId),
          billingReady: false,
          ok: false,
          code: refreshed.code,
          error: refreshed.error
        });
      }
      continue;
    }

    let ghlLocationId = pickGhlLocationId(subscription, customer);
    let lookupSource = ghlLocationId ? "stripe_metadata" : "";
    let lookupDiagnostics: string | undefined;

    if (!ghlLocationId) {
      const lookup = await fetchGhlLocationIdsForStripeBilling(env, db, {
        ghlCompanyId,
        stripeCustomerId: customerId,
        stripeSubscriptionId: subscription.id
      });
      if (!lookup.ok) {
        results.push({
          subscriptionId: subscription.id,
          ghlLocationId: null,
          locationId: "",
          locationName: typeof customer.name === "string" ? customer.name : null,
          stripeCustomerMasked: maskStripeCustomerId(customerId),
          billingReady: false,
          ok: false,
          code: lookup.code,
          error: lookup.error
        });
        continue;
      }
      lookupDiagnostics = lookup.diagnostics;
      if (lookup.ghlLocationIds[0]) {
        ghlLocationId = lookup.ghlLocationIds[0]!;
        lookupSource = lookup.source;
      }
    }

    if (!ghlLocationId) {
      const ghlDetail = lookupDiagnostics ? ` GHL: ${lookupDiagnostics}` : "";
      results.push({
        subscriptionId: subscription.id,
        ghlLocationId: null,
        locationId: "",
        locationName: typeof customer.name === "string" ? customer.name : null,
        stripeCustomerMasked: maskStripeCustomerId(customerId),
        billingReady: false,
        ok: false,
        code: "no_ghl_location_mapping",
        error: `No Stripe metadata and GHL /saas/locations returned no subaccount.${ghlDetail} Run sync-ghl-saas-billing-catalog.mjs first.`
      });
      continue;
    }

    const rowCompanyId = pickGhlCompanyId(subscription, customer, ghlCompanyId);
    const locationName =
      (typeof customer.name === "string" && customer.name.trim()) ||
      subscription.description?.trim() ||
      null;

    try {
      const location = await upsertAgencyLocationFromGhl(
        db,
        rowCompanyId,
        ghlLocationId,
        locationName,
        now
      );
      const applied = await applyPlatformStripeCustomerToLocation(stripe, db, location.id, customerId);
      if (!applied.ok) {
        results.push({
          subscriptionId: subscription.id,
          ghlLocationId,
          locationId: location.id,
          locationName: location.name,
          stripeCustomerMasked: maskStripeCustomerId(customerId),
          billingReady: false,
          ok: false,
          code: applied.code,
          error: applied.error,
          lookupSource
        });
        continue;
      }

      results.push({
        subscriptionId: subscription.id,
        ghlLocationId,
        locationId: location.id,
        locationName: location.name,
        stripeCustomerMasked: maskStripeCustomerId(applied.stripeCustomerId),
        billingReady: applied.billingReady,
        ok: true,
        lookupSource
      });
    } catch (err) {
      results.push({
        subscriptionId: subscription.id,
        ghlLocationId,
        locationId: "",
        locationName: locationName,
        stripeCustomerMasked: maskStripeCustomerId(customerId),
        billingReady: false,
        ok: false,
        code: "row_sync_failed",
        error: err instanceof Error ? err.message : String(err),
        lookupSource
      });
    }
  }

  const summary = {
    linkedOk: results.filter((r) => r.ok && r.code !== "refreshed_existing").length,
    billingReady: results.filter((r) => r.billingReady).length,
    refreshedExisting: results.filter((r) => r.code === "refreshed_existing").length,
    skipped: results.filter((r) => r.code === "no_ghl_location_mapping").length,
    failed: results.filter((r) => !r.ok).length
  };

  return {
    ghlCompanyId,
    processed: results.length,
    hasMore: subscriptions.has_more,
    nextStartingAfter:
      subscriptions.has_more && subscriptions.data.length > 0
        ? subscriptions.data[subscriptions.data.length - 1]!.id
        : null,
    summary,
    results,
    note:
      "Links active Stripe subscriptions via metadata, GHL GET /saas/locations?customerId=…, or refreshes rows already linked in DB. Run GHL catalog sync separately to upsert all subaccounts."
  };
}
