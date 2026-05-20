import { getApiBaseUrl } from "./api-base-url";

/**
 * Use the Worker OAuth start route so the CSRF `state` cookie is set before redirecting to HighLevel.
 * Do not link directly to Marketplace or a raw Installation URL from the web app.
 */
export function getGhlWorkerOAuthStartUrl() {
  const base = getApiBaseUrl().replace(/\/$/, "");
  return `${base}/oauth/gohighlevel/start`;
}

/** @deprecated Use {@link getGhlWorkerOAuthStartUrl} — same behavior (Worker start URL). */
export function getGhlInstallUrl() {
  return getGhlWorkerOAuthStartUrl();
}
