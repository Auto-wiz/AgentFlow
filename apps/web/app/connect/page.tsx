"use client";

import { getApiBaseUrl } from "../../lib/api-base-url";
import { writeStoredGhlUserId, writeStoredToken } from "../../lib/auth-storage";
import { useWorkspaceAuth } from "../components/workspace-auth-provider";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

function describeOAuthReason(raw: string | null): string {
  if (!raw) {
    return "OAuth sign-in failed.";
  }
  const messages: Record<string, string> = {
    wrong_agency:
      "This AgentFlow workspace is already linked to a different HighLevel agency. Sign in with that same agency.",
    no_ghl_user_id: "HighLevel did not return a user id for this installation.",
    provision_failed: "Could not finish creating your workspace user.",
    jwt_issue_failed: "Could not create your session token.",
    oauth_error: "OAuth sign-in failed."
  };
  if (messages[raw]) {
    return messages[raw]!;
  }
  if (/[\s]/.test(raw)) {
    return raw;
  }
  return raw.replace(/_/g, " ");
}

/** XML error mentioning `Generation` usually means the browser hit Google Cloud Storage, not the Worker API. */
function misconfiguredApiBaseHint(apiBase: string): string | null {
  try {
    const u = new URL(apiBase);
    const h = u.hostname.toLowerCase();
    if (h === "storage.googleapis.com" || h.endsWith(".storage.googleapis.com")) {
      return "NEXT_PUBLIC_API_BASE_URL points at Google Cloud Storage. Set it to your Cloudflare Worker API origin (for example https://your-api.workers.dev), not a static bucket URL.";
    }
    return null;
  } catch {
    return "NEXT_PUBLIC_API_BASE_URL is not a valid URL.";
  }
}

/** OAuth entry + session hash from Marketplace callback (provisioned via API Worker). */
export default function ConnectGhlPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const apiBaseUrl = getApiBaseUrl();
  const ghlOAuthStartUrl = `${apiBaseUrl}/oauth/gohighlevel/start`;

  const apiBaseMisconfigurationHint = useMemo(() => misconfiguredApiBaseHint(apiBaseUrl), [apiBaseUrl]);

  const { hydrated, reloadFromStorage, token, user } = useWorkspaceAuth();
  const [hashError, setHashError] = useState<string | null>(null);

  const oauthQueryError = useMemo(() => {
    if (searchParams.get("ghl") !== "error") {
      return null;
    }
    const raw = searchParams.get("reason");
    return describeOAuthReason(raw ? decodeURIComponent(raw) : null);
  }, [searchParams]);

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
      let canEnterApp = false;
      try {
        const res = await fetch(`${apiBaseUrl}/auth/me`, {
          headers: { Authorization: `Bearer ${sessionJwt}` }
        });
        if (res.ok) {
          const body = (await res.json()) as { user?: { ghlUserId?: string | null } };
          const gid = body.user?.ghlUserId?.trim();
          if (gid) {
            writeStoredGhlUserId(gid);
            canEnterApp = true;
          }
        }
      } finally {
        const sp = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
        const next = sp?.get("next");
        if (canEnterApp) {
          router.replace(next && next.startsWith("/") ? next : "/appointments");
        }
      }
    })();
  }, [apiBaseUrl, reloadFromStorage, router]);

  useEffect(() => {
    if (!hydrated || !token) {
      return;
    }
    if (!user) {
      return;
    }
    if (!user.ghlUserId?.trim()) {
      return;
    }
    const sp = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
    const next = sp?.get("next");
    router.replace(next && next.startsWith("/") ? next : "/appointments");
  }, [hydrated, router, token, user]);

  return (
    <section className="module-shell" style={{ maxWidth: 620, margin: "0 auto" }}>
      <div className="panel" style={{ padding: 22 }}>
        <p className="eyebrow">GoHighLevel</p>
        <h1 style={{ marginTop: 8 }}>Connect workspace</h1>
        <p className="muted" style={{ marginTop: 8 }}>
          Sign in to HighLevel and authorize AgentFlow. The Worker uses your app&apos;s{" "}
          <strong>Installation URL</strong> from the Developer Portal (Advanced Settings → Auth → show install link) — you
          don&apos;t browse the public Marketplace listing here.
        </p>

        {(hashError || oauthQueryError) ? (
          <p className="inbox-reply-error" style={{ marginTop: 14 }}>
            {hashError ?? oauthQueryError}
          </p>
        ) : null}

        {apiBaseMisconfigurationHint ? (
          <p className="inbox-reply-error" style={{ marginTop: 14 }}>
            {apiBaseMisconfigurationHint}
          </p>
        ) : null}

        <div className="toolbar" style={{ marginTop: 18, flexWrap: "wrap", gap: 10 }}>
          <a className="button" href={ghlOAuthStartUrl} target="_blank" rel="noopener noreferrer">
            Open OAuth in a new tab
          </a>
          <button
            className="button secondary"
            onClick={() => {
              window.location.href = ghlOAuthStartUrl;
            }}
            type="button"
          >
            Go to Marketplace (this window)
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
          If the iframe stays blank because of HighLevel policies, use the buttons above. If you see an XML error about{" "}
          <code className="muted">Generation</code> or <code className="muted">InvalidArgument</code>, the browser likely hit
          Google Cloud Storage or another static host — set <code className="muted">NEXT_PUBLIC_API_BASE_URL</code> to your
          Cloudflare Worker API origin, not the Pages app URL or a bucket.
        </p>
      </div>
    </section>
  );
}
