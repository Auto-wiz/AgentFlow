import { agencies, ghlOAuthInstallations, locations } from "@agentflow/db";
import type { AgentFlowDb } from "@agentflow/db";
import { and, desc, eq } from "drizzle-orm";

/** Bindings touched by OAuth token retrieval (compatible with Workers `Env` in index.ts). */
export type GhlOAuthTokenEnv = {
  GHL_API_BASE_URL?: string;
  GHL_API_TOKEN?: string;
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

async function getRecentCompanyOAuthInstallations(db: AgentFlowDb, limit = 5) {
  const safeLimit = Math.max(1, Math.min(limit, 20));
  return db
    .select({
      companyId: ghlOAuthInstallations.companyId,
      locationId: ghlOAuthInstallations.locationId,
      userType: ghlOAuthInstallations.userType,
      accessToken: ghlOAuthInstallations.accessToken,
      refreshToken: ghlOAuthInstallations.refreshToken,
      expiresAt: ghlOAuthInstallations.expiresAt,
      updatedAt: ghlOAuthInstallations.updatedAt
    })
    .from(ghlOAuthInstallations)
    .where(eq(ghlOAuthInstallations.userType, "Company"))
    .orderBy(desc(ghlOAuthInstallations.updatedAt))
    .limit(safeLimit);
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
  }
) {
  const hydrateBatch = options?.hydrateBatchMode === true;
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
