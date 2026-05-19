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

export const WORKSPACE_GHL_USER_ID_KEY = "agentflow.ghl_user_id";

export function readStoredGhlUserId(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  return window.localStorage.getItem(WORKSPACE_GHL_USER_ID_KEY)?.trim() || null;
}

export function writeStoredGhlUserId(value: string | null) {
  if (typeof window === "undefined") {
    return;
  }
  if (value) {
    window.localStorage.setItem(WORKSPACE_GHL_USER_ID_KEY, value);
  } else {
    window.localStorage.removeItem(WORKSPACE_GHL_USER_ID_KEY);
  }
}