"use client";

import { WORKSPACE_AUDIT_ACTION_OPTIONS } from "@agentflow/shared";
import { getApiBaseUrl } from "../../../../lib/api-base-url";
import { mergeWorkspaceHeaders } from "../../../../lib/workspace-api-headers";
import { formatLocationName } from "../../../../lib/location-display";
import { useWorkspaceAuth } from "../../../components/workspace-auth-provider";
import { useGuardedNavigate } from "../../../components/navigation-guard-provider";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type AuditLogRow = {
  id: string;
  createdAt: string;
  actionKind: string;
  entityType: string | null;
  entityId: string | null;
  locationId: string | null;
  summary: string;
  details: Record<string, unknown>;
  actorWorkspaceUserId: string | null;
  actorEmail: string | null;
  actorDisplayName: string | null;
};

type LogsPayload = {
  from?: string;
  to?: string;
  retentionDays?: number;
  logs?: AuditLogRow[];
  error?: string;
};

function startOfUtcDay(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function isoDateInputFromMs(ms: number) {
  const d = new Date(ms);
  return d.toISOString().slice(0, 10);
}

export default function WorkspaceAuditLogsPage() {
  const apiBaseUrl = getApiBaseUrl();
  const { replaceGuarded } = useGuardedNavigate();
  const { user, hydrated, sessionKey } = useWorkspaceAuth();

  const nowMs = Date.now();

  const [fromDate, setFromDate] = useState(() =>
    isoDateInputFromMs(startOfUtcDay(new Date(nowMs - 7 * 86400000)).getTime())
  );
  const [toDate, setToDate] = useState(() => isoDateInputFromMs(startOfUtcDay(new Date(nowMs)).getTime()));
  const [actionKind, setActionKind] = useState("");
  const [locationId, setLocationId] = useState("");
  const [actorId, setActorId] = useState("");
  const [limit, setLimit] = useState(80);

  const [locations, setLocations] = useState<{ locationId: string; ghlLocationId: string; name: string | null }[]>([]);
  const [users, setUsers] = useState<{ id: string; email: string | null; displayName: string | null }[]>([]);
  const [logs, setLogs] = useState<AuditLogRow[]>([]);
  const [meta, setMeta] = useState<{ from: string; to: string; retentionDays?: number } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    if (user?.role !== "admin") {
      void replaceGuarded("/settings");
    }
  }, [hydrated, replaceGuarded, user?.role]);

  useEffect(() => {
    let cancelled = false;

    async function loadFiltersCatalog() {
      try {
        const [locRes, userRes] = await Promise.all([
          fetch(`${apiBaseUrl}/admin/workspace-locations`, { headers: mergeWorkspaceHeaders() }),
          fetch(`${apiBaseUrl}/admin/workspace-users`, { headers: mergeWorkspaceHeaders() })
        ]);
        const locPayload = (await locRes.json().catch(() => ({}))) as {
          locations?: { locationId: string; ghlLocationId: string; name: string | null }[];
        };
        const userPayload = (await userRes.json().catch(() => ({}))) as {
          users?: { id: string; email: string | null; displayName: string | null }[];
        };
        if (!cancelled) {
          setLocations(locPayload.locations ?? []);
          setUsers(userPayload.users ?? []);
        }
      } catch {
        if (!cancelled) {
          setLocations([]);
          setUsers([]);
        }
      }
    }

    void loadFiltersCatalog();
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, sessionKey]);

  const filtersRef = useRef({
    fromDate,
    toDate,
    actionKind,
    locationId,
    actorId,
    limit
  });
  filtersRef.current = { fromDate, toDate, actionKind, locationId, actorId, limit };

  const runQuery = useCallback(async () => {
    if (!hydrated || user?.role !== "admin") {
      return;
    }
    const f = filtersRef.current;
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("from", `${f.fromDate}T00:00:00.000Z`);
      params.set("to", `${f.toDate}T23:59:59.999Z`);
      params.set("limit", String(f.limit));
      if (f.actionKind.trim()) {
        params.set("actionKind", f.actionKind.trim());
      }
      if (f.locationId.trim()) {
        params.set("locationId", f.locationId.trim());
      }
      if (f.actorId.trim()) {
        params.set("actorWorkspaceUserId", f.actorId.trim());
      }

      const res = await fetch(`${apiBaseUrl}/admin/workspace-audit-logs?${params.toString()}`, {
        headers: mergeWorkspaceHeaders(),
        cache: "no-store"
      });
      const payload = (await res.json()) as LogsPayload;
      if (!res.ok) {
        throw new Error(payload.error ?? "Unable to load logs");
      }
      setLogs(payload.logs ?? []);
      setMeta(
        payload.from && payload.to
          ? { from: payload.from, to: payload.to, retentionDays: payload.retentionDays }
          : null
      );
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to load logs");
      setLogs([]);
      setMeta(null);
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl, hydrated, user?.role]);

  useEffect(() => {
    if (!hydrated || user?.role !== "admin") {
      return;
    }
    void runQuery();
  }, [hydrated, user?.role, sessionKey, runQuery]);

  const applyPresetDays = useCallback(
    (days: number) => {
      const end = startOfUtcDay(new Date());
      const start = startOfUtcDay(new Date(Date.now() - days * 86400000));
      const nextFrom = isoDateInputFromMs(start.getTime());
      const nextTo = isoDateInputFromMs(end.getTime());
      setFromDate(nextFrom);
      setToDate(nextTo);
      queueMicrotask(() => void runQuery());
    },
    [runQuery]
  );

  const sortedUsers = useMemo(() => {
    return [...users].sort((a, b) =>
      String(a.email ?? a.displayName ?? a.id).localeCompare(String(b.email ?? b.displayName ?? b.id))
    );
  }, [users]);

  return (
    <>
      <div className="panel" style={{ padding: 18 }}>
        <p className="eyebrow">Workspace</p>
        <h2 style={{ marginTop: 8 }}>Activity logs</h2>
        <p className="muted">
          Audit trail for appointment overrides and workspace administration. Records older than retention are pruned
          automatically (default 90 days).
        </p>
        {meta?.retentionDays != null ? (
          <p className="muted" style={{ marginTop: 10 }}>
            Retention policy:{" "}
            <strong>{meta.retentionDays}</strong> days · effective window {new Date(meta.from).toLocaleString()} —{" "}
            {new Date(meta.to).toLocaleString()}
          </p>
        ) : null}
      </div>

      <div className="panel" style={{ padding: 18, marginTop: 12 }}>
        <h3 style={{ marginTop: 0 }}>Filters</h3>
        <div className="toolbar" style={{ alignItems: "flex-end", flexWrap: "wrap", gap: 12, marginBottom: 12 }}>
          <div style={{ display: "grid", gap: 6 }}>
            <label className="inbox-field-label" htmlFor="log-from">
              From
            </label>
            <input
              id="log-from"
              onChange={(e) => setFromDate(e.target.value)}
              style={{ padding: "6px 10px" }}
              type="date"
              value={fromDate}
            />
          </div>
          <div style={{ display: "grid", gap: 6 }}>
            <label className="inbox-field-label" htmlFor="log-to">
              To
            </label>
            <input
              id="log-to"
              onChange={(e) => setToDate(e.target.value)}
              style={{ padding: "6px 10px" }}
              type="date"
              value={toDate}
            />
          </div>
          <div style={{ display: "grid", gap: 6, minWidth: 200 }}>
            <label className="inbox-field-label" htmlFor="log-action">
              Event type
            </label>
            <select className="appointments-filter-select" id="log-action" style={{ padding: "6px 10px" }} value={actionKind} onChange={(e) => setActionKind(e.target.value)}>
              <option value="">All kinds</option>
              {WORKSPACE_AUDIT_ACTION_OPTIONS.map((kind) => (
                <option key={kind} value={kind}>
                  {kind}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: "grid", gap: 6, flex: "1 1 200px", minWidth: 220 }}>
            <label className="inbox-field-label" htmlFor="log-loc">
              Subaccount
            </label>
            <select className="appointments-filter-select" id="log-loc" style={{ padding: "6px 10px" }} value={locationId} onChange={(e) => setLocationId(e.target.value)}>
              <option value="">All subaccounts</option>
              {locations.map((loc) => (
                <option key={loc.locationId} value={loc.locationId}>
                  {formatLocationName(loc.name, loc.ghlLocationId)}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: "grid", gap: 6, flex: "1 1 220px", minWidth: 220 }}>
            <label className="inbox-field-label" htmlFor="log-person">
              Person
            </label>
            <select className="appointments-filter-select" id="log-person" style={{ padding: "6px 10px" }} value={actorId} onChange={(e) => setActorId(e.target.value)}>
              <option value="">Anyone</option>
              {sortedUsers.map((u) => (
                <option key={u.id} value={u.id}>
                  {(u.email ?? u.displayName ?? `${u.id.slice(0, 8)}…`) + ""}
                </option>
              ))}
            </select>
          </div>
          <div style={{ display: "grid", gap: 6, width: 100 }}>
            <label className="inbox-field-label" htmlFor="log-limit">
              Limit
            </label>
            <input
              id="log-limit"
              min={1}
              max={500}
              onChange={(e) => setLimit(Number.parseInt(e.target.value, 10) || 80)}
              style={{ padding: "6px 10px", width: 100 }}
              type="number"
              value={limit}
            />
          </div>
          <button className="button" disabled={loading} onClick={() => void runQuery()} type="button">
            {loading ? "Loading…" : "Apply"}
          </button>
        </div>
        <div className="toolbar" style={{ gap: 8, marginBottom: 12 }}>
          <span className="muted" style={{ fontSize: 12 }}>
            Quick ranges (UTC calendar days):
          </span>
          <button className="button secondary" onClick={() => applyPresetDays(7)} type="button">
            Last 7 days
          </button>
          <button className="button secondary" onClick={() => applyPresetDays(30)} type="button">
            Last 30 days
          </button>
          <button className="button secondary" onClick={() => applyPresetDays(90)} type="button">
            Last 90 days
          </button>
        </div>

        {error ? <div className="empty">{error}</div> : null}
        {loading && !error ? <p className="muted">Loading…</p> : null}

        {!loading && logs.length === 0 && !error ? (
          <p className="muted">No log entries in this window.</p>
        ) : null}

        {!loading && logs.length > 0 ? (
          <div style={{ display: "grid", gap: 12 }}>
            {logs.map((row) => (
              <article className="panel" key={row.id} style={{ border: "1px solid var(--border)", padding: 14 }}>
                <div style={{ alignItems: "baseline", display: "flex", flexWrap: "wrap", gap: 10, justifyContent: "space-between" }}>
                  <strong>{row.actionKind}</strong>
                  <span className="muted" style={{ fontSize: 12 }}>
                    {new Date(row.createdAt).toLocaleString()}
                  </span>
                </div>
                <p style={{ margin: "8px 0 4px 0" }}>{row.summary}</p>
                <p className="muted" style={{ fontSize: 12, marginBottom: 6 }}>
                  Actor:{" "}
                  {row.actorEmail ?? row.actorDisplayName ?? row.actorWorkspaceUserId ?? "System / viewer key"}
                </p>
                {row.locationId ? (
                  <p className="muted" style={{ fontSize: 12 }}>
                    Subaccount UUID: {row.locationId}
                  </p>
                ) : null}
                {Object.keys(row.details ?? {}).length > 0 ? (
                  <pre
                    style={{
                      background: "var(--panel-soft)",
                      borderRadius: 10,
                      fontSize: 11,
                      maxHeight: 200,
                      overflow: "auto",
                      padding: 10,
                      whiteSpace: "pre-wrap"
                    }}
                  >
                    {JSON.stringify(row.details, null, 2)}
                  </pre>
                ) : null}
              </article>
            ))}
          </div>
        ) : null}
      </div>
    </>
  );
}
