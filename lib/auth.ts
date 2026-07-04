import { randomBytes } from "crypto";
import { NextRequest, NextResponse } from "next/server";
import { redis } from "@/lib/redis";

// Two ways to prove you're the admin:
//   1. The x-admin-password header (the original, still-supported method).
//   2. A session cookie, handed out after you unlock with a password or a
//      passkey (Touch ID / Face ID). Sessions are stored server-side in Redis
//      so they can expire and be revoked.

const SESSION_COOKIE = "cl_session";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days
const sessionKey = (token: string) => `webauthn:session:${token}`;

// Constant-time-ish comparison so the password check doesn't leak via timing.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function passwordOk(req: NextRequest): boolean {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false; // never allow access if no password is configured
  const given = req.headers.get("x-admin-password");
  return typeof given === "string" && safeEqual(given, expected);
}

export async function hasValidSession(req: NextRequest): Promise<boolean> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return false;
  const exists = await redis.exists(sessionKey(token));
  return exists === 1;
}

// The single source of truth for "is this request allowed to touch links?"
export async function authorized(req: NextRequest): Promise<boolean> {
  if (passwordOk(req)) return true;
  return hasValidSession(req);
}

// Create a fresh session in Redis and attach its cookie to the response.
export async function startSession(res: NextResponse): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  await redis.set(sessionKey(token), "1", { ex: SESSION_TTL_SECONDS });
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  });
}

// Destroy the current session (Redis + cookie).
export async function endSession(
  req: NextRequest,
  res: NextResponse,
): Promise<void> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (token) await redis.del(sessionKey(token));
  res.cookies.set(SESSION_COOKIE, "", { path: "/", maxAge: 0 });
}
