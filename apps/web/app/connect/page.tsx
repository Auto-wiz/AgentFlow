"use client";

import { getApiBaseUrl } from "../../lib/api-base-url";
import { writeStoredGhlUserId, writeStoredToken } from "../../lib/auth-storage";
import { isForceWorkspaceLogin } from "../../lib/workspace-auth-env";
import { useWorkspaceAuth } from "../components/workspace-auth-provider";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

/** OAuth entry + session hash from Marketplace callback (provisioned via API Worker). */
export default function ConnectGhlPage() {
  const router = useRouter();
  const apiBaseUrl = getApiBaseUrl();
  const ghlOAuthStartUrl = `${apiBaseUrl}/oauth/gohighlevel/start`;

  const { hydrated, reloadFromStorage, token } = useWorkspaceAuth();
  const [hashError, setHashError] = useState<string | null>(null);

  const oauthQueryError = useMemo(() => {
    if (typeof window === "undefined") {
      return null;
    }
    const qs = new URLSearchParams(window.location.search);
    if (qs.get("ghl") === "error") {
      const reason = qs.get("reason");
      return reason ? decodeURIComponent(reason) : "oauth_error";
    }
    return null;
  }, []);

  useEffect(() => {
    if (typeof window === "undefined") {
      return;
    }

    const hashPart = window.location.hash.startsWith("#")
      ? window.location.hash.slice(1)
      : window.location.hash;
    if (!hashPart.trim()) {
      return;
    }

    const params = new URLSearchParams(hashPart);
    const encodedSession = params.get("session");
    if (!encodedSession?.trim()) {
      setHashError("Missing session in URL fragment.");
      return;
    }

    window.history.replaceState(null, "", window.location.pathname + window.location.search);

    let sessionJwt: string;
    try {
      sessionJwt = decodeURIComponent(encodedSession.trim());
    } catch {
      setHashError("Malformed session fragment.");
      return;
    }

    writeStoredToken(sessionJwt);
    writeStoredGhlUserId(null);
    reloadFromStorage();

    void (async () => {
      try {
        const res = await fetch(`${apiBaseUrl}/auth/me`, {
          headers: { Authorization: `Bearer ${sessionJwt}` }
        });
        if (res.ok) {
          const body = (await res.json()) as { user?: { ghlUserId?: string | null } };
          const gid = body.user?.ghlUserId?.trim();
          if (gid) {
            writeStoredGhlUserId(gid);
          }
        }
      } finally {
        const sp = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
        const next = sp?.get("next");
        router.replace(next && next.startsWith("/") ? next : "/appointments");
      }
    })();
  }, [apiBaseUrl, reloadFromStorage, router]);

  useEffect(() => {
    if (!hydrated || !isForceWorkspaceLogin() || !token) {
      return;
    }
    const sp = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
    const next = sp?.get("next");
    router.replace(next && next.startsWith("/") ? next : "/appointments");
  }, [hydrated, router, token]);

  const legacyBypass = hydrated && !isForceWorkspaceLogin();

  return (
    <section className="module-shell" style={{ maxWidth: 620, margin: "0 auto" }}>
      <div className="panel" style={{ padding: 22 }}>
        <p className="eyebrow">GoHighLevel</p>
        <h1 style={{ marginTop: 8 }}>Conectar workspace</h1>
        <p className="muted" style={{ marginTop: 8 }}>
          Iniciá OAuth en el Marketplace. Al volver creamos tu usuario AgentFlow usando el HL user id y guardamos sesión en
          este navegador.
        </p>
        {legacyBypass ? (
          <p className="muted" style={{ marginTop: 12 }}>
            Este entorno permite modo legacy (`NEXT_PUBLIC_FORCE_WORKSPACE_LOGIN=false`). Podés entrar igual a{" "}
            <Link className="app-user-menu-link" href="/appointments">
              Appointments
            </Link>{" "}
            sin JWT.
          </p>
        ) : null}

        {(hashError || oauthQueryError) ? (
          <p className="inbox-reply-error" style={{ marginTop: 14 }}>
            {hashError ?? oauthQueryError}
          </p>
        ) : null}

        <div className="toolbar" style={{ marginTop: 18, flexWrap: "wrap", gap: 10 }}>
          <a className="button" href={ghlOAuthStartUrl} target="_blank" rel="noopener noreferrer">
            Abrir OAuth en nueva pestaña
          </a>
          <button
            className="button secondary"
            onClick={() => {
              window.location.href = ghlOAuthStartUrl;
            }}
            type="button"
          >
            Ir al Marketplace (misma ventana)
          </button>
        </div>

        <div style={{ marginTop: 18, aspectRatio: "16 / 9", border: "1px solid rgba(128,128,128,0.25)", borderRadius: 12 }}>
          <iframe
            allow="clipboard-write; fullscreen"
            src={ghlOAuthStartUrl}
            style={{ width: "100%", height: "100%", border: "none", borderRadius: 11 }}
            title="GoHighLevel OAuth"
          />
        </div>

        <p className="muted" style={{ marginTop: 10 }}>
          Si el iframe queda vacío por políticas HL, usá los botones de arriba.
        </p>
      </div>
    </section>
  );
}
