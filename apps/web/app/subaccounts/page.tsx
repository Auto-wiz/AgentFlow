"use client";

import type { SubaccountOverview } from "@agentflow/shared";
import { getApiBaseUrl } from "../../lib/api-base-url";
import { mergeWorkspaceHeaders } from "../../lib/workspace-api-headers";
import { useWorkspaceAuth } from "../components/workspace-auth-provider";
import { useEffect, useMemo, useState } from "react";

function formatLocationName(locationName: string | null, ghlLocationId: string) {
  return locationName ? `${locationName} (${ghlLocationId})` : ghlLocationId;
}

export default function SubaccountsPage() {
  const apiBaseUrl = getApiBaseUrl();
  const { sessionKey } = useWorkspaceAuth();
  const [subaccounts, setSubaccounts] = useState<SubaccountOverview[]>([]);
  const [searchLocationId, setSearchLocationId] = useState("");
  const [savingIds, setSavingIds] = useState<Record<string, boolean>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function loadSubaccounts() {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch(`${apiBaseUrl}/subaccounts/overview?surface=all`, {
          signal: controller.signal,
          headers: mergeWorkspaceHeaders()
        });
        if (!response.ok) {
          throw new Error("Failed to load subaccounts");
        }
        const data = (await response.json()) as { subaccounts: SubaccountOverview[] };
        setSubaccounts(data.subaccounts);
      } catch (caught) {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : "Failed to load subaccounts");
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    loadSubaccounts();
    return () => controller.abort();
  }, [apiBaseUrl, sessionKey]);

  const filteredSubaccounts = useMemo(() => {
    const normalizedSearch = searchLocationId.trim().toLowerCase();
    if (!normalizedSearch) {
      return subaccounts;
    }
    return subaccounts.filter((subaccount) =>
      subaccount.ghlLocationId.toLowerCase().includes(normalizedSearch)
    );
  }, [searchLocationId, subaccounts]);

  async function toggleSubaccount(locationId: string, nextVisible: boolean) {
    const previous = subaccounts;
    setSubaccounts((current) =>
      current.map((subaccount) =>
        subaccount.locationId === locationId ? { ...subaccount, visible: nextVisible } : subaccount
      )
    );
    setSavingIds((current) => ({ ...current, [locationId]: true }));
    setError(null);

    try {
      const response = await fetch(`${apiBaseUrl}/subaccounts/visibility`, {
        method: "POST",
        headers: mergeWorkspaceHeaders({
          "Content-Type": "application/json"
        }),
        body: JSON.stringify({
          locationId,
          visible: nextVisible
        })
      });
      if (!response.ok) {
        const payload = (await response.json().catch(() => ({}))) as { error?: string };
        if (payload.error === "forbidden_use_admin_portal") {
          throw new Error("Workspace users cannot change visibility here. Ask an admin.");
        }
        throw new Error("Failed to update subaccount visibility");
      }
    } catch (caught) {
      setSubaccounts(previous);
      setError(caught instanceof Error ? caught.message : "Failed to update subaccount visibility");
    } finally {
      setSavingIds((current) => {
        const copy = { ...current };
        delete copy[locationId];
        return copy;
      });
    }
  }

  return (
    <section className="module-shell">
      <div className="panel" style={{ padding: 18 }}>
        <p className="eyebrow">Management module</p>
        <h2 style={{ marginTop: 8 }}>Subaccounts tracking</h2>
        <p className="muted">
          Tracks visibility using the shared dashboard chrome for a consistent workspace experience.
        </p>
      </div>

      <div className="panel" style={{ padding: 18, marginBottom: 12 }}>
        <p className="eyebrow">Subaccounts</p>
        <h2 style={{ marginTop: 8 }}>Track and filter visible subaccounts</h2>
        <div className="toolbar">
          <input
            aria-label="Search by location ID"
            placeholder="Search by location ID"
            value={searchLocationId}
            onChange={(event) => setSearchLocationId(event.target.value)}
          />
        </div>
      </div>

      <div className="panel" style={{ padding: 18 }}>
        {loading ? <div className="empty muted">Loading subaccounts...</div> : null}
        {error ? <div className="empty">{error}</div> : null}
        {!loading && !error && filteredSubaccounts.length === 0 ? (
          <div className="empty muted">No subaccounts found.</div>
        ) : null}
        <div className="subaccounts-config-list">
          {filteredSubaccounts.map((subaccount) => (
            <label className="subaccount-config-row" key={subaccount.locationId}>
              <div>
                <strong>{formatLocationName(subaccount.locationName, subaccount.ghlLocationId)}</strong>
                <div className="muted">Location ID: {subaccount.ghlLocationId}</div>
                <div className="muted">{subaccount.appointmentCount} appointments</div>
              </div>
              <input
                aria-label={`Track subaccount ${subaccount.ghlLocationId}`}
                checked={subaccount.visible}
                disabled={Boolean(savingIds[subaccount.locationId])}
                onChange={(event) => toggleSubaccount(subaccount.locationId, event.target.checked)}
                type="checkbox"
              />
            </label>
          ))}
        </div>
      </div>
    </section>
  );
}
