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
  email: string;
}) {
  const key = new TextEncoder().encode(args.secret);
  return new jose.SignJWT({ role: args.role, email: args.email })
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
  const email = typeof payload.email === "string" ? payload.email : "";
  if (!sub || !role) {
    throw new Error("invalid_claims");
  }
  return { sub, role, email };
}

export function parseBearerHeader(headerValue: string | undefined) {
  const raw = headerValue?.trim();
  if (!raw?.toLowerCase().startsWith("bearer ")) {
    return null;
  }
  const token = raw.slice(7).trim();
  return token || null;
}
