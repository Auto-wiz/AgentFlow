import type { createDb } from "@agentflow/db";

import {
  extractSaasSubscriptionStripeCustomerId,
  findGhlSaasLocationRecord,
  isEmptySaasLocationsPage,
  summarizeUnknownJsonShape
} from "./client-charges-logic.js";
import {
  explainGhlSaasFetchFailure,
  GHL_SAAS_API_VERSION,
  GHL_SAAS_SCOPE_HELP,
  shouldTreatAsGhlSaasAuthFailure
} from "./ghl-saas-subscription-errors.js";
import { summarizeGhlTokenForSaas } from "./ghl-access-token-claims.js";
import {
  getCompanyAccessTokensForGhlLocation,
  getCompanyOAuthScopeSnapshotForLocation,
  getCompanyOAuthInstallationForLocation,
  oauthInstallationScopeIncludesSaas,
  reattachLocationToGhlCompany,
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

export { GHL_SAAS_API_VERSION, GHL_SAAS_SCOPE_HELP } from "./ghl-saas-subscription-errors.js";

/** Company catalog first (saas/company.read). Path+Version pairs that HighLevel documents. */
const COMPANY_SAAS_CATALOG_ATTEMPTS = [
  { pathPrefix: "/saas-api/public-api/saas-locations", version: GHL_SAAS_API_VERSION },
  { pathPrefix: "/saas/saas-locations", version: "v3" },
  { pathPrefix: "/saas/saas-locations", version: GHL_SAAS_API_VERSION },
  { pathPrefix: "/saas-api/public-api/saas-locations", version: "v3" }
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
  listCompletedWithoutMatch: boolean;
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

function noteAuthFailure(state: AttemptState, status: number, message: string) {
  if (shouldTreatAsGhlSaasAuthFailure(status, message)) {
    state.sawScopeError = true;
  }
}

async function fetchSaasLocationsV3ForLocation(
  baseUrl: string,
  token: string,
  companyId: string,
  ghlLocationId: string,
  state: AttemptState,
  pathPrefix: "/saas/saas-locations" | "/saas-api/public-api/saas-locations",
  version: string
): Promise<GhlSaasSubscriptionFetchResult | null> {
  let sawListOk = false;
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
          Version: version
        }
      });
      state.lastStatus = response.status;
      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        state.lastMessage = ghlErrorMessage(payload, response.status);
        noteAuthFailure(state, response.status, state.lastMessage);
        return null;
      }

      sawListOk = true;
      const row = findGhlSaasLocationRecord(payload, ghlLocationId);
      if (row) {
        const customerId = extractSaasSubscriptionStripeCustomerId(row);
        if (customerId) {
          console.info("[ghl.saas.subscription] ok", {
            ghlLocationId,
            source: "saas-locations-v3",
            companyId,
            page,
            pathPrefix,
            version
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

  if (sawListOk) {
    state.listCompletedWithoutMatch = true;
  }
  return null;
}

const PER_LOCATION_SAAS_ATTEMPTS: Array<{ pathPrefix: string; version: string }> = [
  { pathPrefix: "/saas-api/public-api/get-saas-subscription", version: GHL_SAAS_API_VERSION },
  { pathPrefix: "/saas/get-saas-subscription", version: GHL_SAAS_API_VERSION },
  { pathPrefix: "/saas/location", version: GHL_SAAS_API_VERSION }
];

function perLocationSaasPath(pathPrefix: string, ghlLocationId: string): string {
  if (pathPrefix === "/saas/location") {
    return `/saas/location/${encodeURIComponent(ghlLocationId)}/subscription`;
  }
  return `${pathPrefix}/${encodeURIComponent(ghlLocationId)}`;
}

async function fetchLegacySaasSubscription(
  baseUrl: string,
  token: string,
  companyId: string | null,
  ghlLocationId: string,
  state: AttemptState
): Promise<GhlSaasSubscriptionFetchResult | null> {
  const query = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";

  for (const attempt of PER_LOCATION_SAAS_ATTEMPTS) {
    if (!canFetchGhl(state)) return null;
    const path = perLocationSaasPath(attempt.pathPrefix, ghlLocationId);
    const url = `${baseUrl}${path}${query}`;
    try {
      noteGhlFetch(state);
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          Version: attempt.version
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
          source: path,
          version: attempt.version
        });
        return { ok: true, payload, customerId };
      }

      state.lastMessage = ghlErrorMessage(payload, response.status);
      noteAuthFailure(state, response.status, state.lastMessage);
    } catch (err) {
      state.lastMessage = err instanceof Error ? err.message : String(err);
    }
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

  await reattachLocationToGhlCompany(db, locationId, companyId);

  const companyTokenPick = await getCompanyAccessTokensForGhlLocation(env, db, locationId, {
    preemptiveOAuthRefresh: true
  });
  const oauthScopeOnFile = await getCompanyOAuthScopeSnapshotForLocation(db, locationId);

  if (companyTokenPick.rejectedLocationTypedJwt || companyTokenPick.tokens.length === 0) {
    if (companyTokenPick.rejectedLocationTypedJwt) {
      const explained = explainGhlSaasFetchFailure({
        ghlLocationId: locationId,
        lastStatus: 403,
        lastMessage: "Forbidden resource",
        sawScopeError: true,
        listCompletedWithoutMatch: false,
        oauthScopeOnFile,
        jwtLooksLikeLocation: true
      });
      return {
        ok: false as const,
        status: explained.status,
        error: explained.error,
        code: explained.code,
        oauthScopeOnFile
      };
    }
    return {
      ok: false,
      status: null,
      error: oauthScopeOnFile
        ? "Agency Company OAuth token is present but expired and could not be refreshed. Use Settings → Connect GoHighLevel for the agency. Reinstalling the Marketplace app on a single subaccount does not refresh that token."
        : "No agency-level (Company) OAuth token in AgentFlow. Use Settings → Connect GoHighLevel for the agency. Reinstalling the Marketplace app on a single subaccount does not replace that token.",
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

  const token = companyTokenPick.tokens[0]!;
  const jwtSummary = summarizeGhlTokenForSaas(token);
  const baseUrl = (env.GHL_API_BASE_URL ?? "https://services.leadconnectorhq.com").replace(/\/$/, "");
  const state: AttemptState = {
    lastStatus: null,
    lastMessage: "GHL SaaS request failed",
    sawScopeError: false,
    listCompletedWithoutMatch: false,
    fetchCount: 0,
    maxGhlFetches: fetchOpts?.maxGhlFetches ?? MAX_GHL_FETCHES_PER_SAAS_SYNC,
    maxV3Pages: fetchOpts?.maxV3Pages ?? MAX_SAAS_LOCATIONS_V3_PAGES
  };

  for (const attempt of COMPANY_SAAS_CATALOG_ATTEMPTS) {
    if (!canFetchGhl(state)) break;
    const v3Result = await fetchSaasLocationsV3ForLocation(
      baseUrl,
      token,
      companyId,
      locationId,
      state,
      attempt.pathPrefix,
      attempt.version
    );
    if (v3Result) return v3Result;
    if (state.listCompletedWithoutMatch) break;
  }

  if (!state.listCompletedWithoutMatch) {
    const legacyResult = await fetchLegacySaasSubscription(baseUrl, token, companyId, locationId, state);
    if (legacyResult?.ok) return legacyResult;
    if (legacyResult && !legacyResult.ok && legacyResult.code === "customer_id_missing") {
      return legacyResult;
    }
  }

  const explained = explainGhlSaasFetchFailure({
    ghlLocationId: locationId,
    lastStatus: state.lastStatus,
    lastMessage: state.lastMessage,
    sawScopeError: state.sawScopeError,
    listCompletedWithoutMatch: state.listCompletedWithoutMatch,
    oauthScopeOnFile,
    jwtLooksLikeLocation: jwtSummary.jwtLooksLikeLocation,
    jwtAuthClass: jwtSummary.jwtAuthClass
  });
  return {
    ok: false as const,
    status: explained.status,
    error: explained.error,
    code: explained.code,
    ghlApiMessage: state.lastMessage,
    oauthScopeOnFile
  };
}
