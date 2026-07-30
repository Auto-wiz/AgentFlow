import type { createDb } from "@agentflow/db";

import {
  extractSaasSubscriptionStripeCustomerId,
  summarizeUnknownJsonShape
} from "./client-charges-logic.js";
import {
  getAccessTokensForLocation,
  getCompanyAccessTokensForGhlLocation,
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
      /** Present when GHL returned JSON but no cus_… was found (undocumented schema). */
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

export async function fetchGhlSaasSubscriptionForLocation(
  env: GhlOAuthTokenEnv,
  db: AgentFlowDb,
  ghlLocationId: string
): Promise<GhlSaasSubscriptionFetchResult> {
  const locationId = ghlLocationId.trim();
  if (!locationId) {
    return { ok: false, status: null, error: "missing_ghl_location_id", code: "missing_location" };
  }

  const companyId = await resolveGhlCompanyIdForLocation(db, locationId);

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
  const path = `/saas/get-saas-subscription/${encodeURIComponent(locationId)}`;
  const query = companyId ? `?companyId=${encodeURIComponent(companyId)}` : "";
  const url = `${baseUrl}${path}${query}`;

  let lastStatus: number | null = null;
  let lastMessage = "GHL SaaS subscription request failed";
  let sawScopeError = false;

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
        lastStatus = response.status;
        const payload = await response.json().catch(() => ({}));
        if (response.ok) {
          const customerId = extractSaasSubscriptionStripeCustomerId(payload);
          if (!customerId) {
            const payloadShape = summarizeUnknownJsonShape(payload);
            console.info("[ghl.saas.subscription] customer_id_missing", {
              ghlLocationId: locationId,
              payloadShape
            });
            return {
              ok: false,
              status: response.status,
              error:
                "SaaS subscription JSON had no Stripe customer id (cus_…). GHL does not publish a sample response — check payloadShape in this error or Worker logs and we can extend the parser.",
              code: "customer_id_missing",
              payloadShape
            };
          }
          const payloadKeys =
            payload && typeof payload === "object" && !Array.isArray(payload)
              ? Object.keys(payload as Record<string, unknown>).slice(0, 12)
              : [];
          console.info("[ghl.saas.subscription] ok", {
            ghlLocationId: locationId,
            apiVersion: version,
            topLevelKeys: payloadKeys
          });
          return { ok: true, payload, customerId };
        }

        lastMessage = ghlErrorMessage(payload, response.status);
        if (isGhlOAuthScopeFailure(response.status, lastMessage)) {
          sawScopeError = true;
          continue;
        }

        if (response.status === 401 || response.status === 403) {
          continue;
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
        lastMessage = err instanceof Error ? err.message : String(err);
      }
    }
  }

  if (sawScopeError || isGhlOAuthScopeFailure(lastStatus ?? 0, lastMessage)) {
    return {
      ok: false,
      status: lastStatus ?? 403,
      error: `GHL OAuth token lacks SaaS scope. ${GHL_SAAS_SCOPE_HELP}`,
      code: "ghl_scope_forbidden"
    };
  }

  if (lastStatus === 403) {
    return {
      ok: false,
      status: 403,
      error: GHL_SAAS_SCOPE_HELP,
      code: "ghl_scope_forbidden"
    };
  }

  return {
    ok: false,
    status: lastStatus,
    error: lastMessage,
    code: "ghl_saas_fetch_failed"
  };
}
