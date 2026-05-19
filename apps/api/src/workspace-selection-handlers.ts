import { createDb, workspaceUserLocationSelection, workspaceUsers } from "@agentflow/db";
import { asc, sql } from "drizzle-orm";
import type { Context } from "hono";

import { fetchSelectionLocationRows, replaceWorkspaceSelections, assertAllLocationIdsExist } from "./workspace-selection-db.js";
import { resolveSessionUser, type WorkspaceJwtEnv } from "./workspace-access.js";

type HonoBindings = { Bindings: WorkspaceJwtEnv };

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

export async function mePutLocationSelectionsHandler(c: Context<HonoBindings>) {
  const me = await resolveSessionUser(c, c.env);
  if (!me) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const body = asRecord(await c.req.json().catch(() => ({})));
  const rawIds = Array.isArray(body.locationIds) ? body.locationIds : [];
  const trimmed = [...new Set(rawIds.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean))];
  const locationIds = trimmed.filter(isUuid);
  if (locationIds.length !== trimmed.length) {
    return c.json({ error: "invalid_location_ids" }, 400);
  }

  const db = createDb(c.env.DATABASE_URL);
  const ok = await assertAllLocationIdsExist(db, locationIds);
  if (!ok) {
    return c.json({ error: "unknown_location_ids" }, 400);
  }

  await replaceWorkspaceSelections(db, me.id, locationIds, new Date());

  return c.json({ ok: true, workspaceUserId: me.id, count: locationIds.length });
}

/** Every authenticated workspace JWT user sees the selection matrix across the team. */
export async function workspaceSelectionMatrixHandler(c: Context<HonoBindings>) {
  const me = await resolveSessionUser(c, c.env);
  if (!me) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const db = createDb(c.env.DATABASE_URL);

  const userRows = await db
    .select({
      id: workspaceUsers.id,
      email: workspaceUsers.email,
      displayName: workspaceUsers.displayName,
      role: workspaceUsers.role,
      ghlUserId: workspaceUsers.ghlUserId
    })
    .from(workspaceUsers)
    .orderBy(
      asc(sql`CASE WHEN workspace_users.role = 'admin' THEN 0 ELSE 1 END`),
      asc(workspaceUsers.ghlUserId),
      asc(workspaceUsers.createdAt)
    );

  const selectionRows = await db
    .select({
      workspaceUserId: workspaceUserLocationSelection.workspaceUserId,
      locationId: workspaceUserLocationSelection.locationId
    })
    .from(workspaceUserLocationSelection);

  const selectionsByUser = new Map<string, string[]>();
  for (const row of selectionRows) {
    const list = selectionsByUser.get(row.workspaceUserId) ?? [];
    list.push(row.locationId);
    selectionsByUser.set(row.workspaceUserId, list);
  }

  const byUser = userRows.map((u) => {
    const lids = selectionsByUser.get(u.id);
    const mode = lids && lids.length > 0 ? "explicit" : "all_locations";
    const locationIds = lids && lids.length > 0 ? lids : null;
    return {
      workspaceUserId: u.id,
      email: u.email,
      displayName: u.displayName,
      role: u.role,
      ghlUserId: u.ghlUserId,
      selectionMode: mode,
      locationIds
    };
  });

  const byLocation = buildByLocation(selectionRows.map((s) => [s.workspaceUserId, s.locationId] as const));

  return c.json({
    viewer: { workspaceUserId: me.id },
    users: byUser,
    selectionsByLocation: byLocation,
    disclaimer:
      selectionRows.length === 0
        ? "No explicit selections stored yet — everyone behaves as showing all tracked locations."
        : null
  });
}

function buildByLocation(rows: readonly (readonly [string, string])[]) {
  const map = new Map<string, string[]>();
  for (const [userId, lid] of rows) {
    const bucket = map.get(lid) ?? [];
    bucket.push(userId);
    map.set(lid, bucket);
  }

  const out = [...map.entries()].map(([locationId, workspaceUserIds]) => ({ locationId, workspaceUserIds }));
  out.sort((a, b) => a.locationId.localeCompare(b.locationId));
  return out;
}