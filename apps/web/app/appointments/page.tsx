"use client";

import type { AppointmentSummary, SubaccountOverview } from "@agentflow/shared";
import { getApiBaseUrl } from "../../lib/api-base-url";
import { useEffect, useMemo, useState } from "react";

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

function buildGhlContactEmbedUrl(locationId: string, contactId: string | null) {
  if (!contactId?.trim()) {
    return null;
  }
  return `https://app.gohighlevel.com/v2/location/${encodeURIComponent(locationId)}/contacts/detail/${encodeURIComponent(contactId)}`;
}

export default function AppointmentsPage() {
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

  return (
    <section className="module-shell">
      <div className="panel" style={{ padding: 18 }}>
        <p className="eyebrow">Appointments</p>
        <h2 style={{ marginTop: 8 }}>Unpaid appointment filters</h2>
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
                  <strong>{appointment.title ?? "Untitled appointment"}</strong>
                  <span className="muted">
                    {formatLocationName(appointment.locationName, appointment.ghlLocationId)}
                  </span>
                  <span className="muted">
                    {appointment.contactName} · starts {formatDate(appointment.startTime)}
                  </span>
                  <div className="badge-row">
                    <span className="badge">Unpaid</span>
                    <span className="badge">{appointment.status ?? "status"}</span>
                  </div>
                </button>
              ))}
            </div>
          ) : null}
        </div>

        <div className="panel appointments-embed-panel">
          {!selectedAppointment ? (
            <div className="empty muted">Seleccioná una cita en la lista.</div>
          ) : (
            <>
              <div className="appointments-embed-toolbar">
                <p className="eyebrow" style={{ letterSpacing: "0.06em", margin: 0 }}>
                  Contacto en GoHighLevel
                </p>
                {ghlEmbedUrl ? (
                  <a className="button secondary" href={ghlEmbedUrl} rel="noreferrer noopener" target="_blank">
                    Abrir en GHL
                  </a>
                ) : (
                  <span className="muted" style={{ fontSize: 12 }}>
                    Sin ID de contacto en GHL
                  </span>
                )}
              </div>

              {!selectedAppointment.ghlContactId ? (
                <div className="empty muted">
                  Esta cita no tiene contacto vinculado en la base local. Cuando llegue sincronizada desde GHL vas a
                  poder abrirla acá.
                </div>
              ) : (
                <>
                  {/* Viewport acotado: sin esto el iframe puede crecer con el contenido y no aparece scroll interno. */}
                  <div className="appointments-iframe-holder">
                    <iframe className="appointments-ghl-iframe" src={ghlEmbedUrl ?? undefined} title="GoHighLevel contact" />
                  </div>
                  <p className="muted iframe-hint">
                    Hacé clic dentro del iframe y usá la rueda del mouse ahí si el login no muestra el botón. Si sigue igual,
                    GHL puede tener la página sin scroll propio — usá «Abrir en GHL».
                  </p>
                </>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
