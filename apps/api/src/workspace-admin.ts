import { createDb } from "@agentflow/db";
import { locations, workspaceUsers } from "@agentflow/db";
import { asc, eq } from "drizzle-orm";
import type { Context } from "hono";

import { hashPassword, normalizeEmail } from "./auth-lib.js";
import { resolveSessionUser, type WorkspaceJwtEnv } from "./workspace-access.js";
import {
  assertAllLocationIdsExist,
  fetchSelectionLocationRows,
  replaceWorkspaceSelections,
  rowsToNullableSelectionSet
} from "./workspace-selection-db.js";

type HonoBindings = { Bindings: WorkspaceJwtEnv };

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

async function assertAdminSession(c: Context<HonoBindings>) {
  const me = await resolveSessionUser(c, c.env);
  if (!me || me.role !== "admin") {
    return null;
  }
  return me;
}

export async function adminListUsers(c: Context<HonoBindings>) {
  const admin = await assertAdminSession(c);
  if (!admin) {
    return c.json({ error: "forbidden" }, 403);
  }
  const db = createDb(c.env.DATABASE_URL);
  const rows = await db
    .select({
      id: workspaceUsers.id,
      email: workspaceUsers.email,
      displayName: workspaceUsers.displayName,
      ghlUserId: workspaceUsers.ghlUserId,
      role: workspaceUsers.role,
      createdAt: workspaceUsers.createdAt
    })
    .from(workspaceUsers)
    .orderBy(asc(workspaceUsers.ghlUserId), asc(workspaceUsers.createdAt));
  return c.json({ users: rows });
}

/** Provision a workspace user that signs in with email + password (admin only). */
export async function adminPostWorkspaceUser(c: Context<HonoBindings>) {
  const admin = await assertAdminSession(c);
  if (!admin) {
    return c.json({ error: "forbidden" }, 403);
  }

  const body = asRecord(await c.req.json().catch(() => ({})));
  const emailRaw = typeof body.email === "string" ? body.email.trim() : "";
  const passwordRaw = typeof body.password === "string" ? body.password : "";
  const displayNameRaw = typeof body.displayName === "string" ? body.displayName.trim() : "";
  const requestedRole =
    body.role === "admin" || body.role === "user" ? (body.role as "admin" | "user") : "user";

  if (!emailRaw || !passwordRaw || passwordRaw.length < 8) {
    return c.json(
      { error: "invalid_body", message: "Valid email and password (at least 8 characters) required" },
      400
    );
  }

  const email = normalizeEmail(emailRaw);
  const db = createDb(c.env.DATABASE_URL);

  const [duplicate] = await db
    .select({ id: workspaceUsers.id })
    .from(workspaceUsers)
    .where(eq(workspaceUsers.email, email))
    .limit(1);

  if (duplicate) {
    return c.json({ error: "email_taken", message: "That email already exists in this workspace." }, 409);
  }

  const passwordHash = await hashPassword(passwordRaw);
  const displayName = displayNameRaw.length > 0 ? displayNameRaw : null;
  const now = new Date();

  const [inserted] = await db
    .insert(workspaceUsers)
    .values({
      email,
      passwordHash,
      displayName,
      role: requestedRole,
      updatedAt: now
    })
    .returning({
      id: workspaceUsers.id,
      email: workspaceUsers.email,
      displayName: workspaceUsers.displayName,
      role: workspaceUsers.role,
      createdAt: workspaceUsers.createdAt
    });

  if (!inserted) {
    return c.json({ error: "insert_failed" }, 500);
  }

  return c.json({ user: inserted }, 201);
}

export async function adminListLocations(c: Context<HonoBindings>) {
  const admin = await assertAdminSession(c);
  if (!admin) {
    return c.json({ error: "forbidden" }, 403);
  }
  const db = createDb(c.env.DATABASE_URL);
  const rows = await db
    .select({
      locationId: locations.id,
      ghlLocationId: locations.ghlLocationId,
      name: locations.name
    })
    .from(locations)
    .orderBy(asc(locations.ghlLocationId));

  return c.json({ locations: rows });
}

export async function adminGetUserSubaccounts(c: Context<HonoBindings>) {
  const admin = await assertAdminSession(c);
  if (!admin) {
    return c.json({ error: "forbidden" }, 403);
  }
  const userIdParam = c.req.param("id");
  if (typeof userIdParam !== "string" || !isUuid(userIdParam)) {
    return c.json({ error: "invalid_user" }, 400);
  }
  const userId = userIdParam;
  const db = createDb(c.env.DATABASE_URL);

  const [target] = await db
    .select({ id: workspaceUsers.id })
    .from(workspaceUsers)
    .where(eq(workspaceUsers.id, userId))
    .limit(1);
  if (!target) {
    return c.json({ error: "user_not_found" }, 404);
  }

  const locRows = await db
    .select({
      locationId: locations.id,
      ghlLocationId: locations.ghlLocationId,
      name: locations.name
    })
    .from(locations)
    .orderBy(asc(locations.ghlLocationId));

  const selectionRows = await fetchSelectionLocationRows(db, userId);
  const nullableSet = rowsToNullableSelectionSet(selectionRows);

  return c.json({
    userId,
    locations: locRows.map((loc) => ({
      locationId: loc.locationId,
      ghlLocationId: loc.ghlLocationId,
      name: loc.name,
      selected: nullableSet === null ? true : nullableSet.has(loc.locationId),
      implicitAll: nullableSet === null
    }))
  });
}

/** Replace seed/default subaccount picker rows for a workspace user (admin only). */
export async function adminPutUserSubaccounts(c: Context<HonoBindings>) {
  const admin = await assertAdminSession(c);
  if (!admin) {
    return c.json({ error: "forbidden" }, 403);
  }
  const userIdParam = c.req.param("id");
  if (typeof userIdParam !== "string" || !isUuid(userIdParam)) {
    return c.json({ error: "invalid_user" }, 400);
  }
  const userId = userIdParam;

  const db = createDb(c.env.DATABASE_URL);
  const [target] = await db
    .select({ id: workspaceUsers.id })
    .from(workspaceUsers)
    .where(eq(workspaceUsers.id, userId))
    .limit(1);

  if (!target) {
    return c.json({ error: "user_not_found" }, 404);
  }

  const body = asRecord(await c.req.json().catch(() => ({})));
  const rawIds = Array.isArray(body.locationIds) ? body.locationIds : [];

  const trimmed = [...new Set(rawIds.map((v) => (typeof v === "string" ? v.trim() : "")).filter(Boolean))];

  const locationIds = trimmed.filter(isUuid);
  if (locationIds.length !== trimmed.length) {
    return c.json({ error: "invalid_location_ids" }, 400);
  }

  const ok = await assertAllLocationIdsExist(db, locationIds);
  if (!ok) {
    return c.json({ error: "unknown_location_ids" }, 400);
  }

  await replaceWorkspaceSelections(db, userId, locationIds);

  return c.json({ ok: true, userId, count: locationIds.length });
}
