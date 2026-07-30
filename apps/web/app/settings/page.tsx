"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useMemo } from "react";
import { getGhlInstallUrl } from "../../lib/ghl-install-url";
import { useWorkspaceAuth } from "../components/workspace-auth-provider";

function describeGhlOAuthBanner(ghl: string | null, reason: string | null, warn: string | null): string | null {
  if (ghl === "connected") {
    if (warn === "no_ghl_user_id") {
      return "GoHighLevel connected and API tokens saved. HighLevel did not return a user id in the token (this is fine — no workspace user was created).";
    }
    return "GoHighLevel connected. API tokens are saved; you stay signed in as your current workspace user.";
  }
  if (ghl === "error") {
    if (reason === "wrong_agency") {
      return "This workspace is linked to a different HighLevel agency. Use the same agency as your existing data.";
    }
    if (reason?.trim()) {
      return reason.includes("_") ? reason.replace(/_/g, " ") : reason;
    }
    return "GoHighLevel connection failed.";
  }
  return null;
}

export default function SettingsPage() {
  const goHighLevelConnectUrl = getGhlInstallUrl();
  const { user, hydrated } = useWorkspaceAuth();
  const searchParams = useSearchParams();

  const isAdmin = hydrated && user?.role === "admin";
  const ghlBanner = useMemo(
    () =>
      describeGhlOAuthBanner(
        searchParams.get("ghl"),
        searchParams.get("reason"),
        searchParams.get("warn")
      ),
    [searchParams]
  );

  return (
    <>
      {ghlBanner ? (
        <div className="panel" style={{ padding: 14, marginBottom: 16 }} role="status">
          <p style={{ margin: 0 }}>{ghlBanner}</p>
        </div>
      ) : null}
      <div className="panel" style={{ padding: 18 }}>
        <p className="eyebrow">Configuration module</p>
        <h2 style={{ marginTop: 8 }}>Settings</h2>
        <p className="muted">
          {isAdmin
            ? "Central place for GoHighLevel connection setup and internal workspace configuration."
            : "Preferences for subaccount visibility and how Appointments behaves for your account."}
        </p>
      </div>

      <div className="panel" style={{ padding: 18 }}>
        <div className="placeholder-grid">
          {isAdmin ? (
            <article className="placeholder-card">
              <strong>GoHighLevel setup</strong>
              <span className="muted">OAuth and connected locations</span>
              <a className="button" href={goHighLevelConnectUrl}>
                Connect GoHighLevel
              </a>
            </article>
          ) : null}
          <article className="placeholder-card">
            <strong>Subaccount visibility</strong>
            <span className="muted">Choose which subaccounts are shown in Appointments</span>
            <Link className="button secondary" href="/subaccounts">
              Manage subaccounts
            </Link>
          </article>
          {isAdmin ? (
            <article className="placeholder-card">
              <strong>Workspace admin</strong>
              <span className="muted">Choose which locations each role=user can filter by default</span>
              <Link className="button secondary" href="/settings/admin">
                Open workspace admin
              </Link>
            </article>
          ) : null}
        </div>
      </div>
    </>
  );
}
