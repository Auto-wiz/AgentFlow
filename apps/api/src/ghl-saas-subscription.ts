import type { createDb } from "@agentflow/db";

import {
  extractSaasSubscriptionStripeCustomerId,
  findGhlSaasLocationRecord,
  isEmptySaasLocationsPage,
  summarizeUnknownJsonShape
} from "./client-charges-logic.js";
import {
  getAccessTokensForLocation,
  getCompanyAccessTokensForGhlLocation,
  getCompanyOAuthInstallationForLocation,
  resolveGhlCompanyIdForLocation,
  type GhlOAuthTokenEnv
} from "./ghl-oauth-location-token.js";

export type AgentFlowDb = ReturnType<typeof createDb>;

export type GhlSaasSubscriptionFetchResult =
  | { ok: true; payload: unknown; customerId: string }
  | {
      ok: false;
      status: number | null;
      error: string;
      code: string;
      payloadShape?: unknown;
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
    status === 403 ||
    m.includes("not authorized for this scope") ||
    m.includes("token is not authorized")
  );
}

const GHL_SAAS_SCOPE_HELP =
  "Add scopes saas/location.read (and saas/location.write) to the Autowiz Marketplace app, publish a new version, then reconnect GoHighLevel from Settings so tokens include SaaS access.";

const SAAS_LOCATIONS_V3_PATHS = [
  (companyId: string, page: number) =>
    `/saas/saas-locations/${encodeURIComponent(companyId)}?page=${page}`,
  (companyId: string, page: number) =>
    `/saas-api/public-api/saas-locations/${encodeURIComponent(companyId)}?page=${page}`
] as const;

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
};

async function fetchSaasLocationsV3ForLocation(
  baseUrl: string,
  tokens: string[],
  companyId: string,
  ghlLocationId: string,
  state: AttemptState
): Promise<GhlSaasSubscriptionFetchResult | null> {
  const maxPages = 40;

  for (const token of tokens) {
    for (const buildPath of SAAS_LOCATIONS_V3_PATHS) {
      for (let page = 1; page <= maxPages; page++) {
        const url = `${baseUrl}${buildPath(companyId, page)}`;
        try {
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
            break;
          }

          const row = findGhlSaasLocationRecord(payload, ghlLocationId);
          if (row) {
            const customerId = extractSaasSubscriptionStripeCustomerId(row);
            if (customerId) {
              console.info("[ghl.saas.subscription] ok", {
                ghlLocationId,
                source: "saas-locations-v3",
                companyId,
                page
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
    }
  }

  return null;
}

async function fetchLegacySaasSubscription(
  baseUrl: string,
  tokens: string[],
  companyId: string | null,
  ghlLocationId: string,
  state: AttemptState
): Promise<GhlSaasSubscriptionFetchResult | null> {
  const path = `/saas/get-saas-subscription/${encodeURIComponent(ghlLocationId)}`;
  const query = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
  const url = `${baseUrl}${path}${query}`;
  const apiVersions = ["2021-04-15", "2021-07-28"] as const;

  for (const token of tokens) {
    for (const version of apiVersions) {
      try {
        const response = await fetch(url, {
          method: "GET",
          headers: {
            Authorization: `Bearer ${token}`,
            Accept: "application/json",
            Version: version
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
            source: "get-saas-subscription",
            apiVersion: version
          });
          return { ok: true, payload, customerId };
        }

        state.lastMessage = ghlErrorMessage(payload, response.status);
        if (isGhlOAuthScopeFailure(response.status, state.lastMessage)) {
          state.sawScopeError = true;
          continue;
        }
        if (response.status === 401 || response.status === 403) continue;
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
    }
  }
  return null;
}

export async function fetchGhlSaasSubscriptionForLocation(
  env: GhlOAuthTokenEnv,
  db: AgentFlowDb,
  ghlLocationId: string
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

  const companyTokens = await getCompanyAccessTokensForGhlLocation(env, db, locationId, {
    preemptiveOAuthRefresh: true
  });
  const locationTokens = await getAccessTokensForLocation(env, db, locationId, {
    preemptiveOAuthRefresh: false
  });
  const tokens = [...new Set([...companyTokens, ...locationTokens])];

  if (tokens.length === 0) {
    return {
      ok: false,
      status: null,
      error: "No GHL access token available for this location",
      code: "ghl_token_missing"
    };
  }

  const baseUrl = (env.GHL_API_BASE_URL ?? "https://services.leadconnectorhq.com").replace(/\/$/, "");
  const state: AttemptState = { lastStatus: null, lastMessage: "GHL SaaS request failed", sawScopeError: false };

  const v3Result = await fetchSaasLocationsV3ForLocation(baseUrl, tokens, companyId, locationId, state);
  if (v3Result) return v3Result;

  const legacyResult = await fetchLegacySaasSubscription(baseUrl, tokens, companyId, locationId, state);
  if (legacyResult) return legacyResult;

  if (state.sawScopeError || isGhlOAuthScopeFailure(state.lastStatus ?? 0, state.lastMessage)) {
    return {
      ok: false,
      status: state.lastStatus ?? 403,
      error: `GHL OAuth token lacks SaaS scope. ${GHL_SAAS_SCOPE_HELP}`,
      code: "ghl_scope_forbidden"
    };
  }

  return {
    ok: false,
    status: state.lastStatus,
    error: state.lastMessage,
    code: "ghl_saas_fetch_failed"
  };
}
