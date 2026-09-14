import { agencies, ghlOAuthInstallations, locations } from "@agentflow/db";
import type { AgentFlowDb } from "@agentflow/db";
import { and, desc, eq, or, sql } from "drizzle-orm";

import { ghlJwtScopeIncludesSaas, pickCompanyTypedAccessTokens } from "./ghl-access-token-claims.js";
import { pickFirstUsableGhlCompanyId, usableGhlCompanyId } from "./ghl-company-id.js";

/** Bindings touched by OAuth token retrieval (compatible with Workers `Env` in index.ts). */
export type GhlOAuthTokenEnv = {
  GHL_API_BASE_URL?: string;
  GHL_API_TOKEN?: string;
};

/** Subset needed for oauth/token refresh_grant (matches Workers `Env` fields). */
export type GhlOAuthRefreshCredentialEnv = GhlOAuthTokenEnv & {
  GHL_CLIENT_ID?: string;
  GHL_CLIENT_SECRET?: string;
  GHL_OAUTH_USER_TYPE?: string;
};

function asRecord(value: unknown): Record<string, any> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, any>;
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

export function addSecondsToNow(seconds: number) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  return new Date(Date.now() + safeSeconds * 1000);
}

async function exchangeLocationAccessTokenFromCompanyToken(
  env: GhlOAuthTokenEnv,
  params: {
    companyId: string;
    ghlLocationId: string;
    companyAccessToken: string;
  }
) {
  const baseUrl = env.GHL_API_BASE_URL ?? "https://services.leadconnectorhq.com";
  const requestBody = new URLSearchParams({
    companyId: params.companyId,
    locationId: params.ghlLocationId
  });

  try {
    const response = await fetch(`${baseUrl}/oauth/locationToken`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${params.companyAccessToken}`,
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
        Version: "2021-07-28"
      },
      body: requestBody.toString()
    });
    const raw = asRecord(await response.json().catch(() => ({}))) ?? {};
    if (!response.ok) {
      return null;
    }

    const accessToken = stringOrNull(raw.access_token ?? raw.accessToken);
    if (!accessToken) {
      return null;
    }

    return {
      accessToken,
      refreshToken: stringOrNull(raw.refresh_token ?? raw.refreshToken),
      tokenType: stringOrNull(raw.token_type ?? raw.tokenType) ?? "Bearer",
      expiresIn: Number(raw.expires_in ?? raw.expiresIn ?? 86400),
      scope: stringOrNull(raw.scope),
      userId: stringOrNull(raw.userId ?? raw.user_id),
      raw
    };
  } catch {
    return null;
  }
}

async function upsertLocationOAuthInstallationFromExchange(
  db: AgentFlowDb,
  params: {
    companyId: string;
    ghlLocationId: string;
    fallbackRefreshToken: string | null;
    token: {
      accessToken: string;
      refreshToken: string | null;
      tokenType: string;
      expiresIn: number;
      scope: string | null;
      userId: string | null;
      raw: Record<string, any>;
    };
  }
) {
  const now = new Date();
  let refreshToken = params.token.refreshToken ?? params.fallbackRefreshToken;
  if (!refreshToken) {
    const [existing] = await db
      .select({
        refreshToken: ghlOAuthInstallations.refreshToken
      })
      .from(ghlOAuthInstallations)
      .where(
        and(
          eq(ghlOAuthInstallations.companyId, params.companyId),
          eq(ghlOAuthInstallations.locationId, params.ghlLocationId),
          eq(ghlOAuthInstallations.userType, "Location")
        )
      )
      .limit(1);
    refreshToken = existing?.refreshToken ?? null;
  }
  if (!refreshToken) {
    return;
  }

  const values = {
    companyId: params.companyId,
    locationId: params.ghlLocationId,
    userId: params.token.userId,
    userType: "Location" as const,
    accessToken: params.token.accessToken,
    refreshToken,
    tokenType: params.token.tokenType,
    scope: params.token.scope,
    refreshTokenId: stringOrNull(
      params.token.raw.refreshTokenId ?? params.token.raw.refresh_token_id
    ),
    expiresAt: addSecondsToNow(params.token.expiresIn),
    raw: params.token.raw,
    updatedAt: now
  };

  await db
    .insert(ghlOAuthInstallations)
    .values(values)
    .onConflictDoUpdate({
      target: [
        ghlOAuthInstallations.companyId,
        ghlOAuthInstallations.locationId,
        ghlOAuthInstallations.userType
      ],
      set: values
    });
}

async function getCompanyOAuthInstallationsForLocationInternal(db: AgentFlowDb, ghlLocationId: string) {
  const readCompanyInstallations = async (companyId?: string | null) => {
    const filters = [eq(ghlOAuthInstallations.userType, "Company")];
    if (companyId) {
      filters.push(eq(ghlOAuthInstallations.companyId, companyId));
    }

    try {
      return await db
        .select({
          companyId: ghlOAuthInstallations.companyId,
          locationId: ghlOAuthInstallations.locationId,
          userType: ghlOAuthInstallations.userType,
          accessToken: ghlOAuthInstallations.accessToken,
          refreshToken: ghlOAuthInstallations.refreshToken,
          scope: ghlOAuthInstallations.scope,
          expiresAt: ghlOAuthInstallations.expiresAt,
          updatedAt: ghlOAuthInstallations.updatedAt
        })
        .from(ghlOAuthInstallations)
        .where(and(...filters))
        .orderBy(desc(ghlOAuthInstallations.updatedAt))
        .limit(5);
    } catch {
      return [];
    }
  };

  let locationWithAgency: { ghlAgencyId: string } | undefined;
  try {
    [locationWithAgency] = await db
      .select({
        ghlAgencyId: agencies.ghlAgencyId
      })
      .from(locations)
      .innerJoin(agencies, eq(locations.agencyId, agencies.id))
      .where(eq(locations.ghlLocationId, ghlLocationId))
      .limit(1);
  } catch {
    return [];
  }

  if (usableGhlCompanyId(locationWithAgency?.ghlAgencyId)) {
    const agencyCompanyInstallations = await readCompanyInstallations(locationWithAgency!.ghlAgencyId);
    if (agencyCompanyInstallations.length > 0) {
      return agencyCompanyInstallations;
    }
  }

  try {
    const [locationInstallation] = await db
      .select({
        companyId: ghlOAuthInstallations.companyId
      })
      .from(ghlOAuthInstallations)
      .where(eq(ghlOAuthInstallations.locationId, ghlLocationId))
      .orderBy(desc(ghlOAuthInstallations.updatedAt))
      .limit(1);

    if (locationInstallation?.companyId) {
      const inferredCompanyInstallations = await readCompanyInstallations(locationInstallation.companyId);
      if (inferredCompanyInstallations.length > 0) {
        return inferredCompanyInstallations;
      }
    }
  } catch {
    // Fall through to the newest Company token on file.
  }

  return readCompanyInstallations();
}

export function oauthInstallationScopeIncludesSaas(scope: string | null | undefined): boolean {
  const raw = scope?.trim().toLowerCase();
  if (!raw) return true;
  return raw.includes("saas/") || raw.includes("saas.");
}

export async function getCompanyOAuthScopeSnapshotForLocation(db: AgentFlowDb, ghlLocationId: string) {
  const rows = await getCompanyOAuthInstallationsForLocationInternal(db, ghlLocationId);
  if (rows[0]?.scope?.trim()) return rows[0].scope.trim();
  const recent = await getRecentCompanyOAuthInstallations(db, 3);
  for (const row of recent) {
    if (row.scope?.trim()) return row.scope.trim();
  }
  return null;
}

async function getRecentCompanyOAuthInstallations(db: AgentFlowDb, limit = 5) {
  const safeLimit = Math.max(1, Math.min(limit, 20));
  return db
    .select({
      companyId: ghlOAuthInstallations.companyId,
      locationId: ghlOAuthInstallations.locationId,
      userType: ghlOAuthInstallations.userType,
      accessToken: ghlOAuthInstallations.accessToken,
      refreshToken: ghlOAuthInstallations.refreshToken,
      scope: ghlOAuthInstallations.scope,
      expiresAt: ghlOAuthInstallations.expiresAt,
      updatedAt: ghlOAuthInstallations.updatedAt
    })
    .from(ghlOAuthInstallations)
    .where(eq(ghlOAuthInstallations.userType, "Company"))
    .orderBy(desc(ghlOAuthInstallations.updatedAt))
    .limit(safeLimit);
}

export function normalizeOAuthUserType(value: string | null) {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "location") {
    return "Location";
  }
  return "Company";
}

export async function refreshGhlAccessTokenWithRefreshToken(
  env: GhlOAuthRefreshCredentialEnv,
  refreshToken: string,
  installationUserType: string | null
) {
  const clientId = env.GHL_CLIENT_ID?.trim();
  const clientSecret = env.GHL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    return null;
  }

  const baseUrl = env.GHL_API_BASE_URL ?? "https://services.leadconnectorhq.com";
  const configuredUserType = normalizeOAuthUserType(
    stringOrNull(installationUserType) ?? env.GHL_OAUTH_USER_TYPE ?? "Company"
  );
  const fallbackUserType = configuredUserType === "Company" ? "Location" : "Company";
  const userTypeAttempts = [configuredUserType, fallbackUserType];

  for (const userType of userTypeAttempts) {
    const requestBody = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      user_type: userType
    });
    try {
      const response = await fetch(`${baseUrl}/oauth/token`, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded"
        },
        body: requestBody.toString()
      });
      const raw = asRecord(await response.json().catch(() => ({}))) ?? {};
      if (!response.ok) {
        continue;
      }
      const nextAccessToken = stringOrNull(raw.access_token ?? raw.accessToken);
      if (!nextAccessToken) {
        continue;
      }
      return {
        accessToken: nextAccessToken,
        refreshToken: stringOrNull(raw.refresh_token ?? raw.refreshToken) ?? refreshToken,
        expiresIn: Number(raw.expires_in ?? raw.expiresIn ?? 86400)
      };
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * Rotate access tokens via refresh_token for Location + Agency Company installs scoped to `ghlLocationId`.
 */
export async function refreshOAuthAccessTokensForLocation(
  env: GhlOAuthRefreshCredentialEnv,
  db: AgentFlowDb,
  ghlLocationId: string
): Promise<number> {
  const clientId = env.GHL_CLIENT_ID?.trim();
  const clientSecret = env.GHL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    return 0;
  }

  const [locationWithAgency] = await db
    .select({
      ghlAgencyId: agencies.ghlAgencyId
    })
    .from(locations)
    .innerJoin(agencies, eq(locations.agencyId, agencies.id))
    .where(eq(locations.ghlLocationId, ghlLocationId))
    .limit(1);

  const filters = [eq(ghlOAuthInstallations.locationId, ghlLocationId)];
  if (locationWithAgency?.ghlAgencyId) {
    filters.push(
      and(
        eq(ghlOAuthInstallations.companyId, locationWithAgency.ghlAgencyId),
        eq(ghlOAuthInstallations.userType, "Company")
      )!
    );
  }

  let installations = await db
    .select({
      id: ghlOAuthInstallations.id,
      refreshToken: ghlOAuthInstallations.refreshToken,
      userType: ghlOAuthInstallations.userType
    })
    .from(ghlOAuthInstallations)
    .where(or(...filters))
    .orderBy(desc(ghlOAuthInstallations.updatedAt))
    .limit(8);

  const companyInstallations = await db
    .select({
      id: ghlOAuthInstallations.id,
      refreshToken: ghlOAuthInstallations.refreshToken,
      userType: ghlOAuthInstallations.userType
    })
    .from(ghlOAuthInstallations)
    .where(eq(ghlOAuthInstallations.userType, "Company"))
    .orderBy(desc(ghlOAuthInstallations.updatedAt))
    .limit(8);
  const seenInstallationIds = new Set(installations.map((row) => row.id));
  for (const installation of companyInstallations) {
    if (seenInstallationIds.has(installation.id)) {
      continue;
    }
    seenInstallationIds.add(installation.id);
    installations.push(installation);
  }

  let refreshedCount = 0;
  for (const installation of installations) {
    const rt = installation.refreshToken?.trim();
    if (!rt) {
      continue;
    }
    const refreshed = await refreshGhlAccessTokenWithRefreshToken(env, rt, installation.userType);
    if (!refreshed) {
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
      .where(eq(ghlOAuthInstallations.id, installation.id));
    refreshedCount += 1;
  }

  return refreshedCount;
}

/** Rotate Company OAuth rows for a GHL agency id (used when catalog sync has no location row yet). */
export async function refreshOAuthAccessTokensForCompany(
  env: GhlOAuthRefreshCredentialEnv,
  db: AgentFlowDb,
  ghlCompanyId: string
): Promise<number> {
  const clientId = env.GHL_CLIENT_ID?.trim();
  const clientSecret = env.GHL_CLIENT_SECRET?.trim();
  if (!clientId || !clientSecret) {
    return 0;
  }

  const companyId = ghlCompanyId.trim();
  if (!companyId) {
    return 0;
  }

  const installations = await db
    .select({
      id: ghlOAuthInstallations.id,
      refreshToken: ghlOAuthInstallations.refreshToken,
      userType: ghlOAuthInstallations.userType
    })
    .from(ghlOAuthInstallations)
    .where(
      and(eq(ghlOAuthInstallations.companyId, companyId), eq(ghlOAuthInstallations.userType, "Company"))
    )
    .orderBy(desc(ghlOAuthInstallations.updatedAt))
    .limit(8);

  let refreshedCount = 0;
  for (const installation of installations) {
    const rt = installation.refreshToken?.trim();
    if (!rt) {
      continue;
    }
    const refreshed = await refreshGhlAccessTokenWithRefreshToken(env, rt, installation.userType);
    if (!refreshed) {
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
      .where(eq(ghlOAuthInstallations.id, installation.id));
    refreshedCount += 1;
  }

  return refreshedCount;
}

/**
 * Company OAuth bearer tokens for SaaS APIs keyed by GHL agency id.
 * Mirrors per-location fetch: optional preemptive refresh when rows are expired.
 */
export async function getCompanyAccessTokensForGhlCompanyId(
  env: GhlOAuthTokenEnv,
  db: AgentFlowDb,
  ghlCompanyId: string,
  options?: { preemptiveOAuthRefresh?: boolean }
) {
  const companyId = usableGhlCompanyId(ghlCompanyId);
  if (!companyId) {
    return [];
  }

  const credentialEnv = env as GhlOAuthRefreshCredentialEnv;
  if (options?.preemptiveOAuthRefresh === true) {
    const cid = credentialEnv.GHL_CLIENT_ID?.trim();
    const csec = credentialEnv.GHL_CLIENT_SECRET?.trim();
    if (cid && csec) {
      await refreshOAuthAccessTokensForCompany(credentialEnv, db, companyId);
    }
  }

  const isStillValid = (expiresAt: Date | null | undefined) => {
    if (!expiresAt) return true;
    return expiresAt.getTime() > Date.now() + 60_000;
  };

  const tokenCandidates = new Set<string>();
  const installs = await db
    .select({
      accessToken: ghlOAuthInstallations.accessToken,
      expiresAt: ghlOAuthInstallations.expiresAt
    })
    .from(ghlOAuthInstallations)
    .where(
      and(eq(ghlOAuthInstallations.companyId, companyId), eq(ghlOAuthInstallations.userType, "Company"))
    )
    .orderBy(desc(ghlOAuthInstallations.updatedAt))
    .limit(5);

  for (const row of installs) {
    if (!isStillValid(row.expiresAt)) continue;
    const token = row.accessToken?.trim();
    if (token) tokenCandidates.add(token);
  }

  if (tokenCandidates.size === 0) {
    for (const row of await getRecentCompanyOAuthInstallations(db, 5)) {
      if (row.companyId?.trim() !== companyId) continue;
      if (!isStillValid(row.expiresAt)) continue;
      const token = row.accessToken?.trim();
      if (token) tokenCandidates.add(token);
    }
  }

  if (tokenCandidates.size === 0) {
    for (const row of installs) {
      const token = row.accessToken?.trim();
      if (token) tokenCandidates.add(token);
    }
  }

  const envToken = env.GHL_API_TOKEN?.trim();
  if (envToken) tokenCandidates.add(envToken);
  return pickCompanyTypedAccessTokens(Array.from(tokenCandidates)).tokens;
}

/** Same precedence as conversational / contact fetch paths (`index.ts` historically). */
export async function getCompanyOAuthInstallationForLocation(db: AgentFlowDb, ghlLocationId: string) {
  const rows = await getCompanyOAuthInstallationsForLocationInternal(db, ghlLocationId);
  return rows[0] ?? null;
}

/** Match `apps/api/src/index.ts` behavior for resolving usable bearer tokens per GHL location. */
export async function getAccessTokensForLocation(
  env: GhlOAuthTokenEnv,
  db: AgentFlowDb,
  ghlLocationId: string,
  options?: {
    hydrateBatchMode?: boolean;
    /** When true (and CLIENT_ID + CLIENT_SECRET configured), rotates OAuth rows via refresh_token before reading installers. Use for outbound GHL calls that need a fresh Bearer (calendar catalog, drills). */
    preemptiveOAuthRefresh?: boolean;
  }
) {
  const hydrateBatch = options?.hydrateBatchMode === true;
  const credentialEnv = env as GhlOAuthRefreshCredentialEnv;

  if (options?.preemptiveOAuthRefresh === true) {
    const cid = credentialEnv.GHL_CLIENT_ID?.trim();
    const csec = credentialEnv.GHL_CLIENT_SECRET?.trim();
    if (cid && csec) {
      await refreshOAuthAccessTokensForLocation(credentialEnv, db, ghlLocationId);
    }
  }

  const tokenCandidates = new Set<string>();
  const addTokenCandidate = (value: string | null | undefined) => {
    const token = value?.trim();
    if (token) {
      tokenCandidates.add(token);
    }
  };
  const isStillValid = (expiresAt: Date | null | undefined) => {
    if (!expiresAt) {
      return true;
    }
    return expiresAt.getTime() > Date.now() + 60_000;
  };

  const locationInstallations = await db
    .select({
      accessToken: ghlOAuthInstallations.accessToken,
      expiresAt: ghlOAuthInstallations.expiresAt
    })
    .from(ghlOAuthInstallations)
    .where(
      and(eq(ghlOAuthInstallations.locationId, ghlLocationId), eq(ghlOAuthInstallations.userType, "Location"))
    )
    .orderBy(desc(ghlOAuthInstallations.updatedAt))
    .limit(5);
  for (const installation of locationInstallations) {
    if (isStillValid(installation.expiresAt)) {
      addTokenCandidate(installation.accessToken);
    }
  }

  if (hydrateBatch && tokenCandidates.size > 0) {
    addTokenCandidate(env.GHL_API_TOKEN?.trim());
    return Array.from(tokenCandidates);
  }

  const companyInstallations = [
    ...(await getCompanyOAuthInstallationsForLocationInternal(db, ghlLocationId)),
    ...(hydrateBatch ? [] : await getRecentCompanyOAuthInstallations(db, 5))
  ];
  const seenCompanyTokens = new Set<string>();
  let hydrateBatchExchangeBudget = hydrateBatch ? 2 : 500;
  for (const installation of companyInstallations) {
    if (hydrateBatch && hydrateBatchExchangeBudget <= 0) {
      break;
    }
    const companyToken = installation.accessToken?.trim();
    if (!companyToken || seenCompanyTokens.has(companyToken)) {
      continue;
    }
    seenCompanyTokens.add(companyToken);

    if (hydrateBatch) {
      hydrateBatchExchangeBudget -= 1;
    }

    const locationToken = await exchangeLocationAccessTokenFromCompanyToken(env, {
      companyId: installation.companyId,
      ghlLocationId,
      companyAccessToken: companyToken
    });
    if (!locationToken) {
      continue;
    }

    addTokenCandidate(locationToken.accessToken);
    await upsertLocationOAuthInstallationFromExchange(db, {
      companyId: installation.companyId,
      ghlLocationId,
      fallbackRefreshToken: installation.refreshToken,
      token: locationToken
    });
  }

  if (tokenCandidates.size === 0) {
    for (const installation of companyInstallations) {
      addTokenCandidate(installation.accessToken);
    }
  }

  addTokenCandidate(env.GHL_API_TOKEN?.trim());
  return Array.from(tokenCandidates);
}

/** Agency Company OAuth tokens for SaaS Configurator APIs (prefer over location-scoped tokens). */
function isOAuthTokenStillValid(expiresAt: Date | null | undefined) {
  if (!expiresAt) return true;
  return expiresAt.getTime() > Date.now() + 60_000;
}

function collectCompanyAccessTokens(
  rows: Array<{ accessToken: string | null; expiresAt: Date | null }>,
  options?: { includeExpired?: boolean }
) {
  const tokenCandidates = new Set<string>();
  for (const installation of rows) {
    if (!options?.includeExpired && !isOAuthTokenStillValid(installation.expiresAt)) {
      continue;
    }
    const token = installation.accessToken?.trim();
    if (token) tokenCandidates.add(token);
  }
  return tokenCandidates;
}

/** Agency Company OAuth tokens; Location-typed JWTs are dropped so SaaS APIs are not called with them. */
export async function getCompanyAccessTokensForGhlLocation(
  env: GhlOAuthTokenEnv,
  db: AgentFlowDb,
  ghlLocationId: string,
  options?: { preemptiveOAuthRefresh?: boolean }
) {
  const credentialEnv = env as GhlOAuthRefreshCredentialEnv;
  const canRefresh = Boolean(credentialEnv.GHL_CLIENT_ID?.trim() && credentialEnv.GHL_CLIENT_SECRET?.trim());

  const loadCompanyInstallations = async () => [
    ...(await getCompanyOAuthInstallationsForLocationInternal(db, ghlLocationId)),
    ...(await getRecentCompanyOAuthInstallations(db, 5))
  ];

  let companyInstallations = await loadCompanyInstallations();
  let tokenCandidates = collectCompanyAccessTokens(companyInstallations);
  const shouldRefreshCompanyTokens =
    canRefresh && (options?.preemptiveOAuthRefresh === true || tokenCandidates.size === 0);

  if (shouldRefreshCompanyTokens) {
    const companyIds = new Set<string>();
    const mappedCompanyId = await resolveGhlCompanyIdForLocation(db, ghlLocationId);
    if (mappedCompanyId) companyIds.add(mappedCompanyId);
    for (const installation of companyInstallations) {
      const companyId = installation.companyId?.trim();
      if (companyId) companyIds.add(companyId);
    }
    for (const companyId of companyIds) {
      await refreshOAuthAccessTokensForCompany(credentialEnv, db, companyId);
    }
    if (companyIds.size === 0) {
      await refreshOAuthAccessTokensForLocation(credentialEnv, db, ghlLocationId);
    }
    companyInstallations = await loadCompanyInstallations();
    tokenCandidates = collectCompanyAccessTokens(companyInstallations);
  }

  if (tokenCandidates.size === 0) {
    tokenCandidates = collectCompanyAccessTokens(companyInstallations, { includeExpired: true });
  }

  const picked = pickCompanyTypedAccessTokens(Array.from(tokenCandidates));
  const withSaas = picked.tokens.filter((token) => ghlJwtScopeIncludesSaas(token) === true);
  return {
    tokens: withSaas.length > 0 ? withSaas : picked.tokens,
    rejectedLocationTypedJwt: picked.rejectedLocationTypedJwt
  };
}

export async function resolveGhlCompanyIdForLocation(db: AgentFlowDb, ghlLocationId: string) {
  const [row] = await db
    .select({ ghlAgencyId: agencies.ghlAgencyId })
    .from(locations)
    .innerJoin(agencies, eq(locations.agencyId, agencies.id))
    .where(eq(locations.ghlLocationId, ghlLocationId))
    .limit(1);
  const mapped = usableGhlCompanyId(row?.ghlAgencyId);
  if (mapped) return mapped;

  const [locationInstall] = await db
    .select({ companyId: ghlOAuthInstallations.companyId })
    .from(ghlOAuthInstallations)
    .where(eq(ghlOAuthInstallations.locationId, ghlLocationId))
    .orderBy(desc(ghlOAuthInstallations.updatedAt))
    .limit(1);
  const fromLocationOauth = usableGhlCompanyId(locationInstall?.companyId);
  if (fromLocationOauth) return fromLocationOauth;

  const companyInstalls = await getCompanyOAuthInstallationsForLocationInternal(db, ghlLocationId);
  for (const installation of companyInstalls) {
    const fromCompanyOauth = usableGhlCompanyId(installation.companyId);
    if (fromCompanyOauth) return fromCompanyOauth;
  }
  return null;
}

/** Move a subaccount off placeholder agencies (`default`, demo, test) onto the real GHL company. */
export async function reattachLocationToGhlCompany(
  db: AgentFlowDb,
  ghlLocationId: string,
  ghlCompanyId: string
) {
  const companyId = usableGhlCompanyId(ghlCompanyId);
  const locationId = ghlLocationId.trim();
  if (!companyId || !locationId) return false;

  const [current] = await db
    .select({ ghlAgencyId: agencies.ghlAgencyId })
    .from(locations)
    .innerJoin(agencies, eq(locations.agencyId, agencies.id))
    .where(eq(locations.ghlLocationId, locationId))
    .limit(1);
  if (usableGhlCompanyId(current?.ghlAgencyId) === companyId) {
    return false;
  }

  const now = new Date();
  const [agency] = await db
    .insert(agencies)
    .values({ ghlAgencyId: companyId, updatedAt: now })
    .onConflictDoUpdate({
      target: agencies.ghlAgencyId,
      set: { updatedAt: now }
    })
    .returning({ id: agencies.id });
  if (!agency) return false;

  await db
    .update(locations)
    .set({ agencyId: agency.id, updatedAt: now })
    .where(eq(locations.ghlLocationId, locationId));
  return true;
}

export async function pickGhlCompanyIdForSaasCatalog(db: AgentFlowDb): Promise<string | null> {
  const companyRows = await db
    .select({
      companyId: ghlOAuthInstallations.companyId,
      scope: ghlOAuthInstallations.scope
    })
    .from(ghlOAuthInstallations)
    .where(eq(ghlOAuthInstallations.userType, "Company"))
    .orderBy(desc(ghlOAuthInstallations.updatedAt))
    .limit(20);

  for (const row of companyRows) {
    const companyId = usableGhlCompanyId(row.companyId);
    if (!companyId) continue;
    if (row.scope?.trim() && !oauthInstallationScopeIncludesSaas(row.scope)) continue;
    if (oauthInstallationScopeIncludesSaas(row.scope) && (row.scope ?? "").toLowerCase().includes("saas")) {
      return companyId;
    }
  }

  const usableFromOauth = pickFirstUsableGhlCompanyId(companyRows.map((row) => row.companyId));
  if (usableFromOauth) return usableFromOauth;

  const agencyRows = await db.select({ ghlAgencyId: agencies.ghlAgencyId }).from(agencies);
  return pickFirstUsableGhlCompanyId(agencyRows.map((row) => row.ghlAgencyId));
}

/** Keep a real company mapping when a later webhook only has the placeholder agency `default`. */
export function locationAgencyIdPreserveUnlessPlaceholder() {
  return sql`
    CASE
      WHEN EXISTS (
        SELECT 1 FROM agencies AS incoming_agency
        WHERE incoming_agency.id = EXCLUDED.agency_id
          AND (
            incoming_agency.ghl_agency_id = 'default'
            OR incoming_agency.ghl_agency_id LIKE 'agency_demo%'
            OR incoming_agency.ghl_agency_id LIKE 'test-company%'
          )
      ) THEN ${locations.agencyId}
      ELSE EXCLUDED.agency_id
    END
  `;
}
