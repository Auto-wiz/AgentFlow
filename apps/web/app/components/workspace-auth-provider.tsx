"use client";

import { getApiBaseUrl } from "../../lib/api-base-url";
import { readStoredToken, writeStoredToken } from "../../lib/auth-storage";
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";

export type WorkspaceUser = {
  id: string;
  email: string;
  role: string;
  displayName: string | null;
};

type WorkspaceAuthContextValue = {
  user: WorkspaceUser | null;
  /** True once localStorage has been read once (browser only). */
  hydrated: boolean;
  sessionKey: number;
  token: string | null;
  signOut: () => void;
  /** Re-read JWT from storage and invalidate session-derived state (after login). */
  reloadFromStorage: () => void;
};

const WorkspaceAuthContext = createContext<WorkspaceAuthContextValue | null>(null);

export function useWorkspaceAuth() {
  const ctx = useContext(WorkspaceAuthContext);
  if (!ctx) {
    throw new Error("useWorkspaceAuth requires WorkspaceAuthProvider");
  }
  return ctx;
}

export function WorkspaceAuthProvider({ children }: { children: React.ReactNode }) {
  const [hydrated, setHydrated] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<WorkspaceUser | null>(null);
  const [sessionKey, setSessionKey] = useState(0);

  useEffect(() => {
    setToken(readStoredToken());
    setHydrated(true);
  }, []);

  useEffect(() => {
    if (!hydrated || !token) {
      setUser(null);
      return;
    }

    let cancelled = false;
    async function hydrateUser() {
      const apiBase = getApiBaseUrl();
      try {
        const res = await fetch(`${apiBase}/auth/me`, {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (cancelled) {
          return;
        }
        if (!res.ok) {
          if (res.status === 401) {
            writeStoredToken(null);
            setToken(null);
          }
          setUser(null);
          return;
        }
        const payload = (await res.json()) as { user: WorkspaceUser };
        if (!cancelled) {
          setUser(payload.user);
        }
      } catch {
        if (!cancelled) {
          setUser(null);
        }
      }
    }

    void hydrateUser();
    return () => {
      cancelled = true;
    };
  }, [hydrated, token, sessionKey]);

  const bumpSession = useCallback(() => {
    setSessionKey((k) => k + 1);
  }, []);

  const signOut = useCallback(() => {
    writeStoredToken(null);
    setToken(null);
    setUser(null);
    bumpSession();
  }, [bumpSession]);

  const reloadFromStorage = useCallback(() => {
    setToken(readStoredToken());
    bumpSession();
  }, [bumpSession]);

  const value = useMemo<WorkspaceAuthContextValue>(
    () => ({
      user,
      hydrated,
      sessionKey,
      token,
      signOut,
      reloadFromStorage
    }),
    [user, hydrated, sessionKey, token, reloadFromStorage, signOut]
  );

  return <WorkspaceAuthContext.Provider value={value}>{children}</WorkspaceAuthContext.Provider>;
}
