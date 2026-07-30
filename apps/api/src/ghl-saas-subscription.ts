import type { createDb } from "@agentflow/db";

import {
  extractSaasSubscriptionStripeCustomerId,
  summarizeUnknownJsonShape
} from "./client-charges-logic.js";
import {
  getAccessTokensForLocation,
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

export async function fetchGhlSaasSubscriptionForLocation(
  env: GhlOAuthTokenEnv,
  db: AgentFlowDb,
  ghlLocationId: string
): Promise<GhlSaasSubscriptionFetchResult> {
  const locationId = ghlLocationId.trim();
  if (!locationId) {
    return { ok: false, status: null, error: "missing_ghl_location_id", code: "missing_location" };
  }

  const tokens = await getAccessTokensForLocation(env, db, locationId, {
    preemptiveOAuthRefresh: true
  });
  if (tokens.length === 0) {
    return {
      ok: false,
      status: null,
      error: "No GHL access token available for this location",
      code: "ghl_token_missing"
    };
  }

  const baseUrl = (env.GHL_API_BASE_URL ?? "https://services.leadconnectorhq.com").replace(/\/$/, "");
  const url = `${baseUrl}/saas/get-saas-subscription/${encodeURIComponent(locationId)}`;

  let lastStatus: number | null = null;
  let lastMessage = "GHL SaaS subscription request failed";

  for (const token of tokens) {
    try {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          Version: "2021-07-28"
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
        console.info("[ghl.saas.subscription] ok", { ghlLocationId: locationId, topLevelKeys: payloadKeys });
        return { ok: true, payload, customerId };
      }

      const body = asRecord(payload);
      lastMessage =
        (typeof body?.message === "string" && body.message) ||
        (typeof body?.error === "string" && body.error) ||
        `HTTP ${response.status}`;

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

  if (lastStatus === 403) {
    return {
      ok: false,
      status: 403,
      error:
        "GHL denied SaaS subscription access — add the SaaS scope to the Autowiz app and reinstall OAuth for the agency.",
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
