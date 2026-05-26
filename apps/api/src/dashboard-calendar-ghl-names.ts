import type { AgentFlowDb } from "@agentflow/db";
import { locationCalendars } from "@agentflow/db";
import { eq } from "drizzle-orm";

import { upsertLocationCalendarCanonicalNameFromGhlApi } from "./ghl-dimension-sync.js";
import { fetchFullCalendarCatalogForLocation, fetchGhlCalendarNameLookup } from "./ghl-calendar-remote.js";
import type { GhlOAuthTokenEnv } from "./ghl-oauth-location-token.js";
import { getAccessTokensForLocation } from "./ghl-oauth-location-token.js";

function lookupCalendarNameCaseInsensitive(map: Map<string, string>, calendarId: string): string | undefined {
  const t = calendarId.trim();
  if (!t || map.size === 0) {
    return undefined;
  }
  const direct = map.get(t);
  if (direct !== undefined && direct.trim() !== "") {
    return direct;
  }
  const tl = t.toLowerCase();
  for (const [k, v] of map) {
    if (k.trim().toLowerCase() === tl && v.trim() !== "") {
      return v;
    }
  }
  return undefined;
}

/** True when the breakdown label is our SQL/UI fallback instead of a real calendar name. */
function looksLikeSyntheticCalendarBucketName(name: string, ghlCalendarId: string | null | undefined): boolean {
  if (!ghlCalendarId || typeof name !== "string") {
    return false;
  }
  const id = ghlCalendarId.trim();
  const n = name.trim();
  if (id === "" || n === "" || n === "No calendar") {
    return false;
  }
  if (/^calendar\s*[·\-]/i.test(n)) {
    return true;
  }
  if (/\bcalendar\b/i.test(n) && n.includes(id)) {
    return true;
  }
  return false;
}

/**
 * Persist the full GET /calendars catalog for this location into `location_calendars` so joins in dashboard SQL
 * resolve real calendar names (not appointment titles synced from webhooks).
 */
export async function hydrateLocationCalendarCatalogFromGhlIntoDb(
  env: GhlOAuthTokenEnv,
  db: AgentFlowDb,
  internalLocationId: string,
  ghlLocationId: string | null | undefined
): Promise<void> {
  const trimmedGhlLoc = typeof ghlLocationId === "string" ? ghlLocationId.trim() : "";
  if (!trimmedGhlLoc) {
    return;
  }
  const tokens = await getAccessTokensForLocation(env, db, trimmedGhlLoc);
  if (tokens.length === 0) {
    return;
  }

  const now = new Date();
  for (const accessToken of tokens) {
    const catalog = await fetchFullCalendarCatalogForLocation(env, {
      accessToken,
      ghlLocationId: trimmedGhlLoc
    });
    if (catalog.size === 0) {
      continue;
    }
    await Promise.all(
      [...catalog.entries()].map(([ghlCalendarId, canonicalName]) =>
        upsertLocationCalendarCanonicalNameFromGhlApi(db, {
          locationId: internalLocationId,
          ghlCalendarId,
          canonicalName,
          now
        })
      )
    );
    return;
  }
}

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
      const canonical = lookupCalendarNameCaseInsensitive(nameById, calendarId);
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
    const canonical = lookupCalendarNameCaseInsensitive(nameById, cid);
    if (!canonical || canonical.trim() === "") {
      return row;
    }
    return { ...row, name: canonical } as T;
  });
}

/**
 * Re-read names from `location_calendars` using case-insensitive id match — fixes dashboards when join keys
 * differ only by casing or when rows were hydrated after the aggregate query cached no match.
 */
export async function reconcileCalendarBucketsWithStoredLocationCalendarNames<
  T extends { ghlCalendarId: string | null; name: string; bookedCount: number }
>(
  db: AgentFlowDb,
  internalLocationId: string,
  rows: T[]
): Promise<T[]> {
  const storedRows = await db
    .select({
      ghlCalendarId: locationCalendars.ghlCalendarId,
      name: locationCalendars.name
    })
    .from(locationCalendars)
    .where(eq(locationCalendars.locationId, internalLocationId));

  const lowerToName = new Map<string, string>();
  for (const r of storedRows) {
    const id = (r.ghlCalendarId ?? "").trim();
    const nm = (r.name ?? "").trim();
    if (id && nm) {
      lowerToName.set(id.toLowerCase(), nm);
    }
  }

  return rows.map((row) => {
    const cid = row.ghlCalendarId?.trim();
    if (!cid) {
      return row;
    }
    const storedName = lowerToName.get(cid.toLowerCase());
    if (!storedName || looksLikeSyntheticCalendarBucketName(storedName, cid)) {
      return row;
    }
    if (looksLikeSyntheticCalendarBucketName(row.name, row.ghlCalendarId ?? null)) {
      return { ...row, name: storedName } as T;
    }
    return row;
  });
}
