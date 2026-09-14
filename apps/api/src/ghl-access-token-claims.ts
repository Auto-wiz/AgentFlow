export type GhlAccessTokenClaims = {
  authClass: string | null;
  userType: string | null;
  companyId: string | null;
  locationId: string | null;
  scope: string | null;
};

function stringClaim(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
  }
  if (Array.isArray(value)) {
    const joined = value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter(Boolean)
      .join(" ");
    return joined ? joined : null;
  }
  return null;
}

function decodeBase64UrlJson(segment: string): Record<string, unknown> | null {
  const b64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
  try {
    const json = Buffer.from(padded, "base64").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Decode a GHL bearer JWT payload without verifying the signature. Non-JWT tokens return null. */
export function decodeGhlAccessTokenClaims(accessToken: string): GhlAccessTokenClaims | null {
  const parts = accessToken.split(".");
  if (parts.length < 2 || !parts[1]) return null;
  const payload = decodeBase64UrlJson(parts[1]);
  if (!payload) return null;
  const oauthMeta =
    payload.oauthMeta && typeof payload.oauthMeta === "object" && !Array.isArray(payload.oauthMeta)
      ? (payload.oauthMeta as Record<string, unknown>)
      : null;
  return {
    authClass: stringClaim(payload.authClass ?? payload.auth_class),
    userType: stringClaim(payload.userType ?? payload.user_type),
    companyId: stringClaim(payload.companyId ?? payload.company_id ?? payload.authClassId),
    locationId: stringClaim(payload.locationId ?? payload.location_id),
    scope: stringClaim(payload.scope ?? oauthMeta?.scopes ?? oauthMeta?.scope)
  };
}

export function ghlTokenLooksLikeLocation(accessToken: string): boolean {
  const claims = decodeGhlAccessTokenClaims(accessToken);
  if (!claims) return false;
  const cls = `${claims.authClass ?? ""} ${claims.userType ?? ""}`.toLowerCase();
  if (cls.includes("company") || cls.includes("agency")) return false;
  return cls.includes("location");
}

export function ghlJwtScopeIncludesSaas(accessToken: string): boolean | null {
  const claims = decodeGhlAccessTokenClaims(accessToken);
  if (!claims) return null;
  if (!claims.scope) return null;
  const raw = claims.scope.toLowerCase();
  return raw.includes("saas/") || raw.includes("saas.");
}

export function summarizeGhlTokenForSaas(accessToken: string) {
  const claims = decodeGhlAccessTokenClaims(accessToken);
  return {
    jwtAuthClass: claims?.authClass ?? null,
    jwtUserType: claims?.userType ?? null,
    jwtLooksLikeLocation: ghlTokenLooksLikeLocation(accessToken),
    jwtHasSaasScope: ghlJwtScopeIncludesSaas(accessToken)
  };
}

/** Keep Company/agency JWTs; drop Location JWTs so SaaS calls do not 403 Forbidden resource. */
export function pickCompanyTypedAccessTokens(tokens: string[]): {
  tokens: string[];
  rejectedLocationTypedJwt: boolean;
} {
  const companyTyped: string[] = [];
  let locationTypedCount = 0;
  for (const token of tokens) {
    if (ghlTokenLooksLikeLocation(token)) {
      locationTypedCount += 1;
    } else {
      companyTyped.push(token);
    }
  }
  return {
    tokens: companyTyped,
    rejectedLocationTypedJwt: locationTypedCount > 0 && companyTyped.length === 0
  };
}
