"use client";

import { useState } from "react";

const apiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "https://api.agentflow.autowiz.net";

export default function DebugPage() {
  const [locationId, setLocationId] = useState("");
  const [accessToken, setAccessToken] = useState("");
  const [loading, setLoading] = useState(false);
  const [locationDebugResponse, setLocationDebugResponse] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function debugLocation() {
    const normalized = locationId.trim();
    if (!normalized) {
      setError("Please enter a location ID first.");
      return;
    }
    const normalizedToken = accessToken.trim();
    if (!normalizedToken) {
      setError("Please enter an access token first.");
      return;
    }

    const url = `${apiBaseUrl}/debug/location/${encodeURIComponent(normalized)}`;
    setLoading(true);
    setError(null);
    try {
      const response = await fetch(url, {
        headers: {
          "x-ghl-access-token": normalizedToken
        }
      });
      const responseText = await response.text();
      setLocationDebugResponse(responseText);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <section>
      <div className="panel" style={{ padding: 20, marginBottom: 16 }}>
        <p className="eyebrow">Debug tools</p>
        <h2 style={{ marginTop: 8 }}>GET /debug/location/:id</h2>
        <div className="toolbar">
          <input
            aria-label="GoHighLevel location ID"
            placeholder="GHL locationId or UUID"
            value={locationId}
            onChange={(event) => setLocationId(event.target.value)}
          />
          <input
            aria-label="GoHighLevel access token"
            placeholder="GHL access token"
            type="password"
            value={accessToken}
            onChange={(event) => setAccessToken(event.target.value)}
          />
          <button className="button secondary" disabled={loading} onClick={debugLocation}>
            GET /debug/location/:id
          </button>
        </div>
        {error ? <p className="muted">{error}</p> : null}
      </div>

      <div className="panel" style={{ padding: 20 }}>
        <h3>Response: /debug/location/:id</h3>
        <pre className="debug-json">{locationDebugResponse}</pre>
      </div>
    </section>
  );
}
