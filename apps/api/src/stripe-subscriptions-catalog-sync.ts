import type Stripe from "stripe";

import { createDb } from "@agentflow/db";

import {
  extractGhlCompanyIdFromStripeMetadata,
  extractGhlLocationIdFromStripeMetadata,
  normalizeStripeCustomerId
} from "./client-charges-logic.js";
import { createStripeClient, type ClientChargeStripeEnv } from "./client-charges-stripe.js";
import { upsertAgencyLocationFromGhl } from "./ghl-saas-catalog-sync.js";
import { maskStripeCustomerId } from "./location-billing-stripe.js";
import { applyPlatformStripeCustomerToLocation } from "./stripe-platform-customer.js";

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
};

export type StripeSubscriptionsSyncPageResult = {
  ghlCompanyId: string;
  processed: number;
  hasMore: boolean;
  nextStartingAfter: string | null;
  summary: {
    linkedOk: number;
    billingReady: number;
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

    const ghlLocationId = pickGhlLocationId(subscription, customer);
    if (!ghlLocationId) {
      results.push({
        subscriptionId: subscription.id,
        ghlLocationId: null,
        locationId: "",
        locationName: typeof customer.name === "string" ? customer.name : null,
        stripeCustomerMasked: maskStripeCustomerId(customerId),
        billingReady: false,
        ok: false,
        code: "no_ghl_location_metadata",
        error:
          "Active subscription has no GHL locationId in Stripe customer/subscription metadata — cannot map to a subaccount."
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
          error: applied.error
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
        ok: true
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
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const summary = {
    linkedOk: results.filter((r) => r.ok).length,
    billingReady: results.filter((r) => r.billingReady).length,
    skipped: results.filter((r) => r.code === "no_ghl_location_metadata").length,
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
      "Links platform Stripe active subscriptions to subaccounts via customer/subscription metadata.locationId. POST again with starting_after=nextStartingAfter until hasMore is false. Use alongside GHL catalog sync — Stripe is the source of truth when GHL list omits cus_."
  };
}
