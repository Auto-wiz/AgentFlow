"use client";

import type { AppointmentSummary, AppointmentsResponse } from "@agentflow/shared";
import { useEffect, useState } from "react";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

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
  const [appointments, setAppointments] = useState<AppointmentSummary[]>([]);
  const [locationId, setLocationId] = useState("");
  const [timeframe, setTimeframe] = useState<"future" | "past">("future");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function loadAppointments() {
      setLoading(true);
      setError(null);
      setAppointments([]);
      const params = new URLSearchParams();
      if (locationId.trim()) {
        params.set("locationId", locationId.trim());
      }
      params.set("timeframe", timeframe);

      try {
        const url = params.toString()
          ? `${apiBaseUrl}/appointments?${params.toString()}`
          : `${apiBaseUrl}/appointments`;
        const response = await fetch(url, {
          signal: controller.signal
        });
        if (!response.ok) {
          throw new Error("Failed to load appointments");
        }
        const data = (await response.json()) as AppointmentsResponse;
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
  }, [locationId, timeframe]);

  return (
    <section>
      <div className="toolbar">
        <input
          aria-label="Subaccount location ID"
          placeholder="Filter by subaccount (locationId)"
          value={locationId}
          onChange={(event) => setLocationId(event.target.value)}
        />
        <select
          aria-label="Appointments timeframe"
          value={timeframe}
          onChange={(event) => setTimeframe(event.target.value === "past" ? "past" : "future")}
        >
          <option value="future">Only future appointments</option>
          <option value="past">Only past appointments</option>
        </select>
      </div>

      <div className="panel" style={{ padding: 18 }}>
        <p className="eyebrow">Unpaid appointments</p>
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
              <span className="muted">
                Created: {formatDate(appointment.dateAdded)}
              </span>
              <div className="badge-row">
                <span className="badge">{appointment.status ?? "status unknown"}</span>
                <span className="badge">Unpaid</span>
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
