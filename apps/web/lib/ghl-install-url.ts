import { getApiBaseUrl } from "./api-base-url";

export function getGhlInstallUrl() {
  const apiBaseUrl = getApiBaseUrl().replace(/\/+$/, "");
  return `${apiBaseUrl}/oauth/gohighlevel/start`;
}
