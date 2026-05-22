"use client";

import type { ReactNode } from "react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { useRouter } from "next/navigation";

export type DraftNavigationGuard = {
  id: string;
  isDirty: () => boolean;
  persist: () => Promise<boolean>;
};

type NavigateKind = "push" | "replace";

type LeaveResolution = "cancelled" | "saved" | "discarded";

type PendingLeave = {
  targetHref: string;
  resolve: (value: LeaveResolution) => void;
  persist: () => Promise<boolean>;
};

type NavigationGuardContextValue = {
  pushGuarded: (href: string) => Promise<void>;
  replaceGuarded: (href: string) => Promise<void>;
};

const NavigationGuardCtx = createContext<NavigationGuardContextValue | null>(null);
const RegistrarCtx = createContext<((guard: DraftNavigationGuard) => () => void) | null>(null);

/** Programmatic navigation (`push`/`replace`) that respects registered draft guards. */
export function useGuardedNavigate(): NavigationGuardContextValue {
  const ctx = useContext(NavigationGuardCtx);
  if (!ctx) {
    throw new Error("useGuardedNavigate must be used inside NavigationGuardProvider.");
  }
  return ctx;
}

/**
 * Keeps edits local until persisted; unregister on unmount.
 * Latest `guard` snapshot is always read via a ref when the registrar invokes `isDirty` / `persist`.
 */
export function useRegisterDraftNavigationGuard(id: string, guard: Omit<DraftNavigationGuard, "id">): void {
  const registerGuard = useContext(RegistrarCtx);
  const guardRef = useRef(guard);
  guardRef.current = guard;

  useEffect(() => {
    if (!registerGuard) {
      return;
    }
    const registration: DraftNavigationGuard = {
      id,
      isDirty: () => guardRef.current.isDirty(),
      persist: () => guardRef.current.persist()
    };
    return registerGuard(registration);
  }, [id, registerGuard]);
}

export function NavigationGuardProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const guardsRef = useRef<DraftNavigationGuard[]>([]);
  /** While true, guardedNavigate skips running guards (avoids recursion after user confirms navigation). */
  const bypassGuardRef = useRef(false);
  /** Prevents overlapping navigations triggered from the modal + captured links. */
  const navigationLockRef = useRef(false);

  const [prompt, setPrompt] = useState<PendingLeave | null>(null);
  const [savingPrompt, setSavingPrompt] = useState(false);

  const waitForLeaveDecision = useCallback((targetHref: string, persist: () => Promise<boolean>) => {
    return new Promise<LeaveResolution>((resolve) => {
      setPrompt({ targetHref, resolve, persist });
    });
  }, []);

  const registerGuard = useCallback((incoming: DraftNavigationGuard) => {
    guardsRef.current = [...guardsRef.current.filter((g) => g.id !== incoming.id), incoming];
    return () => {
      guardsRef.current = guardsRef.current.filter((g) => g.id !== incoming.id);
    };
  }, []);

  const guardedNavigate = useCallback(
    async (kind: NavigateKind, href: string) => {
      if (navigationLockRef.current) {
        return;
      }
      navigationLockRef.current = true;
      try {
        if (!bypassGuardRef.current) {
          let safety = 0;
          while (safety++ < 20) {
            const blocking =
              [...guardsRef.current].filter((guard) => {
                try {
                  return guard.isDirty();
                } catch {
                  return false;
                }
              })[0] ?? null;

            if (!blocking) {
              break;
            }

            const outcome = await waitForLeaveDecision(href, blocking.persist);
            if (outcome === "cancelled") {
              return;
            }
            if (outcome === "discarded") {
              bypassGuardRef.current = true;
              try {
                if (kind === "push") {
                  router.push(href);
                } else {
                  router.replace(href);
                }
              } finally {
                bypassGuardRef.current = false;
              }
              return;
            }
            // Saved: persist() should have cleared dirty; loop verifies.
          }

          const guardsStillDirty = [...guardsRef.current].some((guard) => {
            try {
              return guard.isDirty();
            } catch {
              return false;
            }
          });
          if (guardsStillDirty) {
            return;
          }
        }

        bypassGuardRef.current = false;
        if (kind === "push") {
          router.push(href);
        } else {
          router.replace(href);
        }
      } finally {
        navigationLockRef.current = false;
      }
    },
    [router, waitForLeaveDecision]
  );

  const attemptNavigateRef = useRef<(kind: NavigateKind, href: string) => Promise<void>>(async () => {});
  attemptNavigateRef.current = guardedNavigate;

  const pushGuarded = useCallback(async (href: string) => {
    await attemptNavigateRef.current("push", href);
  }, []);
  const replaceGuarded = useCallback(async (href: string) => {
    await attemptNavigateRef.current("replace", href);
  }, []);

  const ctxValue = useMemo(() => ({ pushGuarded, replaceGuarded }), [pushGuarded, replaceGuarded]);

  /** Clicks en `<Link>`/`a` mismo origen salvo mismo path: si hay borrador, abrimos el mismo modal. */
  useEffect(() => {
    const onAnchorClickCapture = (event: MouseEvent) => {
      if (prompt || navigationLockRef.current) {
        return;
      }
      if (event.defaultPrevented) {
        return;
      }
      const target = event.target;
      if (!(target instanceof Element)) {
        return;
      }
      const anchor = target.closest("a[href]");
      if (!(anchor instanceof HTMLAnchorElement)) {
        return;
      }
      const raw = anchor.getAttribute("href");
      if (!raw || raw.startsWith("#") || raw.startsWith("mailto:") || raw.startsWith("tel:")) {
        return;
      }
      let url: URL;
      try {
        url = new URL(raw, window.location.href);
      } catch {
        return;
      }
      if (url.origin !== window.location.origin) {
        return;
      }
      if (url.pathname === window.location.pathname && url.search === "" && url.hash === "") {
        return;
      }
      const guards = [...guardsRef.current];
      const shouldBlock =
        guards.find((guard) => {
          try {
            return guard.isDirty();
          } catch {
            return false;
          }
        }) !== undefined;
      if (!shouldBlock) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      const combined = `${url.pathname}${url.search}${url.hash}`;
      void attemptNavigateRef.current("push", combined);
    };

    document.addEventListener("click", onAnchorClickCapture, true);
    return () => document.removeEventListener("click", onAnchorClickCapture, true);
  }, [prompt]);

  useEffect(() => {
    if (!prompt) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        prompt.resolve("cancelled");
        setPrompt(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [prompt]);

  async function handleSaveAndLeave() {
    if (!prompt || savingPrompt) {
      return;
    }
    setSavingPrompt(true);
    try {
      const ok = await prompt.persist();
      if (ok) {
        prompt.resolve("saved");
        setPrompt(null);
      }
    } finally {
      setSavingPrompt(false);
    }
  }

  function handleLeaveWithoutSaving() {
    if (!prompt || savingPrompt) {
      return;
    }
    prompt.resolve("discarded");
    setPrompt(null);
  }

  function handleKeepEditing() {
    if (!prompt || savingPrompt) {
      return;
    }
    prompt.resolve("cancelled");
    setPrompt(null);
  }

  return (
    <RegistrarCtx.Provider value={registerGuard}>
      <NavigationGuardCtx.Provider value={ctxValue}>
        {children}
        {prompt ? (
          <div
            role="presentation"
            style={{
              position: "fixed",
              inset: 0,
              background: "rgba(0,0,0,.55)",
              zIndex: 110,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              padding: 16
            }}
            onClick={() => {
              handleKeepEditing();
            }}
          >
            <div
              role="dialog"
              aria-labelledby="nav-guard-dialog-title"
              aria-modal="true"
              className="panel"
              style={{ maxWidth: 440, padding: 20, width: "100%", position: "relative", zIndex: 111 }}
              onClick={(event) => event.stopPropagation()}
            >
              <h3 id="nav-guard-dialog-title" style={{ marginTop: 0 }}>
                Cambios sin guardar
              </h3>
              <p className="muted" style={{ marginTop: 8 }}>
                Tenés cambios locales. ¿Los guardamos antes de ir a otro lugar de la app (por ejemplo Appointments o
                Settings)?
              </p>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: 18 }}>
                <button type="button" className="button" disabled={savingPrompt} onClick={() => void handleSaveAndLeave()}>
                  {savingPrompt ? "Guardando…" : "Guardar y salir"}
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={savingPrompt}
                  onClick={() => handleLeaveWithoutSaving()}
                >
                  Salir sin guardar
                </button>
                <button
                  type="button"
                  className="button secondary"
                  disabled={savingPrompt}
                  onClick={() => handleKeepEditing()}
                >
                  Seguir editando
                </button>
              </div>
            </div>
          </div>
        ) : null}
      </NavigationGuardCtx.Provider>
    </RegistrarCtx.Provider>
  );
}
