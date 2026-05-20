import { createDb, workspaceUsers } from "@agentflow/db";
import { and, eq, isNotNull } from "drizzle-orm";
import type { Context } from "hono";

import { normalizeEmail, verifyPassword } from "./auth-lib.js";
import { signSessionForProvisionedUser, type WorkspaceJwtEnv } from "./workspace-access.js";

function jwtConfigured(env: WorkspaceJwtEnv) {
  return Boolean(env.JWT_SECRET?.trim());
}

export async function authLoginHandler(c: Context<{ Bindings: WorkspaceJwtEnv }>) {
  if (!jwtConfigured(c.env)) {
    return c.json({ error: "jwt_not_configured", message: "Set JWT_SECRET on the Worker" }, 501);
  }

  const body = (await c.req.json().catch(() => null)) as { email?: string; password?: string } | null;
  const emailRaw = typeof body?.email === "string" ? body.email.trim() : "";
  const password = typeof body?.password === "string" ? body.password : "";
  if (!emailRaw || !password) {
    return c.json({ error: "invalid_body", message: "email and password required" }, 400);
  }

  const email = normalizeEmail(emailRaw);
  const db = createDb(c.env.DATABASE_URL);
  const [user] = await db
    .select({
      id: workspaceUsers.id,
      role: workspaceUsers.role,
      email: workspaceUsers.email,
      displayName: workspaceUsers.displayName,
      ghlUserId: workspaceUsers.ghlUserId,
      passwordHash: workspaceUsers.passwordHash
    })
    .from(workspaceUsers)
    .where(and(eq(workspaceUsers.email, email), isNotNull(workspaceUsers.passwordHash)))
    .limit(1);

  if (!user?.passwordHash) {
    return c.json({ error: "invalid_credentials" }, 401);
  }

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) {
    return c.json({ error: "invalid_credentials" }, 401);
  }

  const token = await signSessionForProvisionedUser(c.env, {
    id: user.id,
    role: user.role === "admin" ? "admin" : "user",
    email: user.email,
    ghlUserId: user.ghlUserId
  });

  return c.json({ token });
}
