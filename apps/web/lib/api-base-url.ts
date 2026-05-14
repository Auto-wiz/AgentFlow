const fallbackApiBaseUrl = "https://api.agentflow.autowiz.net";
const configuredApiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL?.trim();

export function getApiBaseUrl() {
  if (!configuredApiBaseUrl) {
    return fallbackApiBaseUrl;
  }

  if (isLocalhostUrl(configuredApiBaseUrl) && !isLocalBrowserHost()) {
    return fallbackApiBaseUrl;
  }

  return configuredApiBaseUrl;
}

function isLocalhostUrl(urlValue: string) {
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?/i.test(urlValue);
}

function isLocalBrowserHost() {
  if (typeof window === "undefined") {
    return false;
  }
  return (
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1" ||
    window.location.hostname === "::1"
  );
}
