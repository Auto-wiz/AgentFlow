"use client";

import { getApiBaseUrl } from "../../../../lib/api-base-url";
import { mergeWorkspaceHeaders } from "../../../../lib/workspace-api-headers";
import { useWorkspaceAuth } from "../../../components/workspace-auth-provider";
import { useGuardedNavigate } from "../../../components/navigation-guard-provider";
import { useEffect, useState, type FormEvent } from "react";

type CreatedUserSummary = {
  id: string;
  email: string | null;
  displayName: string | null;
  role: string;
  createdAt: string | null;
};

export default function CreateWorkspaceUsersPage() {
  const apiBaseUrl = getApiBaseUrl();
  const { replaceGuarded } = useGuardedNavigate();
  const { user, hydrated } = useWorkspaceAuth();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<"user" | "admin">("user");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [lastCreated, setLastCreated] = useState<CreatedUserSummary | null>(null);

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    if (user?.role !== "admin") {
      void replaceGuarded("/settings");
    }
  }, [hydrated, replaceGuarded, user?.role]);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (!email.trim() || password.length < 8) {
      setFormError("Email and password (min 8 characters) are required.");
      return;
    }
    setSubmitting(true);
    setFormError(null);
    try {
      const res = await fetch(`${apiBaseUrl}/admin/workspace-users`, {
        method: "POST",
        headers: mergeWorkspaceHeaders({
          "Content-Type": "application/json"
        }),
        body: JSON.stringify({
          email: email.trim(),
          password,
          displayName: displayName.trim(),
          role
        })
      });
      const payload = (await res.json().catch(() => ({}))) as {
        user?: CreatedUserSummary;
        error?: string;
        message?: string;
      };
      if (!res.ok) {
        if (payload.error === "email_taken") {
          throw new Error("That email is already registered.");
        }
        throw new Error(payload.message ?? payload.error ?? "Could not create user");
      }
      setLastCreated(payload.user ?? null);
      setEmail("");
      setPassword("");
      setDisplayName("");
      setRole("user");
    } catch (caught) {
      setFormError(caught instanceof Error ? caught.message : "Could not create user");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <>
      <div className="panel" style={{ padding: 18 }}>
        <p className="eyebrow">Workspace · Admin</p>
        <h2 style={{ marginTop: 8 }}>Create workspace user</h2>
        <p className="muted">
          Provision an account that signs in at <code>/login</code> with email and password. Users created through
          GoHighLevel OAuth are unchanged; avoid reusing emails that already exist.
        </p>
      </div>

      <div className="panel" style={{ padding: 18, marginTop: 12 }}>
        <form
          className="auth-login-form"
          onSubmit={(e) => void onSubmit(e)}
          noValidate
          style={{ marginTop: 0, maxWidth: 420 }}
        >
          <div className="auth-login-field">
            <label className="auth-login-label" htmlFor="admin-create-email">
              Email
            </label>
            <input
              autoCapitalize="off"
              autoComplete="username"
              className="auth-login-input"
              id="admin-create-email"
              inputMode="email"
              name="email"
              onChange={(e) => setEmail(e.target.value)}
              placeholder="member@agency.com"
              required
              spellCheck={false}
              type="email"
              value={email}
            />
          </div>

          <div className="auth-login-field">
            <label className="auth-login-label" htmlFor="admin-create-password">
              Password
            </label>
            <input
              autoComplete="new-password"
              className="auth-login-input"
              id="admin-create-password"
              minLength={8}
              name="password"
              onChange={(e) => setPassword(e.target.value)}
              placeholder="············"
              required
              type="password"
              value={password}
            />
          </div>

          <div className="auth-login-field">
            <label className="auth-login-label" htmlFor="admin-create-display-name">
              Display name (optional)
            </label>
            <input
              autoCapitalize="words"
              className="auth-login-input"
              id="admin-create-display-name"
              name="displayName"
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Alex Agent"
              spellCheck={true}
              type="text"
              value={displayName}
            />
          </div>

          <div className="auth-login-field">
            <span className="auth-login-label" id="admin-create-role-label">
              Role
            </span>
            <div
              aria-labelledby="admin-create-role-label"
              className="auth-login-choice-group"
              role="radiogroup"
            >
              <label className="auth-login-radio-row">
                <input
                  checked={role === "user"}
                  name="workspace-role"
                  onChange={() => setRole("user")}
                  type="radio"
                />
                <span>
                  Standard user (<code className="muted">user</code>) — gated by Team access subaccount list
                </span>
              </label>
              <label className="auth-login-radio-row">
                <input
                  checked={role === "admin"}
                  name="workspace-role"
                  onChange={() => setRole("admin")}
                  type="radio"
                />
                <span>
                  Administrator (<code className="muted">admin</code>) — full workspace admin menus
                </span>
              </label>
            </div>
          </div>

          {formError ? (
            <div className="auth-login-alerts" role="alert" style={{ marginTop: 0 }}>
              <p className="auth-login-alert">{formError}</p>
            </div>
          ) : null}

          <button
            className="button auth-login-submit"
            disabled={submitting || user?.role !== "admin"}
            type="submit"
          >
            {submitting ? "Creating…" : "Create user"}
          </button>
        </form>

        {lastCreated ? (
          <div
            className="panel"
            style={{
              marginTop: 20,
              maxWidth: 420,
              padding: 14,
              border: "1px solid var(--border)",
              background: "var(--panel-soft)"
            }}
          >
            <p style={{ margin: 0 }}>
              <strong>Created</strong> <span>{lastCreated.email ?? lastCreated.id}</span>{" "}
              <span className="muted">({lastCreated.role})</span>
            </p>
            <p className="muted" style={{ marginBottom: 0 }}>
              Assign subaccounts under <strong>Team access</strong> for standard users when they&apos;re listed there.
            </p>
          </div>
        ) : null}
      </div>
    </>
  );
}
