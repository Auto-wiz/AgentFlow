import { locations, type AgentFlowDb } from "@agentflow/db";
import { eq } from "drizzle-orm";

import { getAccessTokensForLocation, type GhlOAuthTokenEnv } from "./ghl-oauth-location-token.js";
import {
  locationNameNeedsGhlRefresh,
  overlayLocationDisplayName
} from "./location-display-name-policy.js";

export {
  catalogNamePreservingStored,
  locationNameNeedsGhlRefresh,
  overlayLocationDisplayName
} from "./location-display-name-policy.js";

export type LocationDisplayNameEntry = {
  locationId: string;
  ghlLocationId: string;
  locationName: string | null;
};

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

async function fetchLocationNameWithToken(
  env: GhlOAuthTokenEnv,
  ghlLocationId: string,
  accessToken: string
): Promise<string | null> {
  const baseUrl = env.GHL_API_BASE_URL ?? "https://services.leadconnectorhq.com";
  const endpoint = new URL(`/locations/${encodeURIComponent(ghlLocationId)}`, baseUrl);
  try {
    const response = await fetch(endpoint, {
      headers: {
        Accept: "application/json",
        Version: "2021-07-28",
        Authorization: `Bearer ${accessToken}`
      }
    });
    if (!response.ok) return null;
    const data = asRecord(await response.json().catch(() => null));
    const location = asRecord(data.location ?? data.data ?? data);
    return stringOrNull(location.name ?? location.locationName ?? location.businessName);
  } catch {
    return null;
  }
}

export async function fetchGhlLocationDisplayName(
  env: GhlOAuthTokenEnv,
  db: AgentFlowDb,
  ghlLocationId: string,
  tokenCache?: Map<string, string[]>
): Promise<string | null> {
  let tokens = tokenCache?.get(ghlLocationId);
  if (!tokens) {
    tokens = await getAccessTokensForLocation(env, db, ghlLocationId, { hydrateBatchMode: true });
    tokenCache?.set(ghlLocationId, tokens);
  }
  const tryTokens = tokens.length > 4 ? tokens.slice(0, 4) : tokens;
  for (const accessToken of tryTokens) {
    const name = await fetchLocationNameWithToken(env, ghlLocationId, accessToken);
    if (name) return name;
  }
  return null;
}

/**
 * Overlay (and persist) GHL Location API display names onto a small result set.
 * Client Charges uses `refreshExisting: true` so renamed subaccounts replace stale DB labels.
 */
export async function refreshLocationDisplayNames(
  env: GhlOAuthTokenEnv,
  db: AgentFlowDb,
  entries: LocationDisplayNameEntry[],
  opts?: { refreshExisting?: boolean; maxLookups?: number }
): Promise<Map<string, string | null>> {
  const locationNameMap = new Map(entries.map((entry) => [entry.locationId, entry.locationName]));
  const refreshExisting = opts?.refreshExisting === true;
  const maxLookups = opts?.maxLookups;
  const budgetCap =
    typeof maxLookups === "number" && Number.isFinite(maxLookups) ? Math.max(0, Math.floor(maxLookups)) : 15;
  let budget = budgetCap;
  const tokenCache = new Map<string, string[]>();

  for (const entry of entries) {
    if (budget <= 0) break;
    if (!locationNameNeedsGhlRefresh(entry.locationName, refreshExisting)) continue;
    budget -= 1;
    try {
      const fetched = await fetchGhlLocationDisplayName(env, db, entry.ghlLocationId, tokenCache);
      const next = overlayLocationDisplayName(entry.locationName, fetched);
      locationNameMap.set(entry.locationId, next);
      if (!fetched) continue;
      const prior = typeof entry.locationName === "string" ? entry.locationName.trim() : "";
      if (next === prior) {
        await db
          .update(locations)
          .set({ locationNameSyncedAt: new Date() })
          .where(eq(locations.id, entry.locationId));
        continue;
      }
      await db
        .update(locations)
        .set({ name: next, updatedAt: new Date(), locationNameSyncedAt: new Date() })
        .where(eq(locations.id, entry.locationId));
    } catch (caught) {
      console.warn("[refreshLocationDisplayNames] lookup failed", {
        locationId: entry.locationId,
        ghlLocationId: entry.ghlLocationId,
        caught
      });
    }
  }

  return locationNameMap;
}
