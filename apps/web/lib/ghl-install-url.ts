const defaultClientId = "6a035ee24b80374d79d8c5c0-mp2xo4p3";
const defaultVersionId = "6a035ee24b80374d79d8c5c0";
const defaultRedirectUri = "https://api.agentflow.autowiz.net/oauth/gohighlevel/callback";
const defaultScope =
  "contacts.readonly conversations.readonly conversations.write conversations/message.readonly conversations/message.write conversations/reports.readonly conversations/livechat.write locations.readonly locations/tags.readonly locations/tags.write locations/customValues.readonly oauth.write oauth.readonly calendars/events.readonly invoices.readonly invoices/schedule.readonly";

export function getGhlInstallUrl() {
  const configuredInstallUrl = process.env.NEXT_PUBLIC_GHL_INSTALL_URL?.trim();
  const url = configuredInstallUrl ? parseUrl(configuredInstallUrl) : createDefaultInstallUrl();
  const clientId = process.env.NEXT_PUBLIC_GHL_CLIENT_ID?.trim() || defaultClientId;

  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", defaultRedirectUri);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("scope", encodeScope(url.searchParams.get("scope") ?? defaultScope));
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

function encodeScope(rawScope: string) {
  return rawScope
    .trim()
    .replace(/%2F/gi, "/")
    .replace(/\+/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .join(" ");
}
