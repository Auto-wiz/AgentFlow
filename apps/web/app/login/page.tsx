"use client";

import { getApiBaseUrl } from "../../lib/api-base-url";
import { writeStoredGhlUserId, writeStoredToken } from "../../lib/auth-storage";
import { useWorkspaceAuth } from "../components/workspace-auth-provider";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

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

/** Email/password sign-in; optional fragment `#session=` after GoHighLevel OAuth (Settings / integrations). */
export default function LoginPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const apiBaseUrl = getApiBaseUrl();
  const apiBaseMisconfigurationHint = useMemo(() => misconfiguredApiBaseHint(apiBaseUrl), [apiBaseUrl]);

  const { hydrated, reloadFromStorage } = useWorkspaceAuth();
  const [hashError, setHashError] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const oauthQueryError = useMemo(() => {
    if (searchParams.get("ghl") !== "error") {
      return null;
    }
    const raw = searchParams.get("reason");
    return describeOAuthReason(raw ? decodeURIComponent(raw) : null);
  }, [searchParams]);

  const consumeSessionFromHash = useCallback(async () => {
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
      if (canEnterApp) {
        const sp = new URLSearchParams(window.location.search);
        const next = sp.get("next");
        router.replace(next && next.startsWith("/") ? next : "/appointments");
      }
    }
  }, [apiBaseUrl, reloadFromStorage, router]);

  useEffect(() => {
    void consumeSessionFromHash();
  }, [consumeSessionFromHash]);

  async function onLogin(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);
    setPending(true);
    try {
      const res = await fetch(`${apiBaseUrl}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });
      const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
      if (!res.ok) {
        setFormError(
          body.error === "invalid_credentials"
            ? "Incorrect email or password."
            : (body as { message?: string }).message || body.error || "Sign-in failed."
        );
        return;
      }
      if (!body.token) {
        setFormError("No token returned.");
        return;
      }
      writeStoredToken(body.token);
      reloadFromStorage();
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="module-shell" style={{ maxWidth: 620, margin: "0 auto" }}>
      <div className="panel" style={{ padding: 22 }}>
        <p className="eyebrow">AgentFlow</p>
        <h1 style={{ marginTop: 8 }}>Sign in</h1>
        <p className="muted" style={{ marginTop: 8 }}>
          Workspace email and password. HighLevel OAuth (for API tokens) is separate — use Settings when needed.
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

        {formError ? (
          <p className="inbox-reply-error" style={{ marginTop: 14 }}>
            {formError}
          </p>
        ) : null}

        <form onSubmit={onLogin} style={{ marginTop: 18 }}>
          <label className="muted" style={{ display: "block", marginBottom: 6, fontSize: 13 }}>
            Email
          </label>
          <input
            autoComplete="email"
            className="inbox-reply-input"
            name="email"
            onChange={(ev) => setEmail(ev.target.value)}
            required
            style={{ width: "100%", maxWidth: 400, marginBottom: 14 }}
            type="email"
            value={email}
          />
          <label className="muted" style={{ display: "block", marginBottom: 6, fontSize: 13 }}>
            Password
          </label>
          <input
            autoComplete="current-password"
            className="inbox-reply-input"
            name="password"
            onChange={(ev) => setPassword(ev.target.value)}
            required
            style={{ width: "100%", maxWidth: 400, marginBottom: 18 }}
            type="password"
            value={password}
          />

          <button className="button" disabled={pending || !hydrated} type="submit">
            {pending ? "Please wait…" : "Sign in"}
          </button>
        </form>
      </div>
    </section>
  );
}
