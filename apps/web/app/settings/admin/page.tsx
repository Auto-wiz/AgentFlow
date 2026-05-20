"use client";

import { getApiBaseUrl } from "../../../lib/api-base-url";
import { mergeWorkspaceHeaders } from "../../../lib/workspace-api-headers";
import { useWorkspaceAuth } from "../../components/workspace-auth-provider";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

type AdminUserRow = {
  id: string;
  email: string | null;
  displayName: string | null;
  role: string;
  ghlUserId?: string | null;
  createdAt?: string;
};

type LocationOption = {
  locationId: string;
  ghlLocationId: string;
  name: string | null;
  selected: boolean;
  implicitAll?: boolean;
};

export default function WorkspaceAdminSettingsPage() {
  const apiBaseUrl = getApiBaseUrl();
  const router = useRouter();
  const { user, hydrated, sessionKey } = useWorkspaceAuth();

  const [users, setUsers] = useState<AdminUserRow[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [loadingUsers, setLoadingUsers] = useState(true);

  const [selectedUserId, setSelectedUserId] = useState("");
  const [locations, setLocations] = useState<LocationOption[]>([]);
  const [locationsLoading, setLocationsLoading] = useState(false);
  const [locationsError, setLocationsError] = useState<string | null>(null);

  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const sortedUsers = useMemo(() => {
    return [...users].sort((a, b) => {
      const ka = (a.email ?? a.displayName ?? a.ghlUserId ?? a.id).toLowerCase();
      const kb = (b.email ?? b.displayName ?? b.ghlUserId ?? b.id).toLowerCase();
      return ka.localeCompare(kb);
    });
  }, [users]);

  const selectedUserRole = users.find((u) => u.id === selectedUserId)?.role ?? null;

  useEffect(() => {
    if (!hydrated) {
      return;
    }
    if (user?.role !== "admin") {
      router.replace("/settings");
    }
  }, [hydrated, router, user?.role]);

  useEffect(() => {
    let cancelled = false;

    async function loadUsers() {
      setLoadingUsers(true);
      setListError(null);
      try {
        const res = await fetch(`${apiBaseUrl}/admin/workspace-users`, {
          headers: mergeWorkspaceHeaders()
        });
        const payload = (await res.json().catch(() => ({}))) as { users?: AdminUserRow[]; error?: string };
        if (!res.ok) {
          throw new Error(payload.error ?? "Unable to load users");
        }
        if (!cancelled) {
          setUsers(payload.users ?? []);
        }
      } catch (caught) {
        if (!cancelled) {
          setListError(caught instanceof Error ? caught.message : "Unable to load users");
          setUsers([]);
        }
      } finally {
        if (!cancelled) {
          setLoadingUsers(false);
        }
      }
    }

    void loadUsers();
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, sessionKey]);

  useEffect(() => {
    let cancelled = false;
    async function loadSubaccountsSelection() {
      if (!selectedUserId) {
        setLocations([]);
        setDirty(false);
        return;
      }
      const target = users.find((u) => u.id === selectedUserId);
      if (target?.role === "admin") {
        setLocations([]);
        setDirty(false);
        return;
      }
      setLocationsLoading(true);
      setLocationsError(null);
      try {
        const res = await fetch(`${apiBaseUrl}/admin/workspace-users/${selectedUserId}/subaccounts`, {
          headers: mergeWorkspaceHeaders()
        });
        const payload = (await res.json().catch(() => ({}))) as {
          locations?: Array<{
            locationId: string;
            ghlLocationId: string;
            name: string | null;
            selected: boolean;
            implicitAll?: boolean;
          }>;
          error?: string;
        };
        if (!res.ok) {
          throw new Error(payload.error ?? "Unable to load subaccounts for user");
        }
        if (!cancelled) {
          setLocations(payload.locations ?? []);
          setDirty(false);
          setSaveError(null);
        }
      } catch (caught) {
        if (!cancelled) {
          setLocationsError(caught instanceof Error ? caught.message : "Unable to load subaccounts");
          setLocations([]);
        }
      } finally {
        if (!cancelled) {
          setLocationsLoading(false);
        }
      }
    }

    void loadSubaccountsSelection();
    return () => {
      cancelled = true;
    };
  }, [apiBaseUrl, selectedUserId, users]);

  function toggleLocation(locationId: string, checked: boolean) {
    setLocations((rows) =>
      rows.map((row) => (row.locationId === locationId ? { ...row, selected: checked } : row))
    );
    setDirty(true);
    setSaveError(null);
  }

  function selectAll(checked: boolean) {
    setLocations((rows) => rows.map((row) => ({ ...row, selected: checked })));
    setDirty(true);
    setSaveError(null);
  }

  async function saveSelection() {
    if (!selectedUserId || saving) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    const locationIds = locations.filter((l) => l.selected).map((l) => l.locationId);
    try {
      const res = await fetch(`${apiBaseUrl}/admin/workspace-users/${selectedUserId}/subaccounts`, {
        method: "PUT",
        headers: mergeWorkspaceHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ locationIds })
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        throw new Error(payload.error ?? "Save failed");
      }
      setDirty(false);
    } catch (caught) {
      setSaveError(caught instanceof Error ? caught.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const headerNote = useMemo(() => {
    if (!hydrated) {
      return "Loading workspace session…";
    }
    if (user?.role !== "admin") {
      return "You need admin access to use this panel.";
    }
    return null;
  }, [hydrated, user?.role]);

  return (
    <>
      <div className="panel" style={{ padding: 18 }}>
        <p className="eyebrow">Workspace</p>
        <h2 style={{ marginTop: 8 }}>User access</h2>
        <p className="muted">
          Los usuarios se crean cuando se autentican con GoHighLevel (provisionado desde OAuth). Acá sólo configurás cuáles subcuentas
          están habilitadas por defecto por usuario (<code className="muted">role=user</code>). El rol administrador sólo puede
          marcarse manualmente en la base de datos.
        </p>
        {headerNote ? <p className="muted" style={{ marginTop: 10 }}>{headerNote}</p> : null}
      </div>

      <div className="panel" style={{ padding: 18, marginTop: 12 }}>
        <h3 style={{ marginTop: 0 }}>Subaccount visibility by user</h3>
        <p className="muted">
          Applies to workspace users (`role=user`). Administrators are not constrained by this list.
        </p>

        {loadingUsers ? <p className="muted">Loading roster…</p> : null}
        {listError ? <div className="empty">{listError}</div> : null}

        {!loadingUsers && !listError ? (
          <div className="toolbar" style={{ marginTop: 12, gap: 10, alignItems: "center" }}>
            <label className="inbox-field-label" htmlFor="admin-user-picker">
              User
            </label>
            <select
              id="admin-user-picker"
              style={{ flex: "1 1 240px", minWidth: 200 }}
              value={selectedUserId}
              onChange={(event) => setSelectedUserId(event.target.value)}
            >
              <option value="">Select a workspace user…</option>
              {sortedUsers.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.email ?? u.displayName ?? u.ghlUserId ?? `${u.id.slice(0, 8)}…`} ({u.role})
                </option>
              ))}
            </select>
          </div>
        ) : null}

        {selectedUserId && selectedUserRole === "admin" ? (
          <p className="muted" style={{ marginTop: 16 }}>
            Administrators are not gated by explicit sub-account allowlists. Downgrade them to User if they should be limited,
            then assign rows here.
          </p>
        ) : null}

        {locationsLoading ? <p className="muted" style={{ marginTop: 14 }}>Loading locations…</p> : null}
        {locationsError ? <div className="empty" style={{ marginTop: 12 }}>{locationsError}</div> : null}

        {!locationsLoading &&
        !locationsError &&
        selectedUserId &&
        selectedUserRole !== "admin" &&
        locations.length > 0 ? (
          <div style={{ marginTop: 16 }}>
            <div className="toolbar" style={{ flexWrap: "wrap", gap: 10 }}>
              <button className="button secondary" disabled={user?.role !== "admin"} onClick={() => selectAll(true)} type="button">
                Select all
              </button>
              <button
                className="button secondary"
                disabled={user?.role !== "admin"}
                onClick={() => selectAll(false)}
                type="button"
              >
                Clear all
              </button>
              <button className="button" disabled={!dirty || saving || user?.role !== "admin"} onClick={() => void saveSelection()} type="button">
                {saving ? "Saving…" : "Save changes"}
              </button>
              {dirty ? <span className="badge">Unsaved</span> : <span className="muted">Saved</span>}
            </div>
            <div className="subaccounts-config-list" style={{ marginTop: 14 }}>
              {locations.map((loc) => (
                <label className="subaccount-config-row" key={loc.locationId}>
                  <div>
                    <strong>{loc.name ?? loc.ghlLocationId}</strong>
                    <div className="muted">GHL: {loc.ghlLocationId}</div>
                    <div className="muted">
                      uuid: {loc.locationId}
                      {loc.implicitAll ? " · modo implícito: todas hasta guardar primera lista" : null}
                    </div>
                  </div>
                  <input
                    aria-label={`Allow ${loc.ghlLocationId}`}
                    checked={loc.selected}
                    disabled={user?.role !== "admin"}
                    type="checkbox"
                    onChange={(event) => toggleLocation(loc.locationId, event.target.checked)}
                  />
                </label>
              ))}
            </div>
            {saveError ? <p className="inbox-reply-error" style={{ marginTop: 10 }}>{saveError}</p> : null}
          </div>
        ) : null}

        {!locationsLoading &&
        !locationsError &&
        selectedUserId &&
        selectedUserRole !== "admin" &&
        locations.length === 0 ? (
          <p className="muted" style={{ marginTop: 16 }}>
            Connect GoHighLevel and sync locations before assigning access.
          </p>
        ) : null}
      </div>
    </>
  );
}
