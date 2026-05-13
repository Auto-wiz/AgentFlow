"use client";

import type { AppointmentSummary } from "@agentflow/shared";
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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();

    async function loadAppointments() {
      setLoading(true);
      setError(null);
      const params = new URLSearchParams();
      if (locationId.trim()) {
        params.set("locationId", locationId.trim());
      }

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
  }, [locationId]);

  return (
    <section>
      <div className="toolbar">
        <input
          aria-label="GoHighLevel location ID"
          placeholder="Filter by locationId"
          value={locationId}
          onChange={(event) => setLocationId(event.target.value)}
        />
      </div>

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
    </section>
  );
}
