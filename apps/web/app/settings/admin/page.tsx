"use client";

import { getApiBaseUrl } from "../../../lib/api-base-url";
import { mergeWorkspaceHeaders } from "../../../lib/workspace-api-headers";
import { useWorkspaceAuth } from "../../components/workspace-auth-provider";
import { useEffect, useMemo, useState } from "react";

type AdminUserRow = {
  id: string;
  email: string;
  displayName: string | null;
  role: string;
  createdAt?: string;
};

type LocationOption = {
  locationId: string;
  ghlLocationId: string;
  name: string | null;
  selected: boolean;
};

export default function WorkspaceAdminSettingsPage() {
  const apiBaseUrl = getApiBaseUrl();
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

  const [newEmail, setNewEmail] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newRole, setNewRole] = useState<"user" | "admin">("user");
  const [createSubmitting, setCreateSubmitting] = useState(false);
  const [createMessage, setCreateMessage] = useState<string | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);

  const selectedUserRole = users.find((u) => u.id === selectedUserId)?.role ?? null;

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

  async function createUser(ev: React.FormEvent) {
    ev.preventDefault();
    setCreateSubmitting(true);
    setCreateError(null);
    setCreateMessage(null);
    try {
      const res = await fetch(`${apiBaseUrl}/admin/workspace-users`, {
        method: "POST",
        headers: mergeWorkspaceHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          email: newEmail.trim(),
          password: newPassword,
          displayName: newDisplayName.trim() || undefined,
          role: newRole
        })
      });
      const payload = (await res.json().catch(() => ({}))) as { error?: string; user?: AdminUserRow };
      if (!res.ok) {
        throw new Error(
          payload.error === "email_taken_or_invalid" ? "Email already in use." : payload.error ?? "Unable to create"
        );
      }
      if (payload.user) {
        const row: AdminUserRow = {
          ...payload.user,
          createdAt: new Date().toISOString()
        };
        setUsers((curr) => [...curr, row].sort((a, b) => a.email.localeCompare(b.email)));
      }
      setCreateMessage(`Created ${payload.user?.email ?? "user"}.`);
      setNewEmail("");
      setNewPassword("");
      setNewDisplayName("");
      setNewRole("user");
    } catch (caught) {
      setCreateError(caught instanceof Error ? caught.message : "Unable to create");
    } finally {
      setCreateSubmitting(false);
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
          Create accounts manually (no signup). Workspace users see only locations you allow below. Workspace admins retain
          access to legacy visibility controls keyed on their viewer id unless you migrate them explicitly.
        </p>
        {headerNote ? <p className="muted" style={{ marginTop: 10 }}>{headerNote}</p> : null}
      </div>

      <div className="panel" style={{ padding: 18, marginTop: 12 }}>
        <h3 style={{ marginTop: 0 }}>Invite user</h3>
        <p className="muted">Minimum password length: 8 characters.</p>
        <form onSubmit={(e) => void createUser(e)} style={{ marginTop: 12 }}>
          <div className="toolbar" style={{ flexWrap: "wrap", gap: 10 }}>
            <input placeholder="Email" type="email" value={newEmail} onChange={(e) => setNewEmail(e.target.value)} />
            <input placeholder="Password" type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
            <input
              placeholder="Display name"
              type="text"
              value={newDisplayName}
              onChange={(e) => setNewDisplayName(e.target.value)}
            />
            <select value={newRole} onChange={(e) => setNewRole(e.target.value as "user" | "admin")}>
              <option value="user">Role: user</option>
              <option value="admin">Role: admin</option>
            </select>
          </div>
          <button className="button" disabled={createSubmitting || user?.role !== "admin"} style={{ marginTop: 14 }} type="submit">
            {createSubmitting ? "Creating…" : "Create workspace user"}
          </button>
        </form>
        {createError ? <p className="inbox-reply-error" style={{ marginTop: 10 }}>{createError}</p> : null}
        {createMessage ? <p className="muted" style={{ marginTop: 10 }}>{createMessage}</p> : null}
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
              {users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.email} ({u.role})
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
                    <div className="muted">uuid: {loc.locationId}</div>
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
