// Definitions shared by the proxy (which matches slugs on every request), the
// links API (which creates them), and the admin UI (which renders them), so
// none of them can drift out of sync.

// Lowercase letters, numbers, and dashes only.
export const SLUG_RE = /^[a-z0-9-]+$/;

// The app's own routes: the links API refuses to create these as slugs, and
// the proxy passes them straight through without a Redis lookup. One set,
// used by both, so adding a route here is the whole job.
export const RESERVED = new Set(["admin", "api"]);

// Upper bounds on stored fields, so a stray paste can't bloat the Redis
// hashes. The note cap is mirrored by the admin textarea's maxLength.
export const MAX_SLUG_LEN = 64;
export const MAX_URL_LEN = 2048;
export const MAX_NOTE_LEN = 2000;

// Bounds on the organizational tags a link can carry, and on the length of a
// link's default query string (its UTM / parameter preset).
export const MAX_TAGS = 12;
export const MAX_TAG_LEN = 32;
export const MAX_PARAMS_LEN = 512;

// Normalize free-form tag input (a comma-separated string or an array) into a
// clean, deduped, capped list. Tags use the same character set as slugs, so
// they stay tidy in chips, filters, and CSV exports.
export function parseTags(raw: unknown): string[] {
  const parts = Array.isArray(raw) ? raw : String(raw ?? "").split(",");
  const seen = new Set<string>();
  for (const part of parts) {
    const t = String(part)
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, "")
      .slice(0, MAX_TAG_LEN);
    if (t) seen.add(t);
  }
  return [...seen].slice(0, MAX_TAGS);
}

// Normalize a default query-param preset (e.g. "utm_source=resume&utm_medium=qr")
// into a canonical query string with no leading "?". Empty-named keys are
// dropped; the whole thing is length-capped. The proxy layers these onto a
// link's destination, beneath any params the visitor supplies.
export function parseParams(raw: unknown): string {
  const trimmed = String(raw ?? "").trim().replace(/^\?/, "").slice(0, MAX_PARAMS_LEN);
  if (!trimmed) return "";
  const out = new URLSearchParams();
  for (const [k, v] of new URLSearchParams(trimmed)) {
    if (k) out.set(k, v);
  }
  return out.toString();
}

// Turn a bare domain like "foo.trycloudflare.com" into a full URL. Anything
// that already carries an explicit scheme:// is left untouched — non-http(s)
// schemes then get rejected by the API's protocol check.
export function normalizeUrl(input: string): string {
  if (/^https?:\/\//i.test(input)) return input;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(input)) return input; // some other scheme://
  return `https://${input}`;
}

// One recorded hit. Deliberately coarse — no IP address or anything that
// identifies an individual, just the shape of the traffic.
export type HitEvent = {
  t: number; // unix ms
  src: "qr" | "direct";
  device: string; // mobile / tablet / desktop / bot / console / smarttv / …
  os: string; // name + version, e.g. "iOS 17.4"
  browser: string; // name + major version, e.g. "Mobile Safari 17"
  model?: string; // device vendor + model, e.g. "Apple iPhone"
  ref?: string; // referring host, if any
  country?: string;
  city?: string;
};

// What the links API returns for each slug (GET /api/links).
export type LinkInfo = {
  url: string;
  clicks: number;
  scans: number;
  disabled: boolean;
  note: string;
  // Unix ms when the slug was first created; 0 for links that predate
  // creation-date tracking.
  created: number;
  // Unix ms when the link stops redirecting; 0 for links that never expire.
  // Past this moment the proxy 404s the slug (its clicks and note are kept).
  expiresAt: number;
  // Organizational tags for filtering the admin list; [] when untagged.
  tags: string[];
  // Default query params appended to the destination on redirect (a UTM
  // preset), as a canonical query string with no leading "?"; "" when none.
  params: string;
  // Set when this slug is a combined link: it follows another slug instead of
  // carrying its own URL. `url` then holds the target's current destination
  // ("" if the target has gone missing).
  aliasOf?: string;
};

// How many alias hops the proxy and API will follow. Creation flattens
// aliases to point at a real link, so chains barely exist in practice — the
// cap is a backstop so a hand-edited Redis cycle can't loop forever.
export const MAX_ALIAS_HOPS = 3;

// True once a link's expiry timestamp has passed. `expiresAt` is unix ms, with
// 0 meaning "never expires". Shared by the proxy (which enforces it) and the
// admin (which labels expired links) so the cutoff is defined in one place.
export function isExpired(expiresAt: number, now: number): boolean {
  return expiresAt > 0 && now >= expiresAt;
}

// Follow alias pointers until we land on a slug that isn't itself an alias.
// Used by the links API to resolve a display URL for each combined link.
export function resolveAlias(
  aliases: Record<string, string>,
  slug: string,
): string {
  let cur = slug;
  for (let i = 0; i < MAX_ALIAS_HOPS && aliases[cur]; i++) cur = aliases[cur];
  return cur;
}
