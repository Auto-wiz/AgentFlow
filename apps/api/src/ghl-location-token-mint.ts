/**
 * Refresh the agency company token, add installed subaccounts, and mint a
 * location access token for rows that do not have a valid one.
 * Responses never include access or refresh tokens.
 */

import {
  agencies,
  createDb,
  ghlOAuthInstallations,
  ghlPaymentOrders,
  locationBillingConfig,
  locations,
  type AgentFlowDb
} from "@agentflow/db";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";

import { usableGhlCompanyId } from "./ghl-company-id.js";
import {
  addSecondsToNow,
  exchangeCompanyTokenForLocation,
  refreshGhlAccessTokenDetailed,
  upsertLocationOAuthInstallationFromExchange,
  type GhlOAuthRefreshCredentialEnv
} from "./ghl-oauth-location-token.js";
import { sanitizeGhlOAuthError } from "./ghl-oauth-error.js";
import { syncDueOrdersForLocation, type OrderTransactionSyncEnv } from "./ghl-payment-transactions.js";

export type LocationTokenMintEnv = GhlOAuthRefreshCredentialEnv &
  OrderTransactionSyncEnv & {
    GHL_APP_ID?: string;
  };

type CompanyToken = {
  id: string;
  companyId: string;
  accessToken: string;
  refreshToken: string;
};

export type CompanyRefreshReport = {
  companyId: string;
  ok: boolean;
  status: number;
  message: string | null;
};

export type LocationTokenAttempt = {
  ghlLocationId: string;
  name: string | null;
  ok: boolean;
  status: number;
  message: string | null;
  ordersSynced: number;
};

export type LocationTokenMintSummary = {
  ok: boolean;
  companyRefresh: CompanyRefreshReport[];
  checked: number;
  minted: number;
  failed: number;
  remaining: number;
  ordersSynced: number;
  nextAfter: string | null;
  results: LocationTokenAttempt[];
};

export type InstalledLocationDiscovery = {
  ok: boolean;
  companyRefresh: CompanyRefreshReport[];
  companies: Array<{
    companyId: string;
    status: number;
    message: string | null;
    fetched: number;
    added: number;
    nextSkip: number | null;
    installToFutureLocations: boolean | null;
  }>;
};

function asRecord(value: unknown): Record<string, any> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, any>;
}

function stringOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function tokenStillValid(expiresAt: Date | null | undefined) {
  if (!expiresAt) return false;
  return expiresAt.getTime() > Date.now() + 60_000;
}

async function ensureCompanyAccessTokens(
  env: LocationTokenMintEnv,
  db: AgentFlowDb
): Promise<{ tokens: CompanyToken[]; refresh: CompanyRefreshReport[] }> {
  const rows = await db
    .select({
      id: ghlOAuthInstallations.id,
      companyId: ghlOAuthInstallations.companyId,
      accessToken: ghlOAuthInstallations.accessToken,
      refreshToken: ghlOAuthInstallations.refreshToken,
      expiresAt: ghlOAuthInstallations.expiresAt
    })
    .from(ghlOAuthInstallations)
    .where(eq(ghlOAuthInstallations.userType, "Company"));

  const tokens: CompanyToken[] = [];
  const refresh: CompanyRefreshReport[] = [];

  for (const row of rows) {
    const companyId = usableGhlCompanyId(row.companyId);
    if (!companyId) continue;
    if (tokenStillValid(row.expiresAt) && row.accessToken.trim()) {
      tokens.push({
        id: row.id,
        companyId,
        accessToken: row.accessToken.trim(),
        refreshToken: row.refreshToken
      });
      refresh.push({ companyId, ok: true, status: 200, message: null });
      continue;
    }

    const refreshed = await refreshGhlAccessTokenDetailed(env, row.refreshToken, "Company");
    if (!refreshed.ok) {
      refresh.push({
        companyId,
        ok: false,
        status: refreshed.status,
        message: refreshed.message
      });
      continue;
    }

    const now = new Date();
    await db
      .update(ghlOAuthInstallations)
      .set({
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: addSecondsToNow(refreshed.expiresIn),
        updatedAt: now
      })
      .where(eq(ghlOAuthInstallations.id, row.id));

    tokens.push({
      id: row.id,
      companyId,
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken
    });
    refresh.push({ companyId, ok: true, status: 200, message: null });
  }

  return { tokens, refresh };
}

function tokenForCompany(tokens: CompanyToken[], ghlAgencyId: string | null): CompanyToken | null {
  const wanted = usableGhlCompanyId(ghlAgencyId);
  if (wanted) {
    const match = tokens.find((token) => token.companyId === wanted);
    if (match) return match;
  }
  return tokens[0] ?? null;
}

function readInstalledLocations(payload: Record<string, any> | null) {
  const list = payload?.locations ?? payload?.installedLocations ?? payload?.data;
  if (!Array.isArray(list)) return [];
  const rows: Array<{ ghlLocationId: string; name: string | null; isInstalled: boolean | null }> = [];
  for (const item of list) {
    const record = asRecord(item);
    if (!record) continue;
    const ghlLocationId = stringOrNull(record._id ?? record.id ?? record.locationId);
    if (!ghlLocationId) continue;
    const installedFlag = record.isInstalled ?? record.is_installed;
    rows.push({
      ghlLocationId,
      name: stringOrNull(record.name ?? record.locationName),
      isInstalled: typeof installedFlag === "boolean" ? installedFlag : null
    });
  }
  return rows;
}

export async function discoverInstalledGhlLocations(
  env: LocationTokenMintEnv,
  options?: { companyId?: string; skip?: number; limit?: number }
): Promise<InstalledLocationDiscovery> {
  const db = createDb(env.DATABASE_URL);
  const { tokens, refresh } = await ensureCompanyAccessTokens(env, db);
  const wanted = usableGhlCompanyId(options?.companyId);
  const selected = tokens.filter((token) => !wanted || token.companyId === wanted);
  const limit = Math.min(Math.max(options?.limit ?? 20, 1), 40);
  const skip = Math.max(options?.skip ?? 0, 0);
  const baseUrl = env.GHL_API_BASE_URL ?? "https://services.leadconnectorhq.com";
  const appId = env.GHL_APP_ID?.trim();

  if (selected.length === 0) {
    return { ok: false, companyRefresh: refresh, companies: [] };
  }

  const companies: InstalledLocationDiscovery["companies"] = [];
  for (const token of selected) {
    const url = new URL(`${baseUrl}/oauth/installedLocations`);
    url.searchParams.set("companyId", token.companyId);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("skip", String(skip));
    if (appId) url.searchParams.set("appId", appId);

    let status = 0;
    let message: string | null = null;
    let fetched = 0;
    let added = 0;
    let nextSkip: number | null = null;
    let installToFutureLocations: boolean | null = null;

    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${token.accessToken}`,
          Accept: "application/json",
          Version: "2021-07-28"
        }
      });
      status = response.status;
      const raw = asRecord(await response.json().catch(() => ({}))) ?? {};
      if (!response.ok) {
        message = sanitizeGhlOAuthError(response.status, raw);
      } else {
        installToFutureLocations =
          typeof raw.installToFutureLocations === "boolean" ? raw.installToFutureLocations : null;
        const installed = readInstalledLocations(raw).filter((row) => row.isInstalled !== false);
        fetched = installed.length;
        const count = Number(raw.count ?? raw.total ?? 0);
        nextSkip = fetched === 0 ? null : skip + fetched;
        if (Number.isFinite(count) && count > 0 && skip + fetched >= count) nextSkip = null;

        if (installed.length > 0) {
          const now = new Date();
          const [agency] = await db
            .insert(agencies)
            .values({ ghlAgencyId: token.companyId, updatedAt: now })
            .onConflictDoUpdate({
              target: agencies.ghlAgencyId,
              set: { updatedAt: now }
            })
            .returning({ id: agencies.id });

          if (agency) {
            const saved = await db
              .insert(locations)
              .values(
                installed.map((row) => ({
                  agencyId: agency.id,
                  ghlLocationId: row.ghlLocationId,
                  name: row.name,
                  updatedAt: now
                }))
              )
              .onConflictDoUpdate({
                target: locations.ghlLocationId,
                set: {
                  name: sql`COALESCE(${locations.name}, EXCLUDED.name)`,
                  updatedAt: now
                }
              })
              .returning({ id: locations.id, ghlLocationId: locations.ghlLocationId });

            const existingBilling = await db
              .select({ locationId: locationBillingConfig.locationId })
              .from(locationBillingConfig)
              .where(
                inArray(
                  locationBillingConfig.locationId,
                  saved.map((row) => row.id)
                )
              );
            const haveBilling = new Set(existingBilling.map((row) => row.locationId));
            const missingBilling = saved.filter((row) => !haveBilling.has(row.id));
            if (missingBilling.length > 0) {
              await db
                .insert(locationBillingConfig)
                .values(missingBilling.map((row) => ({ locationId: row.id, updatedAt: now })))
                .onConflictDoNothing();
            }
            added = saved.length;
          }
        }
      }
    } catch (error) {
      message = sanitizeGhlOAuthError(0, { message: error instanceof Error ? error.message : "installed_locations_failed" });
    }

    companies.push({
      companyId: token.companyId,
      status,
      message,
      fetched,
      added,
      nextSkip,
      installToFutureLocations
    });
  }

  return {
    ok: companies.some((company) => company.status >= 200 && company.status < 300),
    companyRefresh: refresh,
    companies
  };
}

export type LocationRefreshSummary = {
  ok: boolean;
  checked: number;
  refreshed: number;
  failed: number;
  remaining: number;
  nextAfter: string | null;
  results: Array<{ ghlLocationId: string; ok: boolean; status: number; message: string | null }>;
};

/** Rotate expired per-location refresh tokens. Does not touch the agency company token. */
export async function refreshExpiredLocationOAuthTokens(
  env: LocationTokenMintEnv,
  options?: { limit?: number; after?: string | null; locationId?: string | null }
): Promise<LocationRefreshSummary> {
  const db = createDb(env.DATABASE_URL);
  const limit = Math.min(Math.max(options?.limit ?? 4, 1), 12);
  const after = options?.after?.trim() || null;
  const onlyLocationId = options?.locationId?.trim() || null;
  const filters = [
    eq(ghlOAuthInstallations.userType, "Location"),
    sql`${ghlOAuthInstallations.expiresAt} <= now() + interval '60 seconds'`,
    sql`${ghlOAuthInstallations.locationId} <> ''`
  ];
  if (after) filters.push(sql`${ghlOAuthInstallations.locationId} > ${after}`);
  if (onlyLocationId) filters.push(eq(ghlOAuthInstallations.locationId, onlyLocationId));

  const [remainingRow] = await db
    .select({ remaining: sql<number>`count(*)::int` })
    .from(ghlOAuthInstallations)
    .where(and(...filters));
  const remainingBefore = Number(remainingRow?.remaining ?? 0);

  const rows = await db
    .select({
      id: ghlOAuthInstallations.id,
      locationId: ghlOAuthInstallations.locationId,
      refreshToken: ghlOAuthInstallations.refreshToken
    })
    .from(ghlOAuthInstallations)
    .where(and(...filters))
    .orderBy(asc(ghlOAuthInstallations.updatedAt), asc(ghlOAuthInstallations.locationId))
    .limit(limit);

  const results: LocationRefreshSummary["results"] = [];
  for (const row of rows) {
    const refreshed = await refreshGhlAccessTokenDetailed(env, row.refreshToken, "Location");
    if (!refreshed.ok) {
      await db
        .update(ghlOAuthInstallations)
        .set({ updatedAt: new Date() })
        .where(eq(ghlOAuthInstallations.id, row.id));
      results.push({
        ghlLocationId: row.locationId,
        ok: false,
        status: refreshed.status,
        message: refreshed.message
      });
      continue;
    }
    await db
      .update(ghlOAuthInstallations)
      .set({
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: addSecondsToNow(refreshed.expiresIn),
        updatedAt: new Date()
      })
      .where(eq(ghlOAuthInstallations.id, row.id));
    results.push({ ghlLocationId: row.locationId, ok: true, status: 200, message: null });
  }

  const refreshed = results.filter((result) => result.ok).length;
  return {
    ok: refreshed > 0 || results.length === 0,
    checked: results.length,
    refreshed,
    failed: results.length - refreshed,
    remaining: Math.max(remainingBefore - refreshed, 0),
    nextAfter: rows[rows.length - 1]?.locationId ?? null,
    results
  };
}

export async function syncAuthorizedDueOrders(
  env: LocationTokenMintEnv,
  options?: { locationLimit?: number; perLocation?: number }
): Promise<{ locations: number; ordersSynced: number; ordersFailed: number; results: LocationTokenAttempt[] }> {
  const db = createDb(env.DATABASE_URL);
  const locationLimit = Math.min(Math.max(options?.locationLimit ?? 2, 1), 4);
  const perLocation = Math.min(Math.max(options?.perLocation ?? 4, 1), 4);
  const rows = await db
    .select({
      ghlLocationId: locations.ghlLocationId,
      name: locations.name
    })
    .from(locations)
    .where(
      sql`exists (
        select 1 from ghl_oauth_installations i
        where i.location_id = ${locations.ghlLocationId}
          and i.user_type = 'Location'
          and i.expires_at > now() + interval '60 seconds'
      ) and exists (
        select 1 from ghl_payment_orders o
        where o.location_id = ${locations.id}
          and o.is_deleted = false
          and o.transaction_synced_at is null
          and coalesce(o.ghl_created_at, o.created_at) >= now() - interval '30 days'
          and (o.transaction_sync_after is null or o.transaction_sync_after <= now())
      )`
    )
    .orderBy(asc(locations.ghlLocationId))
    .limit(locationLimit);

  const results: LocationTokenAttempt[] = [];
  let ordersSynced = 0;
  let ordersFailed = 0;
  for (const row of rows) {
    const synced = await syncDueOrdersForLocation(env, row.ghlLocationId, perLocation);
    ordersSynced += synced.ok;
    ordersFailed += synced.failed;
    const reason = Object.keys(synced.reasons)[0] ?? null;
    results.push({
      ghlLocationId: row.ghlLocationId,
      name: row.name,
      ok: synced.failed === 0,
      status: synced.failed === 0 ? 200 : 0,
      message: reason,
      ordersSynced: synced.ok
    });
  }
  return { locations: rows.length, ordersSynced, ordersFailed, results };
}

export async function mintMissingLocationOAuthTokens(
  env: LocationTokenMintEnv,
  options?: {
    limit?: number;
    after?: string | null;
    slot?: number;
    scope?: "all" | "unsynced";
    syncOrderBudget?: number;
  }
): Promise<LocationTokenMintSummary> {
  const db = createDb(env.DATABASE_URL);
  const limit = Math.min(Math.max(options?.limit ?? 4, 1), 8);
  const scope = options?.scope === "unsynced" ? "unsynced" : "all";
  const after = options?.after?.trim() || null;
  const { tokens, refresh } = await ensureCompanyAccessTokens(env, db);

  const missingFilter = sql`not exists (
    select 1 from ghl_oauth_installations i
    where i.location_id = ${locations.ghlLocationId}
      and i.user_type = 'Location'
      and i.expires_at > now() + interval '60 seconds'
  )`;
  const unsyncedFilter = sql`exists (
    select 1 from ghl_payment_orders o
    where o.location_id = ${locations.id}
      and o.is_deleted = false
      and o.transaction_synced_at is null
  )`;
  const filters = [missingFilter];
  if (scope === "unsynced") filters.push(unsyncedFilter);
  if (after) filters.push(sql`${locations.ghlLocationId} > ${after}`);

  const [remainingRow] = await db
    .select({ remaining: sql<number>`count(*)::int` })
    .from(locations)
    .where(and(...filters));
  const remaining = Number(remainingRow?.remaining ?? 0);

  if (tokens.length === 0) {
    return {
      ok: false,
      companyRefresh: refresh,
      checked: 0,
      minted: 0,
      failed: 0,
      remaining,
      ordersSynced: 0,
      nextAfter: after,
      results: []
    };
  }

  let offset = 0;
  if (!after && options?.slot !== undefined && remaining > 0) {
    offset = (Math.abs(options.slot) * limit) % remaining;
  }

  const candidates = await db
    .select({
      locationId: locations.id,
      ghlLocationId: locations.ghlLocationId,
      name: locations.name,
      ghlAgencyId: agencies.ghlAgencyId
    })
    .from(locations)
    .innerJoin(agencies, eq(locations.agencyId, agencies.id))
    .where(and(...filters))
    .orderBy(asc(locations.ghlLocationId))
    .offset(offset)
    .limit(limit);

  const results: LocationTokenAttempt[] = [];
  let ordersSynced = 0;
  let orderBudget = Math.min(Math.max(options?.syncOrderBudget ?? 0, 0), 8);

  for (const candidate of candidates) {
    const company = tokenForCompany(tokens, candidate.ghlAgencyId);
    if (!company) {
      results.push({
        ghlLocationId: candidate.ghlLocationId,
        name: candidate.name,
        ok: false,
        status: 0,
        message: "no_company_token",
        ordersSynced: 0
      });
      continue;
    }

    const exchanged = await exchangeCompanyTokenForLocation(env, {
      companyId: company.companyId,
      ghlLocationId: candidate.ghlLocationId,
      companyAccessToken: company.accessToken
    });
    if (!exchanged.ok) {
      results.push({
        ghlLocationId: candidate.ghlLocationId,
        name: candidate.name,
        ok: false,
        status: exchanged.status,
        message: exchanged.message,
        ordersSynced: 0
      });
      continue;
    }

    await upsertLocationOAuthInstallationFromExchange(db, {
      companyId: company.companyId,
      ghlLocationId: candidate.ghlLocationId,
      fallbackRefreshToken: exchanged.token.refreshToken ? null : company.refreshToken,
      token: exchanged.token
    });

    const now = new Date();
    await db
      .update(ghlPaymentOrders)
      .set({ transactionSyncAfter: now, updatedAt: now })
      .where(
        and(
          eq(ghlPaymentOrders.locationId, candidate.locationId),
          isNull(ghlPaymentOrders.transactionSyncedAt),
          eq(ghlPaymentOrders.isDeleted, false)
        )
      );

    let locationOrdersSynced = 0;
    if (orderBudget > 0) {
      const synced = await syncDueOrdersForLocation(env, candidate.ghlLocationId, Math.min(4, orderBudget));
      locationOrdersSynced = synced.ok;
      ordersSynced += synced.ok;
      orderBudget -= synced.checked;
    }

    results.push({
      ghlLocationId: candidate.ghlLocationId,
      name: candidate.name,
      ok: true,
      status: 200,
      message: null,
      ordersSynced: locationOrdersSynced
    });
  }

  const minted = results.filter((result) => result.ok).length;
  const last = candidates[candidates.length - 1]?.ghlLocationId ?? null;
  return {
    ok: minted > 0 || results.length === 0,
    companyRefresh: refresh,
    checked: results.length,
    minted,
    failed: results.length - minted,
    remaining: Math.max(remaining - minted, 0),
    ordersSynced,
    nextAfter: last,
    results
  };
}
