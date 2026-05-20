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

  async function toggleSubaccount(locationId: string, nextVisible: boolean, current: SubaccountOverview[]) {
    const previous = current;
    const optimistic = current.map((subaccount) =>
      subaccount.locationId === locationId ? { ...subaccount, visible: nextVisible } : subaccount
    );
    const locationIds = optimistic.filter((s) => s.visible).map((s) => s.locationId);

    setSubaccounts(optimistic);
    setSavingIds((s) => ({ ...s, [locationId]: true }));
    setError(null);

    try {
      const jwtResponse = await fetch(`${apiBaseUrl}/workspace/me/location-selections`, {
        method: "PUT",
        headers: mergeWorkspaceHeaders({
          "Content-Type": "application/json"
        }),
        body: JSON.stringify({ locationIds })
      });

      if (jwtResponse.ok) {
        const response = await fetch(`${apiBaseUrl}/subaccounts/overview?surface=all`, {
          headers: mergeWorkspaceHeaders()
        });
        if (response.ok) {
          const data = (await response.json()) as { subaccounts: SubaccountOverview[] };
          setSubaccounts(data.subaccounts);
        }
        return;
      }

      if (jwtResponse.status !== 401) {
        const payload = (await jwtResponse.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? "Failed to update selections");
      }

      const legacyResponse = await fetch(`${apiBaseUrl}/subaccounts/visibility`, {
        method: "POST",
        headers: mergeWorkspaceHeaders({
          "Content-Type": "application/json"
        }),
        body: JSON.stringify({
          locationId,
          visible: nextVisible
        })
      });

      if (!legacyResponse.ok) {
        const payload = (await legacyResponse.json().catch(() => ({}))) as { error?: string };
        if (payload.error === "forbidden_legacy_only") {
          throw new Error("Sign in with GoHighLevel to save selections.");
        }
        throw new Error("Failed to update subaccount visibility");
      }

      setSubaccounts(optimistic);
    } catch (caught) {
      setSubaccounts(previous);
      setError(caught instanceof Error ? caught.message : "Failed to update subaccount visibility");
    } finally {
      setSavingIds((s) => {
        const copy = { ...s };
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
          With an active GoHighLevel session, each change replaces the account list used to drive filters. Legacy mode
          continues to use the viewer-key endpoint.
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
                onChange={(event) => toggleSubaccount(subaccount.locationId, event.target.checked, subaccounts)}
                type="checkbox"
              />
            </label>
          ))}
        </div>
      </div>
    </section>
  );
}
