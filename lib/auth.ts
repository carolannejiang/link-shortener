import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { redis } from "@/lib/redis";
import { clientIp, overLimit, strike } from "@/lib/rate-limit";

// Two ways to prove you're the admin:
//   1. The x-admin-password header (the original method, still handy for curl).
//   2. A session cookie, handed out after you unlock with the password or a
//      passkey (Touch ID / Face ID). Sessions are stored server-side in Redis
//      so they can expire and be revoked.

const SESSION_COOKIE = "cl_session";

// A session dies after 30 days *without use* — hasValidSession refreshes the
// TTL on every hit, so devices you actually use stay signed in.
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30;

// The cookie deliberately outlives the Redis entry (400 days is the browser
// cap). Redis is the source of truth for validity; the cookie just carries
// the token.
const COOKIE_TTL_SECONDS = 60 * 60 * 24 * 400;

// Wrong password guesses allowed per IP per minute before we stop comparing.
const MAX_PASSWORD_FAILURES = 10;

const sessionKey = (token: string) => `session:${token}`;

// Compare via fixed-length digests: constant time, and no length leak.
function safeEqual(a: string, b: string): boolean {
  return timingSafeEqual(
    createHash("sha256").update(a).digest(),
    createHash("sha256").update(b).digest(),
  );
}

function passwordOk(req: NextRequest): boolean {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false; // never allow access if no password is configured
  const given = req.headers.get("x-admin-password");
  return typeof given === "string" && safeEqual(given, expected);
}

export async function hasValidSession(req: NextRequest): Promise<boolean> {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!token) return false;
  // GETEX reads and refreshes the TTL in one command (sliding expiration).
  const value = await redis.getex(sessionKey(token), {
    ex: SESSION_TTL_SECONDS,
  });
  return value !== null;
}

// The single source of truth for "is this request allowed to touch links?"
export async function authorized(req: NextRequest): Promise<boolean> {
  const given = req.headers.get("x-admin-password");
  if (given !== null) {
    const ip = clientIp(req);
    // Over the failure budget → refuse without even comparing.
    if (await overLimit("password", ip, MAX_PASSWORD_FAILURES)) return false;
    if (passwordOk(req)) return true;
    await strike("password", ip);
  }
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
    maxAge: COOKIE_TTL_SECONDS,
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
