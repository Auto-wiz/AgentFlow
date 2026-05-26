import type { GhlOAuthTokenEnv } from "./ghl-oauth-location-token.js";

const LEAD_CONNECTOR_CALENDAR_VERSIONS = ["2023-02-21", "2021-07-28", "2021-04-15"];

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function stringOrNull(value: unknown): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (typeof value === "string") {
    const t = value.trim();
    return t === "" ? null : t;
  }
  return String(value);
}

function extractCalendarsArray(payload: unknown): unknown[] {
  const root = asRecord(payload);
  if (!root) {
    return [];
  }
  const direct = root.calendars;
  if (Array.isArray(direct)) {
    return direct;
  }
  const data = asRecord(root.data);
  if (data) {
    if (Array.isArray(data.calendars)) {
      return data.calendars;
    }
    if (Array.isArray(data)) {
      return data;
    }
  }
  if (Array.isArray(payload)) {
    return payload;
  }
  return [];
}

function mergeCalendarEntries(map: Map<string, string>, entries: unknown[]) {
  for (const entry of entries) {
    const r = asRecord(entry);
    if (!r) {
      continue;
    }
    const id = stringOrNull(r.id ?? r._id ?? r.calendarId);
    const name = stringOrNull(r.name ?? r.calendarName ?? r.displayName ?? r.label);
    if (id && name) {
      map.set(id, name);
    }
  }
}

function calendarListUrls(baseUrl: string, ghlLocationId: string) {
  return [
    `${baseUrl}/calendars/?locationId=${encodeURIComponent(ghlLocationId)}`,
    `${baseUrl}/calendars?locationId=${encodeURIComponent(ghlLocationId)}`
  ];
}

/**
 * Merge every calendar id → name from GET /calendars for a location (best effort).
 */
export async function fetchFullCalendarCatalogForLocation(
  env: GhlOAuthTokenEnv,
  params: { accessToken: string; ghlLocationId: string }
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const baseUrl = env.GHL_API_BASE_URL ?? "https://services.leadconnectorhq.com";
  const ghlLocationId = params.ghlLocationId.trim();
  if (!ghlLocationId) {
    return out;
  }

  for (const url of calendarListUrls(baseUrl, ghlLocationId)) {
    for (const version of LEAD_CONNECTOR_CALENDAR_VERSIONS) {
      try {
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${params.accessToken}`,
            Accept: "application/json",
            Version: version,
            "Location-Id": ghlLocationId,
            locationId: ghlLocationId
          }
        });
        const rawText = await response.text();
        const parsed = safeJsonParse(rawText);
        if (response.ok) {
          mergeCalendarEntries(out, extractCalendarsArray(parsed));
        }
        if (out.size > 0) {
          return out;
        }
      } catch {
        /* try next */
      }
    }
  }
  return out;
}

/**
 * List calendars for a location (GET /calendars/) and return id → display name.
 * Falls back to GET /calendars/:id when the list response is empty or missing ids.
 * Uses `name` / `calendarName` only on single-calendar fetch (not `title`, which can mirror appointment text).
 */
export async function fetchGhlCalendarNameLookup(
  env: GhlOAuthTokenEnv,
  params: { accessToken: string; ghlLocationId: string; calendarIds: string[] }
): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const baseUrl = env.GHL_API_BASE_URL ?? "https://services.leadconnectorhq.com";
  const uniqueIds = Array.from(new Set(params.calendarIds.map((x) => x.trim()).filter(Boolean)));
  if (uniqueIds.length === 0) {
    return out;
  }

  const ghlLocationId = params.ghlLocationId.trim();
  if (!ghlLocationId) {
    return out;
  }

  for (const url of calendarListUrls(baseUrl, ghlLocationId)) {
    for (const version of LEAD_CONNECTOR_CALENDAR_VERSIONS) {
      try {
        const response = await fetch(url, {
          headers: {
            Authorization: `Bearer ${params.accessToken}`,
            Accept: "application/json",
            Version: version,
            "Location-Id": ghlLocationId,
            locationId: ghlLocationId
          }
        });
        const rawText = await response.text();
        const parsed = safeJsonParse(rawText);
        if (response.ok) {
          mergeCalendarEntries(out, extractCalendarsArray(parsed));
        }
        if (out.size > 0) {
          break;
        }
      } catch {
        /* try next */
      }
    }
    if (out.size > 0) {
      break;
    }
  }

  const missing = uniqueIds.filter((id) => !out.has(id));
  if (missing.length === 0) {
    return out;
  }

  for (const calendarId of missing) {
    for (const version of LEAD_CONNECTOR_CALENDAR_VERSIONS) {
      try {
        const response = await fetch(`${baseUrl}/calendars/${encodeURIComponent(calendarId)}`, {
          headers: {
            Authorization: `Bearer ${params.accessToken}`,
            Accept: "application/json",
            Version: version,
            "Location-Id": ghlLocationId,
            locationId: ghlLocationId
          }
        });
        const rawText = await response.text();
        const parsed = safeJsonParse(rawText);
        if (!response.ok) {
          continue;
        }
        const rec = asRecord(parsed) ?? asRecord(asRecord(parsed)?.calendar) ?? null;
        if (!rec) {
          continue;
        }
        const name = stringOrNull(
          rec.name ?? rec.calendarName ?? rec.displayName ?? rec.label ?? rec.title
        );
        if (name) {
          out.set(calendarId, name);
          break;
        }
      } catch {
        /* continue */
      }
    }
  }

  return out;
}
