import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { ADMIN_COOKIE_NAME, ADMIN_TOKEN_TTL_SEC } from "../constants";
import type { JWTPayload } from "jose";

type AdminAuthEnv = CloudflareEnv;

const encoder = new TextEncoder();

function getSecret(env: AdminAuthEnv): Uint8Array {
  const secret = env?.ADMIN_JWT_SECRET || env?.APP_SECRET;
  if (!secret) throw new Error("ADMIN_JWT_SECRET or APP_SECRET not configured");
  return encoder.encode(secret);
}

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

export async function signAdminToken(env: AdminAuthEnv, payload: JWTPayload): Promise<string> {
  return new SignJWT(payload)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(`${ADMIN_TOKEN_TTL_SEC}s`)
    .sign(getSecret(env));
}

export async function verifyAdminToken(env: AdminAuthEnv, token: string): Promise<JWTPayload | null> {
  try {
    const { payload } = await jwtVerify(token, getSecret(env));
    return payload;
  } catch {
    return null;
  }
}

export function readTokenFromRequest(request: Request): string | null {
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(new RegExp(`${ADMIN_COOKIE_NAME}=([^;]+)`));
  return match ? decodeURIComponent(match[1]) : null;
}

// Secure would strip the cookie on a plain-http dev origin, so it follows the
// scheme the request actually arrived on rather than being hardcoded.
function secureFlag(request: Request): string[] {
  try {
    return new URL(request.url).protocol === "https:" ? ["Secure"] : [];
  } catch {
    return ["Secure"];
  }
}

export function buildSetCookie(token: string, request: Request, maxAgeSec = ADMIN_TOKEN_TTL_SEC): string {
  const parts = [
    `${ADMIN_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    ...secureFlag(request),
    `Max-Age=${maxAgeSec}`
  ];
  return parts.join("; ");
}

export function buildClearCookie(request: Request): string {
  return [
    `${ADMIN_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    ...secureFlag(request),
    "Max-Age=0"
  ].join("; ");
}
