"use client";

import type { AppointmentSummary, SubaccountOverview } from "@agentflow/shared";
import { getApiBaseUrl } from "../../lib/api-base-url";
import { useEffect, useState } from "react";

const viewerKey = "default";

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
  }, [selectedLocationId]);

  const totalAppointments = subaccounts.reduce(
    (sum, subaccount) => sum + subaccount.appointmentCount,
    0
  );

  return (
    <section className="module-shell">
      <div className="panel" style={{ padding: 18 }}>
        <p className="eyebrow">Calendar module</p>
        <h2 style={{ marginTop: 8 }}>Appointments</h2>
        <p className="muted">Vista en formato módulo, siguiendo el shell general del workspace.</p>
      </div>

      <div className="split-layout">
        <aside className="panel subaccount-sidebar">
          <p className="eyebrow">Subaccounts</p>
          <h3 style={{ marginTop: 8 }}>Appointments</h3>
          <div className="subaccount-list">
            <button
              className={`subaccount-item ${selectedLocationId ? "" : "active"}`}
              onClick={() => setSelectedLocationId("")}
              type="button"
            >
              <strong>All tracked subaccounts</strong>
              <span className="muted">{totalAppointments} appointments</span>
            </button>
            {subaccounts.map((subaccount) => (
              <button
                className={`subaccount-item ${
                  selectedLocationId === subaccount.locationId ? "active" : ""
                }`}
                key={subaccount.locationId}
                onClick={() => setSelectedLocationId(subaccount.locationId)}
                type="button"
              >
                <strong>{formatLocationName(subaccount.locationName, subaccount.ghlLocationId)}</strong>
                <span className="muted">{subaccount.appointmentCount} appointments</span>
              </button>
            ))}
          </div>
        </aside>

        <div className="panel" style={{ padding: 18 }}>
          {loading ? <div className="empty muted">Loading appointments...</div> : null}
          {error ? <div className="empty">{error}</div> : null}
          {!loading && !error && appointments.length === 0 ? (
            <div className="empty muted">No appointments found.</div>
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
                  <span className="badge">{appointment.status ?? "status unknown"}</span>
                  <span className="badge">GHL: {appointment.ghlAppointmentId}</span>
                  <span className="badge">Updated: {formatDate(appointment.updatedAt)}</span>
                </div>
              </article>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}
