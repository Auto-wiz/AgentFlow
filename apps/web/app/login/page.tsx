"use client";

import { getApiBaseUrl } from "../../lib/api-base-url";
import { writeStoredToken } from "../../lib/auth-storage";
import { isForceWorkspaceLogin } from "../../lib/workspace-auth-env";
import { useWorkspaceAuth } from "../components/workspace-auth-provider";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

export default function LoginPage() {
  const router = useRouter();
  const { hydrated, reloadFromStorage } = useWorkspaceAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const notice = useMemo(() => {
    if (!hydrated) {
      return null;
    }
    if (!isForceWorkspaceLogin()) {
      return "Workspace login is not enforced for this deployment (NEXT_PUBLIC_FORCE_WORKSPACE_LOGIN). You can use the app with the legacy viewer key until JWT auth is enabled on the API.";
    }
    return null;
  }, [hydrated]);

  async function onSubmit(ev: React.FormEvent) {
    ev.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const apiBaseUrl = getApiBaseUrl();
      const res = await fetch(`${apiBaseUrl}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          password
        })
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string; token?: string };
      if (!res.ok) {
        if (payload.error === "jwt_not_configured") {
          throw new Error("Server has workspace auth disabled (JWT_SECRET not set). Enable it before logging in.");
        }
        throw new Error(payload.error === "invalid_credentials" ? "Invalid email or password" : "Could not log in.");
      }
      if (!payload.token) {
        throw new Error("No token returned.");
      }
      writeStoredToken(payload.token);
      reloadFromStorage();
      const params = typeof window !== "undefined" ? new URLSearchParams(window.location.search) : null;
      const next = params?.get("next");
      router.replace(next && next.startsWith("/") ? next : "/appointments");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not log in.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="module-shell" style={{ maxWidth: 480, margin: "0 auto" }}>
      <div className="panel" style={{ padding: 24 }}>
        <p className="eyebrow">AgentFlow workspace</p>
        <h1 style={{ marginTop: 8 }}>Sign in</h1>
        <p className="muted" style={{ marginTop: 8 }}>
          Accounts are provisioned internally. There is no public registration flow.
        </p>
        {notice ? (
          <p className="muted" style={{ marginTop: 12 }}>
            {notice}{" "}
            <Link className="app-user-menu-link" href="/appointments">
              Continue to appointments
            </Link>
          </p>
        ) : null}

        <form onSubmit={(e) => void onSubmit(e)} style={{ marginTop: 20 }}>
          <label className="inbox-field-label" htmlFor="workspace-email">
            Email
          </label>
          <input
            id="workspace-email"
            autoComplete="email"
            name="email"
            onChange={(e) => setEmail(e.target.value)}
            placeholder="you@agency.com"
            style={{ marginTop: 6, marginBottom: 14, width: "100%" }}
            type="email"
            value={email}
          />

          <label className="inbox-field-label" htmlFor="workspace-password">
            Password
          </label>
          <input
            id="workspace-password"
            autoComplete="current-password"
            name="password"
            onChange={(e) => setPassword(e.target.value)}
            style={{ marginTop: 6, marginBottom: 18, width: "100%" }}
            type="password"
            value={password}
          />

          {error ? <p className="inbox-reply-error" style={{ marginBottom: 12 }}>{error}</p> : null}

          <button className="button" disabled={submitting} type="submit">
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>
      </div>
    </section>
  );
}
