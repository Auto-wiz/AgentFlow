import { readStoredToken } from "./auth-storage";
import { isForceWorkspaceLogin, legacyViewerKey } from "./workspace-auth-env";

/**
 * Builds API request headers compatible with legacy `x-viewer-key` flows and JWT workspace sessions.
 * When NEXT_PUBLIC_FORCE_WORKSPACE_LOGIN=true, unauthenticated callers omit the legacy header so the API rejects with 401.
 */
export function getWorkspaceHeaders(): Record<string, string> {
  const token = readStoredToken();
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  if (isForceWorkspaceLogin()) {
    return {};
  }
  return { "x-viewer-key": legacyViewerKey() };
}

export function mergeWorkspaceHeaders(
  headers?: HeadersInit
): HeadersInit | Record<string, string> {
  const base = getWorkspaceHeaders();

  if (headers === undefined || headers === null) {
    return base;
  }

  const out = { ...base } as Record<string, string>;

  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }

  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      out[key] = value;
    }
    return out;
  }

  return { ...out, ...(headers as Record<string, string>) };
}
