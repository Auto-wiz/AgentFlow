"use client";

import type { AppointmentSummary, SubaccountOverview } from "@agentflow/shared";
import { getApiBaseUrl } from "../../lib/api-base-url";
import { mergeWorkspaceHeaders } from "../../lib/workspace-api-headers";
import { useAppointmentsTopbarSlot } from "../components/appointments-topbar-bridge";
import { useWorkspaceAuth } from "../components/workspace-auth-provider";
import { useEffect, useMemo, useState } from "react";

type AppointmentTimeFilter = "future" | "past" | "all";

function formatLocationName(locationName: string | null, ghlLocationId: string) {
  return locationName ? `${locationName} (${ghlLocationId})` : ghlLocationId;
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

export default function AppointmentsPage() {
  const setTopbarFilters = useAppointmentsTopbarSlot();
  const { sessionKey } = useWorkspaceAuth();
  const apiBaseUrl = getApiBaseUrl();
  const [appointments, setAppointments] = useState<AppointmentSummary[]>([]);
  const [subaccounts, setSubaccounts] = useState<SubaccountOverview[]>([]);
  const [selectedLocationId, setSelectedLocationId] = useState("");
  const [timeFilter, setTimeFilter] = useState<AppointmentTimeFilter>("future");
  const [selectedAppointmentId, setSelectedAppointmentId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function loadAppointments() {
      setLoading(true);
      setError(null);
      setAppointments([]);

      try {
        const subaccountsResponse = await fetch(
          `${apiBaseUrl}/subaccounts/overview?surface=appointments`,
          {
            signal: controller.signal,
            headers: mergeWorkspaceHeaders()
          }
        );
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
          !subaccountsData.subaccounts.some(
            (subaccount) => subaccount.locationId === nextSelectedLocationId
          )
        ) {
          nextSelectedLocationId = "";
          setSelectedLocationId("");
        }

        const params = new URLSearchParams();
        if (nextSelectedLocationId) {
          params.set("locationId", nextSelectedLocationId);
        }
        if (timeFilter !== "all") {
          params.set("time", timeFilter);
        }
        params.set("paymentStatus", "unpaid");

        const url = params.toString()
          ? `${apiBaseUrl}/appointments?${params.toString()}`
          : `${apiBaseUrl}/appointments`;
        const response = await fetch(url, {
          signal: controller.signal,
          headers: mergeWorkspaceHeaders()
        });
        if (!response.ok) {
          throw new Error("Failed to load appointments");
        }
        const data = (await response.json()) as { appointments: AppointmentSummary[] };
        setAppointments(data.appointments);
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

    loadAppointments();
    return () => controller.abort();
  }, [apiBaseUrl, selectedLocationId, timeFilter, sessionKey]);

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

  const totalAppointments = subaccounts.reduce(
    (sum, subaccount) => sum + subaccount.appointmentCount,
    0
  );

  const selectedAppointment = useMemo(
    () => appointments.find((appointment) => appointment.id === selectedAppointmentId) ?? null,
    [appointments, selectedAppointmentId]
  );

  const ghlEmbedUrl = useMemo(() => {
    if (!selectedAppointment) {
      return null;
    }
    return buildGhlContactEmbedUrl(selectedAppointment.ghlLocationId, selectedAppointment.ghlContactId);
  }, [selectedAppointment]);

  useEffect(() => {
    setTopbarFilters(
      <div aria-label="Unpaid appointments filters" className="appointments-header-filters">
        <div className="appointments-filter-field appointments-filter-inline">
          <label className="appointments-filter-label" htmlFor="appointment-subaccount-filter">
            Subaccount
          </label>
          <select
            className="appointments-filter-select appointments-filter-select-inline"
            id="appointment-subaccount-filter"
            value={selectedLocationId}
            onChange={(event) => setSelectedLocationId(event.target.value)}
          >
            <option value="">All ({totalAppointments})</option>
            {subaccounts.map((subaccount) => (
              <option key={subaccount.locationId} value={subaccount.locationId}>
                {formatLocationName(subaccount.locationName, subaccount.ghlLocationId)} ({subaccount.appointmentCount})
              </option>
            ))}
          </select>
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
      </div>
    );
    return () => setTopbarFilters(null);
  }, [setTopbarFilters, selectedLocationId, subaccounts, timeFilter, totalAppointments]);

  return (
    <section className="module-shell appointments-module-page">
      <div className="appointments-workspace-grid">
        <div className="panel appointments-list-panel">
          {loading ? <div className="empty muted">Loading appointments...</div> : null}
          {error ? <div className="empty">{error}</div> : null}
          {!loading && !error && appointments.length === 0 ? (
            <div className="empty muted">No unpaid appointments found.</div>
          ) : null}

          {!loading && !error && appointments.length > 0 ? (
            <div aria-label="Unpaid appointments" className="appointments-scroll-list" role="list">
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
                      <span className="badge">Unpaid</span>
                      <span className="badge">{appointment.status ?? "status"}</span>
                    </div>
                  </div>
                  <div className="appointments-row-sub muted">{formatLocationName(appointment.locationName, appointment.ghlLocationId)}</div>
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
