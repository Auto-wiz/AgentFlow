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

type OverviewPagination = {
  page: number;
  pageSize: number;
  totalSubaccounts: number;
  totalPages: number;
  query?: string;
};

type OverviewResponse = {
  fromInclusive: string;
  toExclusive: string;
  totals: Omit<OverviewRow, "locationId" | "ghlLocationId" | "locationName">;
  stats?: {
    meanConversionAcrossAccountsPct: number | null;
  };
  pagination: OverviewPagination;
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

function locationLabel(row: OverviewRow): string {
  return formatLocationName(row.locationName, row.ghlLocationId);
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

const OVERVIEW_PAGE_SIZE = 50;

export default function DashboardOverviewPage() {
  const apiBaseUrl = useMemo(() => getApiBaseUrl(), []);
  const [preset, setPreset] = useState<Exclude<PresetKey, "custom"> | "custom">("30");
  const [range, setRange] = useState(() => utcInclusiveRange(30));
  const [customDraft, setCustomDraft] = useState<DateRangeStrings>(() => utcInclusiveRange(30));
  const [overview, setOverview] = useState<OverviewResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortState>({ column: "booked", direction: "desc" });
  const [overviewSearchDraft, setOverviewSearchDraft] = useState("");
  const [debouncedOverviewQ, setDebouncedOverviewQ] = useState("");
  const [page, setPage] = useState(1);
  const [expandedLocationId, setExpandedLocationId] = useState<string | null>(null);
  const [detailsByLoc, setDetailsByLoc] = useState<Record<string, LocationDetailResponse>>({});
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);
  const [detailErrors, setDetailErrors] = useState<Record<string, string>>({});

  const detailsByLocRef = useRef(detailsByLoc);
  detailsByLocRef.current = detailsByLoc;

  const prefetchDetailInFlightRef = useRef(new Set<string>());

  const query = useMemo(() => new URLSearchParams({ from: range.fromInclusive, to: range.toInclusive }), [range]);

  const buildOverviewParams = useCallback(() => {
    const params = new URLSearchParams(query);
    params.set("page", String(page));
    params.set("limit", String(OVERVIEW_PAGE_SIZE));
    if (debouncedOverviewQ) {
      params.set("q", debouncedOverviewQ);
    }
    params.set("sort", sort.column);
    params.set("order", sort.direction);
    return params;
  }, [query, page, debouncedOverviewQ, sort]);

  const detailFetchAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setDebouncedOverviewQ(overviewSearchDraft.trim()), 400);
    return () => window.clearTimeout(t);
  }, [overviewSearchDraft]);

  useEffect(() => {
    setPage(1);
  }, [debouncedOverviewQ]);

  useEffect(() => {
    setPage(1);
  }, [range.fromInclusive, range.toInclusive]);

  const prefetchDashboardDetail = useCallback(
    async (locationId: string, signal: AbortSignal) => {
      if (detailsByLocRef.current[locationId] || prefetchDetailInFlightRef.current.has(locationId)) {
        return;
      }
      prefetchDetailInFlightRef.current.add(locationId);
      try {
        const res = await fetch(
          `${apiBaseUrl}/workspace/dashboard/locations/${encodeURIComponent(locationId)}/detail?${query}`,
          { headers: mergeWorkspaceHeaders(), cache: "no-store", signal }
        );
        const payload = (await res.json().catch(() => ({}))) as LocationDetailResponse & { error?: string };
        if (!res.ok) {
          return;
        }
        setDetailsByLoc((prev) => {
          if (prev[locationId]) {
            return prev;
          }
          return { ...prev, [locationId]: payload as LocationDetailResponse };
        });
      } catch {
        /* aborted / network */
      } finally {
        prefetchDetailInFlightRef.current.delete(locationId);
      }
    },
    [apiBaseUrl, query]
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`${apiBaseUrl}/workspace/dashboard/overview?${buildOverviewParams()}`, {
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
  }, [apiBaseUrl, buildOverviewParams]);

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

  useEffect(() => {
    if (!overview?.subaccounts.length || loading) {
      return;
    }
    const ac = new AbortController();
    const ids = overview.subaccounts.map((r) => r.locationId);
    void (async () => {
      const chunk = 3;
      for (let i = 0; i < ids.length; i += chunk) {
        if (ac.signal.aborted) {
          return;
        }
        await Promise.all(ids.slice(i, i + chunk).map((id) => prefetchDashboardDetail(id, ac.signal)));
      }
    })();
    return () => ac.abort();
  }, [overview, loading, prefetchDashboardDetail]);

  useEffect(() => {
    if (!overview?.pagination || loading) {
      return;
    }
    const ac = new AbortController();
    const { page: curPage, totalPages } = overview.pagination;
    const run = async () => {
      if (curPage >= totalPages) {
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
      if (ac.signal.aborted) {
        return;
      }
      const p = buildOverviewParams();
      p.set("page", String(curPage + 1));
      try {
        const res = await fetch(`${apiBaseUrl}/workspace/dashboard/overview?${p}`, {
          headers: mergeWorkspaceHeaders(),
          cache: "no-store",
          signal: ac.signal
        });
        if (!res.ok) {
          return;
        }
        const data = (await res.json()) as OverviewResponse;
        const ids = (data.subaccounts ?? []).map((r) => r.locationId);
        const chunk = 3;
        for (let i = 0; i < ids.length; i += chunk) {
          if (ac.signal.aborted) {
            return;
          }
          await Promise.all(ids.slice(i, i + chunk).map((id) => prefetchDashboardDetail(id, ac.signal)));
        }
      } catch {
        /* aborted */
      }
    };
    void run();
    return () => ac.abort();
  }, [overview, loading, apiBaseUrl, buildOverviewParams, prefetchDashboardDetail]);

  const tableRows = overview?.subaccounts ?? [];
  const pagination = overview?.pagination;
  const rowOrdinalBase = pagination ? (pagination.page - 1) * pagination.pageSize : 0;
  const accountCount = pagination?.totalSubaccounts ?? 0;
  const meanAcrossAccountsPct = overview?.stats?.meanConversionAcrossAccountsPct ?? null;

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
    setPage(1);
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
                Locations matching filters · period
                {pagination && pagination.totalPages > 1
                  ? ` · page ${pagination.page} of ${pagination.totalPages}`
                  : ""}
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
              <p className="muted dashboard-kpi-sub">
                Mean of each visible location&apos;s ratio (booked &gt; 0), after search filter
              </p>
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
              onChange={(e) => setOverviewSearchDraft(e.target.value)}
              placeholder="Name, HighLevel location id, or UUID…"
              spellCheck={false}
              style={{ display: "block", marginTop: 6, maxWidth: 440, width: "100%" }}
              type="search"
              value={overviewSearchDraft}
            />
            <p className="muted" style={{ marginBottom: 0, marginTop: 8 }}>
              {pagination ? (
                <>
                  Page <strong>{pagination.page}</strong> of <strong>{pagination.totalPages}</strong> ·{" "}
                  <strong>{tableRows.length}</strong> rows on this page · <strong>{pagination.totalSubaccounts}</strong>{" "}
                  subaccounts match
                  {debouncedOverviewQ ? ` · search: "${debouncedOverviewQ}"` : ""}.
                </>
              ) : null}
            </p>
          </div>
          {pagination && pagination.totalPages > 1 ? (
            <div
              className="toolbar"
              style={{ alignItems: "center", flexWrap: "wrap", gap: 10, marginTop: 12 }}
            >
              <button
                className="button secondary"
                disabled={pagination.page <= 1 || loading}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                type="button"
              >
                Previous
              </button>
              <span className="muted">
                Page {pagination.page} / {pagination.totalPages}
              </span>
              <button
                className="button secondary"
                disabled={pagination.page >= pagination.totalPages || loading}
                onClick={() => setPage((p) => p + 1)}
                type="button"
              >
                Next
              </button>
            </div>
          ) : null}
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
                {tableRows.map((row, idx) => (
                  <Fragment key={row.locationId}>
                    <tr>
                      <td>{rowOrdinalBase + idx + 1}</td>
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
            {accountCount === 0 ? (
              <p className="empty muted" style={{ padding: 16 }}>
                No booked appointments in this window for visible locations
                {debouncedOverviewQ ? " (or no subaccounts match your search)." : "."}
              </p>
            ) : tableRows.length === 0 ? (
              <p className="empty muted" style={{ padding: 16 }}>
                No rows on this page.
              </p>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}
