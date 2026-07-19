import { Redis } from "@upstash/redis";

// Vercel's Redis Marketplace integrations expose their credentials under one of
// two naming schemes depending on the provider. We accept either so you don't
// have to care which one you picked.
const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const token =
  process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

if (!url || !token) {
  throw new Error(
    "Missing Redis credentials. Set KV_REST_API_URL + KV_REST_API_TOKEN " +
      "(or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN).",
  );
}

// Auto-pipelining batches commands issued in the same tick (e.g. under a
// Promise.all) into one HTTP request — over the REST transport each command
// would otherwise pay its own round trip.
export const redis = new Redis({ url, token, enableAutoPipelining: true });

// Every link is one field in a single Redis hash: field = slug, value = URL.
export const LINKS_KEY = "links";

// Click counters, kept in a parallel hash: field = slug, value = integer count.
// Stored separately from LINKS_KEY so the link values stay plain URL strings.
export const CLICKS_KEY = "clicks";

// Scan counters: the subset of clicks that came from scanning the link's QR
// code (the QR encodes the short URL with a ?src=qr marker). field = slug.
export const SCANS_KEY = "scans";

// Combined links, kept in a parallel hash: field = alias slug, value = the
// slug it follows. An alias stores no URL of its own — the proxy resolves it
// to the target's URL at redirect time, so repointing the target repoints
// every alias with it. The target slug keeps working as itself.
export const ALIASES_KEY = "aliases";

// Archived links, kept as a set of slugs. Archiving only tidies the admin —
// an archived link still redirects and still counts hits; it's just tucked
// into a collapsed section of the list. Disabling is what turns a link off.
export const ARCHIVED_KEY = "archived";

// Disabled links, kept as a set of slugs. A slug in this set still exists (URL
// and click count are preserved) but the proxy refuses to redirect it.
export const DISABLED_KEY = "disabled";

// When each slug was first created, kept in a parallel hash: field = slug,
// value = unix ms. Written with HSETNX so overwriting a link's URL keeps the
// original date. Links made before this hash existed simply have no entry.
export const CREATED_KEY = "created";

// Private, admin-only notes about a link, kept in a parallel hash: field =
// slug, value = free-text note. Never shown to visitors — only in the admin.
export const NOTES_KEY = "notes";

// Per-hit event log for one slug: a capped Redis list of small JSON objects,
// newest first, describing each click/scan (time, device, browser, geo, …).
export const eventsKey = (slug: string) => `events:${slug}`;

// How many recent hits we keep per link.
export const EVENTS_LIMIT = 500;

// How many of those one stats request returns (newest first). The admin UI
// shows a slice of these and uses the rest for its breakdowns.
export const STATS_FETCH_LIMIT = 200;
