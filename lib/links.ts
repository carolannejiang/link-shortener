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
  // Archived links still redirect — they're just collapsed out of the admin's
  // main list. Independent of `disabled`, which actually turns a link off.
  archived: boolean;
  note: string;
  // Unix ms when the slug was first created; 0 for links that predate
  // creation-date tracking.
  created: number;
  // Set when this slug is a combined link: it follows another slug instead of
  // carrying its own URL. `url` then holds the target's current destination
  // ("" if the target has gone missing).
  aliasOf?: string;
};

// How many alias hops the proxy and API will follow. Creation flattens
// aliases to point at a real link, so chains barely exist in practice — the
// cap is a backstop so a hand-edited Redis cycle can't loop forever.
export const MAX_ALIAS_HOPS = 3;

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
