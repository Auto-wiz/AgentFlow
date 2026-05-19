import { createDb } from "@agentflow/db";
import { userSubaccountVisibilities, workspaceUsers } from "@agentflow/db";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";

import { parseBearerHeader, signWorkspaceJwt, verifyWorkspaceJwt } from "./auth-lib.js";
import { getViewerKey } from "./viewer-key.js";

export type WorkspaceJwtEnv = {
  DATABASE_URL: string;
  JWT_SECRET?: string;
};

export type AccessPolicy =
  | { kind: "legacy"; viewerKey: string }
  | { kind: "jwt_workspace"; workspaceUserId: string; role: "admin" | "user" };

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
        role: workspaceUsers.role
      })
      .from(workspaceUsers)
      .where(eq(workspaceUsers.id, jwtPayload.sub))
      .limit(1);

    if (!user) {
      return null;
    }

    const role = user.role === "admin" ? ("admin" as const) : ("user" as const);
    return { kind: "jwt_workspace", workspaceUserId: user.id, role };
  } catch {
    return null;
  }
}

/** User session used by /auth/me and admin routes. Null if legacy / invalid. */
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
        role: workspaceUsers.role,
        ghlUserId: workspaceUsers.ghlUserId
      })
      .from(workspaceUsers)
      .where(eq(workspaceUsers.id, claims.sub))
      .limit(1);
    return user ?? null;
  } catch {
    return null;
  }
}

/** Legacy viewer-key denies (is_visible = false rows). JWT workspace users bypass this entirely. */
export async function getHiddenLocationIdsForPolicy(
  db: ReturnType<typeof createDb>,
  policy: { kind: "legacy"; viewerKey: string }
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

// --- GoHighLevel -> workspace user provisioning (OAuth callback only) ---
export async function provisionWorkspaceUserFromGhlAccount(
  db: ReturnType<typeof createDb>,
  ghlUserId: string
) {
  const trimmed = ghlUserId.trim();
  if (!trimmed) {
    return null as null;
  }
  const now = new Date();
  const existing = await db
    .select({
      id: workspaceUsers.id,
      role: workspaceUsers.role,
      email: workspaceUsers.email,
      displayName: workspaceUsers.displayName,
      ghlUserId: workspaceUsers.ghlUserId
    })
    .from(workspaceUsers)
    .where(eq(workspaceUsers.ghlUserId, trimmed))
    .limit(1);

  const row = existing[0];
  if (row) {
    await db
      .update(workspaceUsers)
      .set({ updatedAt: now })
      .where(eq(workspaceUsers.id, row.id));
    return row;
  }

  const role = ("user" as const);
  const [inserted] = await db
    .insert(workspaceUsers)
    .values({
      ghlUserId: trimmed,
      email: null,
      passwordHash: null,
      displayName: null,
      role,
      updatedAt: now,
      createdAt: now
    })
    .returning({
      id: workspaceUsers.id,
      role: workspaceUsers.role,
      email: workspaceUsers.email,
      displayName: workspaceUsers.displayName,
      ghlUserId: workspaceUsers.ghlUserId
    });

  return inserted ?? null;
}

export async function signSessionForProvisionedUser(
  env: WorkspaceJwtEnv,
  user: { id: string; role: "admin" | "user"; email: string | null; ghlUserId: string | null }
) {
  if (!jwtConfigured(env) || !env.JWT_SECRET) {
    throw new Error("jwt_not_configured");
  }

  const role = user.role === "admin" ? ("admin" as const) : ("user" as const);

  const token = await signWorkspaceJwt({
    secret: env.JWT_SECRET,
    sub: user.id,
    role,
    email: user.email ?? undefined,
    ghlUserId: user.ghlUserId ?? undefined
  });

  return token;
}

export async function meHandler(c: Context<{ Bindings: WorkspaceJwtEnv }>) {
  const user = await resolveSessionUser(c, c.env);
  if (!user) {
    return c.json({ error: "unauthorized" }, 401);
  }
  return c.json({
    user: {
      id: user.id,
      email: user.email ?? null,
      displayName: user.displayName,
      role: user.role,
      ghlUserId: user.ghlUserId
    }
  });
}
