"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";

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
  depositsCollectedAmount: number;
  depositsCollectedFormatted: string;
};

type OverviewResponse = {
  fromInclusive: string;
  toExclusive: string;
  totals: Omit<OverviewRow, "locationId" | "ghlLocationId" | "locationName">;
  subaccounts: OverviewRow[];
};

type LocationDetailResponse = {
  fromInclusive: string;
  toExclusive: string;
  locationId: string;
  calendars: Array<{ ghlCalendarId: string | null; name: string; bookedCount: number }>;
  orderPaymentsBySource: Array<{
    paymentSourceId: string | null;
    displayName: string;
    paidOrderCount: number;
    depositsCollectedAmount: number;
    depositsCollectedFormatted: string;
  }>;
  invoiceDepositsCollectedAmount: number;
  invoiceDepositsCollectedFormatted: string;
};

type SortColumn = "subaccount" | "booked" | "paid" | "conversion" | "deposits";

type SortState = {
  column: SortColumn;
  direction: "asc" | "desc";
};

function pctLabel(v: number | null | undefined, fractionDigits = 0): string {
  if (v === null || v === undefined || !Number.isFinite(v)) {
    return "—";
  }
  if (fractionDigits > 0) {
    return `${v.toFixed(fractionDigits)}%`;
  }
  return `${Math.round(v)}%`;
}

/** Ratio paid/booked when there are bookings; otherwise null (sorts last). */
function paidBookedRatio(row: OverviewRow): number | null {
  if (row.bookedAppointments <= 0) {
    return null;
  }
  return row.appointmentsWithCollectedPayment / row.bookedAppointments;
}

function locationLabel(row: OverviewRow): string {
  return formatLocationName(row.locationName, row.ghlLocationId);
}

function tieBreak(a: OverviewRow, b: OverviewRow): number {
  return a.locationId.localeCompare(b.locationId);
}

/** Compare rows for client-side sorting. Null conversion / zero-booked ratios sort last regardless of direction. */
function compareRows(a: OverviewRow, b: OverviewRow, column: SortColumn, direction: "asc" | "desc"): number {
  const dir = direction === "asc" ? 1 : -1;

  switch (column) {
    case "subaccount": {
      const cmp = locationLabel(a).localeCompare(locationLabel(b), undefined, { sensitivity: "base" });
      if (cmp !== 0) {
        return dir * cmp;
      }
      return tieBreak(a, b);
    }
    case "booked": {
      const diff = a.bookedAppointments - b.bookedAppointments;
      if (diff !== 0) {
        return dir * diff;
      }
      return tieBreak(a, b);
    }
    case "paid": {
      const diff = a.appointmentsWithCollectedPayment - b.appointmentsWithCollectedPayment;
      if (diff !== 0) {
        return dir * diff;
      }
      return tieBreak(a, b);
    }
    case "deposits": {
      const diff = a.depositsCollectedAmount - b.depositsCollectedAmount;
      if (diff !== 0) {
        return dir * diff;
      }
      return tieBreak(a, b);
    }
    case "conversion": {
      const ra = paidBookedRatio(a);
      const rb = paidBookedRatio(b);
      if (ra === null && rb === null) {
        return tieBreak(a, b);
      }
      if (ra === null) {
        return 1;
      }
      if (rb === null) {
        return -1;
      }
      const diff = ra - rb;
      if (diff !== 0) {
        return dir * diff;
      }
      return tieBreak(a, b);
    }
    default:
      return tieBreak(a, b);
  }
}

/** Simple mean of each location's paid/booked ratio (locations with bookings only). */
function meanConversionAcrossAccounts(rows: OverviewRow[]): number | null {
  const ratios = rows.filter((r) => r.bookedAppointments > 0).map((r) => paidBookedRatio(r)!);
  if (ratios.length === 0) {
    return null;
  }
  const mean = ratios.reduce((s, x) => s + x, 0) / ratios.length;
  return mean * 100;
}

function DashboardOverviewLocationDetailPanels({ detail }: { detail: LocationDetailResponse }) {
  const hasInvoice =
    Number.isFinite(detail.invoiceDepositsCollectedAmount) &&
    Number(detail.invoiceDepositsCollectedAmount ?? 0) > 0;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 20 }}>
      <div>
        <p className="dashboard-kpi-eyebrow" style={{ marginBottom: 10 }}>
          Calendars · bookings in window
        </p>
        {detail.calendars.length === 0 ? (
          <p className="muted">No calendar breakdown for this window.</p>
        ) : (
          <div className="dashboard-overview-detail-metrics-scroll">
            <table className="dashboard-table dashboard-table-nested-compact">
              <thead>
                <tr>
                  <th scope="col">Calendar / service label</th>
                  <th className="dashboard-th-actions" scope="col">
                    Booked
                  </th>
                </tr>
              </thead>
              <tbody>
                {detail.calendars.map((c, i) => (
                  <tr key={c.ghlCalendarId ?? `cal-${i}`}>
                    <td>{c.name}</td>
                    <td className="dashboard-th-actions">{c.bookedCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div>
        <p className="dashboard-kpi-eyebrow" style={{ marginBottom: 10 }}>
          Paid orders · by payment source
        </p>
        {detail.orderPaymentsBySource.length === 0 ? (
          <p className="muted">No paid-order deposits matched this dashboard window.</p>
        ) : (
          <div className="dashboard-overview-detail-metrics-scroll">
            <table className="dashboard-table dashboard-table-nested-compact">
              <thead>
                <tr>
                  <th scope="col">Source</th>
                  <th className="dashboard-th-actions" scope="col">
                    Orders
                  </th>
                  <th className="dashboard-th-actions" scope="col">
                    Amount
                  </th>
                </tr>
              </thead>
              <tbody>
                {detail.orderPaymentsBySource.map((p, i) => (
                  <tr key={p.paymentSourceId ?? `psrc-${i}-${p.displayName}`}>
                    <td>{p.displayName}</td>
                    <td className="dashboard-th-actions">{p.paidOrderCount}</td>
                    <td className="dashboard-th-actions">{p.depositsCollectedFormatted}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {hasInvoice ? (
          <p className="muted" style={{ marginTop: 12 }}>
            Invoices paid in window (combined):{" "}
            <strong>{detail.invoiceDepositsCollectedFormatted}</strong> — totals are grouped separately from order
            sources.
          </p>
        ) : null}
      </div>
    </div>
  );
}

export default function DashboardOverviewPage() {
  const apiBaseUrl = useMemo(() => getApiBaseUrl(), []);
  const [preset, setPreset] = useState<Exclude<PresetKey, "custom"> | "custom">("30");
  const [range, setRange] = useState(() => utcInclusiveRange(30));
  const [customDraft, setCustomDraft] = useState<DateRangeStrings>(() => utcInclusiveRange(30));
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortState>({ column: "booked", direction: "desc" });
  const [overviewSearch, setOverviewSearch] = useState("");
  const [expandedLocationId, setExpandedLocationId] = useState<string | null>(null);
  const [detailsByLoc, setDetailsByLoc] = useState<Record<string, LocationDetailResponse>>({});
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({});

  const query = useMemo(() => new URLSearchParams({ from: range.fromInclusive, to: range.toInclusive }), [range]);

  const detailFetchAbortRef = useRef<AbortController | null>(null);

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

  useEffect(() => {
    setExpandedLocationId(null);
    setDetailsByLoc({});
    setDetailErrors({});
    detailFetchAbortRef.current?.abort();
    detailFetchAbortRef.current = null;
  }, [range.fromInclusive, range.toInclusive]);

  const rowsRaw = overview?.subaccounts ?? [];
  const accountCount = rowsRaw.length;
  const meanAcrossAccountsPct = useMemo(() => meanConversionAcrossAccounts(rowsRaw), [rowsRaw]);

  const sortedRows = useMemo(() => [...rowsRaw].sort((a, b) => compareRows(a, b, sort.column, sort.direction)), [rowsRaw, sort]);

  const overviewSearchTrimmed = overviewSearch.trim().toLowerCase();
  const filteredSortedRows = useMemo(() => {
    if (!overviewSearchTrimmed) {
      return sortedRows;
    }
    return sortedRows.filter((row) => {
      const label = locationLabel(row).toLowerCase();
      return (
        label.includes(overviewSearchTrimmed) ||
        row.ghlLocationId.toLowerCase().includes(overviewSearchTrimmed) ||
        row.locationId.toLowerCase().includes(overviewSearchTrimmed)
      );
    });
  }, [sortedRows, overviewSearchTrimmed]);

  async function toggleRowDetail(locationId: string) {
    if (expandedLocationId === locationId) {
      setExpandedLocationId(null);
      setDetailErrors((prev) => {
        const next = { ...prev };
        delete next[locationId];
        return next;
      });
      return;
    }

    detailFetchAbortRef.current?.abort();
    const controller = new AbortController();
    detailFetchAbortRef.current = controller;

    setExpandedLocationId(locationId);
    setDetailErrors((prev) => {
      const next = { ...prev };
      delete next[locationId];
      return next;
    });
    if (detailsByLoc[locationId]) {
      return;
    }
    setDetailLoadingId(locationId);
    try {
      const res = await fetch(
        `${apiBaseUrl}/workspace/dashboard/locations/${encodeURIComponent(locationId)}/detail?${query}`,
        { headers: mergeWorkspaceHeaders(), cache: "no-store", signal: controller.signal }
      );
      const payload = (await res.json().catch(() => ({}))) as LocationDetailResponse & { error?: string };
      if (!res.ok) {
        throw new Error(payload.error ?? "Failed to load detail");
      }
      setDetailsByLoc((prev) => ({ ...prev, [locationId]: payload as LocationDetailResponse }));
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        return;
      }
      const message = e instanceof Error ? e.message : "Failed to load detail";
      setDetailErrors((prev) => ({ ...prev, [locationId]: message }));
    } finally {
      setDetailLoadingId(null);
    }
  }

  function toggleSort(column: SortColumn) {
    setSort((prev) =>
      prev.column === column
        ? { column, direction: prev.direction === "asc" ? "desc" : "asc" }
        : { column, direction: column === "subaccount" ? "asc" : "desc" }
    );
  }

  function sortAria(column: SortColumn): "ascending" | "descending" | undefined {
    return sort.column === column ? (sort.direction === "asc" ? "ascending" : "descending") : undefined;
  }

  function sortCaret(column: SortColumn): string | null {
    return sort.column === column ? (sort.direction === "desc" ? "↓" : "↑") : null;
  }

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
              <p className="dashboard-kpi-eyebrow">Subaccounts · period</p>
              <p className="dashboard-kpi-value">{accountCount}</p>
              <p className="muted dashboard-kpi-sub">
                Locations in this ranking · period
                {overviewSearchTrimmed ? ` · showing ${filteredSortedRows.length}` : ""}
              </p>
            </div>
            <div className="panel dashboard-kpi-panel">
              <p className="dashboard-kpi-eyebrow">Portfolio conversion</p>
              <p className="dashboard-kpi-value">{pctLabel(overview.totals.depositsCollectedPercentage)}</p>
              <p className="muted dashboard-kpi-sub">Weighted · all bookings together</p>
            </div>
            <div className="panel dashboard-kpi-panel">
              <p className="dashboard-kpi-eyebrow">Avg. conversion / account</p>
              <p className="dashboard-kpi-value">{pctLabel(meanAcrossAccountsPct, 1)}</p>
              <p className="muted dashboard-kpi-sub">Mean of each location&apos;s ratio (booked &gt; 0)</p>
            </div>
            <div className="panel dashboard-kpi-panel">
              <p className="dashboard-kpi-eyebrow">Booked appointments</p>
              <p className="dashboard-kpi-value">{overview.totals.bookedAppointments}</p>
            </div>
            <div className="panel dashboard-kpi-panel">
              <p className="dashboard-kpi-eyebrow">Paid bookings</p>
              <p className="dashboard-kpi-value">{overview.totals.appointmentsWithCollectedPayment}</p>
            </div>
            <div className="panel dashboard-kpi-panel">
              <p className="dashboard-kpi-eyebrow">Deposits collected</p>
              <p className="dashboard-kpi-value">{overview.totals.depositsCollectedFormatted}</p>
              <p className="muted dashboard-kpi-sub">Invoices + paid orders · period</p>
            </div>
          </div>
          <div className="appointments-filter-field" style={{ marginTop: 16 }}>
            <label className="appointments-filter-label" htmlFor="dashboard-overview-search">
              Filter dashboard table
            </label>
            <input
              aria-label="Filter dashboard overview rows by name or location id"
              autoCapitalize="off"
              autoComplete="off"
              className="appointments-filter-select"
              id="dashboard-overview-search"
              onChange={(e) => setOverviewSearch(e.target.value)}
              placeholder="Name, HighLevel location id, or UUID…"
              spellCheck={false}
              style={{ display: "block", marginTop: 6, maxWidth: 440, width: "100%" }}
              type="search"
              value={overviewSearch}
            />
            <p className="muted" style={{ marginBottom: 0, marginTop: 8 }}>
              Showing <strong>{filteredSortedRows.length}</strong> of <strong>{sortedRows.length}</strong> rows in table
              {overviewSearchTrimmed ? ` · filter: "${overviewSearch.trim()}"` : ""}.
            </p>
          </div>
          <div className="panel" style={{ marginTop: 16, overflow: "auto", padding: 0 }}>
            <table className="dashboard-table">
              <thead>
                <tr>
                  <th scope="col">#</th>
                  <th scope="col">
                    <button
                      aria-sort={sortAria("subaccount")}
                      className="dashboard-th-sort"
                      onClick={() => toggleSort("subaccount")}
                      type="button"
                    >
                      Subaccount
                      {sortCaret("subaccount") ? (
                        <span aria-hidden className="dashboard-th-sort-hint">
                          {sortCaret("subaccount")}
                        </span>
                      ) : null}
                    </button>
                  </th>
                  <th scope="col">
                    <button
                      aria-sort={sortAria("booked")}
                      className="dashboard-th-sort"
                      onClick={() => toggleSort("booked")}
                      type="button"
                    >
                      Booked
                      {sortCaret("booked") ? (
                        <span aria-hidden className="dashboard-th-sort-hint">
                          {sortCaret("booked")}
                        </span>
                      ) : null}
                    </button>
                  </th>
                  <th scope="col">
                    <button
                      aria-sort={sortAria("paid")}
                      className="dashboard-th-sort"
                      onClick={() => toggleSort("paid")}
                      type="button"
                    >
                      Paid bookings
                      {sortCaret("paid") ? (
                        <span aria-hidden className="dashboard-th-sort-hint">
                          {sortCaret("paid")}
                        </span>
                      ) : null}
                    </button>
                  </th>
                  <th scope="col">
                    <button
                      aria-sort={sortAria("conversion")}
                      className="dashboard-th-sort"
                      onClick={() => toggleSort("conversion")}
                      type="button"
                    >
                      Conversion
                      {sortCaret("conversion") ? (
                        <span aria-hidden className="dashboard-th-sort-hint">
                          {sortCaret("conversion")}
                        </span>
                      ) : null}
                    </button>
                  </th>
                  <th scope="col">
                    <button
                      aria-sort={sortAria("deposits")}
                      className="dashboard-th-sort"
                      onClick={() => toggleSort("deposits")}
                      type="button"
                    >
                      Deposits
                      {sortCaret("deposits") ? (
                        <span aria-hidden className="dashboard-th-sort-hint">
                          {sortCaret("deposits")}
                        </span>
                      ) : null}
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {filteredSortedRows.map((row, idx) => (
                  <Fragment key={row.locationId}>
                    <tr>
                      <td>{idx + 1}</td>
                      <td>
                        <button
                          aria-expanded={expandedLocationId === row.locationId}
                          aria-label={`${expandedLocationId === row.locationId ? "Collapse" : "Expand"} details for ${locationLabel(row)}`}
                          className="dashboard-subaccount-expand"
                          type="button"
                          onClick={() => void toggleRowDetail(row.locationId)}
                        >
                          <span>{locationLabel(row)}</span>
                          <span aria-hidden className="dashboard-subaccount-expand-caret">
                            {expandedLocationId === row.locationId ? "\u25BC" : "\u25B6"}
                          </span>
                        </button>
                      </td>
                      <td>{row.bookedAppointments}</td>
                      <td>{row.appointmentsWithCollectedPayment}</td>
                      <td>{pctLabel(row.depositsCollectedPercentage)}</td>
                      <td>{row.depositsCollectedFormatted}</td>
                    </tr>
                    {expandedLocationId === row.locationId ? (
                      <tr>
                        <td colSpan={6} style={{ background: "var(--muted-bg, rgba(0, 0, 0, 0.032))", padding: "18px 20px" }}>
                          {detailLoadingId === row.locationId ? (
                            <p className="muted">Loading breakdown…</p>
                          ) : null}
                          {detailErrors[row.locationId] ? (
                            <p className="empty">{detailErrors[row.locationId]}</p>
                          ) : null}
                          {detailsByLoc[row.locationId] ? (
                            <DashboardOverviewLocationDetailPanels detail={detailsByLoc[row.locationId]!} />
                          ) : null}
                        </td>
                      </tr>
                    ) : null}
                  </Fragment>
                ))}
              </tbody>
            </table>
            {sortedRows.length === 0 ? (
              <p className="empty muted" style={{ padding: 16 }}>
                No booked appointments in this window for visible locations.
              </p>
            ) : filteredSortedRows.length === 0 ? (
              <p className="empty muted" style={{ padding: 16 }}>
                No subaccounts match your search.
              </p>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
