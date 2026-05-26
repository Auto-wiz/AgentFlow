"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import { getApiBaseUrl } from "../../../lib/api-base-url";
import type { SubaccountOverview } from "@agentflow/shared";
import { formatLocationName } from "../../../lib/location-display";
import { mergeWorkspaceHeaders } from "../../../lib/workspace-api-headers";
import { DashboardRangeControl, type DateRangeStrings, utcInclusiveRange } from "../dashboard-date-range";
import { DashboardSubnav } from "../dashboard-subnav";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isLocationUuid(raw: string | null): raw is string {
  return typeof raw === "string" && UUID_RE.test(raw.trim());
}

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
    depositsCollectedAmount: number;
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

function subaccountHref(locationId: string) {
  const q = new URLSearchParams({ locationId });
  return `/dashboard/subaccount?${q.toString()}`;
}

export default function DashboardSubaccountClient() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const apiBaseUrl = useMemo(() => getApiBaseUrl(), []);

  const locationIdParam = searchParams.get("locationId");
  const locationId = isLocationUuid(locationIdParam) ? locationIdParam.trim() : null;

  const [subs, setSubs] = useState<SubaccountOverview[]>([]);
  const [subsLoading, setSubsLoading] = useState(true);
  const [subsError, setSubsError] = useState<string | null>(null);

  const [preset, setPreset] = useState<Exclude<PresetKey, "custom"> | "custom">("30");
  const [range, setRange] = useState(() => utcInclusiveRange(30));
  const [customDraft, setCustomDraft] = useState<DateRangeStrings>(() => utcInclusiveRange(30));
  const [granularity, setGranularity] = useState<"day" | "week">("day");
  const [data, setData] = useState<SeriesResponse | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    const ac = new AbortController();
    async function run() {
      setSubsLoading(true);
      setSubsError(null);
      try {
        const res = await fetch(`${apiBaseUrl}/subaccounts/overview?surface=dashboard`, {
          signal: ac.signal,
          headers: mergeWorkspaceHeaders(),
          cache: "no-store"
        });
        const payload = (await res.json().catch(() => ({}))) as { subaccounts?: SubaccountOverview[]; error?: string };
        if (!res.ok) {
          throw new Error(payload.error ?? "Failed to load locations");
        }
        setSubs(payload.subaccounts ?? []);
      } catch (e) {
        if (!ac.signal.aborted) {
          setSubsError(e instanceof Error ? e.message : "Failed to load");
        }
      } finally {
        if (!ac.signal.aborted) {
          setSubsLoading(false);
        }
      }
    }
    void run();
    return () => ac.abort();
  }, [apiBaseUrl]);

  const seriesQuery = useMemo(
    () =>
      new URLSearchParams({
        from: range.fromInclusive,
        to: range.toInclusive,
        granularity
      }),
    [granularity, range]
  );

  const loadSeries = useCallback(async () => {
    if (!locationId) {
      return;
    }
    setDetailLoading(true);
    setDetailError(null);
    try {
      const res = await fetch(
        `${apiBaseUrl}/workspace/dashboard/locations/${encodeURIComponent(locationId)}/series?${seriesQuery}`,
        { headers: mergeWorkspaceHeaders(), cache: "no-store" }
      );
      const payload = (await res.json().catch(() => ({}))) as SeriesResponse & { error?: string };
      if (!res.ok) {
        const code = payload.error;
        const readable =
          code === "location_excluded_from_dashboard"
            ? "This subaccount was excluded from the portfolio dashboard (Dashboard → Portfolio admin)."
            : code ?? "Failed to load subaccount metrics";
        throw new Error(readable);
      }
      setData(payload);
    } catch (e) {
      setDetailError(e instanceof Error ? e.message : "Failed to load");
      setData(null);
    } finally {
      setDetailLoading(false);
    }
  }, [apiBaseUrl, locationId, seriesQuery]);

  useEffect(() => {
    if (locationId) {
      void loadSeries();
    } else {
      setData(null);
      setDetailError(null);
      setDetailLoading(false);
    }
  }, [loadSeries, locationId]);

  const bookedSeries = (data?.series ?? []).map((b) => b.bookedAppointments);
  const maxBooked = Math.max(1, ...bookedSeries, 0);
  const locationHeading = formatLocationName(data?.locationName ?? null, data?.ghlLocationId ?? "");

  const invalidQuery = Boolean(locationIdParam && !locationId);

  /** Picker only (no scoped subaccount selected). */
  if (!locationId) {
    return (
      <div style={{ paddingTop: 8 }}>
        <DashboardSubnav />
        {invalidQuery ? <p className="empty">Invalid location id in URL.</p> : null}
        {subsLoading ? <p className="muted">Loading locations…</p> : null}
        {subsError ? <p className="empty">{subsError}</p> : null}
        {!subsLoading && subs.length === 0 ? <p className="muted">No subaccounts available.</p> : null}
        {!subsLoading && subs.length > 0 ? (
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
                  router.push(subaccountHref(id));
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
                  router.push(subaccountHref(id));
                }
              }}
              value={locationId}
            >
              {subs.map((s) => (
                <option key={s.locationId} value={s.locationId}>
                  {formatLocationName(s.locationName, s.ghlLocationId)}
                </option>
              ))}
            </select>
          ) : subsLoading ? (
            <span className="muted" style={{ fontSize: 12 }}>
              Locations…
            </span>
          ) : (
            <Link className="dashboard-drill-link" href="/dashboard/subaccount">
              Pick location
            </Link>
          )
        }
      />

      <DashboardRangeControl
        customDraft={customDraft}
        onApplyCustom={() => {
          const f = Date.parse(customDraft.fromInclusive.slice(0, 10));
          const t = Date.parse(customDraft.toInclusive.slice(0, 10));
          if (!Number.isFinite(f) || !Number.isFinite(t) || f > t) {
            setDetailError("Invalid custom range.");
            return;
          }
          setPreset("custom");
          setRange({ fromInclusive: customDraft.fromInclusive.slice(0, 10), toInclusive: customDraft.toInclusive.slice(0, 10) });
          setDetailError(null);
        }}
        onCustomDraft={setCustomDraft}
        onPresetChange={(p) => {
          if (p === "7" || p === "30" || p === "90") {
            setPreset(p);
            setRange(utcInclusiveRange(Number(p)));
            setDetailError(null);
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
          <option value="day">By booking day (UTC)</option>
          <option value="week">By booking week (UTC)</option>
        </select>
      </div>

      {detailLoading ? <p className="muted">Loading…</p> : null}
      {detailError ? <p className="empty">{detailError}</p> : null}

      {!detailLoading && data ? (
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
              Booked vs paid — by booking date ({data.granularity}, UTC)
            </p>
            <p className="muted" style={{ marginTop: -6, marginBottom: 12, fontSize: 12 }}>
              Bars use when the booking was captured in AgentFlow/GHL metadata, not the scheduled visit slot.
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
              <p className="muted">No bookings captured in this window.</p>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
