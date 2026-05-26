import type { AgentFlowDb } from "@agentflow/db";

import {
  upsertLocationCalendarCanonicalNameFromGhlApi
} from "./ghl-dimension-sync.js";
import { fetchGhlCalendarNameLookup } from "./ghl-calendar-remote.js";
import type { GhlOAuthTokenEnv } from "./ghl-oauth-location-token.js";
import { getAccessTokensForLocation } from "./ghl-oauth-location-token.js";

/** Replace calendar buckets that used appointment/service titles with GHL canonical calendar names when OAuth allows. */
export async function hydrateDashboardCalendarBucketsWithGhlCanonicalNames<T extends {
  ghlCalendarId: string | null;
  name: string;
  bookedCount: number;
}>(
  env: GhlOAuthTokenEnv,
  db: AgentFlowDb,
  internalLocationId: string,
  ghlLocationId: string | null | undefined,
  rows: T[]
): Promise<T[]> {
  const trimmedGhlLoc = typeof ghlLocationId === "string" ? ghlLocationId.trim() : "";
  if (!trimmedGhlLoc || rows.length === 0) {
    return rows;
  }

  const neededIds = Array.from(
    new Set(
      rows
        .map((r) => r.ghlCalendarId)
        .filter((cid): cid is string => typeof cid === "string" && cid.trim() !== "")
        .map((cid) => cid.trim())
    )
  );
  if (neededIds.length === 0) {
    return rows;
  }

  const tokens = await getAccessTokensForLocation(env, db, trimmedGhlLoc);
  if (tokens.length === 0) {
    return rows;
  }

  const now = new Date();
  let nameById = new Map<string, string>();

  for (const accessToken of tokens) {
    const map = await fetchGhlCalendarNameLookup(env, {
      accessToken,
      ghlLocationId: trimmedGhlLoc,
      calendarIds: neededIds
    });
    if (map.size > 0) {
      nameById = map;
      break;
    }
  }

  await Promise.all(
    neededIds.map(async (calendarId) => {
      const canonical = nameById.get(calendarId);
      if (!canonical) {
        return;
      }
      await upsertLocationCalendarCanonicalNameFromGhlApi(db, {
        locationId: internalLocationId,
        ghlCalendarId: calendarId,
        canonicalName: canonical,
        now
      });
    })
  );

  return rows.map((row) => {
    const cid = row.ghlCalendarId?.trim();
    if (!cid) {
      return row;
    }
    const canonical = nameById.get(cid);
    if (!canonical || canonical.trim() === "") {
      return row;
    }
    return { ...row, name: canonical } as T;
  });
}
