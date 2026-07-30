"use client";

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

import { canAccessClientCharges } from "@agentflow/shared";

import { getApiBaseUrl } from "../../../lib/api-base-url";
import { formatLocationName } from "../../../lib/location-display";
import { mergeWorkspaceHeaders } from "../../../lib/workspace-api-headers";
import { useGuardedNavigate } from "../../components/navigation-guard-provider";
import { useWorkspaceAuth } from "../../components/workspace-auth-provider";
import {
  DashboardRangeControl,
  type DateRangeStrings,
  utcInclusiveRange
} from "../dashboard-date-range";
import { DashboardSubnav } from "../dashboard-subnav";

type PresetKey = "7" | "30" | "90" | "custom";
type StatusFilter = "all" | "unbilled" | "pending" | "succeeded" | "failed";
type OverviewSortColumn = "subaccount" | "unbilled" | "charged" | "eligible";

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

type ClientChargeOverviewRow = {
  locationId: string;
  ghlLocationId: string;
  locationName: string | null;
  eligibleCount: number;
  unbilledCount: number;
  unbilledAmount: number;
  chargedCount: number;
  chargedAmount: number;
  pendingCount: number;
  failedCount: number;
  currency: string | null;
  mixedCurrencies: boolean;
};

type ClientChargesOverviewResponse = {
  fromInclusive: string;
  toExclusive: string;
  subaccounts: ClientChargeOverviewRow[];
  totals: ClientChargesTotals;
  pagination: {
    page: number;
    pageSize: number;
    totalSubaccounts: number;
    totalPages: number;
    query?: string;
  };
};

type BillingLocationConfig = {
  locationId: string;
  ghlLocationId: string;
  locationName: string | null;
  enabled: boolean;
  currency: string;
  billingReady: boolean;
  stripeAccountId: string | null;
  stripeAccountMasked: string | null;
  connectOnboardingStatus: string | null;
  connectDetailsSubmitted: boolean;
  connectChargesEnabled: boolean;
  connectPayoutsEnabled: boolean;
  hasPaymentMethod: boolean;
  billingReadyAt: string | null;
  updatedAt: string | null;
};

type OverviewSortState = {
  column: OverviewSortColumn;
  direction: "asc" | "desc";
};

const OVERVIEW_PAGE_SIZE = 50;
const DETAIL_PAGE_SIZE = 50;

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

function stripeConnectStatusLabel(loc: BillingLocationConfig) {
  if (loc.billingReady) return "Ready";
  const hasAccount = Boolean(loc.stripeAccountMasked || loc.stripeAccountId?.trim());
  if (!hasAccount) return "Not started";
  if (!loc.connectDetailsSubmitted || !loc.connectChargesEnabled) return "Onboarding";
  if (!loc.hasPaymentMethod) return "Needs payment method";
  return "Onboarding";
}

function buildGhlPaymentOrderUrl(
  ghlLocationId: string | null | undefined,
  deposit: CanonicalDeposit
): string | null {
  if (deposit.kind !== "payment_order") return null;
  const locationId = ghlLocationId?.trim();
  const orderId = deposit.externalId?.trim();
  if (!locationId || !orderId) return null;
  return `https://app.gohighlevel.com/v2/location/${encodeURIComponent(locationId)}/payments/v2/orders/${encodeURIComponent(orderId)}`;
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

function locationLabel(row: Pick<ClientChargeOverviewRow, "locationName" | "ghlLocationId">) {
  return formatLocationName(row.locationName, row.ghlLocationId);
}

function ClientChargesLocationDetail({
  apiBaseUrl,
  locationId,
  range,
  isAdmin,
  busyAppointmentId,
  onRequestCharge
}: {
  apiBaseUrl: string;
  locationId: string;
  range: DateRangeStrings;
  isAdmin: boolean;
  busyAppointmentId: string | null;
  onRequestCharge: (row: ClientChargeRow, mode: "charge" | "retry") => void;
}) {
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [searchDraft, setSearchDraft] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<ClientChargesResponse | null>(null);
  const reloadTokenRef = useRef(0);

  useEffect(() => {
    const t = window.setTimeout(() => {
      setDebouncedQ(searchDraft.trim());
      setPage(1);
    }, 300);
    return () => window.clearTimeout(t);
  }, [searchDraft]);

  const loadDetail = useCallback(async () => {
    const token = ++reloadTokenRef.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        from: range.fromInclusive.slice(0, 10),
        to: range.toInclusive.slice(0, 10),
        locationId,
        page: String(page),
        limit: String(DETAIL_PAGE_SIZE),
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
      if (token !== reloadTokenRef.current) return;
      if (!res.ok) {
        throw new Error(payload.message ?? payload.error ?? "Unable to load appointments");
      }
      setData(payload);
    } catch (caught) {
      if (token !== reloadTokenRef.current) return;
      setData(null);
      setError(caught instanceof Error ? caught.message : "Unable to load appointments");
    } finally {
      if (token === reloadTokenRef.current) {
        setLoading(false);
      }
    }
  }, [apiBaseUrl, debouncedQ, locationId, page, range.fromInclusive, range.toInclusive, statusFilter]);

  useEffect(() => {
    void loadDetail();
  }, [loadDetail]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ locationId?: string }>).detail;
      if (!detail?.locationId || detail.locationId === locationId) {
        void loadDetail();
      }
    };
    window.addEventListener("client-charges:refresh-detail", handler);
    return () => window.removeEventListener("client-charges:refresh-detail", handler);
  }, [loadDetail, locationId]);

  const rows = data?.rows ?? [];
  const pagination = data?.pagination;

  return (
    <div>
      <div
        className="appointments-filter-field"
        style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 12, alignItems: "flex-end" }}
      >
        <div style={{ flex: "1 1 200px", maxWidth: 360 }}>
          <label className="appointments-filter-label" htmlFor={`client-charges-detail-search-${locationId}`}>
            Search appointments
          </label>
          <input
            aria-label="Filter appointments by contact or title"
            autoCapitalize="off"
            autoComplete="off"
            className="appointments-filter-select"
            id={`client-charges-detail-search-${locationId}`}
            onChange={(e) => setSearchDraft(e.target.value)}
            placeholder="Contact, appointment…"
            spellCheck={false}
            style={{ display: "block", marginTop: 6, width: "100%" }}
            type="search"
            value={searchDraft}
          />
        </div>
        <div>
          <label className="appointments-filter-label" htmlFor={`client-charges-detail-status-${locationId}`}>
            Status
          </label>
          <select
            className="appointments-filter-select"
            id={`client-charges-detail-status-${locationId}`}
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
      </div>

      {loading ? <p className="muted">Loading appointments…</p> : null}
      {error ? <p className="empty">{error}</p> : null}

      {!loading && data ? (
        <>
          {pagination ? (
            <p className="muted" style={{ marginBottom: 8, marginTop: 0 }}>
              <strong>{pagination.totalRows}</strong> appointment{pagination.totalRows === 1 ? "" : "s"}
              {statusFilter !== "all" ? ` · status “${statusFilter}”` : ""}
              {debouncedQ ? ` · search: "${debouncedQ}"` : ""}.
            </p>
          ) : null}
          <div className="dashboard-overview-detail-metrics-scroll">
            <table className="dashboard-table dashboard-table-nested-compact">
              <thead>
                <tr>
                  <th scope="col">Appointment / contact</th>
                  <th scope="col">Deposit source</th>
                  <th className="dashboard-th-actions" scope="col">
                    Deposit (charge amount)
                  </th>
                  <th scope="col">Charge status</th>
                  {isAdmin ? (
                    <th className="dashboard-th-actions" scope="col">
                      Action
                    </th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {rows.length === 0 ? (
                  <tr>
                    <td colSpan={isAdmin ? 5 : 4}>
                      <p className="muted" style={{ margin: "8px 0" }}>
                        No billable results in this period
                        {statusFilter !== "all" ? ` for status “${statusFilter}”` : ""}.
                      </p>
                    </td>
                  </tr>
                ) : (
                  rows.map((row) => {
                    const status = chargeStatusLabel(row);
                    const busy = busyAppointmentId === row.appointmentId;
                    const pending = row.charge?.status.toLowerCase() === "pending";
                    const succeeded = row.charge?.status.toLowerCase() === "succeeded";
                    const paymentOrderUrl = buildGhlPaymentOrderUrl(row.ghlLocationId, row.deposit);
                    return (
                      <tr key={row.appointmentId}>
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
                          {paymentOrderUrl ? (
                            <a
                              className="button secondary"
                              href={paymentOrderUrl}
                              rel="noopener noreferrer"
                              style={{ display: "inline-block", fontSize: "0.85em", marginTop: 6, padding: "4px 10px" }}
                              target="_blank"
                            >
                              Open order in GHL
                            </a>
                          ) : null}
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
                        {isAdmin ? (
                          <td className="dashboard-th-actions">
                            {canRetry(row, isAdmin) ? (
                              <button
                                className="button secondary"
                                disabled={busy}
                                onClick={() => onRequestCharge(row, "retry")}
                                type="button"
                              >
                                {busy ? "…" : "Retry"}
                              </button>
                            ) : canCharge(row, isAdmin) ? (
                              <button
                                className="button"
                                disabled={busy}
                                onClick={() => onRequestCharge(row, "charge")}
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
                        ) : null}
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
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
              <span className="muted">
                Page {pagination.page} / {pagination.totalPages}
              </span>
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
        </>
      ) : null}
    </div>
  );
}

export default function ClientChargesPage() {
  const apiBaseUrl = getApiBaseUrl();
  const { replaceGuarded } = useGuardedNavigate();
  const { user, hydrated, sessionKey } = useWorkspaceAuth();
  const isAdmin = hydrated && user?.role === "admin";
  const canUseClientCharges = hydrated && canAccessClientCharges(user?.email);
  const searchParams = useSearchParams();

  useEffect(() => {
    if (!hydrated) return;
    if (!canAccessClientCharges(user?.email)) {
      void replaceGuarded("/dashboard");
    }
  }, [hydrated, replaceGuarded, user?.email]);

  const [preset, setPreset] = useState<PresetKey>("30");
  const [range, setRange] = useState<DateRangeStrings>(() => utcInclusiveRange(30));
  const [customDraft, setCustomDraft] = useState<DateRangeStrings>(() => utcInclusiveRange(30));

  const [overviewSearchDraft, setOverviewSearchDraft] = useState("");
  const [debouncedOverviewQ, setDebouncedOverviewQ] = useState("");
  const [overviewPage, setOverviewPage] = useState(1);
  const [overviewSort, setOverviewSort] = useState<OverviewSortState>({
    column: "unbilled",
    direction: "desc"
  });
  const [expandedLocationId, setExpandedLocationId] = useState<string | null>(null);

  const [overviewLoading, setOverviewLoading] = useState(false);
  const [overviewError, setOverviewError] = useState<string | null>(null);
  const [overviewHttpStatus, setOverviewHttpStatus] = useState<number | null>(null);
  const [overview, setOverview] = useState<ClientChargesOverviewResponse | null>(null);

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
  const [stripeAccountDrafts, setStripeAccountDrafts] = useState<Record<string, string>>({});
  const [platformStripeLabel, setPlatformStripeLabel] = useState<string | null>(null);

  const query = useMemo(
    () =>
      new URLSearchParams({
        from: range.fromInclusive.slice(0, 10),
        to: range.toInclusive.slice(0, 10)
      }),
    [range.fromInclusive, range.toInclusive]
  );

  useEffect(() => {
    const t = window.setTimeout(() => {
      setDebouncedOverviewQ(overviewSearchDraft.trim());
      setOverviewPage(1);
    }, 400);
    return () => window.clearTimeout(t);
  }, [overviewSearchDraft]);

  useEffect(() => {
    setOverviewPage(1);
  }, [range.fromInclusive, range.toInclusive]);

  useEffect(() => {
    setExpandedLocationId(null);
  }, [range.fromInclusive, range.toInclusive, debouncedOverviewQ]);

  const buildOverviewParams = useCallback(() => {
    const params = new URLSearchParams(query);
    params.set("page", String(overviewPage));
    params.set("limit", String(OVERVIEW_PAGE_SIZE));
    if (debouncedOverviewQ) params.set("q", debouncedOverviewQ);
    params.set("sort", overviewSort.column);
    params.set("order", overviewSort.direction);
    return params;
  }, [query, overviewPage, debouncedOverviewQ, overviewSort]);

  const loadOverview = useCallback(async () => {
    if (!hydrated || !canUseClientCharges) return;
    setOverviewLoading(true);
    setOverviewError(null);
    setOverviewHttpStatus(null);
    try {
      const res = await fetch(`${apiBaseUrl}/workspace/client-charges/overview?${buildOverviewParams()}`, {
        cache: "no-store",
        headers: mergeWorkspaceHeaders()
      });
      setOverviewHttpStatus(res.status);
      const payload = (await res.json().catch(() => ({}))) as ClientChargesOverviewResponse & {
        error?: string;
        message?: string;
      };
      if (!res.ok) {
        if (res.status === 404) {
          throw new Error(
            "Client Charges overview is unavailable on the API (404). Redeploy the Cloudflare Worker so GET /workspace/client-charges/overview is live."
          );
        }
        throw new Error(payload.message ?? payload.error ?? "Unable to load client charges overview");
      }
      setOverview(payload);
    } catch (caught) {
      setOverview(null);
      setOverviewError(caught instanceof Error ? caught.message : "Unable to load client charges overview");
    } finally {
      setOverviewLoading(false);
    }
  }, [apiBaseUrl, buildOverviewParams, canUseClientCharges, hydrated]);

  useEffect(() => {
    void loadOverview();
  }, [loadOverview, sessionKey]);

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

  const loadPlatformStripeStatus = useCallback(async () => {
    if (!isAdmin) {
      setPlatformStripeLabel(null);
      return;
    }
    try {
      const res = await fetch(`${apiBaseUrl}/admin/stripe/platform-status`, {
        cache: "no-store",
        headers: mergeWorkspaceHeaders()
      });
      const payload = (await res.json().catch(() => ({}))) as {
        configured?: boolean;
        platformAccountMasked?: string | null;
      };
      if (!res.ok || !payload.configured) {
        setPlatformStripeLabel("Platform Stripe: not configured");
        return;
      }
      setPlatformStripeLabel(
        payload.platformAccountMasked
          ? `Platform Stripe: ${payload.platformAccountMasked}`
          : "Platform Stripe: configured"
      );
    } catch {
      setPlatformStripeLabel(null);
    }
  }, [apiBaseUrl, isAdmin]);

  useEffect(() => {
    if (showEligibility) {
      void loadBillingLocations();
      void loadPlatformStripeStatus();
    }
  }, [loadBillingLocations, loadPlatformStripeStatus, showEligibility, sessionKey]);

  useEffect(() => {
    const stripeFlow = searchParams.get("stripe");
    if (!stripeFlow || !isAdmin) return;
    setShowEligibility(true);
    void loadBillingLocations();
  }, [searchParams, isAdmin, loadBillingLocations]);

  function notifyDetailRefresh(locationId?: string) {
    window.dispatchEvent(new CustomEvent("client-charges:refresh-detail", { detail: { locationId } }));
  }

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
          currency: loc.currency || "USD"
        })
      });
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        code?: string;
      };
      if (!res.ok) {
        const hint =
          payload.error === "billing_not_ready" || payload.code === "billing_not_ready"
            ? " Link the Stripe Connect account and add a payment method under Location eligibility."
            : "";
        throw new Error((payload.message ?? payload.error ?? "Update failed") + hint);
      }
      await loadBillingLocations();
      await loadOverview();
      notifyDetailRefresh();
    } catch (caught) {
      setBillingError(caught instanceof Error ? caught.message : "Update failed");
    } finally {
      setBillingBusyId(null);
    }
  }

  async function linkStripeAccount(loc: BillingLocationConfig) {
    const draft = (stripeAccountDrafts[loc.locationId] ?? loc.stripeAccountId ?? "").trim();
    if (!draft) {
      setBillingError("Enter a Stripe Connect account id (acct_…).");
      return;
    }
    setBillingBusyId(loc.locationId);
    setBillingError(null);
    try {
      const res = await fetch(
        `${apiBaseUrl}/admin/client-charges/locations/${loc.locationId}/stripe/link`,
        {
          method: "PATCH",
          cache: "no-store",
          headers: mergeWorkspaceHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({ stripeAccountId: draft })
        }
      );
      const payload = (await res.json().catch(() => ({}))) as {
        error?: string;
        message?: string;
        stripeAccountId?: string | null;
      };
      if (!res.ok) {
        throw new Error(payload.message ?? payload.error ?? "Unable to link Stripe account");
      }
      await loadBillingLocations();
    } catch (caught) {
      setBillingError(caught instanceof Error ? caught.message : "Unable to link Stripe account");
    } finally {
      setBillingBusyId(null);
    }
  }

  async function startBillingSetup(loc: BillingLocationConfig) {
    setBillingBusyId(loc.locationId);
    setBillingError(null);
    try {
      const res = await fetch(
        `${apiBaseUrl}/admin/client-charges/locations/${loc.locationId}/stripe/billing-setup`,
        {
          method: "POST",
          cache: "no-store",
          headers: mergeWorkspaceHeaders()
        }
      );
      const payload = (await res.json().catch(() => ({}))) as {
        url?: string;
        error?: string;
        message?: string;
      };
      if (!res.ok || !payload.url) {
        throw new Error(payload.message ?? payload.error ?? "Unable to open billing setup");
      }
      window.location.assign(payload.url);
    } catch (caught) {
      setBillingError(caught instanceof Error ? caught.message : "Unable to open billing setup");
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
        const billingHint =
          payload.error === "billing_not_ready"
            ? " Set up Stripe Connect and a saved payment method under Location eligibility."
            : "";
        throw new Error(
          (payload.message ??
            payload.error ??
            (payload.ambiguous
              ? "Charge outcome is ambiguous — reconcile before retrying."
              : "Charge failed")) + billingHint
        );
      }
      setConfirmRow(null);
      await loadOverview();
      notifyDetailRefresh(row.locationId);
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

  const totals = overview?.totals;
  const tableRows = overview?.subaccounts ?? [];
  const pagination = overview?.pagination;
  const rowOrdinalBase = pagination ? (pagination.page - 1) * pagination.pageSize : 0;
  const accountCount = pagination?.totalSubaccounts ?? 0;

  function toggleOverviewSort(column: OverviewSortColumn) {
    setOverviewPage(1);
    setOverviewSort((prev) =>
      prev.column === column
        ? { column, direction: prev.direction === "asc" ? "desc" : "asc" }
        : { column, direction: column === "subaccount" ? "asc" : "desc" }
    );
  }

  function sortAria(column: OverviewSortColumn): "ascending" | "descending" | undefined {
    return overviewSort.column === column
      ? overviewSort.direction === "asc"
        ? "ascending"
        : "descending"
      : undefined;
  }

  function sortCaret(column: OverviewSortColumn): string | null {
    return overviewSort.column === column ? (overviewSort.direction === "desc" ? "↓" : "↑") : null;
  }

  function toggleRowDetail(locationId: string) {
    setExpandedLocationId((prev) => (prev === locationId ? null : locationId));
  }

  if (!canUseClientCharges) {
    return hydrated ? null : <p className="muted">Loading client charges…</p>;
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
            setOverviewError("Invalid custom range.");
            return;
          }
          setPreset("custom");
          setRange({
            fromInclusive: customDraft.fromInclusive.slice(0, 10),
            toInclusive: customDraft.toInclusive.slice(0, 10)
          });
          setOverviewError(null);
        }}
        onCustomDraft={(d) => setCustomDraft(d)}
        onPresetChange={(p) => {
          if (p === "7" || p === "30" || p === "90") {
            setPreset(p);
            setRange(utcInclusiveRange(Number(p)));
            setOverviewError(null);
            return;
          }
          setPreset("custom");
          setCustomDraft({ ...range });
        }}
        preset={preset}
        value={range}
      />

      {overviewLoading ? <p className="muted">Loading client charges…</p> : null}
      {overviewError ? (
        <div className="panel" style={{ marginTop: 12, padding: 14 }}>
          <p className="empty" style={{ margin: 0 }}>
            {overviewError}
          </p>
          {overviewHttpStatus === 404 ? (
            <p className="muted" style={{ margin: "8px 0 0" }}>
              The web app expects a subaccount overview table. If you only redeployed Pages, publish the API Worker
              too (`wrangler deploy` in <code>apps/api</code>).
            </p>
          ) : null}
        </div>
      ) : null}
      {actionError ? <p className="empty">{actionError}</p> : null}

      {!overviewLoading && totals ? (
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

      <div className="appointments-filter-field" style={{ marginTop: 16 }}>
        <label className="appointments-filter-label" htmlFor="client-charges-overview-search">
          Filter subaccounts
        </label>
        <div
          style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 6, alignItems: "flex-end" }}
        >
          <input
            aria-label="Filter client charges by subaccount name or id"
            autoCapitalize="off"
            autoComplete="off"
            className="appointments-filter-select"
            id="client-charges-overview-search"
            onChange={(e) => setOverviewSearchDraft(e.target.value)}
            placeholder="Name, HighLevel location id, or UUID…"
            spellCheck={false}
            style={{ display: "block", flex: "1 1 220px", maxWidth: 440, width: "100%" }}
            type="search"
            value={overviewSearchDraft}
          />
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
        <p className="muted" style={{ marginBottom: 0, marginTop: 8 }}>
          {pagination ? (
            <>
              Page <strong>{pagination.page}</strong> of <strong>{pagination.totalPages}</strong> ·{" "}
              <strong>{tableRows.length}</strong> rows on this page · <strong>{accountCount}</strong> subaccounts match
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
            disabled={overviewPage <= 1 || overviewLoading}
            onClick={() => setOverviewPage((p) => Math.max(1, p - 1))}
            type="button"
          >
            Previous
          </button>
          <span className="muted">
            Page {pagination.page} / {pagination.totalPages}
          </span>
          <button
            className="button secondary"
            disabled={overviewPage >= pagination.totalPages || overviewLoading}
            onClick={() => setOverviewPage((p) => p + 1)}
            type="button"
          >
            Next
          </button>
        </div>
      ) : null}

      {!overviewLoading && overview ? (
        <div className="panel" style={{ marginTop: 16, overflow: "auto", padding: 0 }}>
          <table className="dashboard-table">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">
                  <button
                    aria-sort={sortAria("subaccount")}
                    className="dashboard-th-sort"
                    onClick={() => toggleOverviewSort("subaccount")}
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
                    aria-sort={sortAria("eligible")}
                    className="dashboard-th-sort"
                    onClick={() => toggleOverviewSort("eligible")}
                    type="button"
                  >
                    Eligible
                    {sortCaret("eligible") ? (
                      <span aria-hidden className="dashboard-th-sort-hint">
                        {sortCaret("eligible")}
                      </span>
                    ) : null}
                  </button>
                </th>
                <th scope="col">
                  <button
                    aria-sort={sortAria("unbilled")}
                    className="dashboard-th-sort"
                    onClick={() => toggleOverviewSort("unbilled")}
                    type="button"
                  >
                    Unbilled
                    {sortCaret("unbilled") ? (
                      <span aria-hidden className="dashboard-th-sort-hint">
                        {sortCaret("unbilled")}
                      </span>
                    ) : null}
                  </button>
                </th>
                <th scope="col">
                  <button
                    aria-sort={sortAria("charged")}
                    className="dashboard-th-sort"
                    onClick={() => toggleOverviewSort("charged")}
                    type="button"
                  >
                    Charged
                    {sortCaret("charged") ? (
                      <span aria-hidden className="dashboard-th-sort-hint">
                        {sortCaret("charged")}
                      </span>
                    ) : null}
                  </button>
                </th>
                <th scope="col">Failed</th>
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
                        aria-label={`${expandedLocationId === row.locationId ? "Collapse" : "Expand"} appointments for ${locationLabel(row)}`}
                        className="dashboard-subaccount-expand"
                        onClick={() => toggleRowDetail(row.locationId)}
                        type="button"
                      >
                        <span>{locationLabel(row)}</span>
                        <span aria-hidden className="dashboard-subaccount-expand-caret">
                          {expandedLocationId === row.locationId ? "\u25BC" : "\u25B6"}
                        </span>
                      </button>
                    </td>
                    <td>{row.eligibleCount}</td>
                    <td>
                      <div>{row.unbilledCount}</div>
                      <div className="muted">
                        {row.mixedCurrencies
                          ? "Mixed currencies"
                          : formatMoney(row.unbilledAmount, row.currency)}
                      </div>
                    </td>
                    <td>
                      <div>{row.chargedCount}</div>
                      <div className="muted">
                        {row.mixedCurrencies
                          ? "Mixed currencies"
                          : formatMoney(row.chargedAmount, row.currency)}
                      </div>
                    </td>
                    <td>
                      {row.failedCount}
                      {row.pendingCount > 0 ? (
                        <div className="muted">{row.pendingCount} pending</div>
                      ) : null}
                    </td>
                  </tr>
                  {expandedLocationId === row.locationId ? (
                    <tr>
                      <td
                        colSpan={6}
                        style={{ background: "var(--muted-bg, rgba(0, 0, 0, 0.032))", padding: "18px 20px" }}
                      >
                        <ClientChargesLocationDetail
                          apiBaseUrl={apiBaseUrl}
                          busyAppointmentId={busyAppointmentId}
                          isAdmin={isAdmin}
                          locationId={row.locationId}
                          onRequestCharge={(chargeRow, mode) => {
                            setConfirmMode(mode);
                            setConfirmRow(chargeRow);
                            setActionError(null);
                          }}
                          range={range}
                        />
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
          {accountCount === 0 ? (
            <p className="empty muted" style={{ padding: 16 }}>
              No billable results in this window for enabled locations
              {debouncedOverviewQ ? " (or no subaccounts match your search)." : "."}
            </p>
          ) : tableRows.length === 0 ? (
            <p className="empty muted" style={{ padding: 16 }}>
              No rows on this page.
            </p>
          ) : null}
        </div>
      ) : null}

      {isAdmin && showEligibility ? (
        <div className="panel" style={{ padding: 18, marginTop: 20 }}>
          <h2 style={{ marginTop: 0 }}>Location eligibility</h2>
          {platformStripeLabel ? <p className="muted">{platformStripeLabel}</p> : null}
          <p className="muted">
            Client Charges stay off by default. Paste the Stripe Connect account id (acct_…) already created in your
            Stripe dashboard for each subaccount, verify it, then add a saved payment method before enabling billing.
            Charges run on that connected account. The amount always mirrors the lead&apos;s paid deposit.
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
                {filteredBillingLocs.map((loc) => {
                  const status = stripeConnectStatusLabel(loc);
                  const busy = billingBusyId === loc.locationId;
                  return (
                    <div className="subaccount-config-row" key={loc.locationId} style={{ alignItems: "center" }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <strong>{formatLocationName(loc.locationName, loc.ghlLocationId)}</strong>
                        <div className="muted">
                          GHL: {loc.ghlLocationId} · {loc.currency} · Stripe: {status}
                          {loc.stripeAccountMasked ? ` · ${loc.stripeAccountMasked}` : ""}
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 8, alignItems: "center" }}>
                          <input
                            aria-label={`Stripe account id for ${loc.ghlLocationId}`}
                            autoCapitalize="off"
                            autoComplete="off"
                            className="appointments-filter-select"
                            disabled={busy}
                            onChange={(e) =>
                              setStripeAccountDrafts((prev) => ({
                                ...prev,
                                [loc.locationId]: e.target.value
                              }))
                            }
                            placeholder="acct_…"
                            spellCheck={false}
                            style={{ maxWidth: 280, minWidth: 180 }}
                            type="text"
                            value={stripeAccountDrafts[loc.locationId] ?? loc.stripeAccountId ?? ""}
                          />
                          <button
                            className="button secondary"
                            disabled={busy}
                            onClick={() => void linkStripeAccount(loc)}
                            type="button"
                          >
                            Save / verify
                          </button>
                          {(loc.stripeAccountMasked || loc.stripeAccountId) && !loc.hasPaymentMethod ? (
                            <button
                              className="button secondary"
                              disabled={busy}
                              onClick={() => void startBillingSetup(loc)}
                              type="button"
                            >
                              Add payment method
                            </button>
                          ) : null}
                        </div>
                      </div>
                      <label style={{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
                        <span className="muted">Enable</span>
                        <input
                          aria-label={`Enable Client Charges for ${loc.ghlLocationId}`}
                          checked={Boolean(loc.enabled)}
                          disabled={busy || (!loc.billingReady && !loc.enabled)}
                          onChange={(e) => void patchLocationBilling(loc, e.target.checked)}
                          type="checkbox"
                        />
                      </label>
                    </div>
                  );
                })}
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
              {confirmMode === "retry" ? "Retry Stripe charge" : "Confirm Stripe charge"}
            </h3>
            <p className="muted appointments-override-subheader">
              You will charge the subaccount the same amount the lead paid as a deposit, using the saved card on file
              with Stripe. This charge is irreversible. Double-check before continuing.
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
