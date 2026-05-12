"use client";

import Link from "next/link";
import { useMemo, useState } from "react";

const defaultApiBaseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "";

const sampleWebhookPayload = JSON.stringify(
  {
    type: "InboundMessage",
    channel: "sms",
    direction: "inbound",
    companyId: "demo-agency",
    locationId: "demo-location",
    contactId: "demo-contact",
    messageId: "demo-message",
    body: "Hola, este es un webhook de prueba",
    dateAdded: new Date().toISOString()
  },
  null,
  2
);

export default function HomePage() {
  const [apiBaseUrl, setApiBaseUrl] = useState(defaultApiBaseUrl);
  const [healthResult, setHealthResult] = useState<string | null>(null);
  const [webhookBody, setWebhookBody] = useState(sampleWebhookPayload);
  const [webhookResult, setWebhookResult] = useState<string | null>(null);
  const [webhookLoading, setWebhookLoading] = useState(false);
  const normalizedApiBase = useMemo(() => apiBaseUrl.trim().replace(/\/$/, ""), [apiBaseUrl]);
  const oauthStartUrl = normalizedApiBase
    ? `${normalizedApiBase}/oauth/gohighlevel/start`
    : "";

  async function checkHealth() {
    if (!normalizedApiBase) {
      setHealthResult("Definí NEXT_PUBLIC_API_BASE_URL o completá API Base URL.");
      return;
    }

    setHealthResult("Consultando /health...");
    try {
      const response = await fetch(`${normalizedApiBase}/health`);
      const body = await response.text();
      setHealthResult(`Status ${response.status}: ${body}`);
    } catch (error) {
      setHealthResult(error instanceof Error ? error.message : "Health check failed");
    }
  }

  async function sendWebhookTest() {
    if (!normalizedApiBase) {
      setWebhookResult("Definí NEXT_PUBLIC_API_BASE_URL o completá API Base URL.");
      return;
    }

    setWebhookLoading(true);
    setWebhookResult("Enviando webhook...");
    try {
      const response = await fetch(`${normalizedApiBase}/webhooks/gohighlevel`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-ghl-idempotency-key": `web-ui-${Date.now()}`
        },
        body: webhookBody
      });
      const body = await response.text();
      setWebhookResult(`Status ${response.status}: ${body}`);
    } catch (error) {
      setWebhookResult(error instanceof Error ? error.message : "Webhook test failed");
    } finally {
      setWebhookLoading(false);
    }
  }

  return (
    <section className="panel" style={{ padding: 32 }}>
      <p className="eyebrow">MVP foundation</p>
      <h2>Test rápido de cuenta y webhooks para AgentFlow.</h2>
      <p className="muted">
        Usá este panel para conectar una cuenta GoHighLevel por OAuth, validar
        salud del API y disparar un webhook de prueba antes de mejorar la UI.
      </p>

      <div className="badge-row" style={{ margin: "20px 0" }}>
        <span className="badge">SMS</span>
        <span className="badge">Email</span>
        <span className="badge">Calls excluded</span>
        <span className="badge">OAuth + Webhook smoke test</span>
      </div>

      <div className="toolbar">
        <input
          aria-label="API base URL"
          placeholder="https://api.agentflow.autowiz.net"
          value={apiBaseUrl}
          onChange={(event) => setApiBaseUrl(event.target.value)}
        />
        <button className="button secondary" onClick={checkHealth}>
          Check /health
        </button>
        <Link className="button" href="/threads">
          Open pending replies
        </Link>
      </div>

      <div className="panel quick-test-card">
        <p className="eyebrow">Paso 1 · Cargar cuenta (OAuth)</p>
        <p className="muted">
          Endpoint de conexión:
          {" "}
          <code>{oauthStartUrl || "{API_BASE_URL}/oauth/gohighlevel/start"}</code>
        </p>
        {oauthStartUrl ? (
          <a className="button" href={oauthStartUrl}>
            Conectar cuenta GHL
          </a>
        ) : (
          <span className="muted">Completá API Base URL para habilitar el botón.</span>
        )}
      </div>

      <div className="panel quick-test-card">
        <p className="eyebrow">Paso 2 · Webhook de prueba</p>
        <p className="muted">
          Si el backend tiene `ALLOW_UNSIGNED_GHL_WEBHOOKS=false`, este test debe
          responder `401` o `500` (esperado en producción hardenizada).
        </p>
        <textarea
          aria-label="Webhook payload JSON"
          className="json-input"
          value={webhookBody}
          onChange={(event) => setWebhookBody(event.target.value)}
        />
        <button className="button secondary" disabled={webhookLoading} onClick={sendWebhookTest}>
          {webhookLoading ? "Enviando..." : "Enviar webhook de prueba"}
        </button>
      </div>

      <div className="panel quick-test-card">
        <p className="eyebrow">Resultados</p>
        <p className="muted"><strong>/health:</strong> {healthResult ?? "Sin ejecutar"}</p>
        <p className="muted"><strong>/webhooks:</strong> {webhookResult ?? "Sin ejecutar"}</p>
      </div>
    </section>
  );
}
