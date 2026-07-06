import { NextRequest, NextResponse } from "next/server";
import { UAParser } from "ua-parser-js";
import { Bots } from "ua-parser-js/extensions";
import {
  redis,
  LINKS_KEY,
  CLICKS_KEY,
  SCANS_KEY,
  DISABLED_KEY,
  eventsKey,
  EVENTS_LIMIT,
} from "@/lib/redis";

// One recorded hit. Deliberately coarse — no IP address or anything that
// identifies an individual, just the shape of the traffic.
type HitEvent = {
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

// Full user-agent parse: precise browser/OS versions, device vendor + model,
// and crawler detection (bots come back with browser.type === "crawler"). The
// Bots extension adds the crawler signatures on top of the default matchers.
function parseUa(ua: string): Pick<HitEvent, "device" | "os" | "browser" | "model"> {
  const r = new UAParser(ua, Bots).getResult();
  const isBot = r.browser.type === "crawler";
  const join = (...parts: (string | undefined)[]) =>
    parts.filter(Boolean).join(" ") || undefined;
  return {
    // A crawler's device.type is empty, so classify it explicitly as "bot".
    // A normal desktop also has an empty device.type — fall back to "desktop".
    device: isBot ? "bot" : r.device.type ?? "desktop",
    os: join(r.os.name, r.os.version) ?? "Other",
    browser: join(r.browser.name, r.browser.major) ?? "Other",
    model: join(r.device.vendor, r.device.model),
  };
}

function refHost(referer: string | null): string | undefined {
  if (!referer) return undefined;
  try {
    return new URL(referer).host || undefined;
  } catch {
    return undefined;
  }
}

// Vercel sets these edge headers on production traffic; they're absent locally.
function geoValue(v: string | null): string | undefined {
  if (!v) return undefined;
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

// This runs on the server before the request reaches a page. For any path like
// /career it looks the slug up in Redis and, if found, fires a redirect to the
// real destination. Unknown paths fall through.
export async function proxy(req: NextRequest) {
  const slug = decodeURIComponent(req.nextUrl.pathname.slice(1)); // drop leading "/"

  if (!slug) return NextResponse.next(); // homepage

  // Look up the destination and the disabled flag together to save a round trip.
  const [url, disabled] = await Promise.all([
    redis.hget<string>(LINKS_KEY, slug),
    redis.sismember(DISABLED_KEY, slug),
  ]);

  // Unknown slug, or one that's been disabled → fall through to the homepage.
  if (!url || disabled) return NextResponse.next();

  // Record the hit before redirecting. Awaited so it isn't dropped when the
  // serverless function freezes after the response is sent. A ?src=qr marker
  // (set by the generated QR code) also bumps a separate scan counter, so
  // scans are a tracked subset of total clicks.
  const fromQr = req.nextUrl.searchParams.get("src") === "qr";
  const ua = req.headers.get("user-agent") ?? "";
  const event: HitEvent = {
    t: Date.now(),
    src: fromQr ? "qr" : "direct",
    ...parseUa(ua),
    ref: refHost(req.headers.get("referer")),
    country: geoValue(req.headers.get("x-vercel-ip-country")),
    city: geoValue(req.headers.get("x-vercel-ip-city")),
  };

  // Counters for quick totals + a capped log of individual hits, all in one
  // round trip. LTRIM keeps only the most recent EVENTS_LIMIT entries.
  const pipe = redis.pipeline();
  pipe.hincrby(CLICKS_KEY, slug, 1);
  if (fromQr) pipe.hincrby(SCANS_KEY, slug, 1);
  pipe.lpush(eventsKey(slug), event);
  pipe.ltrim(eventsKey(slug), 0, EVENTS_LIMIT - 1);
  await pipe.exec();

  // 307 = temporary redirect. We deliberately avoid 301/308 (permanent),
  // because browsers cache those hard — if you ever repoint /career to a
  // new URL, a permanent redirect could keep sending people to the old one.
  return NextResponse.redirect(url, 307);
}

// Don't run the proxy on framework internals, the admin UI, the API,
// or obvious static files. Everything else is treated as a possible slug.
export const config = {
  matcher: ["/((?!_next/|admin|api/|favicon.ico|robots.txt|sitemap.xml).*)"],
};
