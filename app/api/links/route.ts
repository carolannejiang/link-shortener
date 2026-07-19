import { NextRequest, NextResponse } from "next/server";
import {
  redis,
  LINKS_KEY,
  ALIASES_KEY,
  CLICKS_KEY,
  SCANS_KEY,
  DISABLED_KEY,
  NOTES_KEY,
  CREATED_KEY,
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
  resolveAlias,
  type LinkInfo,
} from "@/lib/links";
import { authorized } from "@/lib/auth";
import { bad, readJson, unauthorized } from "@/lib/api";

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

// Generate a slug that isn't already taken (as a link or an alias). Widens
// the space after a few collisions purely as a safety valve — in practice the
// first try is free.
async function uniqueSlug(): Promise<string> {
  for (let i = 0; i < 5; i++) {
    const candidate = randomSlug();
    const [isLink, isAlias] = await Promise.all([
      redis.hexists(LINKS_KEY, candidate),
      redis.hexists(ALIASES_KEY, candidate),
    ]);
    if (!isLink && !isAlias) return candidate;
  }
  return randomSlug(10);
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

  const [urls, aliases, clicks, scans, disabledList, notes, created] =
    await Promise.all([
      redis.hgetall<Record<string, string>>(LINKS_KEY),
      redis.hgetall<Record<string, string>>(ALIASES_KEY),
      redis.hgetall<Record<string, number>>(CLICKS_KEY),
      redis.hgetall<Record<string, number>>(SCANS_KEY),
      redis.smembers(DISABLED_KEY),
      redis.hgetall<Record<string, string>>(NOTES_KEY),
      redis.hgetall<Record<string, number>>(CREATED_KEY),
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
        created: Number(created?.[slug] ?? 0),
      },
    ]),
  );

  // Combined links come after the real ones so their display URL can be read
  // off the target — `aliasOf` names the slug they follow.
  for (const [slug, target] of Object.entries(aliases ?? {})) {
    links[slug] = {
      url: urls?.[resolveAlias(aliases ?? {}, slug)] ?? "",
      clicks: Number(clicks?.[slug] ?? 0),
      scans: Number(scans?.[slug] ?? 0),
      disabled: disabled.has(slug),
      note: notes?.[slug] ?? "",
      created: Number(created?.[slug] ?? 0),
      aliasOf: target,
    };
  }

  return NextResponse.json({ links });
}

// Create (or overwrite) a link. With a `url` in the body this stores a normal
// link; with an `aliasOf` slug instead, it stores a combined link that follows
// that slug's destination (e.g. /bootcamp-eoi → wherever /bootcamp-public
// points, while /bootcamp-public keeps working as itself).
export async function POST(req: NextRequest) {
  if (!(await authorized(req))) return unauthorized();

  const body = await readJson(req);
  const rawSlug = String(body?.slug ?? "").trim().toLowerCase();
  const rawUrl = String(body?.url ?? "").trim();
  const rawTarget = String(body?.aliasOf ?? "").trim().toLowerCase();

  // Validate the destination first (it's free), then resolve the slug.
  let parsed: URL | null = null;
  let target: string | null = null;
  let targetUrl = "";
  if (rawTarget) {
    if (!SLUG_RE.test(rawTarget)) return bad("No such link to combine with.");
    // Combining with an already-combined link flattens to its real target, so
    // alias chains don't form through this API.
    target = (await redis.hget<string>(ALIASES_KEY, rawTarget)) ?? rawTarget;
    targetUrl = (await redis.hget<string>(LINKS_KEY, target)) ?? "";
    if (!targetUrl) {
      return bad(`"/${rawTarget}" doesn't exist yet — create it first.`);
    }
  } else {
    if (rawUrl.length > MAX_URL_LEN) {
      return bad(`URL is too long (${MAX_URL_LEN} characters max).`);
    }
    try {
      parsed = new URL(normalizeUrl(rawUrl));
    } catch {
      return bad("Enter a valid URL.");
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return bad("URL must be an http:// or https:// address.");
    }
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

  if (target) {
    if (slug === target) return bad("A link can't be combined with itself.");
    // Store the pointer and drop any URL the slug used to carry — converting
    // a regular link into a combined one keeps its clicks, scans, and note.
    // HSETNX stamps the creation date only the first time the slug appears.
    await Promise.all([
      redis.hset(ALIASES_KEY, { [slug]: target }),
      redis.hdel(LINKS_KEY, slug),
      redis.srem(DISABLED_KEY, slug),
      redis.hsetnx(CREATED_KEY, slug, Date.now()),
    ]);
    return NextResponse.json({ ok: true, slug, aliasOf: target, url: targetUrl });
  }

  // Saving a link (re)activates it — clear any leftover disabled flag so an
  // overwrite of a disabled slug starts working again. Dropping any alias
  // pointer turns a combined link back into a regular one, and HSETNX stamps
  // the creation date only the first time the slug appears. The writes are
  // independent, so issue them together (one batched round trip).
  await Promise.all([
    redis.hset(LINKS_KEY, { [slug]: parsed!.toString() }),
    redis.hdel(ALIASES_KEY, slug),
    redis.srem(DISABLED_KEY, slug),
    redis.hsetnx(CREATED_KEY, slug, Date.now()),
  ]);
  return NextResponse.json({ ok: true, slug, url: parsed!.toString() });
}

// Update an existing link in place: toggle its disabled state and/or set its
// note. Only the fields present in the request body are touched, so the admin
// can send just `disabled` or just `note`.
export async function PATCH(req: NextRequest) {
  if (!(await authorized(req))) return unauthorized();

  const body = await readJson(req);
  const slug = String(body?.slug ?? "").trim().toLowerCase();
  if (!slug) return bad("Missing slug.");
  const [isLink, isAlias] = await Promise.all([
    redis.hexists(LINKS_KEY, slug),
    redis.hexists(ALIASES_KEY, slug),
  ]);
  if (!isLink && !isAlias) return bad("No such link.");

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

// Delete a link by slug, along with its counters, note, and event log. Any
// combined links that follow the deleted slug would dangle and 404, so they
// go with it — the admin UI warns about this before asking.
export async function DELETE(req: NextRequest) {
  if (!(await authorized(req))) return unauthorized();

  const body = await readJson(req);
  const slug = String(body?.slug ?? "").trim().toLowerCase();
  if (!slug) return bad("Missing slug.");

  const aliases = await redis.hgetall<Record<string, string>>(ALIASES_KEY);
  const dependents = Object.entries(aliases ?? {})
    .filter(([, target]) => target === slug)
    .map(([alias]) => alias);

  await Promise.all(
    [slug, ...dependents].flatMap((s) => [
      redis.hdel(LINKS_KEY, s),
      redis.hdel(ALIASES_KEY, s),
      redis.hdel(CLICKS_KEY, s),
      redis.hdel(SCANS_KEY, s),
      redis.srem(DISABLED_KEY, s),
      redis.hdel(NOTES_KEY, s),
      redis.hdel(CREATED_KEY, s),
      redis.del(eventsKey(s)),
    ]),
  );
  return NextResponse.json({ ok: true, deleted: [slug, ...dependents] });
}
