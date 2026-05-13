"use client";

import { useState } from "react";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

export default function DebugPage() {
  const [locationId, setLocationId] = useState("");
  const [loading, setLoading] = useState(false);
  const [locationsResponse, setLocationsResponse] = useState<unknown>(null);
  const [locationDebugResponse, setLocationDebugResponse] = useState<unknown>(null);
  const [error, setError] = useState<string | null>(null);

  async function runRequest(url: string, setter: (value: unknown) => void) {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(url);
      const payload = await response.json().catch(() => ({ error: "invalid_json" }));
      setter({
        ok: response.ok,
        status: response.status,
        url,
        payload
      });
      if (!response.ok) {
        setError(`Request failed with status ${response.status}`);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  async function fetchLocations() {
    await runRequest(`${apiBaseUrl}/locations?limit=200`, setLocationsResponse);
  }

  async function debugLocation() {
    const normalized = locationId.trim();
    if (!normalized) {
      setError("Please enter a location ID first.");
      return;
    }
    await runRequest(
      `${apiBaseUrl}/debug/location/${encodeURIComponent(normalized)}`,
      setLocationDebugResponse
    );
  }

  return (
    <section>
      <div className="panel" style={{ padding: 20, marginBottom: 16 }}>
        <p className="eyebrow">Debug tools</p>
        <h2 style={{ marginTop: 8 }}>Locations / GHL lookup debug</h2>
        <p className="muted">
          Use these buttons while watching the browser Network tab to inspect API calls directly.
        </p>
        <div className="toolbar">
          <button className="button secondary" disabled={loading} onClick={fetchLocations}>
            GET /locations
          </button>
          <input
            aria-label="GoHighLevel location ID"
            placeholder="GHL locationId or UUID"
            value={locationId}
            onChange={(event) => setLocationId(event.target.value)}
          />
          <button className="button secondary" disabled={loading} onClick={debugLocation}>
            GET /debug/location/:id
          </button>
        </div>
        {error ? <p className="muted">{error}</p> : null}
      </div>

      <div className="panel" style={{ padding: 20, marginBottom: 16 }}>
        <h3>Response: /locations</h3>
        <pre className="debug-json">{JSON.stringify(locationsResponse, null, 2)}</pre>
      </div>

      <div className="panel" style={{ padding: 20 }}>
        <h3>Response: /debug/location/:id</h3>
        <pre className="debug-json">{JSON.stringify(locationDebugResponse, null, 2)}</pre>
      </div>
    </section>
  );
}
