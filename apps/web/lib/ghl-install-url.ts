import { DEFAULT_GHL_MARKETPLACE_OAUTH_SCOPE, normalizeGhlMarketplaceOAuthScope } from "@agentflow/shared";

const defaultClientId = "6a035ee24b80374d79d8c5c0-mp2xo4p3";
const defaultVersionId = "6a035ee24b80374d79d8c5c0";
const defaultRedirectUri = "https://api.agentflow.autowiz.net/oauth/gohighlevel/callback";

export function getGhlInstallUrl() {
  const configuredInstallUrl = process.env.NEXT_PUBLIC_GHL_INSTALL_URL?.trim();
  const url = configuredInstallUrl ? parseUrl(configuredInstallUrl) : createDefaultInstallUrl();
  const clientId = process.env.NEXT_PUBLIC_GHL_CLIENT_ID?.trim() || defaultClientId;

  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", defaultRedirectUri);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set(
    "scope",
    normalizeGhlMarketplaceOAuthScope(url.searchParams.get("scope") ?? DEFAULT_GHL_MARKETPLACE_OAUTH_SCOPE)
  );
  url.searchParams.set("version_id", defaultVersionId);
  return url.toString();
}

function parseUrl(value: string) {
  try {
    return new URL(value);
  } catch {
    return createDefaultInstallUrl();
  }
}

function createDefaultInstallUrl() {
  return new URL("https://marketplace.gohighlevel.com/v2/oauth/chooselocation");
}
