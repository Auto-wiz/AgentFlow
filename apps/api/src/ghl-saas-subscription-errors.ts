/** Documented SaaS Configurator version. Wrong Version headers often yield HTTP 403 "Forbidden resource". */
export const GHL_SAAS_API_VERSION = "2021-04-15";

export const GHL_SAAS_SCOPE_HELP =
  "Publish a new Marketplace app version with saas/location.read and saas/company.read, then use AgentFlow Settings → Connect GoHighLevel at the agency — reinstalling the app on one subaccount alone does not refresh agency OAuth scopes.";

function scopeSnapshotIncludesSaas(scope: string | null | undefined): boolean {
  const raw = scope?.trim().toLowerCase();
  if (!raw) return false;
  return raw.includes("saas/") || raw.includes("saas.");
}

export function isGhlOAuthScopeFailure(status: number, message: string): boolean {
  const m = message.toLowerCase();
  return (
    m.includes("not authorized for this scope") ||
    m.includes("token is not authorized for this scope") ||
    (status === 401 && m.includes("scope"))
  );
}

export function isGhlForbiddenResource(status: number, message: string): boolean {
  const m = message.toLowerCase();
  return (
    status === 403 &&
    (m.includes("forbidden resource") || m.includes("does not have access to this location"))
  );
}

export function shouldTreatAsGhlSaasAuthFailure(status: number | null, message: string): boolean {
  const s = status ?? 0;
  return isGhlOAuthScopeFailure(s, message) || isGhlForbiddenResource(s, message);
}

export function explainGhlSaasFetchFailure(input: {
  ghlLocationId: string;
  lastStatus: number | null;
  lastMessage: string;
  sawScopeError: boolean;
  listCompletedWithoutMatch: boolean;
  oauthScopeOnFile: string | null;
}): { error: string; code: string; status: number | null } {
  if (input.listCompletedWithoutMatch) {
    return {
      status: 404,
      code: "saas_location_not_in_catalog",
      error: `GHL SaaS catalog does not include subaccount ${input.ghlLocationId}. Enable SaaS for that location in HighLevel, then Sync from GHL again.`
    };
  }
  if (input.sawScopeError || shouldTreatAsGhlSaasAuthFailure(input.lastStatus, input.lastMessage)) {
    const hasSaasOnFile = scopeSnapshotIncludesSaas(input.oauthScopeOnFile);
    return {
      status: input.lastStatus ?? 403,
      code: "ghl_scope_forbidden",
      error: hasSaasOnFile
        ? `${GHL_SAAS_SCOPE_HELP} AgentFlow already lists saas/* on the agency token, but GHL still returned "${input.lastMessage}". Reconnect Settings → Connect GoHighLevel at the agency (a single-subaccount Marketplace reinstall is not enough).`
        : GHL_SAAS_SCOPE_HELP
    };
  }
  return {
    status: input.lastStatus,
    code: "ghl_saas_fetch_failed",
    error: input.lastMessage
  };
}
