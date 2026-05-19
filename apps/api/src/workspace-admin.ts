import { createDb } from "@agentflow/db";
import { locations, userSubaccountVisibilities, workspaceUsers } from "@agentflow/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Context } from "hono";

import { hashPassword, normalizeEmail } from "./auth-lib.js";
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
      role: workspaceUsers.role,
      createdAt: workspaceUsers.createdAt
    })
    .from(workspaceUsers)
    .orderBy(asc(workspaceUsers.email));
  return c.json({ users: rows });
}

export async function adminCreateUser(c: Context<HonoBindings>) {
  const admin = await assertAdminSession(c);
  if (!admin) {
    return c.json({ error: "forbidden" }, 403);
  }
  const body = asRecord(await c.req.json().catch(() => ({})));
  const emailRaw = typeof body.email === "string" ? body.email.trim() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const displayNameRaw = typeof body.displayName === "string" ? body.displayName.trim() || null : null;
  const role = body.role === "admin" ? "admin" : "user";

  if (!emailRaw || password.length < 8) {
    return c.json({ error: "invalid_payload" }, 400);
  }

  const db = createDb(c.env.DATABASE_URL);
  const email = normalizeEmail(emailRaw);
  const passwordHash = await hashPassword(password);
  const now = new Date();

  try {
    const [inserted] = await db
      .insert(workspaceUsers)
      .values({
        email,
        passwordHash,
        displayName: displayNameRaw,
        role,
        updatedAt: now,
        createdAt: now
      })
      .returning({
        id: workspaceUsers.id,
        email: workspaceUsers.email,
        displayName: workspaceUsers.displayName,
        role: workspaceUsers.role
      });
    return c.json({ user: inserted }, 201);
  } catch {
    return c.json({ error: "email_taken_or_invalid" }, 409);
  }
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

  const selectedRows = await db
    .select({ locationId: userSubaccountVisibilities.locationId })
    .from(userSubaccountVisibilities)
    .where(and(eq(userSubaccountVisibilities.userKey, userId), eq(userSubaccountVisibilities.isVisible, true)));
  const selected = new Set(selectedRows.map((r) => r.locationId));

  return c.json({
    userId,
    locations: locRows.map((loc) => ({
      locationId: loc.locationId,
      ghlLocationId: loc.ghlLocationId,
      name: loc.name,
      selected: selected.has(loc.locationId)
    }))
  });
}

/** Replace allowed subaccounts whitelist for a workspace user. */
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

  if (locationIds.length > 0) {
    const existing = await db
      .select({ id: locations.id })
      .from(locations)
      .where(inArray(locations.id, locationIds));

    if (existing.length !== locationIds.length) {
      return c.json({ error: "unknown_location_ids" }, 400);
    }
  }

  const now = new Date();

  await db.transaction(async (tx) => {
    await tx.delete(userSubaccountVisibilities).where(eq(userSubaccountVisibilities.userKey, userId));
    if (locationIds.length > 0) {
      await tx.insert(userSubaccountVisibilities).values(
        locationIds.map((lid) => ({
          userKey: userId,
          locationId: lid,
          isVisible: true,
          updatedAt: now,
          createdAt: now
        }))
      );
    }
  });

  return c.json({ ok: true, userId, count: locationIds.length });
}
