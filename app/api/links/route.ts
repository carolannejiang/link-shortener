import { NextRequest, NextResponse } from "next/server";
import {
  redis,
  LINKS_KEY,
  CLICKS_KEY,
  SCANS_KEY,
  DISABLED_KEY,
  eventsKey,
} from "@/lib/redis";
import { authorized } from "@/lib/auth";

export const runtime = "nodejs";

// Slugs that must never be turned into short links, because they'd shadow the
// real pages/routes of this app.
const RESERVED = new Set(["admin", "api"]);

// Lowercase letters, numbers, and dashes only.
const SLUG_RE = /^[a-z0-9-]+$/;

// Characters used for auto-generated slugs. No vowels-only weirdness needed;
// this is just a short, URL-safe, unambiguous set.
const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

// Turn a bare domain like "foo.trycloudflare.com" into a full URL. Anything
// that already carries an http(s) scheme is left untouched. Other schemes
// (mailto:, etc.) are left as-is too and get rejected by the protocol check.
function normalizeUrl(input: string): string {
  if (/^https?:\/\//i.test(input)) return input;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return input; // some other scheme://
  return `https://${input}`;
}

// A random URL-safe slug, e.g. "a7f2kq".
function randomSlug(len = 6): string {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (let i = 0; i < len; i++) out += SLUG_ALPHABET[bytes[i] % SLUG_ALPHABET.length];
  return out;
}

// Generate a slug that isn't already taken. Widens the space after a few
// collisions purely as a safety valve — in practice the first try is free.
async function uniqueSlug(): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const candidate = randomSlug();
    if (!(await redis.hexists(LINKS_KEY, candidate))) return candidate;
  }
  return randomSlug(10);
}

function unauthorized() {
  return NextResponse.json({ error: "Wrong password." }, { status: 401 });
}

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

function safeParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

// List every link, or — with ?stats=<slug> — the recent per-hit event log for
// one link (newest first).
export async function GET(req: NextRequest) {
  if (!(await authorized(req))) return unauthorized();

  const statsSlug = req.nextUrl.searchParams.get("stats");
  if (statsSlug) {
    const raw = await redis.lrange(eventsKey(statsSlug), 0, 199);
    // Upstash usually deserializes JSON for us; parse any stragglers.
    const events = (raw ?? []).map((e) =>
      typeof e === "string" ? safeParse(e) : e,
    );
    return NextResponse.json({ slug: statsSlug, events });
  }

  const [urls, clicks, scans, disabledList] = await Promise.all([
    redis.hgetall<Record<string, string>>(LINKS_KEY),
    redis.hgetall<Record<string, number>>(CLICKS_KEY),
    redis.hgetall<Record<string, number>>(SCANS_KEY),
    redis.smembers(DISABLED_KEY),
  ]);

  const disabled = new Set(disabledList ?? []);
  const links = Object.fromEntries(
    Object.entries(urls ?? {}).map(([slug, url]) => [
      slug,
      {
        url,
        clicks: Number(clicks?.[slug] ?? 0),
        scans: Number(scans?.[slug] ?? 0),
        disabled: disabled.has(slug),
      },
    ]),
  );

  return NextResponse.json({ links });
}

// Create (or overwrite) a link.
export async function POST(req: NextRequest) {
  if (!(await authorized(req))) return unauthorized();

  const body = await req.json().catch(() => null);
  const rawSlug = String(body?.slug ?? "").trim().toLowerCase();
  const rawUrl = String(body?.url ?? "").trim();

  // Validate the URL first (it's free), then resolve the slug.
  let parsed: URL;
  try {
    parsed = new URL(normalizeUrl(rawUrl));
  } catch {
    return bad("Enter a valid URL.");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return bad("URL must be an http:// or https:// address.");
  }

  // No slug given → make one up. Otherwise validate the one we were handed.
  let slug: string;
  if (rawSlug === "") {
    slug = await uniqueSlug();
  } else {
    if (!SLUG_RE.test(rawSlug)) {
      return bad("Slug may contain only lowercase letters, numbers, and dashes.");
    }
    if (RESERVED.has(rawSlug)) {
      return bad(`"${rawSlug}" is reserved and can't be used as a slug.`);
    }
    slug = rawSlug;
  }

  // Saving a link (re)activates it — clear any leftover disabled flag so an
  // overwrite of a disabled slug starts working again. The two writes are
  // independent, so issue them together (one batched round trip).
  await Promise.all([
    redis.hset(LINKS_KEY, { [slug]: parsed.toString() }),
    redis.srem(DISABLED_KEY, slug),
  ]);
  return NextResponse.json({ ok: true, slug, url: parsed.toString() });
}

// Enable or disable a link without deleting it.
export async function PATCH(req: NextRequest) {
  if (!(await authorized(req))) return unauthorized();

  const body = await req.json().catch(() => null);
  const slug = String(body?.slug ?? "").trim().toLowerCase();
  const disabled = Boolean(body?.disabled);
  if (!slug) return bad("Missing slug.");
  if (!(await redis.hexists(LINKS_KEY, slug))) return bad("No such link.");

  if (disabled) await redis.sadd(DISABLED_KEY, slug);
  else await redis.srem(DISABLED_KEY, slug);

  return NextResponse.json({ ok: true, slug, disabled });
}

// Delete a link by slug, along with its click count and disabled flag.
export async function DELETE(req: NextRequest) {
  if (!(await authorized(req))) return unauthorized();

  const body = await req.json().catch(() => null);
  const slug = String(body?.slug ?? "").trim().toLowerCase();
  if (!slug) return bad("Missing slug.");

  await Promise.all([
    redis.hdel(LINKS_KEY, slug),
    redis.hdel(CLICKS_KEY, slug),
    redis.hdel(SCANS_KEY, slug),
    redis.srem(DISABLED_KEY, slug),
    redis.del(eventsKey(slug)),
  ]);
  return NextResponse.json({ ok: true });
}
