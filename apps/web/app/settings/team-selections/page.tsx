"use client";

import type { SubaccountOverview } from "@agentflow/shared";
import { getApiBaseUrl } from "../../../lib/api-base-url";
import { mergeWorkspaceHeaders } from "../../../lib/workspace-api-headers";
import { useWorkspaceAuth } from "../../components/workspace-auth-provider";
import { useEffect, useMemo, useState } from "react";

type MatrixUserRow = {
  workspaceUserId: string;
  email: string | null;
  displayName: string | null;
  role: string;
  ghlUserId: string | null;
  selectionMode: string;
  locationIds: string[] | null;
};

type SelectionsByLocationRow = {
  locationId: string;
  workspaceUserIds: string[];
};

type MatrixPayload = {
  users: MatrixUserRow[];
  selectionsByLocation: SelectionsByLocationRow[];
  disclaimer: string | null;
};

function personLabel(row: Pick<MatrixUserRow, "displayName" | "email" | "ghlUserId" | "workspaceUserId">) {
  return (
    row.displayName?.trim() ||
    row.email?.trim() ||
    row.ghlUserId?.trim() ||
    `${row.workspaceUserId.slice(0, 8)}…`
  );
}

export default function TeamSelectionsPage() {
  const apiBaseUrl = getApiBaseUrl();
  const { hydrated, token, sessionKey } = useWorkspaceAuth();
  const [matrix, setMatrix] = useState<MatrixPayload | null>(null);
  const [locations, setLocations] = useState<SubaccountOverview[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hydrated || !token) {
      setMatrix(null);
      setLocations([]);
      setLoading(false);
      setError(
        hydrated && !token
          ? "Sign in to view the team selection matrix."
          : null
      );
      return;
    }

    const controller = new AbortController();

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const [matrixRes, overviewRes] = await Promise.all([
          fetch(`${apiBaseUrl}/workspace/selection-matrix`, {
            signal: controller.signal,
            headers: mergeWorkspaceHeaders()
          }),
          fetch(`${apiBaseUrl}/subaccounts/overview?surface=all`, {
            signal: controller.signal,
            headers: mergeWorkspaceHeaders()
          })
        ]);

        if (!matrixRes.ok) {
          const payload = (await matrixRes.json().catch(() => ({}))) as { error?: string };
          throw new Error(payload.error ?? "Failed to load selection matrix");
        }
        if (!overviewRes.ok) {
          throw new Error("Failed to load subaccounts overview");
        }

        const matrixPayload = (await matrixRes.json()) as MatrixPayload;
        const overviewPayload = (await overviewRes.json()) as { subaccounts: SubaccountOverview[] };

        setMatrix(matrixPayload);
        setLocations(overviewPayload.subaccounts ?? []);
      } catch (caught) {
        if (!controller.signal.aborted) {
          setMatrix(null);
          setLocations([]);
          setError(caught instanceof Error ? caught.message : "Failed to load");
        }
      } finally {
        if (!controller.signal.aborted) {
          setLoading(false);
        }
      }
    }

    void load();
    return () => controller.abort();
  }, [apiBaseUrl, hydrated, token, sessionKey]);

  const locMetaById = useMemo(() => {
    const map = new Map<string, { ghlLocationId: string; label: string }>();
    for (const l of locations) {
      map.set(l.locationId, {
        ghlLocationId: l.ghlLocationId,
        label: l.locationName ? `${l.locationName} (${l.ghlLocationId})` : l.ghlLocationId
      });
    }
    return map;
  }, [locations]);

  const userById = useMemo(() => {
    const m = new Map<string, MatrixUserRow>();
    matrix?.users.forEach((u) => m.set(u.workspaceUserId, u));
    return m;
  }, [matrix?.users]);

  return (
    <>
      <div className="panel" style={{ padding: 18 }}>
        <p className="eyebrow">Workspace</p>
        <h2 style={{ marginTop: 8 }}>Subaccount selection matrix</h2>
        <p className="muted">
          Read-only view for the whole team: who has explicit lists and who is in “all locations” mode until they save a
          first selection from Subaccounts.
        </p>
        {!token && hydrated ? (
          <p className="muted" style={{ marginTop: 10 }}>
            Sign in to continue.
          </p>
        ) : null}
      </div>

      <div className="panel" style={{ padding: 18, marginTop: 12 }}>
        {loading ? <p className="muted">Loading…</p> : null}
        {error ? <div className="empty">{error}</div> : null}

        {!loading && matrix?.disclaimer ? (
          <p className="muted" style={{ marginBottom: 16 }}>
            {matrix.disclaimer}
          </p>
        ) : null}

        {!loading && !error && matrix ? (
          <>
            <h3 style={{ marginTop: 0 }}>By user</h3>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                <thead>
                  <tr>
                    <th style={{ textAlign: "left", padding: "8px 6px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                      Who
                    </th>
                    <th style={{ textAlign: "left", padding: "8px 6px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                      Role
                    </th>
                    <th style={{ textAlign: "left", padding: "8px 6px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                      Mode
                    </th>
                    <th style={{ textAlign: "left", padding: "8px 6px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                      Selected (UUIDs)
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {matrix.users.map((u) => (
                    <tr key={u.workspaceUserId}>
                      <td style={{ padding: "10px 6px", verticalAlign: "top" }}>
                        <div>{personLabel(u)}</div>
                        {u.email ? (
                          <div className="muted" style={{ fontSize: 12 }}>
                            {u.email}
                          </div>
                        ) : null}
                        {u.ghlUserId ? (
                          <div className="muted" style={{ fontSize: 12 }}>
                            GHL user id: {u.ghlUserId}
                          </div>
                        ) : null}
                      </td>
                      <td style={{ padding: "10px 6px", verticalAlign: "top" }}>
                        <code>{u.role}</code>
                      </td>
                      <td style={{ padding: "10px 6px", verticalAlign: "top" }}>
                        <code>{u.selectionMode}</code>
                      </td>
                      <td style={{ padding: "10px 6px", verticalAlign: "top", wordBreak: "break-all", maxWidth: 480 }}>
                        {u.selectionMode === "all_locations"
                          ? "(all locations — no DB rows until the next explicit PUT)"
                          : u.locationIds?.join(", ") ?? "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h3 style={{ marginTop: 28 }}>By location (saved rows only)</h3>
            <p className="muted" style={{ marginTop: 6 }}>
              Only locations where at least one person has an explicit selection appear here; users still in “all
              locations” mode are omitted until they save a concrete list.
            </p>
            {matrix.selectionsByLocation.length === 0 ? (
              <p className="muted" style={{ marginTop: 8 }}>
                No explicit selections saved yet — everyone still has broad default behavior.
              </p>
            ) : (
              <div style={{ overflowX: "auto", marginTop: 12 }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 14 }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", padding: "8px 6px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                        Location
                      </th>
                      <th style={{ textAlign: "left", padding: "8px 6px", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                        Users
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {matrix.selectionsByLocation.map((row) => {
                      const meta = locMetaById.get(row.locationId);
                      return (
                        <tr key={row.locationId}>
                          <td style={{ padding: "10px 6px", verticalAlign: "top" }}>
                            <div>{meta?.label ?? row.locationId}</div>
                          </td>
                          <td style={{ padding: "10px 6px", verticalAlign: "top" }}>
                            <ul style={{ margin: 0, paddingInlineStart: 18 }}>
                              {row.workspaceUserIds.map((id) => {
                                const usr = userById.get(id);
                                return (
                                  <li key={id}>
                                    {usr ? (
                                      <>
                                        {personLabel(usr)}{" "}
                                        <span className="muted" style={{ fontSize: 12 }}>
                                          ({usr.role})
                                        </span>
                                      </>
                                    ) : (
                                      `${id.slice(0, 8)}…`
                                    )}
                                  </li>
                                );
                              })}
                            </ul>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : null}
      </div>
    </>
  );
}
