import { NextRequest, NextResponse } from "next/server";
import { redis, LINKS_KEY } from "@/lib/redis";

export const runtime = "nodejs";

// Slugs that must never be turned into short links, because they'd shadow the
// real pages/routes of this app.
const RESERVED = new Set(["admin", "api"]);

// Lowercase letters, numbers, and dashes only.
const SLUG_RE = /^[a-z0-9-]+$/;

// Constant-time-ish comparison so the password check doesn't leak via timing.
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

function authorized(req: NextRequest): boolean {
  const expected = process.env.ADMIN_PASSWORD;
  if (!expected) return false; // never allow access if no password is configured
  const given = req.headers.get("x-admin-password");
  return typeof given === "string" && safeEqual(given, expected);
}

function unauthorized() {
  return NextResponse.json({ error: "Wrong password." }, { status: 401 });
}

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

// List every link as a { slug: url } object.
export async function GET(req: NextRequest) {
  if (!authorized(req)) return unauthorized();
  const links =
    (await redis.hgetall<Record<string, string>>(LINKS_KEY)) ?? {};
  return NextResponse.json({ links });
}

// Create (or overwrite) a link.
export async function POST(req: NextRequest) {
  if (!authorized(req)) return unauthorized();

  const body = await req.json().catch(() => null);
  const slug = String(body?.slug ?? "").trim().toLowerCase();
  const rawUrl = String(body?.url ?? "").trim();

  if (!SLUG_RE.test(slug)) {
    return bad("Slug may contain only lowercase letters, numbers, and dashes.");
  }
  if (RESERVED.has(slug)) {
    return bad(`"${slug}" is reserved and can't be used as a slug.`);
  }

  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return bad("Enter a valid URL (including https://).");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return bad("URL must start with http:// or https://");
  }

  await redis.hset(LINKS_KEY, { [slug]: parsed.toString() });
  return NextResponse.json({ ok: true, slug, url: parsed.toString() });
}

// Delete a link by slug.
export async function DELETE(req: NextRequest) {
  if (!authorized(req)) return unauthorized();

  const body = await req.json().catch(() => null);
  const slug = String(body?.slug ?? "").trim().toLowerCase();
  if (!slug) return bad("Missing slug.");

  await redis.hdel(LINKS_KEY, slug);
  return NextResponse.json({ ok: true });
}
