import { readStoredToken } from "./auth-storage";

/**
 * Web app always uses a stored workspace JWT. No anonymous `x-viewer-key` fallback in the browser.
 */
export function getWorkspaceHeaders(): Record<string, string> {
  const token = readStoredToken();
  if (token) {
    return { Authorization: `Bearer ${token}` };
  }
  return {};
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
