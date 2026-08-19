import { agencies, ghlOAuthInstallations, locations } from "@agentflow/db";
import type { AgentFlowDb } from "@agentflow/db";
import { and, desc, eq, or } from "drizzle-orm";

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
  const [locationWithAgency] = await db
    .select({
      ghlAgencyId: agencies.ghlAgencyId
    })
    .from(locations)
    .innerJoin(agencies, eq(locations.agencyId, agencies.id))
    .where(eq(locations.ghlLocationId, ghlLocationId))
    .limit(1);

  if (!locationWithAgency?.ghlAgencyId) {
    return [];
  }

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
    .where(
      and(
        eq(ghlOAuthInstallations.companyId, locationWithAgency.ghlAgencyId),
        eq(ghlOAuthInstallations.userType, "Company")
      )
    )
    .orderBy(desc(ghlOAuthInstallations.updatedAt))
    .limit(5);
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

  if (installations.length === 0) {
    installations = await db
      .select({
        id: ghlOAuthInstallations.id,
        refreshToken: ghlOAuthInstallations.refreshToken,
        userType: ghlOAuthInstallations.userType
      })
      .from(ghlOAuthInstallations)
      .where(eq(ghlOAuthInstallations.userType, "Company"))
      .orderBy(desc(ghlOAuthInstallations.updatedAt))
      .limit(8);
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
  const companyId = ghlCompanyId.trim();
  if (!companyId) {
    return [];
  }

  const [anyLoc] = await db
    .select({ ghlLocationId: locations.ghlLocationId })
    .from(locations)
    .innerJoin(agencies, eq(locations.agencyId, agencies.id))
    .where(eq(agencies.ghlAgencyId, companyId))
    .limit(1);

  if (anyLoc?.ghlLocationId) {
    return getCompanyAccessTokensForGhlLocation(env, db, anyLoc.ghlLocationId, options);
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

  const envToken = env.GHL_API_TOKEN?.trim();
  if (envToken) tokenCandidates.add(envToken);
  return Array.from(tokenCandidates);
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
export async function getCompanyAccessTokensForGhlLocation(
  env: GhlOAuthTokenEnv,
  db: AgentFlowDb,
  ghlLocationId: string,
  options?: { preemptiveOAuthRefresh?: boolean }
) {
  const credentialEnv = env as GhlOAuthRefreshCredentialEnv;
  if (options?.preemptiveOAuthRefresh === true) {
    const cid = credentialEnv.GHL_CLIENT_ID?.trim();
    const csec = credentialEnv.GHL_CLIENT_SECRET?.trim();
    if (cid && csec) {
      await refreshOAuthAccessTokensForLocation(credentialEnv, db, ghlLocationId);
    }
  }

  const isStillValid = (expiresAt: Date | null | undefined) => {
    if (!expiresAt) return true;
    return expiresAt.getTime() > Date.now() + 60_000;
  };

  const tokenCandidates = new Set<string>();
  const companyInstallations = [
    ...(await getCompanyOAuthInstallationsForLocationInternal(db, ghlLocationId)),
    ...(await getRecentCompanyOAuthInstallations(db, 5))
  ];
  for (const installation of companyInstallations) {
    if (!isStillValid(installation.expiresAt)) continue;
    const token = installation.accessToken?.trim();
    if (token) tokenCandidates.add(token);
  }
  return Array.from(tokenCandidates);
}

export async function resolveGhlCompanyIdForLocation(db: AgentFlowDb, ghlLocationId: string) {
  const [row] = await db
    .select({ ghlAgencyId: agencies.ghlAgencyId })
    .from(locations)
    .innerJoin(agencies, eq(locations.agencyId, agencies.id))
    .where(eq(locations.ghlLocationId, ghlLocationId))
    .limit(1);
  return row?.ghlAgencyId?.trim() ?? null;
}
