import type { createDb } from "@agentflow/db";

import {
  extractSaasSubscriptionStripeCustomerId,
  findGhlSaasLocationRecord,
  isEmptySaasLocationsPage,
  summarizeUnknownJsonShape
} from "./client-charges-logic.js";
import {
  getCompanyAccessTokensForGhlLocation,
  getCompanyOAuthScopeSnapshotForLocation,
  getCompanyOAuthInstallationForLocation,
  oauthInstallationScopeIncludesSaas,
  resolveGhlCompanyIdForLocation,
  type GhlOAuthTokenEnv
} from "./ghl-oauth-location-token.js";

export type AgentFlowDb = ReturnType<typeof createDb>;

/** Stay under Cloudflare Workers ~50 subrequests/invocation (GHL + Stripe + DB). */
const MAX_GHL_FETCHES_PER_SAAS_SYNC = 14;
const MAX_SAAS_LOCATIONS_V3_PAGES = 10;

/** Tighter budget when sync-all runs several locations in one Worker invocation. */
export const GHL_SAAS_FETCH_BULK_OPTS = {
  maxGhlFetches: 6,
  maxV3Pages: 4
} as const;

export type GhlSaasFetchOptions = {
  maxGhlFetches?: number;
  maxV3Pages?: number;
};

export type GhlSaasSubscriptionFetchResult =
  | { ok: true; payload: unknown; customerId: string }
  | {
      ok: false;
      status: number | null;
      error: string;
      code: string;
      payloadShape?: unknown;
      ghlApiMessage?: string;
      oauthScopeOnFile?: string | null;
    };

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function ghlErrorMessage(payload: unknown, status: number): string {
  const body = asRecord(payload);
  const msg =
    (typeof body?.message === "string" && body.message) ||
    (typeof body?.error === "string" && body.error) ||
    "";
  return msg || `HTTP ${status}`;
}

function isGhlOAuthScopeFailure(status: number, message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("not authorized for this scope") ||
    m.includes("token is not authorized for this scope") ||
    (status === 401 && m.includes("scope"))
  );
}

const GHL_SAAS_SCOPE_HELP =
  "Publish a new Marketplace app version with saas/location.read (and saas/location.write), then use AgentFlow Settings → Connect GoHighLevel at the agency — reinstalling the app on one subaccount alone does not refresh agency OAuth scopes.";

async function resolveCompanyIdForSaasFetch(db: AgentFlowDb, ghlLocationId: string) {
  const fromDb = await resolveGhlCompanyIdForLocation(db, ghlLocationId);
  if (fromDb) return fromDb;
  const install = await getCompanyOAuthInstallationForLocation(db, ghlLocationId);
  return install?.companyId?.trim() ?? null;
}

type AttemptState = {
  lastStatus: number | null;
  lastMessage: string;
  sawScopeError: boolean;
  fetchCount: number;
  maxGhlFetches: number;
  maxV3Pages: number;
};

function canFetchGhl(state: AttemptState): boolean {
  return state.fetchCount < state.maxGhlFetches;
}

function noteGhlFetch(state: AttemptState) {
  state.fetchCount += 1;
}

async function fetchSaasLocationsV3ForLocation(
  baseUrl: string,
  token: string,
  companyId: string,
  ghlLocationId: string,
  state: AttemptState,
  pathPrefix: "/saas/saas-locations" | "/saas-api/public-api/saas-locations"
): Promise<GhlSaasSubscriptionFetchResult | null> {
  for (let page = 1; page <= state.maxV3Pages; page++) {
    if (!canFetchGhl(state)) {
      state.lastMessage = "GHL SaaS list pagination stopped to avoid Worker subrequest limit";
      break;
    }
    const url = `${baseUrl}${pathPrefix}/${encodeURIComponent(companyId)}?page=${page}`;
    try {
      noteGhlFetch(state);
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          Version: "v3"
        }
      });
      state.lastStatus = response.status;
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        state.lastMessage = ghlErrorMessage(payload, response.status);
        if (isGhlOAuthScopeFailure(response.status, state.lastMessage)) {
          state.sawScopeError = true;
        }
        return response.status === 404 ? null : null;
      }

      const row = findGhlSaasLocationRecord(payload, ghlLocationId);
      if (row) {
        const customerId = extractSaasSubscriptionStripeCustomerId(row);
        if (customerId) {
          console.info("[ghl.saas.subscription] ok", {
            ghlLocationId,
            source: "saas-locations-v3",
            companyId,
            page,
            pathPrefix
          });
          return { ok: true, payload: row, customerId };
        }
        const payloadShape = summarizeUnknownJsonShape(row);
        return {
          ok: false,
          status: response.status,
          error:
            "SaaS location row had no Stripe customer id (cus_…). Paste cus_ manually or share payloadShape to extend the parser.",
          code: "customer_id_missing",
          payloadShape
        };
      }

      if (isEmptySaasLocationsPage(payload)) {
        break;
      }
    } catch (err) {
      state.lastMessage = err instanceof Error ? err.message : String(err);
      break;
    }
  }

  return null;
}

async function fetchLegacySaasSubscription(
  baseUrl: string,
  token: string,
  companyId: string | null,
  ghlLocationId: string,
  state: AttemptState
): Promise<GhlSaasSubscriptionFetchResult | null> {
  if (!canFetchGhl(state)) return null;

  const path = `/saas/get-saas-subscription/${encodeURIComponent(ghlLocationId)}`;
  const query = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
  const url = `${baseUrl}${path}${query}`;

  try {
    noteGhlFetch(state);
    const response = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        Version: "2021-07-28"
      }
    });
    state.lastStatus = response.status;
    const payload = await response.json().catch(() => ({}));
    if (response.ok) {
      const customerId = extractSaasSubscriptionStripeCustomerId(payload);
      if (!customerId) {
        const payloadShape = summarizeUnknownJsonShape(payload);
        return {
          ok: false,
          status: response.status,
          error:
            "SaaS subscription JSON had no Stripe customer id (cus_…). Check payloadShape in this error or Worker logs.",
          code: "customer_id_missing",
          payloadShape
        };
      }
      console.info("[ghl.saas.subscription] ok", {
        ghlLocationId,
        source: "get-saas-subscription"
      });
      return { ok: true, payload, customerId };
    }

    state.lastMessage = ghlErrorMessage(payload, response.status);
    if (isGhlOAuthScopeFailure(response.status, state.lastMessage)) {
      state.sawScopeError = true;
    }
    if (response.status === 404) {
      return {
        ok: false,
        status: 404,
        error: "No SaaS subscription found for this subaccount in GHL",
        code: "saas_subscription_not_found"
      };
    }
  } catch (err) {
    state.lastMessage = err instanceof Error ? err.message : String(err);
  }
  return null;
}

export async function fetchGhlSaasSubscriptionForLocation(
  env: GhlOAuthTokenEnv,
  db: AgentFlowDb,
  ghlLocationId: string,
  fetchOpts?: GhlSaasFetchOptions
): Promise<GhlSaasSubscriptionFetchResult> {
  const locationId = ghlLocationId.trim();
  if (!locationId) {
    return { ok: false, status: null, error: "missing_ghl_location_id", code: "missing_location" };
  }

  const companyId = await resolveCompanyIdForSaasFetch(db, locationId);
  if (!companyId) {
    return {
      ok: false,
      status: null,
      error: "Could not resolve GHL companyId for this location — connect GoHighLevel OAuth for the agency first.",
      code: "company_id_missing"
    };
  }

  let companyTokens = await getCompanyAccessTokensForGhlLocation(env, db, locationId, {
    preemptiveOAuthRefresh: false
  });
  if (companyTokens.length === 0) {
    companyTokens = await getCompanyAccessTokensForGhlLocation(env, db, locationId, {
      preemptiveOAuthRefresh: true
    });
  }
  const oauthScopeOnFile = await getCompanyOAuthScopeSnapshotForLocation(db, locationId);

  if (companyTokens.length === 0) {
    return {
      ok: false,
      status: null,
      error:
        "No agency-level (Company) OAuth token in AgentFlow. Use Settings → Connect GoHighLevel for the agency. Reinstalling the Marketplace app on a single subaccount does not replace that token.",
      code: "company_oauth_token_missing",
      oauthScopeOnFile
    };
  }

  if (oauthScopeOnFile && !oauthInstallationScopeIncludesSaas(oauthScopeOnFile)) {
    return {
      ok: false,
      status: null,
      error: GHL_SAAS_SCOPE_HELP,
      code: "oauth_token_missing_saas_scope",
      oauthScopeOnFile
    };
  }

  const token = companyTokens[0]!;
  const baseUrl = (env.GHL_API_BASE_URL ?? "https://services.leadconnectorhq.com").replace(/\/$/, "");
  const state: AttemptState = {
    lastStatus: null,
    lastMessage: "GHL SaaS request failed",
    sawScopeError: false,
    fetchCount: 0,
    maxGhlFetches: fetchOpts?.maxGhlFetches ?? MAX_GHL_FETCHES_PER_SAAS_SYNC,
    maxV3Pages: fetchOpts?.maxV3Pages ?? MAX_SAAS_LOCATIONS_V3_PAGES
  };

  const legacyResult = await fetchLegacySaasSubscription(baseUrl, token, companyId, locationId, state);
  if (legacyResult?.ok) return legacyResult;
  if (legacyResult && !legacyResult.ok && legacyResult.code !== "saas_subscription_not_found") {
    return legacyResult;
  }

  let v3Result = await fetchSaasLocationsV3ForLocation(
    baseUrl,
    token,
    companyId,
    locationId,
    state,
    "/saas/saas-locations"
  );
  if (!v3Result && !state.sawScopeError && canFetchGhl(state)) {
    v3Result = await fetchSaasLocationsV3ForLocation(
      baseUrl,
      token,
      companyId,
      locationId,
      state,
      "/saas-api/public-api/saas-locations"
    );
  }
  if (v3Result) return v3Result;

  if (state.sawScopeError || isGhlOAuthScopeFailure(state.lastStatus ?? 0, state.lastMessage)) {
    let error = GHL_SAAS_SCOPE_HELP;
    if (oauthScopeOnFile && oauthInstallationScopeIncludesSaas(oauthScopeOnFile)) {
      error = `${GHL_SAAS_SCOPE_HELP} The agency token in AgentFlow already lists saas/* scopes but GHL rejected the API call — use Settings → Connect GoHighLevel again (subaccount reinstall is not enough).`;
    }
    return {
      ok: false,
      status: state.lastStatus ?? 403,
      error,
      code: "ghl_scope_forbidden",
      ghlApiMessage: state.lastMessage,
      oauthScopeOnFile
    };
  }

  if (legacyResult && !legacyResult.ok) {
    return legacyResult;
  }

  return {
    ok: false,
    status: state.lastStatus,
    error: state.lastMessage,
    code: "ghl_saas_fetch_failed",
    oauthScopeOnFile
  };
}
