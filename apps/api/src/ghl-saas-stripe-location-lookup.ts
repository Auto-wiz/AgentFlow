import type { createDb } from "@agentflow/db";

import { normalizeStripeCustomerId, parseGhlLocationIdsFromSaasLocationsLookupPayload } from "./client-charges-logic.js";
import { getCompanyAccessTokensForGhlCompanyId, type GhlOAuthTokenEnv } from "./ghl-oauth-location-token.js";

export type AgentFlowDb = ReturnType<typeof createDb>;

function ghlErrorMessage(payload: unknown, status: number): string {
  const body = payload && typeof payload === "object" && !Array.isArray(payload) ? (payload as Record<string, unknown>) : null;
  const msg =
    (typeof body?.message === "string" && body.message) ||
    (typeof body?.error === "string" && body.error) ||
    "";
  return msg || `HTTP ${status}`;
}

/**
 * Resolve GHL subaccount ids for a Stripe customer/subscription via GHL SaaS API.
 * GET /saas/locations?companyId=…&customerId=…&subscriptionId=…
 */
export async function fetchGhlLocationIdsForStripeBilling(
  env: GhlOAuthTokenEnv,
  db: AgentFlowDb,
  opts: {
    ghlCompanyId: string;
    stripeCustomerId?: string | null;
    stripeSubscriptionId?: string | null;
  }
): Promise<
  | { ok: true; ghlLocationIds: string[]; source: string; diagnostics?: string }
  | { ok: false; code: string; error: string }
> {
  const companyId = opts.ghlCompanyId.trim();
  const customerId = normalizeStripeCustomerId(opts.stripeCustomerId);
  const subscriptionId = opts.stripeSubscriptionId?.trim() ?? null;

  if (!companyId) {
    return { ok: false, code: "missing_company_id", error: "ghlCompanyId is required" };
  }
  if (!customerId && !subscriptionId) {
    return {
      ok: false,
      code: "missing_stripe_lookup_keys",
      error: "Provide stripeCustomerId and/or stripeSubscriptionId"
    };
  }

  let tokens = await getCompanyAccessTokensForGhlCompanyId(env, db, companyId, {
    preemptiveOAuthRefresh: false
  });
  if (tokens.length === 0) {
    tokens = await getCompanyAccessTokensForGhlCompanyId(env, db, companyId, {
      preemptiveOAuthRefresh: true
    });
  }
  const token = tokens[0];
  if (!token) {
    return {
      ok: false,
      code: "company_oauth_token_missing",
      error: "No agency Company OAuth token — connect GoHighLevel for the agency."
    };
  }

  const baseUrl = (env.GHL_API_BASE_URL ?? "https://services.leadconnectorhq.com").replace(/\/$/, "");
  const pathPrefixes = ["/saas/locations", "/saas-api/public-api/locations"] as const;
  const versions = ["2021-04-15", "v3"] as const;
  const attemptErrors: string[] = [];

  const paramSets: URLSearchParams[] = [];
  {
    const both = new URLSearchParams({ companyId });
    if (customerId) both.set("customerId", customerId);
    if (subscriptionId) both.set("subscriptionId", subscriptionId);
    paramSets.push(both);
  }
  if (customerId) {
    paramSets.push(new URLSearchParams({ companyId, customerId }));
  }
  if (subscriptionId) {
    paramSets.push(new URLSearchParams({ companyId, subscriptionId }));
  }

  for (const params of paramSets) {
    for (const pathPrefix of pathPrefixes) {
      for (const version of versions) {
        const url = `${baseUrl}${pathPrefix}?${params.toString()}`;
        try {
          const response = await fetch(url, {
            method: "GET",
            headers: {
              Authorization: `Bearer ${token}`,
              Accept: "application/json",
              Version: version
            }
          });
          const payload = await response.json().catch(() => ({}));
          if (!response.ok) {
            attemptErrors.push(`${pathPrefix} (${version}): ${ghlErrorMessage(payload, response.status)}`);
            continue;
          }
          const ghlLocationIds = parseGhlLocationIdsFromSaasLocationsLookupPayload(payload);
          if (ghlLocationIds.length > 0) {
            return { ok: true, ghlLocationIds, source: `${pathPrefix} (${version})` };
          }
          attemptErrors.push(`${pathPrefix} (${version}): empty result`);
        } catch (err) {
          attemptErrors.push(
            `${pathPrefix} (${version}): ${err instanceof Error ? err.message : String(err)}`
          );
        }
      }
    }
  }

  const diagnostics = attemptErrors.slice(-4).join(" | ") || "GHL SaaS location lookup returned no rows";
  return { ok: true, ghlLocationIds: [], source: "none", diagnostics };
}
