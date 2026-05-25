"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { getApiBaseUrl } from "../../../lib/api-base-url";
import type { SubaccountOverview } from "@agentflow/shared";
import { formatLocationName } from "../../../lib/location-display";
import { mergeWorkspaceHeaders } from "../../../lib/workspace-api-headers";
import { DashboardSubnav } from "../dashboard-subnav";

export default function DashboardSubaccountPickerPage() {
  const apiBaseUrl = getApiBaseUrl();
  const router = useRouter();
  const [subs, setSubs] = useState<SubaccountOverview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    async function run() {
      setLoading(true);
      setError(null);
      try {
        const res = await fetch(`${apiBaseUrl}/subaccounts/overview?surface=appointments`, {
          signal: ac.signal,
          headers: mergeWorkspaceHeaders(),
          cache: "no-store"
        });
        const data = (await res.json().catch(() => ({}))) as { subaccounts?: SubaccountOverview[]; error?: string };
        if (!res.ok) {
          throw new Error(data.error ?? "Failed to load locations");
        }
        setSubs(data.subaccounts ?? []);
      } catch (e) {
        if (!ac.signal.aborted) {
          setError(e instanceof Error ? e.message : "Failed to load");
        }
      } finally {
        if (!ac.signal.aborted) {
          setLoading(false);
        }
      }
    }
    void run();
    return () => ac.abort();
  }, [apiBaseUrl]);

  return (
    <div style={{ paddingTop: 8 }}>
      <DashboardSubnav />
      {loading ? <p className="muted">Loading locations…</p> : null}
      {error ? <p className="empty">{error}</p> : null}
      {!loading && subs.length === 0 ? <p className="muted">No subaccounts available.</p> : null}
      {!loading && subs.length > 0 ? (
        <div className="panel" style={{ padding: 16 }}>
          <label className="appointments-filter-label" htmlFor="dashboard-loc-pick">
            Select subaccount
          </label>
          <select
            className="appointments-filter-select"
            id="dashboard-loc-pick"
            onChange={(e) => {
              const id = e.target.value;
              if (id) {
                router.push(`/dashboard/subaccount/${id}`);
              }
            }}
            style={{ display: "block", marginTop: 8, maxWidth: 400 }}
            value=""
          >
            <option value="">Choose…</option>
            {subs.map((s) => (
              <option key={s.locationId} value={s.locationId}>
                {formatLocationName(s.locationName, s.ghlLocationId)}
              </option>
            ))}
          </select>
        </div>
      ) : null}
    </div>
  );
}
