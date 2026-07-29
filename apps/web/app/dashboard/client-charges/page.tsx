"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { getApiBaseUrl } from "../../../lib/api-base-url";
import { formatLocationName } from "../../../lib/location-display";
import { mergeWorkspaceHeaders } from "../../../lib/workspace-api-headers";
import { useWorkspaceAuth } from "../../components/workspace-auth-provider";
import {
  DashboardRangeControl,
  type DateRangeStrings,
  utcInclusiveRange
} from "../dashboard-date-range";
import { DashboardSubnav } from "../dashboard-subnav";

type PresetKey = "7" | "30" | "90" | "custom";
type StatusFilter = "all" | "unbilled" | "pending" | "succeeded" | "failed";

type CanonicalDeposit = {
  kind: "payment_order" | "invoice";
  id: string;
  externalId: string;
  amount: number;
  currency: string;
  matchedBy: "direct_appointment_order" | "correlated_order" | "correlated_invoice";
  paidAt: string | null;
};

type ChargeLedger = {
  id: string;
  status: string;
  amount: number;
  currency: string;
  attemptCount: number;
  ghlReferenceId: string | null;
  ghlTransactionId: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  succeededAt: string | null;
  failedAt: string | null;
};

type ClientChargeRow = {
  appointmentId: string;
  ghlAppointmentId: string;
  appointmentTitle: string | null;
  appointmentStartTime: string | null;
  appointmentBookedAt: string;
  locationId: string;
  ghlLocationId: string;
  locationName: string | null;
  contactId: string | null;
  contactName: string | null;
  contactEmail: string | null;
  deposit: CanonicalDeposit;
  charge: ChargeLedger | null;
};

type ClientChargesTotals = {
  eligibleCount: number;
  chargedCount: number;
  unbilledCount: number;
  pendingCount: number;
  failedCount: number;
  chargedAmount: number;
  unbilledAmount: number;
  currency: string | null;
  mixedCurrencies: boolean;
};

type ClientChargesResponse = {
  fromInclusive: string;
  toExclusive: string;
  rows: ClientChargeRow[];
  totals: ClientChargesTotals;
  pagination: {
    page: number;
    pageSize: number;
    totalRows: number;
    totalPages: number;
  };
};

type BillingLocationConfig = {
  locationId: string;
  ghlLocationId: string;
  locationName: string | null;
  enabled: boolean;
  currency: string;
  meterId: string | null;
  updatedAt: string | null;
};

function formatMoney(amount: number, currency: string | null | undefined) {
  if (!Number.isFinite(amount)) return "—";
  const nf = new Intl.NumberFormat("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
  const num = nf.format(amount);
  const cur = currency?.trim()?.toUpperCase();
  return cur ? `${num} ${cur}` : `$${num}`;
}

function formatWhen(iso: string | null | undefined) {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return "—";
  return new Date(ms).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  });
}

function depositChargeAmount(row: ClientChargeRow) {
  if (row.charge) return row.charge.amount;
  return row.deposit.amount;
}

function depositChargeCurrency(row: ClientChargeRow) {
  if (row.charge) return row.charge.currency;
  return row.deposit.currency;
}

function depositSourceLabel(deposit: CanonicalDeposit) {
  const kind = deposit.kind === "invoice" ? "Invoice" : "Payment order";
  const match =
    deposit.matchedBy === "direct_appointment_order"
      ? "direct"
      : deposit.matchedBy === "correlated_order"
        ? "correlated order"
        : "correlated invoice";
  return `${kind} · ${match}`;
}

function chargeStatusLabel(row: ClientChargeRow) {
  if (!row.charge) return "Unbilled";
  const status = row.charge.status.toLowerCase();
  if (status === "succeeded") return "Charged";
  if (status === "pending") return "Pending";
  if (status === "failed") return "Failed";
  if (status === "reversed") return "Reversed";
  return row.charge.status;
}

function canCharge(row: ClientChargeRow, isAdmin: boolean) {
  if (!isAdmin) return false;
  if (!row.charge) return true;
  const status = row.charge.status.toLowerCase();
  return status !== "succeeded" && status !== "pending";
}

function canRetry(row: ClientChargeRow, isAdmin: boolean) {
  if (!isAdmin || !row.charge) return false;
  return row.charge.status.toLowerCase() === "failed";
}

export default function ClientChargesPage() {
  const apiBaseUrl = getApiBaseUrl();
  const { user, hydrated, sessionKey } = useWorkspaceAuth();
  const isAdmin = hydrated && user?.role === "admin";

  const [preset, setPreset] = useState<PresetKey>("30");
  const [range, setRange] = useState<DateRangeStrings>(() => utcInclusiveRange(30));
  const [customDraft, setCustomDraft] = useState<DateRangeStrings>(() => utcInclusiveRange(30));
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [searchDraft, setSearchDraft] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [page, setPage] = useState(1);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ClientChargesResponse | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAppointmentId, setBusyAppointmentId] = useState<string | null>(null);
  const [confirmRow, setConfirmRow] = useState<ClientChargeRow | null>(null);
  const [confirmMode, setConfirmMode] = useState<"charge" | "retry">("charge");

  const [billingLocs, setBillingLocs] = useState<BillingLocationConfig[]>([]);
  const [billingLoading, setBillingLoading] = useState(false);
  const [billingError, setBillingError] = useState<string | null>(null);
  const [billingBusyId, setBillingBusyId] = useState<string | null>(null);
  const [billingSearch, setBillingSearch] = useState("");
  const [showEligibility, setShowEligibility] = useState(false);

  useEffect(() => {
    const t = window.setTimeout(() => {
      setDebouncedQ(searchDraft.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(t);
  }, [searchDraft]);

  const loadCharges = useCallback(async () => {
    if (!hydrated) return;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        from: range.fromInclusive.slice(0, 10),
        to: range.toInclusive.slice(0, 10),
        page: String(page),
        limit: "50",
        status: statusFilter
      });
      if (debouncedQ) params.set("q", debouncedQ);
      const res = await fetch(`${apiBaseUrl}/workspace/client-charges?${params}`, {
        cache: "no-store",
        headers: mergeWorkspaceHeaders()
      });
      const payload = (await res.json().catch(() => ({}))) as ClientChargesResponse & {
        error?: string;
        message?: string;
      };
      if (!res.ok) {
        throw new Error(payload.message ?? payload.error ?? "Unable to load client charges");
      }
      setData(payload);
    } catch (caught) {
      setData(null);
      setError(caught instanceof Error ? caught.message : "Unable to load client charges");
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, debouncedQ, hydrated, page, range.fromInclusive, range.toInclusive, statusFilter]);

  useEffect(() => {
    void loadCharges();
  }, [loadCharges, sessionKey]);

  const loadBillingLocations = useCallback(async () => {
    if (!isAdmin) {
      setBillingLocs([]);
      return;
    }
    setBillingLoading(true);
    setBillingError(null);
    try {
      const res = await fetch(`${apiBaseUrl}/admin/client-charges/locations`, {
        cache: "no-store",
        headers: mergeWorkspaceHeaders()
      });
      const payload = (await res.json().catch(() => ({}))) as {
        locations?: BillingLocationConfig[];
        error?: string;
        message?: string;
      };
      if (!res.ok) {
        throw new Error(payload.message ?? payload.error ?? "Unable to load billing eligibility");
      }
      setBillingLocs(payload.locations ?? []);
    } catch (caught) {
      setBillingLocs([]);
      setBillingError(caught instanceof Error ? caught.message : "Unable to load billing eligibility");
    } finally {
      setBillingLoading(false);
    }
  }, [apiBaseUrl, isAdmin]);

  useEffect(() => {
    if (showEligibility) {
      void loadBillingLocations();
    }
  }, [loadBillingLocations, showEligibility, sessionKey]);

  async function patchLocationBilling(loc: BillingLocationConfig, enabled: boolean) {
    setBillingBusyId(loc.locationId);
    setBillingError(null);
    try {
      const res = await fetch(`${apiBaseUrl}/admin/client-charges/locations/${loc.locationId}`, {
        method: "PATCH",
        cache: "no-store",
        headers: mergeWorkspaceHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          enabled,
          currency: loc.currency || "USD",
          meterId: loc.meterId
        })
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string; message?: string };
      if (!res.ok) {
        throw new Error(payload.message ?? payload.error ?? "Update failed");
      }
      await loadBillingLocations();
      await loadCharges();
    } catch (caught) {
      setBillingError(caught instanceof Error ? caught.message : "Update failed");
    } finally {
      setBillingBusyId(null);
    }
  }

  async function runCharge(row: ClientChargeRow, mode: "charge" | "retry") {
    setBusyAppointmentId(row.appointmentId);
    setActionError(null);
    try {
      const path =
        mode === "retry"
          ? `${apiBaseUrl}/workspace/client-charges/${row.appointmentId}/retry`
          : `${apiBaseUrl}/workspace/client-charges/${row.appointmentId}/charge`;
      const res = await fetch(path, {
        method: "POST",
        cache: "no-store",
        headers: mergeWorkspaceHeaders({ "Content-Type": "application/json" })
      });
      const payload = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        message?: string;
        error?: string;
        ambiguous?: boolean;
      };
      if (!res.ok || payload.ok === false) {
        throw new Error(
          payload.message ??
            payload.error ??
            (payload.ambiguous
              ? "Charge outcome is ambiguous — reconcile before retrying."
              : "Charge failed")
        );
      }
      setConfirmRow(null);
      await loadCharges();
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : "Charge failed");
    } finally {
      setBusyAppointmentId(null);
    }
  }

  const filteredBillingLocs = useMemo(() => {
    const needle = billingSearch.trim().toLowerCase();
    const sorted = [...billingLocs].sort((a, b) => {
      const na = (a.locationName ?? a.ghlLocationId).toLowerCase();
      const nb = (b.locationName ?? b.ghlLocationId).toLowerCase();
      return na.localeCompare(nb);
    });
    if (!needle) return sorted;
    return sorted.filter((loc) => {
      const name = (loc.locationName ?? "").toLowerCase();
      return (
        name.includes(needle) ||
        loc.ghlLocationId.toLowerCase().includes(needle) ||
        loc.locationId.toLowerCase().includes(needle)
      );
    });
  }, [billingLocs, billingSearch]);

  const totals = data?.totals;
  const rows = data?.rows ?? [];
  const pagination = data?.pagination;

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
          setRange({
            fromInclusive: customDraft.fromInclusive.slice(0, 10),
            toInclusive: customDraft.toInclusive.slice(0, 10)
          });
          setPage(1);
          setError(null);
        }}
        onCustomDraft={(d) => setCustomDraft(d)}
        onPresetChange={(p) => {
          if (p === "7" || p === "30" || p === "90") {
            setPreset(p);
            setRange(utcInclusiveRange(Number(p)));
            setPage(1);
            setError(null);
            return;
          }
          setPreset("custom");
          setCustomDraft({ ...range });
        }}
        preset={preset}
        value={range}
      />

      {loading ? <p className="muted">Loading client charges…</p> : null}
      {error ? <p className="empty">{error}</p> : null}
      {actionError ? <p className="empty">{actionError}</p> : null}

      {!loading && totals ? (
        <div className="dashboard-kpi-grid">
          <div className="panel dashboard-kpi-panel">
            <p className="dashboard-kpi-eyebrow">Eligible results</p>
            <p className="dashboard-kpi-value">{totals.eligibleCount}</p>
            <p className="muted dashboard-kpi-sub">Paid appointments in enabled locations</p>
          </div>
          <div className="panel dashboard-kpi-panel">
            <p className="dashboard-kpi-eyebrow">Charged</p>
            <p className="dashboard-kpi-value">{totals.chargedCount}</p>
            <p className="muted dashboard-kpi-sub">
              {totals.mixedCurrencies
                ? "Mixed currencies · amount not summed"
                : formatMoney(totals.chargedAmount, totals.currency)}
            </p>
          </div>
          <div className="panel dashboard-kpi-panel">
            <p className="dashboard-kpi-eyebrow">Unbilled</p>
            <p className="dashboard-kpi-value">{totals.unbilledCount}</p>
            <p className="muted dashboard-kpi-sub">
              {totals.mixedCurrencies
                ? "Mixed currencies · amount not summed"
                : formatMoney(totals.unbilledAmount, totals.currency)}
            </p>
          </div>
          <div className="panel dashboard-kpi-panel">
            <p className="dashboard-kpi-eyebrow">Failed</p>
            <p className="dashboard-kpi-value">{totals.failedCount}</p>
            <p className="muted dashboard-kpi-sub">
              {totals.pendingCount > 0 ? `${totals.pendingCount} pending reconciliation` : "Ready to retry"}
            </p>
          </div>
        </div>
      ) : null}

      <div
        className="appointments-filter-field"
        style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 16, alignItems: "flex-end" }}
      >
        <div style={{ flex: "1 1 220px", maxWidth: 440 }}>
          <label className="appointments-filter-label" htmlFor="client-charges-search">
            Search
          </label>
          <input
            aria-label="Filter client charges by location, contact, or appointment"
            autoCapitalize="off"
            autoComplete="off"
            className="appointments-filter-select"
            id="client-charges-search"
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder="Location, contact, appointment…"
            spellCheck={false}
            style={{ display: "block", marginTop: 6, width: "100%" }}
            type="search"
            value={searchDraft}
          />
        </div>
        <div>
          <label className="appointments-filter-label" htmlFor="client-charges-status">
            Status
          </label>
          <select
            className="appointments-filter-select"
            id="client-charges-status"
            onChange={(e) => {
              setStatusFilter(e.target.value as StatusFilter);
              setPage(1);
            }}
            style={{ display: "block", marginTop: 6 }}
            value={statusFilter}
          >
            <option value="all">All</option>
            <option value="unbilled">Unbilled</option>
            <option value="pending">Pending</option>
            <option value="succeeded">Charged</option>
            <option value="failed">Failed</option>
          </select>
        </div>
        {isAdmin ? (
          <button
            className="button secondary"
            onClick={() => setShowEligibility((v) => !v)}
            type="button"
          >
            {showEligibility ? "Hide eligibility" : "Location eligibility"}
          </button>
        ) : null}
      </div>

      {pagination ? (
        <p className="muted" style={{ marginBottom: 0, marginTop: 8 }}>
          Page <strong>{pagination.page}</strong> of <strong>{pagination.totalPages}</strong> ·{" "}
          <strong>{rows.length}</strong> rows on this page · <strong>{pagination.totalRows}</strong> match
          {debouncedQ ? ` · search: "${debouncedQ}"` : ""}.
        </p>
      ) : null}

      {!loading && data ? (
        <div className="dashboard-overview-table-scroll" style={{ marginTop: 12 }}>
          <table className="dashboard-table">
            <thead>
              <tr>
                <th scope="col">Subaccount</th>
                <th scope="col">Appointment / contact</th>
                <th scope="col">Deposit source</th>
                <th className="dashboard-th-actions" scope="col">
                  Deposit (charge amount)
                </th>
                <th scope="col">Charge status</th>
                <th className="dashboard-th-actions" scope="col">
                  Action
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 ? (
                <tr>
                  <td colSpan={6}>
                    <p className="muted" style={{ margin: "12px 0" }}>
                      No billable results in this period
                      {statusFilter !== "all" ? ` for status “${statusFilter}”` : ""}. Enable locations under
                      eligibility, or widen the date range.
                    </p>
                  </td>
                </tr>
              ) : (
                rows.map((row) => {
                  const status = chargeStatusLabel(row);
                  const busy = busyAppointmentId === row.appointmentId;
                  const pending = row.charge?.status.toLowerCase() === "pending";
                  const succeeded = row.charge?.status.toLowerCase() === "succeeded";
                  return (
                    <tr key={row.appointmentId}>
                      <td>
                        <strong>{formatLocationName(row.locationName, row.ghlLocationId)}</strong>
                        <div className="muted">{row.ghlLocationId}</div>
                      </td>
                      <td>
                        <div>{row.appointmentTitle?.trim() || row.ghlAppointmentId}</div>
                        <div className="muted">
                          {row.contactName?.trim() || row.contactEmail?.trim() || "No contact"}
                          {row.appointmentStartTime
                            ? ` · ${formatWhen(row.appointmentStartTime)}`
                            : ` · booked ${formatWhen(row.appointmentBookedAt)}`}
                        </div>
                      </td>
                      <td>
                        <div>{depositSourceLabel(row.deposit)}</div>
                        <div className="muted">{row.deposit.externalId}</div>
                      </td>
                      <td className="dashboard-th-actions">
                        <strong>
                          {formatMoney(depositChargeAmount(row), depositChargeCurrency(row))}
                        </strong>
                      </td>
                      <td>
                        <div>{status}</div>
                        {row.charge?.ghlReferenceId ? (
                          <div className="muted">Ref {row.charge.ghlReferenceId}</div>
                        ) : null}
                        {row.charge?.succeededAt ? (
                          <div className="muted">{formatWhen(row.charge.succeededAt)}</div>
                        ) : null}
                        {row.charge?.lastError ? (
                          <div className="empty" style={{ marginTop: 4, fontSize: "0.85em" }}>
                            {row.charge.lastError}
                          </div>
                        ) : null}
                        {pending ? (
                          <div className="muted" style={{ marginTop: 4 }}>
                            Ambiguous / in flight — do not retry until reconciled
                          </div>
                        ) : null}
                      </td>
                      <td className="dashboard-th-actions">
                        {!isAdmin ? (
                          <span className="muted">Admin only</span>
                        ) : canRetry(row, isAdmin) ? (
                          <button
                            className="button secondary"
                            disabled={busy}
                            onClick={() => {
                              setConfirmMode("retry");
                              setConfirmRow(row);
                              setActionError(null);
                            }}
                            type="button"
                          >
                            {busy ? "…" : "Retry"}
                          </button>
                        ) : canCharge(row, isAdmin) ? (
                          <button
                            className="button"
                            disabled={busy}
                            onClick={() => {
                              setConfirmMode("charge");
                              setConfirmRow(row);
                              setActionError(null);
                            }}
                            type="button"
                          >
                            {busy ? "…" : "Charge"}
                          </button>
                        ) : succeeded || pending ? (
                          <span className="muted">{succeeded ? "Done" : "Pending"}</span>
                        ) : (
                          <span className="muted">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      ) : null}

      {pagination && pagination.totalPages > 1 ? (
        <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
          <button
            className="button secondary"
            disabled={page <= 1 || loading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            type="button"
          >
            Previous
          </button>
          <button
            className="button secondary"
            disabled={page >= pagination.totalPages || loading}
            onClick={() => setPage((p) => p + 1)}
            type="button"
          >
            Next
          </button>
        </div>
      ) : null}

      {isAdmin && showEligibility ? (
        <div className="panel" style={{ padding: 18, marginTop: 20 }}>
          <h2 style={{ marginTop: 0 }}>Location eligibility</h2>
          <p className="muted">
            Client Charges stay off by default. Enable a subaccount only after the GHL dynamic billing meter and wallet
            scopes are configured. The charge amount always mirrors the lead&apos;s paid deposit for that appointment.
          </p>
          {billingLoading ? <p className="muted">Loading locations…</p> : null}
          {billingError ? <div className="empty">{billingError}</div> : null}
          {!billingLoading && billingLocs.length > 0 ? (
            <>
              <label className="inbox-field-label" htmlFor="client-charges-eligibility-search">
                Search subaccounts
              </label>
              <input
                autoCapitalize="off"
                autoComplete="off"
                className="appointments-filter-select"
                id="client-charges-eligibility-search"
                onChange={(e) => setBillingSearch(e.target.value)}
                placeholder="Name, GHL id, or uuid…"
                spellCheck={false}
                style={{ display: "block", marginTop: 6, maxWidth: 400, width: "100%" }}
                type="search"
                value={billingSearch}
              />
              <div className="subaccounts-config-list" style={{ marginTop: 16 }}>
                {filteredBillingLocs.map((loc) => (
                  <label className="subaccount-config-row" key={loc.locationId}>
                    <div>
                      <strong>{formatLocationName(loc.locationName, loc.ghlLocationId)}</strong>
                      <div className="muted">
                        GHL: {loc.ghlLocationId} · {loc.currency}
                        {loc.meterId ? ` · meter ${loc.meterId}` : " · default meter"}
                      </div>
                    </div>
                    <input
                      aria-label={`Enable Client Charges for ${loc.ghlLocationId}`}
                      checked={Boolean(loc.enabled)}
                      disabled={billingBusyId === loc.locationId}
                      onChange={(e) => void patchLocationBilling(loc, e.target.checked)}
                      type="checkbox"
                    />
                  </label>
                ))}
              </div>
            </>
          ) : null}
          {!billingLoading && !billingError && billingLocs.length === 0 ? (
            <p className="muted">No locations in workspace scope.</p>
          ) : null}
        </div>
      ) : null}

      {confirmRow ? (
        <div
          aria-modal
          className="appointments-override-modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget && busyAppointmentId !== confirmRow.appointmentId) {
              setConfirmRow(null);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && busyAppointmentId !== confirmRow.appointmentId) {
              setConfirmRow(null);
            }
          }}
          role="dialog"
        >
          <div className="panel appointments-override-modal panel-narrow">
            <h3 className="appointments-override-modal-title">
              {confirmMode === "retry" ? "Retry wallet charge" : "Confirm wallet charge"}
            </h3>
            <p className="muted appointments-override-subheader">
              You will charge the sub-account the same amount the lead paid as a deposit. This GHL Marketplace wallet
              charge is irreversible. Double-check before continuing.
            </p>
            <dl style={{ margin: "12px 0 0", display: "grid", gap: 8 }}>
              <div>
                <dt className="muted" style={{ margin: 0 }}>
                  Amount to charge
                </dt>
                <dd style={{ margin: "2px 0 0" }}>
                  <strong>
                    {formatMoney(depositChargeAmount(confirmRow), depositChargeCurrency(confirmRow))}
                  </strong>
                  <span className="muted"> (same as lead deposit)</span>
                </dd>
              </div>
              <div>
                <dt className="muted" style={{ margin: 0 }}>
                  Deposit source
                </dt>
                <dd style={{ margin: "2px 0 0" }}>
                  {depositSourceLabel(confirmRow.deposit)} · {confirmRow.deposit.externalId}
                </dd>
              </div>
              <div>
                <dt className="muted" style={{ margin: 0 }}>
                  Appointment
                </dt>
                <dd style={{ margin: "2px 0 0" }}>
                  {confirmRow.appointmentTitle?.trim() || confirmRow.ghlAppointmentId}
                  {confirmRow.contactName ? ` · ${confirmRow.contactName}` : ""}
                </dd>
              </div>
              <div>
                <dt className="muted" style={{ margin: 0 }}>
                  Subaccount
                </dt>
                <dd style={{ margin: "2px 0 0" }}>
                  {formatLocationName(confirmRow.locationName, confirmRow.ghlLocationId)}
                </dd>
              </div>
            </dl>
            <div style={{ display: "flex", gap: 8, marginTop: 18, justifyContent: "flex-end" }}>
              <button
                className="button secondary"
                disabled={busyAppointmentId === confirmRow.appointmentId}
                onClick={() => setConfirmRow(null)}
                type="button"
              >
                Cancel
              </button>
              <button
                className="button"
                disabled={busyAppointmentId === confirmRow.appointmentId}
                onClick={() => void runCharge(confirmRow, confirmMode)}
                type="button"
              >
                {busyAppointmentId === confirmRow.appointmentId
                  ? "Charging…"
                  : confirmMode === "retry"
                    ? "Retry charge"
                    : "Charge now"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
