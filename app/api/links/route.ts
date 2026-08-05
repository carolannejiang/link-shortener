import { NextRequest, NextResponse } from "next/server";
import {
  redis,
  LINKS_KEY,
  ALIASES_KEY,
  CLICKS_KEY,
  SCANS_KEY,
  DISABLED_KEY,
  DISABLED_AT_KEY,
  NOTES_KEY,
  CREATED_KEY,
  EXPIRES_KEY,
  TAGS_KEY,
  PARAMS_KEY,
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
  parseTags,
  parseParams,
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

// Validate and normalize a destination URL. Returns the canonical URL string,
// or an error message ready to hand to bad(). Shared by POST (creating a link)
// and PATCH (repointing one), so both phrase the same failure the same way.
function parseDestination(rawUrl: string): { url: string } | { error: string } {
  if (rawUrl.length > MAX_URL_LEN) {
    return { error: `URL is too long (${MAX_URL_LEN} characters max).` };
  }
  let parsed: URL;
  try {
    parsed = new URL(normalizeUrl(rawUrl));
  } catch {
    return { error: "Enter a valid URL." };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { error: "URL must be an http:// or https:// address." };
  }
  return { url: parsed.toString() };
}

// Read an expiry timestamp from a request body. Returns a positive unix-ms
// integer to set, or 0 to clear (never expire) — anything non-numeric clears.
function parseExpiresAt(value: unknown): number {
  const ms = Math.floor(Number(value ?? 0));
  return Number.isFinite(ms) && ms > 0 ? ms : 0;
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

  const [
    urls,
    aliases,
    clicks,
    scans,
    disabledList,
    disabledAt,
    notes,
    created,
    expires,
    tags,
    params,
  ] = await Promise.all([
    redis.hgetall<Record<string, string>>(LINKS_KEY),
    redis.hgetall<Record<string, string>>(ALIASES_KEY),
    redis.hgetall<Record<string, number>>(CLICKS_KEY),
    redis.hgetall<Record<string, number>>(SCANS_KEY),
    redis.smembers(DISABLED_KEY),
    redis.hgetall<Record<string, number>>(DISABLED_AT_KEY),
    redis.hgetall<Record<string, string>>(NOTES_KEY),
    redis.hgetall<Record<string, number>>(CREATED_KEY),
    redis.hgetall<Record<string, number>>(EXPIRES_KEY),
    redis.hgetall<Record<string, string>>(TAGS_KEY),
    redis.hgetall<Record<string, string>>(PARAMS_KEY),
  ]);

  const disabled = new Set(disabledList ?? []);
  // Tags are stored as one comma-separated string per slug; split back to a list.
  // String() guards against Upstash's read-side JSON.parse turning a value
  // like "2025" into a number (values are written raw but parsed on read).
  const tagsOf = (slug: string) =>
    String(tags?.[slug] ?? "").split(",").filter(Boolean);
  const links: Record<string, LinkInfo> = Object.fromEntries(
    Object.entries(urls ?? {}).map(([slug, url]) => [
      slug,
      {
        url,
        clicks: Number(clicks?.[slug] ?? 0),
        scans: Number(scans?.[slug] ?? 0),
        disabled: disabled.has(slug),
        disabledAt: Number(disabledAt?.[slug] ?? 0),
        note: notes?.[slug] ?? "",
        created: Number(created?.[slug] ?? 0),
        expiresAt: Number(expires?.[slug] ?? 0),
        tags: tagsOf(slug),
        params: params?.[slug] ?? "",
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
      disabledAt: Number(disabledAt?.[slug] ?? 0),
      note: notes?.[slug] ?? "",
      created: Number(created?.[slug] ?? 0),
      expiresAt: Number(expires?.[slug] ?? 0),
      tags: tagsOf(slug),
      params: params?.[slug] ?? "",
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
  const expiresAt = parseExpiresAt(body?.expiresAt);
  // Tags are optional here: present → set (or clear if empty), absent → left
  // untouched, so re-saving a link's URL keeps its existing tags.
  const hasTags = body?.tags !== undefined;
  const tags = hasTags ? parseTags(body?.tags) : [];

  // Validate the destination first (it's free), then resolve the slug.
  let destUrl = "";
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
    const parsed = parseDestination(rawUrl);
    if ("error" in parsed) return bad(parsed.error);
    destUrl = parsed.url;
  }

  // A slug saved with an expiry sets it; without one, the field is cleared —
  // saving is a full (re)definition of the link, like the disabled reset below.
  const applyExpiry = (slug: string) =>
    expiresAt
      ? redis.hset(EXPIRES_KEY, { [slug]: expiresAt })
      : redis.hdel(EXPIRES_KEY, slug);

  // Write tags only when they were provided; store as one comma-joined string.
  const applyTags = (slug: string) =>
    tags.length
      ? redis.hset(TAGS_KEY, { [slug]: tags.join(",") })
      : redis.hdel(TAGS_KEY, slug);

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
      redis.hdel(DISABLED_AT_KEY, slug),
      redis.hsetnx(CREATED_KEY, slug, Date.now()),
      applyExpiry(slug),
      ...(hasTags ? [applyTags(slug)] : []),
    ]);
    return NextResponse.json({
      ok: true,
      slug,
      aliasOf: target,
      url: targetUrl,
      expiresAt,
      tags: hasTags ? tags : undefined,
    });
  }

  // Saving a link (re)activates it — clear any leftover disabled flag so an
  // overwrite of a disabled slug starts working again. Dropping any alias
  // pointer turns a combined link back into a regular one, and HSETNX stamps
  // the creation date only the first time the slug appears. The writes are
  // independent, so issue them together (one batched round trip).
  await Promise.all([
    redis.hset(LINKS_KEY, { [slug]: destUrl }),
    redis.hdel(ALIASES_KEY, slug),
    redis.srem(DISABLED_KEY, slug),
    redis.hdel(DISABLED_AT_KEY, slug),
    redis.hsetnx(CREATED_KEY, slug, Date.now()),
    applyExpiry(slug),
    ...(hasTags ? [applyTags(slug)] : []),
  ]);
  return NextResponse.json({
    ok: true,
    slug,
    url: destUrl,
    expiresAt,
    tags: hasTags ? tags : undefined,
  });
}

// Update an existing link in place: repoint its destination, set an expiry,
// toggle its disabled state, and/or set its note. Only the fields present in
// the request body are touched, so the admin can send just one of them.
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

  // Repoint the destination. A combined link has no URL of its own — it
  // follows its target — so redirect the edit there instead of storing one.
  let url: string | undefined;
  if (typeof body?.url === "string" && body.url.trim() !== "") {
    if (isAlias) {
      return bad("This link follows another — edit the target link instead.");
    }
    const parsed = parseDestination(body.url.trim());
    if ("error" in parsed) return bad(parsed.error);
    url = parsed.url;
    writes.push(redis.hset(LINKS_KEY, { [slug]: url }));
  }

  // Set or clear the expiry. `expiresAt: 0` (or null) removes any existing one.
  let expiresAt: number | undefined;
  if (body?.expiresAt !== undefined) {
    expiresAt = parseExpiresAt(body.expiresAt);
    writes.push(
      expiresAt
        ? redis.hset(EXPIRES_KEY, { [slug]: expiresAt })
        : redis.hdel(EXPIRES_KEY, slug),
    );
  }

  // Set or clear the organizational tags. An empty list removes the field.
  let tags: string[] | undefined;
  if (body?.tags !== undefined) {
    tags = parseTags(body.tags);
    writes.push(
      tags.length
        ? redis.hset(TAGS_KEY, { [slug]: tags.join(",") })
        : redis.hdel(TAGS_KEY, slug),
    );
  }

  // Set or clear the query-param preset. A blank string removes the field.
  let params: string | undefined;
  if (body?.params !== undefined) {
    params = parseParams(body.params);
    writes.push(
      params
        ? redis.hset(PARAMS_KEY, { [slug]: params })
        : redis.hdel(PARAMS_KEY, slug),
    );
  }

  let disabled: boolean | undefined;
  if (typeof body?.disabled === "boolean") {
    disabled = body.disabled;
    writes.push(
      disabled ? redis.sadd(DISABLED_KEY, slug) : redis.srem(DISABLED_KEY, slug),
    );
    // Stamp when the link went dark (HSETNX keeps the original moment if
    // "disable" is sent twice); turning it back on clears the stamp.
    writes.push(
      disabled
        ? redis.hsetnx(DISABLED_AT_KEY, slug, Date.now())
        : redis.hdel(DISABLED_AT_KEY, slug),
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

  return NextResponse.json({
    ok: true,
    slug,
    url,
    expiresAt,
    tags,
    params,
    disabled,
    note,
  });
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
      redis.hdel(DISABLED_AT_KEY, s),
      redis.hdel(NOTES_KEY, s),
      redis.hdel(CREATED_KEY, s),
      redis.hdel(EXPIRES_KEY, s),
      redis.hdel(TAGS_KEY, s),
      redis.hdel(PARAMS_KEY, s),
      redis.del(eventsKey(s)),
    ]),
  );
  return NextResponse.json({ ok: true, deleted: [slug, ...dependents] });
}
