"use client";

import type { AppointmentSummary, SubaccountOverview } from "@agentflow/shared";
import { getApiBaseUrl } from "../../lib/api-base-url";
import { formatLocationName } from "../../lib/location-display";
import { mergeWorkspaceHeaders } from "../../lib/workspace-api-headers";
import { useAppointmentsTopbarSlot } from "../components/appointments-topbar-bridge";
import { useWorkspaceAuth } from "../components/workspace-auth-provider";
import { useEffect, useMemo, useState } from "react";

type AppointmentTimeFilter = "future" | "past" | "all";

type AppointmentPaymentFilter = "unpaid" | "paid" | "all";

/** Mirrors GET /appointments: `lifecycle` query (active/cancelled/all). */
type AppointmentLifecycleFilter = "active" | "cancelled" | "all";

/** Mirrors GET /appointments `hidden` query. */
type AppointmentHiddenFilter = "omit" | "include" | "only";

type ManualPaymentDraft = "inherit" | "force_paid" | "force_unpaid";

function appointmentsEmptyMessage(
  paymentFilter: AppointmentPaymentFilter,
  lifecycleFilter: AppointmentLifecycleFilter
): string {
  const pay =
    paymentFilter === "paid" ? "paid" : paymentFilter === "unpaid" ? "unpaid" : "";
  const life =
    lifecycleFilter === "active"
      ? "confirmed"
      : lifecycleFilter === "cancelled"
        ? "cancelled"
        : "";
  const qualifiers = [pay, life].filter(Boolean).join(" ");
  if (!qualifiers) {
    return "No appointments found.";
  }
  return `No ${qualifiers} appointments found.`;
}

function formatDate(value: string | null) {
  if (!value) {
    return "Not scheduled";
  }
  return new Date(value).toLocaleString("en-US", {
    dateStyle: "medium",
    timeStyle: "short"
  });
}

function buildGhlContactEmbedUrl(locationId: string, contactId: string | null) {
  if (!contactId?.trim()) {
    return null;
  }
  return `https://app.gohighlevel.com/v2/location/${encodeURIComponent(locationId)}/contacts/detail/${encodeURIComponent(contactId)}`;
}

function appointmentMatchesScheduleFilter(startTimeIso: string | null, filter: AppointmentTimeFilter): boolean {
  if (filter === "all") {
    return true;
  }
  if (!startTimeIso) {
    return false;
  }
  const t = new Date(startTimeIso).getTime();
  if (!Number.isFinite(t)) {
    return false;
  }
  const now = Date.now();
  return filter === "future" ? t >= now : t < now;
}

/** Extra client-side alignment with the list UI (server already applies most filters). */
function applyAppointmentListClientFilters(
  rows: AppointmentSummary[],
  timeFilter: AppointmentTimeFilter,
  paymentFilter: AppointmentPaymentFilter,
  lifecycleFilter: AppointmentLifecycleFilter
): AppointmentSummary[] {
  let out = rows;
  if (lifecycleFilter !== "all") {
    out =
      lifecycleFilter === "cancelled"
        ? out.filter((appointment) => appointment.cancelledBooking)
        : out.filter((appointment) => !appointment.cancelledBooking);
  }
  if (paymentFilter !== "all") {
    out = out.filter((appointment) => appointment.paymentStatus === paymentFilter);
  }
  if (timeFilter !== "all") {
    out = out.filter((appointment) => appointmentMatchesScheduleFilter(appointment.startTime, timeFilter));
  }
  return out;
}

function buildAppointmentsQueryParams(
  locationId: string | undefined,
  timeFilter: AppointmentTimeFilter,
  paymentFilter: AppointmentPaymentFilter,
  lifecycleFilter: AppointmentLifecycleFilter,
  hiddenFilter: AppointmentHiddenFilter
) {
  const params = new URLSearchParams();
  if (locationId) {
    params.set("locationId", locationId);
  }
  params.set("schedule", timeFilter);
  params.set("paymentStatus", paymentFilter === "all" ? "all" : paymentFilter);
  params.set(
    "lifecycle",
    lifecycleFilter === "all" ? "all" : lifecycleFilter === "cancelled" ? "cancelled" : "active"
  );
  params.set("hidden", hiddenFilter);
  return params;
}

export default function AppointmentsPage() {
  const setTopbarFilters = useAppointmentsTopbarSlot();
  const { sessionKey, token } = useWorkspaceAuth();
  const apiBaseUrl = getApiBaseUrl();
  const [appointments, setAppointments] = useState<AppointmentSummary[]>([]);
  const [subaccounts, setSubaccounts] = useState<SubaccountOverview[]>([]);
  const [selectedLocationId, setSelectedLocationId] = useState("");
  const [timeFilter, setTimeFilter] = useState<AppointmentTimeFilter>("future");
  const [paymentFilter, setPaymentFilter] = useState<AppointmentPaymentFilter>("unpaid");
  const [lifecycleFilter, setLifecycleFilter] = useState<AppointmentLifecycleFilter>("active");
  const [hiddenFilter, setHiddenFilter] = useState<AppointmentHiddenFilter>("omit");
  const [selectedAppointmentId, setSelectedAppointmentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  /** Rows matching current filters across all subs (bounded by API limit) — drives Subaccount dropdown counts. */
  const [appointmentsForSubaccountTotals, setAppointmentsForSubaccountTotals] = useState<AppointmentSummary[]>([]);
  const [subaccountSelectSearch, setSubaccountSelectSearch] = useState("");

  const [overridesOpen, setOverridesOpen] = useState(false);
  const [overrideBusy, setOverrideBusy] = useState(false);
  const [overrideError, setOverrideError] = useState<string | null>(null);
  const [draftManual, setDraftManual] = useState<ManualPaymentDraft>("inherit");
  const [draftHidden, setDraftHidden] = useState(false);

  useEffect(() => {
    const controller = new AbortController();

    async function loadAppointments() {
      setLoading(true);
      setError(null);
      setAppointments([]);
      setAppointmentsForSubaccountTotals([]);

      try {
        const subaccountsResponse = await fetch(`${apiBaseUrl}/subaccounts/overview?surface=appointments`, {
          signal: controller.signal,
          headers: mergeWorkspaceHeaders()
        });
        if (!subaccountsResponse.ok) {
          throw new Error("Failed to load subaccounts");
        }
        const subaccountsData = (await subaccountsResponse.json()) as {
          subaccounts: SubaccountOverview[];
        };
        setSubaccounts(subaccountsData.subaccounts);

        let nextSelectedLocationId = selectedLocationId;
        if (
          nextSelectedLocationId &&
          !subaccountsData.subaccounts.some((subaccount) => subaccount.locationId === nextSelectedLocationId)
        ) {
          nextSelectedLocationId = "";
          setSelectedLocationId("");
        }

        const allParams = buildAppointmentsQueryParams(
          undefined,
          timeFilter,
          paymentFilter,
          lifecycleFilter,
          hiddenFilter
        );
        const allUrl = `${apiBaseUrl}/appointments?${allParams.toString()}`;
        const allResponse = await fetch(allUrl, {
          signal: controller.signal,
          headers: mergeWorkspaceHeaders(),
          cache: "no-store"
        });
        if (!allResponse.ok) {
          throw new Error("Failed to load appointments");
        }
        const allData = (await allResponse.json()) as { appointments: AppointmentSummary[] };
        const totalsFiltered = applyAppointmentListClientFilters(
          allData.appointments,
          timeFilter,
          paymentFilter,
          lifecycleFilter
        );

        let displayFiltered = totalsFiltered;
        if (nextSelectedLocationId) {
          const scopedParams = buildAppointmentsQueryParams(
            nextSelectedLocationId,
            timeFilter,
            paymentFilter,
            lifecycleFilter,
            hiddenFilter
          );
          const scopedUrl = `${apiBaseUrl}/appointments?${scopedParams.toString()}`;
          const scopedResponse = await fetch(scopedUrl, {
            signal: controller.signal,
            headers: mergeWorkspaceHeaders(),
            cache: "no-store"
          });
          if (!scopedResponse.ok) {
            throw new Error("Failed to load appointments");
          }
          const scopedData = (await scopedResponse.json()) as { appointments: AppointmentSummary[] };
          displayFiltered = applyAppointmentListClientFilters(
            scopedData.appointments,
            timeFilter,
            paymentFilter,
            lifecycleFilter
          );
        }

        setAppointmentsForSubaccountTotals(totalsFiltered);
        setAppointments(displayFiltered);
      } catch (caught) {
        if (!controller.signal.aborted) {
          setError(caught instanceof Error ? caught.message : "Failed to load appointments");
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    void loadAppointments();
    return () => controller.abort();
  }, [
    apiBaseUrl,
    selectedLocationId,
    timeFilter,
    paymentFilter,
    lifecycleFilter,
    hiddenFilter,
    sessionKey,
    reloadTick
  ]);

  useEffect(() => {
    setSelectedAppointmentId((current) => {
      if (!appointments.length) {
        return null;
      }
      if (current && appointments.some((appointment) => appointment.id === current)) {
        return current;
      }
      return appointments[0]?.id ?? null;
    });
  }, [appointments]);

  useEffect(() => {
    if (!selectedAppointmentId) {
      setOverridesOpen(false);
    }
  }, [selectedAppointmentId]);

  const selectedAppointment = useMemo(
    () => appointments.find((appointment) => appointment.id === selectedAppointmentId) ?? null,
    [appointments, selectedAppointmentId]
  );

  useEffect(() => {
    if (!overridesOpen || !selectedAppointment) {
      return;
    }
    const m = selectedAppointment.manualPaymentOverride;
    setDraftManual(
      m === "force_paid" ? "force_paid" : m === "force_unpaid" ? "force_unpaid" : "inherit"
    );
    setDraftHidden(selectedAppointment.hiddenFromUi);
    setOverrideError(null);
  }, [overridesOpen, selectedAppointment]);

  /** Subaccounts that match the type-ahead query (narrow only the picker list). */
  const subaccountsForDropdown = useMemo(() => {
    const needle = subaccountSelectSearch.trim().toLowerCase();
    if (!needle) {
      return subaccounts;
    }
    return subaccounts.filter((sub) => {
      const label = formatLocationName(sub.locationName, sub.ghlLocationId).toLowerCase();
      return (
        label.includes(needle) ||
        sub.ghlLocationId.toLowerCase().includes(needle) ||
        sub.locationId.toLowerCase().includes(needle)
      );
    });
  }, [subaccounts, subaccountSelectSearch]);

  /**
   * Per-location counts derived from `/appointments` without `locationId`, after the same client filters as the list.
   * API returns at most 200 rows, so totals can truncate when many rows match globally.
   */
  const filteredAppointmentCountsByLocation = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of appointmentsForSubaccountTotals) {
      m.set(a.locationId, (m.get(a.locationId) ?? 0) + 1);
    }
    return m;
  }, [appointmentsForSubaccountTotals]);

  const allSubaccountVisibleCount = appointmentsForSubaccountTotals.length;

  const ghlEmbedUrl = useMemo(() => {
    if (!selectedAppointment) {
      return null;
    }
    return buildGhlContactEmbedUrl(selectedAppointment.ghlLocationId, selectedAppointment.ghlContactId);
  }, [selectedAppointment]);

  async function saveAppointmentOverrides() {
    if (!selectedAppointment || !token) {
      setOverrideError("Select an appointment and sign in with a workspace account.");
      return;
    }
    setOverrideBusy(true);
    setOverrideError(null);
    try {
      const res = await fetch(`${apiBaseUrl}/workspace/appointments/${selectedAppointment.id}/overrides`, {
        method: "PUT",
        headers: mergeWorkspaceHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          manualPaymentOverride: draftManual,
          hiddenFromUi: draftHidden
        })
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string; hint?: string };
      if (!res.ok) {
        throw new Error(payload.error ?? payload.hint ?? "Save failed");
      }
      setOverridesOpen(false);
      setReloadTick((n) => n + 1);
    } catch (caught) {
      setOverrideError(caught instanceof Error ? caught.message : "Save failed");
    } finally {
      setOverrideBusy(false);
    }
  }

  useEffect(() => {
    setTopbarFilters(
      <div aria-label="Appointment filters" className="appointments-header-filters">
        <div className="appointments-filter-field appointments-filter-inline">
          <label className="appointments-filter-label" htmlFor="appointment-subaccount-search">
            Subaccount
          </label>
          <input
            aria-label="Filter subaccounts in picker"
            autoCapitalize="off"
            autoComplete="off"
            className="appointments-filter-select appointments-filter-select-inline appointments-subaccount-search"
            id="appointment-subaccount-search"
            type="search"
            placeholder="Find subaccount…"
            spellCheck={false}
            value={subaccountSelectSearch}
            onChange={(e) => setSubaccountSelectSearch(e.target.value)}
          />
          <select
            className="appointments-filter-select appointments-filter-select-inline"
            id="appointment-subaccount-filter"
            title="Counts follow Payment, Status, Date, and Hidden filters; capped at first 200 matches from the API."
            value={selectedLocationId}
            onChange={(event) => setSelectedLocationId(event.target.value)}
          >
            <option value="">All ({allSubaccountVisibleCount})</option>
            {subaccountsForDropdown.map((subaccount) => (
              <option key={subaccount.locationId} value={subaccount.locationId}>
                {formatLocationName(subaccount.locationName, subaccount.ghlLocationId)} (
                {filteredAppointmentCountsByLocation.get(subaccount.locationId) ?? 0})
              </option>
            ))}
          </select>
        </div>
        <div className="appointments-filter-field appointments-filter-times appointments-filter-inline">
          <span className="appointments-filter-label">Payment</span>
          <div className="appointments-time-buttons">
            <button
              className={`button ${paymentFilter === "unpaid" ? "" : "secondary"}`}
              onClick={() => setPaymentFilter("unpaid")}
              type="button"
            >
              Unpaid
            </button>
            <button
              className={`button ${paymentFilter === "paid" ? "" : "secondary"}`}
              onClick={() => setPaymentFilter("paid")}
              type="button"
            >
              Paid
            </button>
            <button
              className={`button ${paymentFilter === "all" ? "" : "secondary"}`}
              onClick={() => setPaymentFilter("all")}
              type="button"
            >
              All
            </button>
          </div>
        </div>
        <div className="appointments-filter-field appointments-filter-times appointments-filter-inline">
          <span className="appointments-filter-label">Status</span>
          <div className="appointments-time-buttons">
            <button
              className={`button ${lifecycleFilter === "active" ? "" : "secondary"}`}
              onClick={() => setLifecycleFilter("active")}
              title="Excludes cancelled, invalid, deleted, declined, no-show"
              type="button"
            >
              Confirmed
            </button>
            <button
              className={`button ${lifecycleFilter === "cancelled" ? "" : "secondary"}`}
              onClick={() => setLifecycleFilter("cancelled")}
              type="button"
            >
              Cancelled
            </button>
            <button
              className={`button ${lifecycleFilter === "all" ? "" : "secondary"}`}
              onClick={() => setLifecycleFilter("all")}
              type="button"
            >
              All
            </button>
          </div>
        </div>
        <div className="appointments-filter-field appointments-filter-times appointments-filter-inline">
          <span className="appointments-filter-label">Date</span>
          <div className="appointments-time-buttons">
            <button
              className={`button ${timeFilter === "future" ? "" : "secondary"}`}
              onClick={() => setTimeFilter("future")}
              type="button"
            >
              Future
            </button>
            <button className={`button ${timeFilter === "past" ? "" : "secondary"}`} onClick={() => setTimeFilter("past")} type="button">
              Past
            </button>
            <button className={`button ${timeFilter === "all" ? "" : "secondary"}`} onClick={() => setTimeFilter("all")} type="button">
              All
            </button>
          </div>
        </div>
        <div className="appointments-filter-field appointments-filter-times appointments-filter-inline">
          <span className="appointments-filter-label">Hidden</span>
          <div className="appointments-time-buttons">
            <button
              className={`button ${hiddenFilter === "omit" ? "" : "secondary"}`}
              onClick={() => setHiddenFilter("omit")}
              title="Exclude appointments marked hidden"
              type="button"
            >
              Default
            </button>
            <button
              className={`button ${hiddenFilter === "include" ? "" : "secondary"}`}
              onClick={() => setHiddenFilter("include")}
              title="Include hidden rows alongside normal list"
              type="button"
            >
              Show all
            </button>
            <button
              className={`button ${hiddenFilter === "only" ? "" : "secondary"}`}
              onClick={() => setHiddenFilter("only")}
              title="Recover rows hidden by mistake"
              type="button"
            >
              Hidden only
            </button>
          </div>
        </div>
        <div className="appointments-filter-field appointments-filter-inline">
          <label className="appointments-filter-label" htmlFor="appointment-modify-btn">
            Appointment
          </label>
          <button
            className="button secondary appointments-modify-inline-button"
            disabled={!selectedAppointmentId || Boolean(loading && appointments.length === 0)}
            id="appointment-modify-btn"
            type="button"
            onClick={() => setOverridesOpen(true)}
          >
            Edit
          </button>
        </div>
      </div>
    );
    return () => setTopbarFilters(null);
  }, [
    setTopbarFilters,
    selectedLocationId,
    subaccountsForDropdown,
    subaccountSelectSearch,
    timeFilter,
    paymentFilter,
    lifecycleFilter,
    hiddenFilter,
    allSubaccountVisibleCount,
    filteredAppointmentCountsByLocation,
    selectedAppointmentId,
    loading,
    appointments.length
  ]);

  const emptyListMessage = appointmentsEmptyMessage(paymentFilter, lifecycleFilter);
  const statusScopeLabel =
    lifecycleFilter === "active"
      ? "Active bookings"
      : lifecycleFilter === "cancelled"
        ? "Cancelled bookings"
        : "All statuses";
  const paymentScopeLabel =
    paymentFilter === "all" ? "Any payment" : paymentFilter === "paid" ? "Paid only" : "Unpaid only";
  const appointmentsListAriaLabel = `${statusScopeLabel}, ${paymentScopeLabel}`;

  return (
    <section className="module-shell appointments-module-page">
      {overridesOpen && selectedAppointment ? (
        <div
          aria-modal
          className="appointments-override-modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget) {
              setOverridesOpen(false);
            }
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              setOverridesOpen(false);
            }
          }}
          role="dialog"
        >
          <div className="panel appointments-override-modal panel-narrow">
            <h3 className="appointments-override-modal-title">Appointment</h3>
            <p className="muted appointments-override-subheader">
              {selectedAppointment.contactName} ·{" "}
              {formatLocationName(selectedAppointment.locationName, selectedAppointment.ghlLocationId)}
            </p>
            <section className="appointments-override-section" aria-labelledby="appt-override-payment-heading">
              <h4 className="appointments-override-section-label" id="appt-override-payment-heading">
                Payment
              </h4>
              <div aria-label="Payment" className="appointments-override-toolbar" role="toolbar">
                <button
                  aria-describedby="appt-override-auto-disclaimer"
                  aria-pressed={draftManual === "inherit"}
                  className={draftManual === "inherit" ? "button" : "button secondary"}
                  onClick={() => setDraftManual("inherit")}
                  type="button"
                >
                  Auto
                  <span aria-hidden="true" className="appointments-override-footnote-mark">
                    *
                  </span>
                </button>
                <button
                  aria-pressed={draftManual === "force_paid"}
                  className={draftManual === "force_paid" ? "button" : "button secondary"}
                  onClick={() => setDraftManual("force_paid")}
                  type="button"
                >
                  Paid
                </button>
                <button
                  aria-pressed={draftManual === "force_unpaid"}
                  className={draftManual === "force_unpaid" ? "button" : "button secondary"}
                  onClick={() => setDraftManual("force_unpaid")}
                  type="button"
                >
                  Unpaid
                </button>
              </div>
              <p className="muted appointments-override-disclaimer" id="appt-override-auto-disclaimer">
                <span className="appointments-override-footnote-mark">*</span>{" "}
                <strong>Auto:</strong> let the system decide paid vs unpaid from synced invoices and orders—no manual
                override.
              </p>
            </section>
            <section className="appointments-override-section" aria-labelledby="appt-override-list-heading">
              <h4 className="appointments-override-section-label" id="appt-override-list-heading">
                In this list
              </h4>
              <div aria-label="List visibility" className="appointments-override-toolbar" role="toolbar">
                <button
                  aria-pressed={!draftHidden}
                  className={!draftHidden ? "button" : "button secondary"}
                  onClick={() => setDraftHidden(false)}
                  type="button"
                >
                  Visible
                </button>
                <button
                  aria-pressed={draftHidden}
                  className={draftHidden ? "button" : "button secondary"}
                  onClick={() => setDraftHidden(true)}
                  type="button"
                >
                  Hidden
                </button>
              </div>
            </section>
            {overrideError ? <div className="empty" style={{ marginBottom: 8 }}>{overrideError}</div> : null}
            {!token ? <p className="muted">Sign in to save overrides.</p> : null}
            <div className="toolbar" style={{ gap: 10, justifyContent: "flex-end" }}>
              <button className="button secondary" onClick={() => setOverridesOpen(false)} type="button">
                Cancel
              </button>
              <button className="button" disabled={overrideBusy || !token} onClick={() => void saveAppointmentOverrides()} type="button">
                {overrideBusy ? "Saving…" : "Save"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      <div className="appointments-workspace-grid">
        <div className="panel appointments-list-panel">
          {loading ? <div className="empty muted">Loading appointments...</div> : null}
          {error ? <div className="empty">{error}</div> : null}
          {!loading && !error && appointments.length === 0 ? (
            <div className="empty muted">{emptyListMessage}</div>
          ) : null}

          {!loading && !error && appointments.length > 0 ? (
            <div aria-label={appointmentsListAriaLabel} className="appointments-scroll-list" role="list">
              {appointments.map((appointment) => (
                <button
                  aria-current={appointment.id === selectedAppointmentId ? true : undefined}
                  aria-label={`Appointment ${appointment.title ?? appointment.ghlAppointmentId}`}
                  className={`appointments-row ${appointment.id === selectedAppointmentId ? "active" : ""}`}
                  key={appointment.id}
                  onClick={() => setSelectedAppointmentId(appointment.id)}
                  role="listitem"
                  type="button"
                >
                  <div className="appointments-row-main">
                    <strong className="appointments-row-title">{appointment.title ?? "Untitled appointment"}</strong>
                    <div className="badge-row appointments-badge-row">
                      <span className="badge">
                        {appointment.paymentStatus === "paid" ? "Paid" : "Unpaid"}
                      </span>
                      {appointment.manualPaymentOverride === "force_paid" ? (
                        <span className="badge secondary" title="Payment forced in AgentFlow">
                          Paid · manual
                        </span>
                      ) : appointment.manualPaymentOverride === "force_unpaid" ? (
                        <span className="badge secondary" title="Payment forced in AgentFlow">
                          Unpaid · manual
                        </span>
                      ) : null}
                      {appointment.hiddenFromUi ? (
                        <span className="badge secondary" title="Hidden from default list">
                          Hidden
                        </span>
                      ) : null}
                      <span className="badge">{appointment.status ?? "status"}</span>
                    </div>
                  </div>
                  <div className="appointments-row-sub muted">
                    {formatLocationName(appointment.locationName, appointment.ghlLocationId)}
                  </div>
                  {(appointment.locationName ?? "").trim() ? (
                    <div className="muted" style={{ fontSize: 10, lineHeight: 1.2 }}>
                      Location ID: {appointment.ghlLocationId}
                    </div>
                  ) : null}
                  <div className="appointments-row-sub muted appointments-row-contact">
                    {appointment.contactName} · {formatDate(appointment.startTime)}
                  </div>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="panel appointments-right-panel appointments-iframe-panel">
          {!selectedAppointment ? (
            <div className="empty muted appointments-iframe-empty">Select an appointment from the list.</div>
          ) : (
            <>
              {!selectedAppointment.ghlContactId ? (
                <div className="empty muted appointments-iframe-empty">
                  This appointment has no linked contact in local data yet. Once it syncs from GoHighLevel you can view it here.
                </div>
              ) : ghlEmbedUrl ? (
                <>
                  <div className="appointments-iframe-holder appointments-iframe-only">
                    <iframe className="appointments-ghl-iframe" src={ghlEmbedUrl ?? undefined} title="GoHighLevel contact" />
                    <div aria-label="Open contact in GoHighLevel" className="appointments-gframe-chip">
                      <a className="button secondary appointments-embed-ext-link" href={ghlEmbedUrl} rel="noreferrer noopener" target="_blank">
                        Open in GHL
                      </a>
                    </div>
                  </div>
                </>
              ) : (
                <div className="empty muted appointments-iframe-empty">Missing GoHighLevel contact URL.</div>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
