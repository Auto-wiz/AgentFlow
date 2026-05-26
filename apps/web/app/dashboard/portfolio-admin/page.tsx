"use client";

import { useEffect, useMemo, useState } from "react";

import { getApiBaseUrl } from "../../../lib/api-base-url";
import { mergeWorkspaceHeaders } from "../../../lib/workspace-api-headers";
import { useWorkspaceAuth } from "../../components/workspace-auth-provider";
import { useGuardedNavigate } from "../../components/navigation-guard-provider";
import { DashboardSubnav } from "../dashboard-subnav";

type PortfolioDashboardLocation = {
  locationId: string;
  ghlLocationId: string;
  name: string | null;
  excludeFromDashboard: boolean;
};

export default function DashboardPortfolioAdminPage() {
  const apiBaseUrl = getApiBaseUrl();
  const { replaceGuarded } = useGuardedNavigate();
  const { user, hydrated, sessionKey } = useWorkspaceAuth();

  const [portfolioLocs, setPortfolioLocs] = useState<PortfolioDashboardLocation[]>([]);
  const [portfolioLoading, setPortfolioLoading] = useState(false);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);
  const [portfolioBusyLocationId, setPortfolioBusyLocationId] = useState<string | null>(null);

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    if (user?.role !== "admin") {
      void replaceGuarded("/dashboard");
    }
  }, [hydrated, replaceGuarded, user?.role]);

  useEffect(() => {
    let cancelled = false;

    async function loadPortfolioLocations() {
      if (!hydrated || user?.role !== "admin") {
        setPortfolioLocs([]);
        return;
      }
      setPortfolioLoading(true);
      setPortfolioError(null);
      try {
        const res = await fetch(`${apiBaseUrl}/admin/workspace-locations`, {
          headers: mergeWorkspaceHeaders()
        });
        const payload = (await res.json().catch(() => ({}))) as {
          locations?: PortfolioDashboardLocation[];
          error?: string;
        };
        if (!res.ok) {
          throw new Error(payload.error ?? "Unable to load locations");
        }
        if (!cancelled) {
          setPortfolioLocs(payload.locations ?? []);
        }
      } catch (caught) {
        if (!cancelled) {
          setPortfolioError(caught instanceof Error ? caught.message : "Unable to load locations");
          setPortfolioLocs([]);
        }
      } finally {
        if (!cancelled) {
          setPortfolioLoading(false);
        }
      }
    }

    void loadPortfolioLocations();
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, hydrated, sessionKey, user?.role]);

  async function toggleDashboardExclusion(locationId: string, excludeFromDashboard: boolean) {
    if (user?.role !== "admin") {
      return;
    }
    setPortfolioBusyLocationId(locationId);
    setPortfolioError(null);
    try {
      const res = await fetch(
        `${apiBaseUrl}/admin/workspace-locations/${locationId}/dashboard-exclusion`,
        {
          method: "PATCH",
          headers: mergeWorkspaceHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ excludeFromDashboard })
        }
      );
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(payload.error ?? "Update failed");
      }
      setPortfolioLocs((rows) =>
        rows.map((r) => (r.locationId === locationId ? { ...r, excludeFromDashboard } : r))
      );
    } catch (caught) {
      setPortfolioError(caught instanceof Error ? caught.message : "Update failed");
    } finally {
      setPortfolioBusyLocationId(null);
    }
  }

  const gateNote = useMemo(() => {
    if (!hydrated) {
      return "Loading workspace session…";
    }
    if (user?.role !== "admin") {
      return "Redirecting…";
    }
    return null;
  }, [hydrated, user?.role]);

  return (
    <div style={{ paddingTop: 8 }}>
      <DashboardSubnav />

      {gateNote ? <p className="muted" style={{ marginTop: 12 }}>{gateNote}</p> : null}

      {user?.role === "admin" ? (
        <div className="panel" style={{ padding: 18, marginTop: 12 }}>
          <h2 style={{ marginTop: 0 }}>Portfolio exclusions</h2>
          <p className="muted">
            Check a subaccount to hide it from dashboard KPIs and the overview table (internal or churned clients). It
            stays available in the rest of AgentFlow. Subaccount drill-down returns an error for excluded locations.
          </p>

          {portfolioLoading ? <p className="muted" style={{ marginTop: 14 }}>Loading locations…</p> : null}
          {portfolioError ? <div className="empty" style={{ marginTop: 12 }}>{portfolioError}</div> : null}

          {!portfolioLoading && !portfolioError && portfolioLocs.length > 0 ? (
            <div className="subaccounts-config-list" style={{ marginTop: 16 }}>
              {[...portfolioLocs]
                .sort((a, b) => {
                  const na = (a.name ?? a.ghlLocationId).toLowerCase();
                  const nb = (b.name ?? b.ghlLocationId).toLowerCase();
                  return na.localeCompare(nb);
                })
                .map((loc) => (
                  <label className="subaccount-config-row" key={loc.locationId}>
                    <div>
                      <strong>{loc.name ?? loc.ghlLocationId}</strong>
                      <div className="muted">GHL: {loc.ghlLocationId}</div>
                      <div className="muted">uuid: {loc.locationId}</div>
                    </div>
                    <input
                      aria-label={`Exclude ${loc.ghlLocationId} from portfolio dashboard`}
                      checked={Boolean(loc.excludeFromDashboard)}
                      disabled={portfolioBusyLocationId === loc.locationId || user?.role !== "admin"}
                      type="checkbox"
                      onChange={(event) =>
                        void toggleDashboardExclusion(loc.locationId, event.target.checked)
                      }
                    />
                  </label>
                ))}
            </div>
          ) : null}

          {!portfolioLoading && !portfolioError && portfolioLocs.length === 0 ? (
            <p className="muted" style={{ marginTop: 14 }}>
              No locations synced yet.
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
