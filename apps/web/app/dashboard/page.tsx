"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { getApiBaseUrl } from "../../lib/api-base-url";
import { formatLocationName } from "../../lib/location-display";
import { mergeWorkspaceHeaders } from "../../lib/workspace-api-headers";
import { DashboardRangeControl, type DateRangeStrings, utcInclusiveRange } from "./dashboard-date-range";
import { DashboardSubnav } from "./dashboard-subnav";

type PresetKey = "7" | "30" | "90" | "custom";

type OverviewRow = {
  locationId: string;
  ghlLocationId: string;
  locationName: string | null;
  bookedAppointments: number;
  appointmentsWithCollectedPayment: number;
  depositsCollectedPercentage: number | null;
  depositsCollectedAmountCents: number;
  depositsCollectedFormatted: string;
};

type OverviewResponse = {
  fromInclusive: string;
  toExclusive: string;
  totals: Omit<OverviewRow, "locationId" | "ghlLocationId" | "locationName">;
  subaccounts: OverviewRow[];
};

function pctLabel(v: number | null) {
  if (v === null || !Number.isFinite(v)) {
    return "—";
  }
  return `${v}%`;
}

export default function DashboardOverviewPage() {
  const apiBaseUrl = useMemo(() => getApiBaseUrl(), []);
  const [preset, setPreset] = useState<Exclude<PresetKey, "custom"> | "custom">("30");
  const [range, setRange] = useState(() => utcInclusiveRange(30));
  const [customDraft, setCustomDraft] = useState<DateRangeStrings>(() => utcInclusiveRange(30));
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const query = useMemo(() => new URLSearchParams({ from: range.fromInclusive, to: range.toInclusive }), [range]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiBaseUrl}/workspace/dashboard/overview?${query}`, {
        headers: mergeWorkspaceHeaders(),
        cache: "no-store"
      });
      const payload = (await res.json().catch(() => ({}))) as OverviewResponse & { error?: string };
      if (!res.ok) {
        throw new Error(payload.error ?? "Failed to load dashboard");
      }
      setOverview(payload as OverviewResponse);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setOverview(null);
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, query]);

  useEffect(() => {
    void load();
  }, [load]);

  const sortedRows = useMemo(
    () => [...(overview?.subaccounts ?? [])].sort((a, b) => b.bookedAppointments - a.bookedAppointments),
    [overview]
  );

  return (
    <div style={{ paddingTop: 8 }}>
      <DashboardSubnav />
      <DashboardRangeControl
        customDraft={customDraft}
        onApplyCustom={() => {
          const f = Date.parse(customDraft.fromInclusive.slice(0, 10));
          const t = Date.parse(customDraft.toInclusive.slice(0, 10));
          if (!Number.isFinite(f) || !Number.isFinite(t) || f > t) {
            setError("Invalid custom range.");
            return;
          }
          setPreset("custom");
          setRange({ fromInclusive: customDraft.fromInclusive.slice(0, 10), toInclusive: customDraft.toInclusive.slice(0, 10) });
          setError(null);
        }}
        onCustomDraft={(d) => setCustomDraft(d)}
        onPresetChange={(p) => {
          if (p === "7" || p === "30" || p === "90") {
            setPreset(p);
            setRange(utcInclusiveRange(Number(p)));
            setError(null);
            return;
          }
          setPreset("custom");
          setCustomDraft({ ...range });
        }}
        preset={preset}
        value={range}
      />
      {loading ? <p className="muted">Loading dashboard…</p> : null}
      {error ? <p className="empty">{error}</p> : null}
      {!loading && overview ? (
        <>
          <div className="dashboard-kpi-grid">
            <div className="panel dashboard-kpi-panel">
              <p className="dashboard-kpi-eyebrow">Booked appointments</p>
              <p className="dashboard-kpi-value">{overview.totals.bookedAppointments}</p>
            </div>
            <div className="panel dashboard-kpi-panel">
              <p className="dashboard-kpi-eyebrow">Collected (bookings paid)</p>
              <p className="dashboard-kpi-value">{overview.totals.appointmentsWithCollectedPayment}</p>
              <p className="muted dashboard-kpi-sub">{pctLabel(overview.totals.depositsCollectedPercentage)} conversion</p>
            </div>
            <div className="panel dashboard-kpi-panel">
              <p className="dashboard-kpi-eyebrow">Deposits collected</p>
              <p className="dashboard-kpi-value">{overview.totals.depositsCollectedFormatted}</p>
              <p className="muted dashboard-kpi-sub">Invoices + paid orders · period</p>
            </div>
          </div>
          <div className="panel" style={{ marginTop: 16, overflow: "auto", padding: 0 }}>
            <table className="dashboard-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Subaccount</th>
                  <th>Booked</th>
                  <th>Paid bookings</th>
                  <th>Conversion</th>
                  <th>Deposits</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {sortedRows.map((row, idx) => (
                  <tr key={row.locationId}>
                    <td>{idx + 1}</td>
                    <td>{formatLocationName(row.locationName, row.ghlLocationId)}</td>
                    <td>{row.bookedAppointments}</td>
                    <td>{row.appointmentsWithCollectedPayment}</td>
                    <td>{pctLabel(row.depositsCollectedPercentage)}</td>
                    <td>{row.depositsCollectedFormatted}</td>
                    <td>
                      <Link
                        className="dashboard-drill-link"
                        href={`/dashboard/subaccount?locationId=${encodeURIComponent(row.locationId)}`}
                      >
                        View
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {sortedRows.length === 0 ? (
              <p className="empty muted" style={{ padding: 16 }}>
                No booked appointments in this window for visible locations.
              </p>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
