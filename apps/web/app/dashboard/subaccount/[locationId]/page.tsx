"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { getApiBaseUrl } from "../../../../lib/api-base-url";
import type { SubaccountOverview } from "@agentflow/shared";
import { formatLocationName } from "../../../../lib/location-display";
import { mergeWorkspaceHeaders } from "../../../../lib/workspace-api-headers";
import { DashboardRangeControl, type DateRangeStrings, utcInclusiveRange } from "../../dashboard-date-range";
import { DashboardSubnav } from "../../dashboard-subnav";

type PresetKey = "7" | "30" | "90" | "custom";

type SeriesBucket = {
  bucketStart: string;
  bookedAppointments: number;
  appointmentsWithCollectedPayment: number;
  depositsCollectedPercentage: number | null;
  granularity: string;
};

type SeriesResponse = {
  fromInclusive: string;
  toExclusive: string;
  granularity: string;
  locationId: string;
  ghlLocationId: string | null;
  locationName: string | null;
  summary: {
    bookedAppointments: number;
    appointmentsWithCollectedPayment: number;
    depositsCollectedPercentage: number | null;
    depositsCollectedAmountCents: number;
    depositsCollectedFormatted: string;
  };
  series: SeriesBucket[];
};

function pctLabel(v: number | null) {
  if (v === null || !Number.isFinite(v)) {
    return "—";
  }
  return `${v}%`;
}

export default function DashboardSubaccountDetailPage({ params }: { params: { locationId: string } }) {
  const router = useRouter();
  const apiBaseUrl = useMemo(() => getApiBaseUrl(), []);
  const locationId = params.locationId;
  const [subs, setSubs] = useState<SubaccountOverview[]>([]);

  const [preset, setPreset] = useState<Exclude<PresetKey, "custom"> | "custom">("30");
  const [range, setRange] = useState(() => utcInclusiveRange(30));
  const [customDraft, setCustomDraft] = useState<DateRangeStrings>(() => utcInclusiveRange(30));
  const [granularity, setGranularity] = useState<"day" | "week">("day");
  const [data, setData] = useState<SeriesResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    async function run() {
      try {
        const res = await fetch(`${apiBaseUrl}/subaccounts/overview?surface=appointments`, {
          signal: ac.signal,
          headers: mergeWorkspaceHeaders(),
          cache: "no-store"
        });
        const payload = (await res.json().catch(() => ({}))) as { subaccounts?: SubaccountOverview[] };
        if (res.ok && payload.subaccounts) {
          setSubs(payload.subaccounts);
        }
      } catch {
        /* optional */
      }
    }
    void run();
    return () => ac.abort();
  }, [apiBaseUrl]);

  const query = useMemo(
    () =>
      new URLSearchParams({
        from: range.fromInclusive,
        to: range.toInclusive,
        granularity
      }),
    [granularity, range]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `${apiBaseUrl}/workspace/dashboard/locations/${encodeURIComponent(locationId)}/series?${query}`,
        { headers: mergeWorkspaceHeaders(), cache: "no-store" }
      );
      const payload = (await res.json().catch(() => ({}))) as SeriesResponse & { error?: string };
      if (!res.ok) {
        throw new Error(payload.error ?? "Failed to load subaccount metrics");
      }
      setData(payload);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, locationId, query]);

  useEffect(() => {
    void load();
  }, [load]);

  const bookedSeries = (data?.series ?? []).map((b) => b.bookedAppointments);
  const maxBooked = Math.max(1, ...bookedSeries, 0);

  const locationHeading = formatLocationName(data?.locationName ?? null, data?.ghlLocationId ?? "");

  return (
    <div style={{ paddingTop: 8 }}>
      <DashboardSubnav
        locationTail={
          subs.length > 0 ? (
            <select
              aria-label="Switch subaccount"
              className="appointments-filter-select dashboard-subaccount-inline-select"
              onChange={(e) => {
                const id = e.target.value;
                if (id) {
                  router.push(`/dashboard/subaccount/${id}`);
                }
              }}
              value={subs.some((s) => s.locationId === locationId) ? locationId : subs[0]?.locationId}
            >
              {subs.map((s) => (
                <option key={s.locationId} value={s.locationId}>
                  {formatLocationName(s.locationName, s.ghlLocationId)}
                </option>
              ))}
            </select>
          ) : null
        }
      />

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
        onCustomDraft={setCustomDraft}
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

      <div className="toolbar" style={{ gap: 12, marginBottom: 12 }}>
        <span className="muted appointments-filter-label">Chart</span>
        <select
          className="appointments-filter-select"
          onChange={(e) => setGranularity(e.target.value as "day" | "week")}
          style={{ maxWidth: 200 }}
          value={granularity}
        >
          <option value="day">By day</option>
          <option value="week">By week</option>
        </select>
      </div>

      {loading ? <p className="muted">Loading…</p> : null}
      {error ? <p className="empty">{error}</p> : null}

      {!loading && data ? (
        <>
          <h2 className="dashboard-sub-heading">{locationHeading}</h2>
          <div className="dashboard-kpi-grid">
            <div className="panel dashboard-kpi-panel">
              <p className="dashboard-kpi-eyebrow">Booked appointments</p>
              <p className="dashboard-kpi-value">{data.summary.bookedAppointments}</p>
            </div>
            <div className="panel dashboard-kpi-panel">
              <p className="dashboard-kpi-eyebrow">Paid bookings</p>
              <p className="dashboard-kpi-value">{data.summary.appointmentsWithCollectedPayment}</p>
              <p className="muted dashboard-kpi-sub">{pctLabel(data.summary.depositsCollectedPercentage)} conversion</p>
            </div>
            <div className="panel dashboard-kpi-panel">
              <p className="dashboard-kpi-eyebrow">Deposits collected</p>
              <p className="dashboard-kpi-value">{data.summary.depositsCollectedFormatted}</p>
            </div>
          </div>

          <div className="panel dashboard-chart-panel" style={{ marginTop: 16, padding: 16 }}>
            <p className="appointments-filter-label" style={{ marginBottom: 12 }}>
              Booked vs paid (by {data.granularity})
            </p>
            <div className="dashboard-bar-list">
              {(data.series ?? []).map((b) => (
                <div className="dashboard-bar-row" key={b.bucketStart}>
                  <span className="dashboard-bar-label muted">
                    {new Date(b.bucketStart).toLocaleDateString("en-US", {
                      month: "short",
                      day: "numeric",
                      year: data.granularity === "week" ? "numeric" : undefined
                    })}
                  </span>
                  <div className="dashboard-bar-track">
                    <div
                      className="dashboard-bar-fill dashboard-bar-booked"
                      style={{ width: `${Math.min(100, maxBooked ? (b.bookedAppointments / maxBooked) * 100 : 0)}%` }}
                      title={`Booked: ${b.bookedAppointments}`}
                    />
                  </div>
                  <div className="dashboard-bar-track">
                    <div
                      className="dashboard-bar-fill dashboard-bar-paid"
                      style={{
                        width: `${Math.min(100, maxBooked ? (b.appointmentsWithCollectedPayment / maxBooked) * 100 : 0)}%`
                      }}
                      title={`Paid: ${b.appointmentsWithCollectedPayment}`}
                    />
                  </div>
                  <span className="dashboard-bar-meta muted">
                    {b.bookedAppointments} / {b.appointmentsWithCollectedPayment} ({pctLabel(b.depositsCollectedPercentage)})
                  </span>
                </div>
              ))}
            </div>
            {(data.series ?? []).length === 0 ? (
              <p className="muted">No appointment starts in this window.</p>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
