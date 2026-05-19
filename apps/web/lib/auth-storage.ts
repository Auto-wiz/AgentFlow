export const WORKSPACE_TOKEN_KEY = "agentflow.workspace_access_token";

export function readStoredToken(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.localStorage.getItem(WORKSPACE_TOKEN_KEY)?.trim() || null;
}

export function writeStoredToken(token: string | null) {
  if (typeof window === "undefined") {
    return;
  }
  if (token) {
    window.localStorage.setItem(WORKSPACE_TOKEN_KEY, token);
  } else {
    window.localStorage.removeItem(WORKSPACE_TOKEN_KEY);
  }
}
