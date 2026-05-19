import { createDb } from "@agentflow/db";
import { userSubaccountVisibilities, workspaceUsers } from "@agentflow/db";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";

import {
  hashPassword,
  normalizeEmail,
  parseBearerHeader,
  signWorkspaceJwt,
  verifyWorkspaceJwt,
  verifyPassword
} from "./auth-lib.js";
import { getViewerKey } from "./viewer-key.js";

export type WorkspaceJwtEnv = {
  DATABASE_URL: string;
  JWT_SECRET?: string;
  BOOTSTRAP_SECRET?: string;
};

export type AccessPolicy =
  | { kind: "legacy"; viewerKey: string }
  | { kind: "admin_session"; viewerKey: string }
  | { kind: "user_session"; viewerKey: string; allowedLocationIds: string[] };

function jwtConfigured(env: WorkspaceJwtEnv) {
  return Boolean(env.JWT_SECRET?.trim());
}

export async function resolveAccessPolicy(c: Context, env: WorkspaceJwtEnv): Promise<AccessPolicy | null> {
  if (!jwtConfigured(env)) {
    return { kind: "legacy", viewerKey: getViewerKey(c) };
  }

  const token = parseBearerHeader(c.req.header("authorization"));
  if (!token) {
    return null;
  }

  const db = createDb(env.DATABASE_URL);

  try {
    const jwtPayload = await verifyWorkspaceJwt(env.JWT_SECRET!, token);

    const [user] = await db
      .select({
        id: workspaceUsers.id,
        email: workspaceUsers.email,
        role: workspaceUsers.role
      })
      .from(workspaceUsers)
      .where(eq(workspaceUsers.id, jwtPayload.sub))
      .limit(1);

    if (!user) {
      return null;
    }

    if (user.role === "admin") {
      return { kind: "admin_session", viewerKey: user.id };
    }

    const allowedRows = await db
      .select({
        locationId: userSubaccountVisibilities.locationId
      })
      .from(userSubaccountVisibilities)
      .where(
        and(eq(userSubaccountVisibilities.userKey, user.id), eq(userSubaccountVisibilities.isVisible, true))
      );

    const allowedLocationIds = allowedRows.map((row) => row.locationId);
    return {
      kind: "user_session",
      viewerKey: user.id,
      allowedLocationIds
    };
  } catch {
    return null;
  }
}

/** User session used by /auth/me and admin routes. Null if only legacy / invalid. */
export async function resolveSessionUser(c: Context, env: WorkspaceJwtEnv) {
  if (!jwtConfigured(env)) {
    return null;
  }
  const token = parseBearerHeader(c.req.header("authorization"));
  if (!token) {
    return null;
  }
  const db = createDb(env.DATABASE_URL);
  try {
    const claims = await verifyWorkspaceJwt(env.JWT_SECRET!, token);
    const [user] = await db
      .select({
        id: workspaceUsers.id,
        email: workspaceUsers.email,
        displayName: workspaceUsers.displayName,
        role: workspaceUsers.role
      })
      .from(workspaceUsers)
      .where(eq(workspaceUsers.id, claims.sub))
      .limit(1);
    return user ?? null;
  } catch {
    return null;
  }
}


export async function getHiddenLocationIdsForPolicy(
  db: ReturnType<typeof createDb>,
  policy: AccessPolicy & { kind: "legacy" | "admin_session" }
) {
  const hiddenRows = await db
    .select({
      locationId: userSubaccountVisibilities.locationId
    })
    .from(userSubaccountVisibilities)
    .where(
      and(
        eq(userSubaccountVisibilities.userKey, policy.viewerKey),
        eq(userSubaccountVisibilities.isVisible, false)
      )
    );
  return hiddenRows.map((row) => row.locationId);
}

async function authenticateEmailPassword(db: ReturnType<typeof createDb>, emailRaw: string, password: string) {
  const email = normalizeEmail(emailRaw);
  const [user] = await db
    .select({
      id: workspaceUsers.id,
      email: workspaceUsers.email,
      passwordHash: workspaceUsers.passwordHash,
      role: workspaceUsers.role,
      displayName: workspaceUsers.displayName
    })
    .from(workspaceUsers)
    .where(eq(workspaceUsers.email, email))
    .limit(1);

  if (!user) {
    return null;
  }
  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    return null;
  }
  return user;
}

export async function loginHandler(c: Context<{ Bindings: WorkspaceJwtEnv }>) {
  const env = c.env;
  const body = asRecord(await c.req.json().catch(() => ({})));
  const email = stringFrom(body.email);
  const password = stringFrom(body.password);
  if (!email || !password) {
    return c.json({ error: "missing_credentials" }, 400);
  }
  if (!jwtConfigured(env)) {
    return c.json({ error: "jwt_not_configured" }, 501);
  }
  const db = createDb(env.DATABASE_URL);
  const user = await authenticateEmailPassword(db, email, password);
  if (!user) {
    return c.json({ error: "invalid_credentials" }, 401);
  }
  const token = await signWorkspaceJwt({
    secret: env.JWT_SECRET!,
    sub: user.id,
    role: user.role,
    email: user.email
  });

  return c.json({
    token,
    user: {
      id: user.id,
      email: user.email,
      role: user.role,
      displayName: user.displayName
    }
  });
}

export async function meHandler(c: Context<{ Bindings: WorkspaceJwtEnv }>) {
  const user = await resolveSessionUser(c, c.env);
  if (!user) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return c.json({ user });
}

export async function bootstrapHandler(c: Context<{ Bindings: WorkspaceJwtEnv }>) {
  const env = c.env;
  const body = asRecord(await c.req.json().catch(() => ({})));
  const secret = stringFrom(body.bootstrapSecret ?? body.secret);
  const emailRaw = stringFrom(body.email);
  const password = stringFrom(body.password);
  const displayNameRaw = typeof body.displayName === "string" ? body.displayName.trim() || null : null;

  if (!secret || secret !== env.BOOTSTRAP_SECRET?.trim()) {
    return c.json({ error: "forbidden" }, 403);
  }
  if (!emailRaw || !password || password.length < 8) {
    return c.json({ error: "invalid_payload" }, 400);
  }
  const db = createDb(env.DATABASE_URL);

  const [existing] = await db.select({ c: workspaceUsers.id }).from(workspaceUsers).limit(1);
  if (existing) {
    return c.json({ error: "already_bootstrapped" }, 409);
  }

  const email = normalizeEmail(emailRaw);
  const passwordHash = await hashPassword(password);
  const now = new Date();

  const [inserted] = await db
    .insert(workspaceUsers)
    .values({
      email,
      passwordHash,
      role: "admin",
      displayName: displayNameRaw,
      updatedAt: now,
      createdAt: now
    })
    .returning({
      id: workspaceUsers.id,
      email: workspaceUsers.email,
      role: workspaceUsers.role,
      displayName: workspaceUsers.displayName
    });

  if (!jwtConfigured(env)) {
    return c.json({ user: inserted, warning: "Set JWT_SECRET to enable login tokens." }, 201);
  }

  const token = await signWorkspaceJwt({
    secret: env.JWT_SECRET!,
    sub: inserted!.id,
    role: inserted!.role,
    email: inserted!.email
  });

  return c.json({ token, user: inserted }, 201);
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function stringFrom(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}
