import { agencies, createDb, locations } from "@agentflow/db";

import { createStripeClient } from "./client-charges-stripe.js";
import {
  extractSaasSubscriptionStripeCustomerId,
  isEmptySaasLocationsPage,
  listGhlSaasLocationRowsFromPage
} from "./client-charges-logic.js";
import { syncLocationStripeFromGhlSaas, type GhlStripeSyncEnv } from "./client-charges-ghl-stripe-sync.js";
import { GHL_SAAS_FETCH_BULK_OPTS } from "./ghl-saas-subscription.js";
import {
  getCompanyAccessTokensForGhlCompanyId,
  type GhlOAuthTokenEnv
} from "./ghl-oauth-location-token.js";
import {
  ensureLocationBillingConfigRow,
  maskStripeCustomerId
} from "./location-billing-stripe.js";
import { applyPlatformStripeCustomerToLocation } from "./stripe-platform-customer.js";

export type AgentFlowDb = ReturnType<typeof createDb>;

export type SaasCatalogSyncRowResult = {
  ghlLocationId: string;
  locationId: string;
  locationName: string | null;
  ghlCustomerIdInList: string | null;
  stripeCustomerMasked: string | null;
  hasPaymentMethod: boolean;
  billingReady: boolean;
  ok: boolean;
  code?: string;
  error?: string;
};

export type SaasCatalogSyncPageResult = {
  ghlCompanyId: string;
  page: number;
  /** Row offset within the current GHL API page (for batches smaller than rowsOnPage). */
  pageOffset: number;
  nextPage: number | null;
  /** Pass as ?offset= on the next request (0 when advancing to nextPage). */
  nextPageOffset: number | null;
  hasMore: boolean;
  rowsOnPage: number;
  processed: number;
  summary: {
    syncedOk: number;
    billingReady: number;
    withGhlCustomerId: number;
    withoutGhlCustomerId: number;
    failed: number;
  };
  results: SaasCatalogSyncRowResult[];
  note: string;
};

async function resolveCompanyAccessToken(
  env: GhlOAuthTokenEnv,
  db: AgentFlowDb,
  ghlCompanyId: string
): Promise<string | null> {
  let tokens = await getCompanyAccessTokensForGhlCompanyId(env, db, ghlCompanyId, {
    preemptiveOAuthRefresh: false
  });
  if (tokens.length === 0) {
    tokens = await getCompanyAccessTokensForGhlCompanyId(env, db, ghlCompanyId, {
      preemptiveOAuthRefresh: true
    });
  }
  return tokens[0] ?? null;
}

export async function upsertAgencyLocationFromGhl(
  db: AgentFlowDb,
  ghlCompanyId: string,
  ghlLocationId: string,
  locationName: string | null,
  now: Date
) {
  const [agency] = await db
    .insert(agencies)
    .values({ ghlAgencyId: ghlCompanyId, updatedAt: now })
    .onConflictDoUpdate({
      target: agencies.ghlAgencyId,
      set: { updatedAt: now }
    })
    .returning({ id: agencies.id });

  if (!agency) throw new Error("agency_upsert_failed");

  const [location] = await db
    .insert(locations)
    .values({
      agencyId: agency.id,
      ghlLocationId,
      name: locationName,
      updatedAt: now
    })
    .onConflictDoUpdate({
      target: locations.ghlLocationId,
      set: {
        agencyId: agency.id,
        name: locationName ?? undefined,
        updatedAt: now
      }
    })
    .returning({ id: locations.id, name: locations.name });

  if (!location) throw new Error("location_upsert_failed");
  await ensureLocationBillingConfigRow(db, location.id, now);
  return location;
}

export async function syncGhlSaasCatalogPage(
  env: GhlStripeSyncEnv,
  db: AgentFlowDb,
  opts: {
    ghlCompanyId: string;
    page?: number;
    /** Slice start within the current GHL page (default 0). */
    pageOffset?: number;
    maxLocations?: number;
  }
): Promise<SaasCatalogSyncPageResult | { ok: false; code: string; error: string }> {
  const ghlCompanyId = opts.ghlCompanyId.trim();
  if (!ghlCompanyId) {
    return { ok: false, code: "missing_company_id", error: "ghlCompanyId is required" };
  }

  if (!env.STRIPE_SECRET_KEY?.trim()) {
    return {
      ok: false,
      code: "stripe_not_configured",
      error: "STRIPE_SECRET_KEY is not configured on the Worker"
    };
  }

  const stripe = createStripeClient(env);
  if (!stripe) {
    return { ok: false, code: "stripe_not_configured", error: "Stripe client could not be created" };
  }

  const token = await resolveCompanyAccessToken(env, db, ghlCompanyId);
  if (!token) {
    return {
      ok: false,
      code: "company_oauth_token_missing",
      error:
        "No usable agency Company OAuth token for this companyId. If Settings already shows connected, the stored token may be expired or ?companyId= may not match the agency id from OAuth — per-location Sync from GHL refreshes tokens automatically; catalog sync retries refresh on the next attempt."
    };
  }

  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const pageOffset = Math.max(0, Math.floor(opts.pageOffset ?? 0));
  const maxLocations = Math.min(12, Math.max(1, Math.floor(opts.maxLocations ?? 8)));
  const baseUrl = (env.GHL_API_BASE_URL ?? "https://services.leadconnectorhq.com").replace(/\/$/, "");
  const url = `${baseUrl}/saas/saas-locations/${encodeURIComponent(ghlCompanyId)}?page=${page}`;

  let payload: unknown;
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        Version: "v3"
      }
    });
    payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const msg =
        payload && typeof payload === "object" && "message" in payload
          ? String((payload as { message?: unknown }).message)
          : `HTTP ${response.status}`;
      return { ok: false, code: "ghl_saas_list_failed", error: msg };
    }
  } catch (err) {
    return {
      ok: false,
      code: "ghl_saas_list_failed",
      error: err instanceof Error ? err.message : String(err)
    };
  }

  const catalogRows = listGhlSaasLocationRowsFromPage(payload);
  const pageEmpty = isEmptySaasLocationsPage(payload) || catalogRows.length === 0;
  const now = new Date();
  const results: SaasCatalogSyncRowResult[] = [];

  const batchRows = catalogRows.slice(pageOffset, pageOffset + maxLocations);
  for (const row of batchRows) {
    try {
      const location = await upsertAgencyLocationFromGhl(
        db,
        ghlCompanyId,
        row.ghlLocationId,
        row.name,
        now
      );
      const ghlCustomerId = extractSaasSubscriptionStripeCustomerId(row.row);

      if (ghlCustomerId) {
        const applied = await applyPlatformStripeCustomerToLocation(
          stripe,
          db,
          location.id,
          ghlCustomerId
        );
        if (!applied.ok) {
          results.push({
            ghlLocationId: row.ghlLocationId,
            locationId: location.id,
            locationName: location.name,
            ghlCustomerIdInList: ghlCustomerId,
            stripeCustomerMasked: null,
            hasPaymentMethod: false,
            billingReady: false,
            ok: false,
            code: applied.code,
            error: applied.error
          });
          continue;
        }
        results.push({
          ghlLocationId: row.ghlLocationId,
          locationId: location.id,
          locationName: location.name,
          ghlCustomerIdInList: ghlCustomerId,
          stripeCustomerMasked: maskStripeCustomerId(applied.stripeCustomerId),
          hasPaymentMethod: Boolean(applied.stripeDefaultPaymentMethodId),
          billingReady: applied.billingReady,
          ok: true
        });
        continue;
      }

      const synced = await syncLocationStripeFromGhlSaas(
        env,
        db,
        location.id,
        row.ghlLocationId,
        GHL_SAAS_FETCH_BULK_OPTS
      );
      if (synced.ok) {
        results.push({
          ghlLocationId: row.ghlLocationId,
          locationId: location.id,
          locationName: location.name,
          ghlCustomerIdInList: null,
          stripeCustomerMasked: synced.stripeCustomerMasked,
          hasPaymentMethod: synced.hasPaymentMethod,
          billingReady: synced.billingReady,
          ok: true
        });
      } else {
        results.push({
          ghlLocationId: row.ghlLocationId,
          locationId: location.id,
          locationName: location.name,
          ghlCustomerIdInList: null,
          stripeCustomerMasked: null,
          hasPaymentMethod: false,
          billingReady: false,
          ok: false,
          code: synced.code,
          error: synced.error
        });
      }
    } catch (err) {
      results.push({
        ghlLocationId: row.ghlLocationId,
        locationId: "",
        locationName: row.name,
        ghlCustomerIdInList: extractSaasSubscriptionStripeCustomerId(row.row),
        stripeCustomerMasked: null,
        hasPaymentMethod: false,
        billingReady: false,
        ok: false,
        code: "row_sync_failed",
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }

  const consumedOnPage = pageOffset + batchRows.length;
  const hasMoreRowsOnPage = consumedOnPage < catalogRows.length;
  const hasMore =
    hasMoreRowsOnPage || (!pageEmpty && catalogRows.length > 0 && consumedOnPage >= catalogRows.length);
  const nextPage = hasMore ? (hasMoreRowsOnPage ? page : page + 1) : null;
  const nextPageOffset = hasMore ? (hasMoreRowsOnPage ? consumedOnPage : 0) : null;
  const summary = {
    syncedOk: results.filter((r) => r.ok).length,
    billingReady: results.filter((r) => r.billingReady).length,
    withGhlCustomerId: results.filter((r) => Boolean(r.ghlCustomerIdInList)).length,
    withoutGhlCustomerId: results.filter((r) => !r.ghlCustomerIdInList).length,
    failed: results.filter((r) => !r.ok).length
  };

  return {
    ghlCompanyId,
    page,
    pageOffset,
    nextPage,
    nextPageOffset,
    hasMore,
    rowsOnPage: catalogRows.length,
    processed: results.length,
    summary,
    results,
    note:
      "Lists SaaS subaccounts from GHL (v3 saas-locations). POST again with page=nextPage&offset=nextPageOffset until hasMore is false. limit caps rows per Worker request (subrequest budget); rowsOnPage may exceed processed when batching within a GHL page. Rows without cus_ in the list fall back to per-location SaaS sync."
  };
}
