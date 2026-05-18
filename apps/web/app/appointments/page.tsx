"use client";

import type { AppointmentSummary, SubaccountOverview } from "@agentflow/shared";
import { getApiBaseUrl } from "../../lib/api-base-url";
import { useEffect, useState } from "react";

const viewerKey = "default";
type AppointmentTimeFilter = "future" | "past" | "all";

function formatLocationName(locationName: string | null, ghlLocationId: string) {
  return locationName ? `${locationName} (${ghlLocationId})` : ghlLocationId;
}

function formatDate(value: string | null) {
  if (!value) {
    return "Not scheduled";
  }
  return new Date(value).toLocaleString();
}

export default function AppointmentsPage() {
  const apiBaseUrl = getApiBaseUrl();
  const [appointments, setAppointments] = useState<AppointmentSummary[]>([]);
  const [subaccounts, setSubaccounts] = useState<SubaccountOverview[]>([]);
  const [selectedLocationId, setSelectedLocationId] = useState("");
  const [timeFilter, setTimeFilter] = useState<AppointmentTimeFilter>("future");
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
            headers: {
              "x-viewer-key": viewerKey
            }
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
          headers: {
            "x-viewer-key": viewerKey
          }
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
  }, [apiBaseUrl, selectedLocationId, timeFilter]);

  const totalAppointments = subaccounts.reduce(
    (sum, subaccount) => sum + subaccount.appointmentCount,
    0
  );

  return (
    <section className="module-shell">
      <div className="panel" style={{ padding: 18 }}>
        <p className="eyebrow">Calendar module</p>
        <h2 style={{ marginTop: 8 }}>Appointments</h2>
        <p className="muted">
          Citas sin pago completo detectado entre la creación del appointment y la fecha de la cita.
        </p>
      </div>

      <div className="panel" style={{ padding: 18 }}>
        <p className="eyebrow">Filters</p>
        <h3 style={{ marginTop: 8 }}>Unpaid appointment filters</h3>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <div className="inbox-filter-block" style={{ minWidth: 280 }}>
            <label className="inbox-field-label" htmlFor="appointment-subaccount-filter">
              Subaccount
            </label>
            <select
              id="appointment-subaccount-filter"
              value={selectedLocationId}
              onChange={(event) => setSelectedLocationId(event.target.value)}
            >
              <option value="">All tracked subaccounts ({totalAppointments})</option>
              {subaccounts.map((subaccount) => (
                <option key={subaccount.locationId} value={subaccount.locationId}>
                  {formatLocationName(subaccount.locationName, subaccount.ghlLocationId)} ·{" "}
                  {subaccount.appointmentCount} appointments
                </option>
              ))}
            </select>
          </div>
          <div className="inbox-filter-block">
            <span className="inbox-field-label">Date</span>
            <div className="badge-row">
              <button
                className={`button ${timeFilter === "future" ? "" : "secondary"}`}
                onClick={() => setTimeFilter("future")}
                type="button"
              >
                Future
              </button>
              <button
                className={`button ${timeFilter === "past" ? "" : "secondary"}`}
                onClick={() => setTimeFilter("past")}
                type="button"
              >
                Past
              </button>
              <button
                className={`button ${timeFilter === "all" ? "" : "secondary"}`}
                onClick={() => setTimeFilter("all")}
                type="button"
              >
                All
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="panel" style={{ padding: 18 }}>
        {loading ? <div className="empty muted">Loading appointments...</div> : null}
        {error ? <div className="empty">{error}</div> : null}
        {!loading && !error && appointments.length === 0 ? (
          <div className="empty muted">No unpaid appointments found.</div>
        ) : null}
        <div className="thread-list">
          {appointments.map((appointment) => (
            <article className="thread-card" key={appointment.id}>
              <strong>{appointment.title ?? "Untitled appointment"}</strong>
              <span className="muted">
                {formatLocationName(appointment.locationName, appointment.ghlLocationId)}
              </span>
              <span className="muted">
                Contact: {appointment.contactName} - Starts {formatDate(appointment.startTime)}
              </span>
              <div className="badge-row">
                <span className="badge">Unpaid</span>
                <span className="badge">{appointment.status ?? "status unknown"}</span>
                <span className="badge">Created: {formatDate(appointment.appointmentCreatedAt)}</span>
                <span className="badge">GHL: {appointment.ghlAppointmentId}</span>
                <span className="badge">Updated: {formatDate(appointment.updatedAt)}</span>
              </div>
            </article>
          ))}
        </div>
      </div>
    </section>
  );
}
