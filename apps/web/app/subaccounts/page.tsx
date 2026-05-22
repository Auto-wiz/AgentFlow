"use client";

import type { SubaccountOverview } from "@agentflow/shared";
import { getApiBaseUrl } from "../../lib/api-base-url";
import { formatLocationName } from "../../lib/location-display";
import { mergeWorkspaceHeaders } from "../../lib/workspace-api-headers";
import { useWorkspaceAuth } from "../components/workspace-auth-provider";
import { useRegisterDraftNavigationGuard } from "../components/navigation-guard-provider";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type MatrixUserRow = {
  workspaceUserId: string;
  email: string | null;
  displayName: string | null;
  role: string;
  ghlUserId: string | null;
  selectionMode: string;
  locationIds: string[] | null;
};

type MatrixPayload = {
  users: MatrixUserRow[];
  selectionsByLocation: Array<{ locationId: string; workspaceUserIds: string[] }>;
  disclaimer: string | null;
};

function cloneRows(rows: SubaccountOverview[]): SubaccountOverview[] {
  return JSON.parse(JSON.stringify(rows)) as SubaccountOverview[];
}

function selectionFingerprint(rows: SubaccountOverview[]): string {
  return rows
    .filter((r) => r.visible)
    .map((r) => r.locationId)
    .sort()
    .join("|");
}

function personLabel(row: Pick<MatrixUserRow, "displayName" | "email" | "ghlUserId" | "workspaceUserId">) {
  return (
    row.displayName?.trim() ||
    row.email?.trim() ||
    row.ghlUserId?.trim() ||
    `${row.workspaceUserId.slice(0, 8)}…`
  );
}

function userTracksLocation(user: MatrixUserRow, workspaceLocationUuid: string): boolean {
  if (user.selectionMode === "all_locations") {
    return true;
  }
  return Boolean(user.locationIds?.includes(workspaceLocationUuid));
}

function workspaceUsersSortedForFilters(matrix: MatrixPayload): MatrixUserRow[] {
  return [...matrix.users].sort((a, b) => personLabel(a).localeCompare(personLabel(b), undefined, { sensitivity: "base" }));
}

/** Users explicitly or implicitly tied to this workspace location UUID (dashboard selection). */
function linkedWorkspaceUsers(matrix: MatrixPayload, workspaceLocationUuid: string): MatrixUserRow[] {
  return matrix.users.filter((u) => userTracksLocation(u, workspaceLocationUuid));
}

/** Short line for cards: chips optional; admins included but sorted last in label list. */
function formatLinkedUsersLine(matrix: MatrixPayload | null, workspaceLocationUuid: string): string | null {
  if (!matrix) {
    return null;
  }
  const linked = linkedWorkspaceUsers(matrix, workspaceLocationUuid);
  if (linked.length === 0) {
    return null;
  }
  const admins = linked.filter((u) => u.role === "admin");
  const members = linked.filter((u) => u.role !== "admin");
  const ordered = [...members.sort((a, b) => personLabel(a).localeCompare(personLabel(b))), ...admins.sort((a, b) => personLabel(a).localeCompare(personLabel(b)))];
  const labels = ordered.map(personLabel);
  const maxShown = 3;
  const head = labels.slice(0, maxShown).join(", ");
  const rest = labels.length - maxShown;
  return rest > 0 ? `${head} +${rest} more` : head;
}

function buildLegacyVisibilityDiff(base: SubaccountOverview[], draft: SubaccountOverview[]) {
  const baseVis = new Map(base.map((r) => [r.locationId, r.visible]));
  return draft.filter((r) => baseVis.get(r.locationId) !== r.visible).map((r) => ({
    locationId: r.locationId,
    visible: r.visible
  }));
}

export default function SubaccountsPage() {
  const apiBaseUrl = getApiBaseUrl();
  const { hydrated, token, sessionKey } = useWorkspaceAuth();
  const [matrix, setMatrix] = useState<MatrixPayload | null>(null);
  const [baseline, setBaseline] = useState<SubaccountOverview[]>([]);
  const [draft, setDraft] = useState<SubaccountOverview[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterWorkspaceUserId, setFilterWorkspaceUserId] = useState("");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const dirtyRef = useRef(false);

  const dirty = useMemo(
    () => selectionFingerprint(draft) !== selectionFingerprint(baseline),
    [baseline, draft]
  );
  dirtyRef.current = dirty;

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [overviewRes, matrixRes] = await Promise.all([
        fetch(`${apiBaseUrl}/subaccounts/overview?surface=all`, {
          headers: mergeWorkspaceHeaders()
        }),
        fetch(`${apiBaseUrl}/workspace/selection-matrix`, {
          headers: mergeWorkspaceHeaders()
        })
      ]);

      if (!overviewRes.ok) {
        throw new Error("Failed to load subaccounts");
      }
      const overviewPayload = (await overviewRes.json()) as { subaccounts: SubaccountOverview[] };
      const rows = overviewPayload.subaccounts ?? [];
      const nextBaseline = cloneRows(rows);
      setBaseline(nextBaseline);
      setDraft(cloneRows(rows));

      if (matrixRes.ok) {
        setMatrix((await matrixRes.json()) as MatrixPayload);
      } else {
        setMatrix(null);
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to load subaccounts");
      setBaseline([]);
      setDraft([]);
      setMatrix(null);
    } finally {
      setLoading(false);
    }
  }, [apiBaseUrl]);

  useEffect(() => {
    if (!hydrated || !token) {
      setMatrix(null);
      setBaseline([]);
      setDraft([]);
      setLoading(false);
      setError(hydrated && !token ? "Sign in to manage subaccounts." : null);
      return;
    }
    void loadAll();
  }, [hydrated, token, sessionKey, loadAll]);

  const rowsAfterUserFilter = useMemo(() => {
    if (!matrix || !filterWorkspaceUserId) {
      return draft;
    }
    const userRow = matrix.users.find((u) => u.workspaceUserId === filterWorkspaceUserId);
    if (!userRow) {
      return draft;
    }
    return draft.filter((row) => userTracksLocation(userRow, row.locationId));
  }, [draft, filterWorkspaceUserId, matrix]);

  const filteredForDisplay = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) {
      return rowsAfterUserFilter;
    }
    return rowsAfterUserFilter.filter((subaccount) => {
      const name = typeof subaccount.locationName === "string" ? subaccount.locationName.trim().toLowerCase() : "";
      return (
        subaccount.ghlLocationId.toLowerCase().includes(q) ||
        (name.length > 0 && name.includes(q))
      );
    });
  }, [rowsAfterUserFilter, searchQuery]);

  const allFilteredTracked = filteredForDisplay.length > 0 && filteredForDisplay.every((r) => r.visible);

  function toggleDraftVisibility(locationId: string, visible: boolean) {
    setDraft((prev) => prev.map((r) => (r.locationId === locationId ? { ...r, visible } : r)));
  }

  function toggleVisibleForFilteredRows() {
    if (filteredForDisplay.length === 0) {
      return;
    }
    const ids = new Set(filteredForDisplay.map((r) => r.locationId));
    const nextChecked = !allFilteredTracked;
    setDraft((prev) => prev.map((r) => (ids.has(r.locationId) ? { ...r, visible: nextChecked } : r)));
  }

  async function persistSelections(): Promise<boolean> {
    if (saving) {
      return false;
    }
    if (!dirty) {
      return true;
    }

    const locationIds = draft.filter((r) => r.visible).map((r) => r.locationId);
    setSaving(true);
    setError(null);

    try {
      const jwtResponse = await fetch(`${apiBaseUrl}/workspace/me/location-selections`, {
        method: "PUT",
        headers: mergeWorkspaceHeaders({
          "Content-Type": "application/json"
        }),
        body: JSON.stringify({ locationIds })
      });

      if (jwtResponse.ok) {
        const refreshed = await fetch(`${apiBaseUrl}/subaccounts/overview?surface=all`, {
          headers: mergeWorkspaceHeaders()
        });
        if (!refreshed.ok) {
          throw new Error("Saved, but failed to reload the list");
        }
        const data = (await refreshed.json()) as { subaccounts: SubaccountOverview[] };
        const next = cloneRows(data.subaccounts ?? []);
        setBaseline(next);
        setDraft(next);
        return true;
      }

      if (jwtResponse.status !== 401) {
        const payload = (await jwtResponse.json().catch(() => ({}))) as { error?: string };
        throw new Error(payload.error ?? "Failed to save selections");
      }

      const diff = buildLegacyVisibilityDiff(baseline, draft);
      for (const item of diff) {
        const legacyResponse = await fetch(`${apiBaseUrl}/subaccounts/visibility`, {
          method: "POST",
          headers: mergeWorkspaceHeaders({
            "Content-Type": "application/json"
          }),
          body: JSON.stringify({
            locationId: item.locationId,
            visible: item.visible
          })
        });

        if (!legacyResponse.ok) {
          const payload = (await legacyResponse.json().catch(() => ({}))) as { error?: string };
          if (payload.error === "forbidden_legacy_only") {
            throw new Error("Sign in with workspace credentials to save selections.");
          }
          throw new Error("Failed to save visibility (legacy mode)");
        }
      }

      const refreshedLegacy = await fetch(`${apiBaseUrl}/subaccounts/overview?surface=all`, {
        headers: mergeWorkspaceHeaders()
      });
      if (!refreshedLegacy.ok) {
        throw new Error("Saved (legacy), but failed to reload the list");
      }
      const dataLegacy = (await refreshedLegacy.json()) as { subaccounts: SubaccountOverview[] };
      const merged = cloneRows(dataLegacy.subaccounts ?? []);
      setBaseline(merged);
      setDraft(merged);
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to save");
      return false;
    } finally {
      setSaving(false);
    }
  }

  useRegisterDraftNavigationGuard("subaccounts-tracking", {
    isDirty: () => dirtyRef.current,
    persist: persistSelections
  });

  function revertDraft() {
    if (!dirty) {
      return;
    }
    const ok = window.confirm(
      "Discard all unsaved subaccount visibility changes?"
    );
    if (!ok) {
      return;
    }
    setDraft(cloneRows(baseline));
  }

  const filterUserOptions = useMemo(() => (matrix ? workspaceUsersSortedForFilters(matrix) : []), [matrix]);

  const layoutSketch = `
┌ Card-style row (current list) ────────────────────┐
│ Bold · location display name                         │
│ Muted · GoHighLevel Location ID                      │
│ Muted · N appointments                               │
│ Muted smaller · Workspace users: Ana, Leo +3        │ ← new line
└────────────────────────────────────────────────────────┘
Toolbar above list:
  [ Search ] [ User ▼ ] | [ Toggle visible in current list ] [ Revert ] [ Save ]
`;

  return (
    <section className="module-shell">
      <div className="panel" style={{ padding: 18 }}>
        <p className="eyebrow">Management module</p>
        <h2 style={{ marginTop: 8 }}>Subaccounts tracking</h2>
        <p className="muted">
          Checkbox changes stay in memory until you save. Saving replaces the location list that powers workspace filters
          (or the legacy viewer mapping when JWT is unavailable). The user filter mirrors each teammate&apos;s dashboard
          picker (&quot;all locations&quot; until someone saves an explicit subset).
        </p>
      </div>

      <details className="panel" style={{ padding: "12px 18", marginBottom: 12 }}>
        <summary style={{ cursor: "pointer", fontWeight: 700 }}>Layout sketch: workspace users on each row</summary>
        <pre
          style={{
            marginTop: 10,
            fontSize: 12,
            lineHeight: 1.35,
            overflowX: "auto",
            whiteSpace: "pre"
          }}
        >
          {layoutSketch}
        </pre>
      </details>

      <div className="panel" style={{ padding: 18, marginBottom: 12 }}>
        <p className="eyebrow">Subaccounts</p>
        <h2 style={{ marginTop: 8 }}>Choose which subaccounts are tracked</h2>
        <div className="toolbar" style={{ marginBottom: 0 }}>
          <input
            aria-label="Search by name or GoHighLevel Location ID"
            placeholder="Search by name or GoHighLevel Location ID"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
            disabled={loading || saving}
          />
          {matrix ? (
            <select
              aria-label="Filter by workspace user"
              value={filterWorkspaceUserId}
              onChange={(event) => setFilterWorkspaceUserId(event.target.value)}
              disabled={loading || saving}
              style={{
                background: "var(--panel-soft)",
                border: "1px solid var(--border)",
                borderRadius: 999,
                color: "var(--foreground)",
                minWidth: 220,
                padding: "10px 14px"
              }}
            >
              <option value="">All workspace users</option>
              {filterUserOptions.map((user) => (
                <option key={user.workspaceUserId} value={user.workspaceUserId}>
                  {personLabel(user)}
                  {user.selectionMode === "all_locations" ? " (all locations)" : ""}
                  {user.role === "admin" ? " · admin" : ""}
                </option>
              ))}
            </select>
          ) : (
            <span className="muted" style={{ alignSelf: "center" }}>
              Workspace user filter requires a signed-in team session.
            </span>
          )}
          <button
            type="button"
            className="button secondary"
            onClick={toggleVisibleForFilteredRows}
            disabled={loading || saving || filteredForDisplay.length === 0}
          >
            {allFilteredTracked ? "Deselect all in current view" : "Select all in current view"}
          </button>
          <button type="button" className="button secondary" onClick={revertDraft} disabled={!dirty || loading || saving}>
            Revert
          </button>
          <button
            type="button"
            className="button"
            onClick={() => void persistSelections()}
            disabled={!dirty || loading || saving}
          >
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
        {matrix?.disclaimer ? <p className="muted">{matrix.disclaimer}</p> : null}
      </div>

      <div className="panel" style={{ padding: 18 }}>
        {loading ? <div className="empty muted">Loading subaccounts…</div> : null}
        {error ? <div className="empty">{error}</div> : null}
        {!loading && !error && filteredForDisplay.length === 0 ? (
          <div className="empty muted">No subaccounts match the current filters.</div>
        ) : null}
        <div className="subaccounts-config-list">
          {filteredForDisplay.map((subaccount) => {
            const linkedLine = formatLinkedUsersLine(matrix, subaccount.locationId);
            return (
              <label className="subaccount-config-row" key={subaccount.locationId}>
                <div>
                  <strong>{formatLocationName(subaccount.locationName, subaccount.ghlLocationId)}</strong>
                  <div className="muted">Location ID: {subaccount.ghlLocationId}</div>
                  <div className="muted">{subaccount.appointmentCount} appointments</div>
                  {linkedLine ? (
                    <div className="muted" style={{ fontSize: 12 }}>
                      Linked workspace users: {linkedLine}
                    </div>
                  ) : null}
                </div>
                <input
                  aria-label={`Track subaccount ${subaccount.ghlLocationId}`}
                  checked={subaccount.visible}
                  disabled={loading || saving}
                  onChange={(event) => toggleDraftVisibility(subaccount.locationId, event.target.checked)}
                  type="checkbox"
                />
              </label>
            );
          })}
        </div>
      </div>
    </section>
  );
}
