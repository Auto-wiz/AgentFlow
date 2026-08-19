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

  let tokens: string[] = [];
  try {
    tokens = await getCompanyAccessTokensForGhlCompanyId(env, db, companyId, {
      preemptiveOAuthRefresh: false
    });
    if (tokens.length === 0) {
      tokens = await getCompanyAccessTokensForGhlCompanyId(env, db, companyId, {
        preemptiveOAuthRefresh: true
      });
    }
  } catch (err) {
    return {
      ok: false,
      code: "company_oauth_token_lookup_failed",
      error: err instanceof Error ? err.message : String(err)
    };
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
  const attemptErrors: string[] = [];

  /** Primary SaaS lookup — keep ≤3 fetches so Stripe subs sync stays under Workers subrequest limits. */
  const primaryAttempts: Array<{ pathPrefix: string; version: string; params: URLSearchParams }> = [];
  {
    const both = new URLSearchParams({ companyId });
    if (customerId) both.set("customerId", customerId);
    if (subscriptionId) both.set("subscriptionId", subscriptionId);
    primaryAttempts.push({ pathPrefix: "/saas/locations", version: "v3", params: both });
  }
  if (customerId) {
    primaryAttempts.push({
      pathPrefix: "/saas/locations",
      version: "v3",
      params: new URLSearchParams({ companyId, customerId })
    });
  }
  if (subscriptionId) {
    primaryAttempts.push({
      pathPrefix: "/saas/locations",
      version: "v3",
      params: new URLSearchParams({ companyId, subscriptionId })
    });
  }

  async function tryLookup(pathPrefix: string, version: string, params: URLSearchParams) {
    const url = `${baseUrl}${pathPrefix}?${params.toString()}`;
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
      return null;
    }
    const ghlLocationIds = parseGhlLocationIdsFromSaasLocationsLookupPayload(payload);
    if (ghlLocationIds.length > 0) {
      return { ghlLocationIds, source: `${pathPrefix} (${version})` };
    }
    attemptErrors.push(`${pathPrefix} (${version}): empty result`);
    return null;
  }

  for (const attempt of primaryAttempts) {
    try {
      const hit = await tryLookup(attempt.pathPrefix, attempt.version, attempt.params);
      if (hit) {
        return { ok: true, ghlLocationIds: hit.ghlLocationIds, source: hit.source };
      }
    } catch (err) {
      attemptErrors.push(
        `${attempt.pathPrefix} (${attempt.version}): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /** Fallback paths only when primary v3 /saas/locations returned nothing (1 extra fetch max). */
  if (customerId) {
    try {
      const hit = await tryLookup(
        "/saas-api/public-api/locations",
        "2021-04-15",
        new URLSearchParams({ companyId, customerId })
      );
      if (hit) {
        return { ok: true, ghlLocationIds: hit.ghlLocationIds, source: hit.source };
      }
    } catch (err) {
      attemptErrors.push(
        `/saas-api/public-api/locations (2021-04-15): ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const diagnostics = attemptErrors.slice(-4).join(" | ") || "GHL SaaS location lookup returned no rows";
  return { ok: true, ghlLocationIds: [], source: "none", diagnostics };
}
