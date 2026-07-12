// Definitions shared by the proxy (which matches slugs on every request), the
// links API (which creates them), and the admin UI (which renders them), so
// none of them can drift out of sync.

// Lowercase letters, numbers, and dashes only.
export const SLUG_RE = /^[a-z0-9-]+$/;

// Slugs that must never be turned into short links, because they'd shadow the
// real pages/routes of this app.
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
  note: string;
};
