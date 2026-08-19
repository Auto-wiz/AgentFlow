import { createDb, locationBillingConfig, locations } from "@agentflow/db";
import { and, asc, eq, gt, isNotNull } from "drizzle-orm";

import { createStripeClient, type ClientChargeStripeEnv } from "./client-charges-stripe.js";
import { maskStripeCustomerId } from "./location-billing-stripe.js";
import {
  refreshStripeCustomerProfileOnLocation,
  type RefreshStripeCustomerProfileResult
} from "./stripe-platform-customer.js";

export type AgentFlowDb = ReturnType<typeof createDb>;

export type RefreshStripeCustomerProfilesRowResult = {
  locationId: string;
  ghlLocationId: string;
  locationName: string | null;
  stripeCustomerMasked: string | null;
  customerName: string | null;
  customerEmail: string | null;
  ok: boolean;
  code?: string;
  error?: string;
};

export type RefreshStripeCustomerProfilesPageResult = {
  processed: number;
  hasMore: boolean;
  nextAfterLocationId: string | null;
  summary: { refreshedOk: number; failed: number };
  results: RefreshStripeCustomerProfilesRowResult[];
  note: string;
};

export async function refreshStripeCustomerProfilesPage(
  env: ClientChargeStripeEnv,
  db: AgentFlowDb,
  opts: { limit?: number; afterLocationId?: string | null }
): Promise<RefreshStripeCustomerProfilesPageResult | { ok: false; code: string; error: string }> {
  const stripe = createStripeClient(env);
  if (!stripe) {
    return { ok: false, code: "stripe_not_configured", error: "STRIPE_SECRET_KEY is not configured on the Worker" };
  }

  const limit = Math.min(15, Math.max(1, Math.floor(opts.limit ?? 10)));
  const after = opts.afterLocationId?.trim() || null;

  const filters = [isNotNull(locationBillingConfig.stripeCustomerId)];
  if (after) {
    filters.push(gt(locationBillingConfig.locationId, after));
  }

  const rows = await db
    .select({
      locationId: locationBillingConfig.locationId,
      stripeCustomerId: locationBillingConfig.stripeCustomerId,
      ghlLocationId: locations.ghlLocationId,
      locationName: locations.name
    })
    .from(locationBillingConfig)
    .innerJoin(locations, eq(locations.id, locationBillingConfig.locationId))
    .where(and(...filters))
    .orderBy(asc(locationBillingConfig.locationId))
    .limit(limit + 1);

  const pageRows = rows.slice(0, limit);
  const hasMore = rows.length > limit;
  const results: RefreshStripeCustomerProfilesRowResult[] = [];

  for (const row of pageRows) {
    let refreshed: RefreshStripeCustomerProfileResult;
    try {
      refreshed = await refreshStripeCustomerProfileOnLocation(
        stripe,
        db,
        row.locationId,
        row.stripeCustomerId
      );
    } catch (err) {
      results.push({
        locationId: row.locationId,
        ghlLocationId: row.ghlLocationId,
        locationName: row.locationName,
        stripeCustomerMasked: maskStripeCustomerId(row.stripeCustomerId),
        customerName: null,
        customerEmail: null,
        ok: false,
        code: "row_refresh_failed",
        error: err instanceof Error ? err.message : String(err)
      });
      continue;
    }

    if (refreshed.ok) {
      results.push({
        locationId: row.locationId,
        ghlLocationId: row.ghlLocationId,
        locationName: row.locationName,
        stripeCustomerMasked: maskStripeCustomerId(refreshed.stripeCustomerId),
        customerName: refreshed.customerName,
        customerEmail: refreshed.customerEmail,
        ok: true
      });
    } else {
      results.push({
        locationId: row.locationId,
        ghlLocationId: row.ghlLocationId,
        locationName: row.locationName,
        stripeCustomerMasked: maskStripeCustomerId(row.stripeCustomerId),
        customerName: null,
        customerEmail: null,
        ok: false,
        code: refreshed.code,
        error: refreshed.error
      });
    }
  }

  return {
    processed: results.length,
    hasMore,
    nextAfterLocationId: hasMore && pageRows.length > 0 ? pageRows[pageRows.length - 1]!.locationId : null,
    summary: {
      refreshedOk: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length
    },
    results,
    note:
      "Refreshes stripe_customer_name/email from Stripe for rows that already have cus_. POST again with after=nextAfterLocationId until hasMore is false."
  };
}
