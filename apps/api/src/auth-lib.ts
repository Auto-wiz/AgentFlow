import bcrypt from "bcryptjs";
import * as jose from "jose";

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 11);
}

export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

export async function signWorkspaceJwt(args: {
  secret: string;
  sub: string;
  role: "admin" | "user";
  email?: string | null;
  ghlUserId?: string | null;
}) {
  const key = new TextEncoder().encode(args.secret);
  const body: Record<string, unknown> = { role: args.role };
  if (typeof args.email === "string" && args.email.length > 0) {
    body.email = args.email;
  }
  if (typeof args.ghlUserId === "string" && args.ghlUserId.length > 0) {
    body.ghlUserId = args.ghlUserId;
  }
  return new jose.SignJWT(body as jose.JWTPayload)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(args.sub)
    .setIssuedAt()
    .setExpirationTime("30d")
    .sign(key);
}

export async function verifyWorkspaceJwt(secret: string, token: string) {
  const key = new TextEncoder().encode(secret);
  const { payload } = await jose.jwtVerify(token, key, { algorithms: ["HS256"] });
  const sub = typeof payload.sub === "string" ? payload.sub : null;
  const role = payload.role === "admin" || payload.role === "user" ? payload.role : null;
  if (!sub || !role) {
    throw new Error("invalid_claims");
  }
  const email = typeof payload.email === "string" ? payload.email : "";
  const ghlUserId = typeof payload.ghlUserId === "string" ? payload.ghlUserId : null;
  return { sub, role, email, ghlUserId };
}

export function parseBearerHeader(headerValue: string | undefined) {
  const raw = headerValue?.trim();
  if (!raw?.toLowerCase().startsWith("bearer ")) {
    return null;
  }
  const token = raw.slice(7).trim();
  return token || null;
}
