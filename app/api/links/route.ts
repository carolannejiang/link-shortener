import { NextRequest, NextResponse } from "next/server";
import {
  redis,
  LINKS_KEY,
  CLICKS_KEY,
  SCANS_KEY,
  DISABLED_KEY,
  NOTES_KEY,
  eventsKey,
  STATS_FETCH_LIMIT,
} from "@/lib/redis";
import {
  SLUG_RE,
  RESERVED,
  MAX_SLUG_LEN,
  MAX_URL_LEN,
  MAX_NOTE_LEN,
  normalizeUrl,
  type LinkInfo,
} from "@/lib/links";
import { authorized } from "@/lib/auth";

export const runtime = "nodejs";

// Characters used for auto-generated slugs. No vowels-only weirdness needed;
// this is just a short, URL-safe, unambiguous set.
const SLUG_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

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
  return NextResponse.json({ error: "Not authorized." }, { status: 401 });
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
    if (!SLUG_RE.test(statsSlug)) return bad("No such link.");
    const raw = await redis.lrange(eventsKey(statsSlug), 0, STATS_FETCH_LIMIT - 1);
    // Upstash usually deserializes JSON for us; parse any stragglers.
    const events = (raw ?? []).map((e) =>
      typeof e === "string" ? safeParse(e) : e,
    );
    return NextResponse.json({ slug: statsSlug, events });
  }

  const [urls, clicks, scans, disabledList, notes] = await Promise.all([
    redis.hgetall<Record<string, string>>(LINKS_KEY),
    redis.hgetall<Record<string, number>>(CLICKS_KEY),
    redis.hgetall<Record<string, number>>(SCANS_KEY),
    redis.smembers(DISABLED_KEY),
    redis.hgetall<Record<string, string>>(NOTES_KEY),
  ]);

  const disabled = new Set(disabledList ?? []);
  const links: Record<string, LinkInfo> = Object.fromEntries(
    Object.entries(urls ?? {}).map(([slug, url]) => [
      slug,
      {
        url,
        clicks: Number(clicks?.[slug] ?? 0),
        scans: Number(scans?.[slug] ?? 0),
        disabled: disabled.has(slug),
        note: notes?.[slug] ?? "",
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
  if (rawUrl.length > MAX_URL_LEN) {
    return bad(`URL is too long (${MAX_URL_LEN} characters max).`);
  }
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
    if (rawSlug.length > MAX_SLUG_LEN) {
      return bad(`Slug is too long (${MAX_SLUG_LEN} characters max).`);
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

// Update an existing link in place: toggle its disabled state and/or set its
// note. Only the fields present in the request body are touched, so the admin
// can send just `disabled` or just `note`.
export async function PATCH(req: NextRequest) {
  if (!(await authorized(req))) return unauthorized();

  const body = await req.json().catch(() => null);
  const slug = String(body?.slug ?? "").trim().toLowerCase();
  if (!slug) return bad("Missing slug.");
  if (!(await redis.hexists(LINKS_KEY, slug))) return bad("No such link.");

  const writes: Promise<unknown>[] = [];

  let disabled: boolean | undefined;
  if (typeof body?.disabled === "boolean") {
    disabled = body.disabled;
    writes.push(
      disabled ? redis.sadd(DISABLED_KEY, slug) : redis.srem(DISABLED_KEY, slug),
    );
  }

  let note: string | undefined;
  if (typeof body?.note === "string") {
    note = body.note.trim().slice(0, MAX_NOTE_LEN);
    // An empty note clears the field rather than storing a blank string.
    writes.push(
      note ? redis.hset(NOTES_KEY, { [slug]: note }) : redis.hdel(NOTES_KEY, slug),
    );
  }

  // Independent writes → auto-pipelining folds them into one round trip.
  await Promise.all(writes);

  return NextResponse.json({ ok: true, slug, disabled, note });
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
    redis.hdel(NOTES_KEY, slug),
    redis.del(eventsKey(slug)),
  ]);
  return NextResponse.json({ ok: true });
}
