import { NextRequest, NextResponse } from "next/server";
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
  device: string;
  os: string;
  browser: string;
  ref?: string; // referring host, if any
  country?: string;
  city?: string;
};

// Rough device class from the user-agent string. Not exhaustive, just enough
// to answer "phone vs. tablet vs. computer".
function deviceType(ua: string): string {
  if (!ua) return "unknown";
  if (/ipad|tablet|playbook|silk/i.test(ua) || (/android/i.test(ua) && !/mobile/i.test(ua)))
    return "tablet";
  if (/mobi|iphone|ipod|windows phone/i.test(ua)) return "mobile";
  return "desktop";
}

function osName(ua: string): string {
  if (/windows nt/i.test(ua)) return "Windows";
  if (/iphone|ipad|ipod/i.test(ua)) return "iOS";
  if (/mac os x/i.test(ua)) return "macOS";
  if (/android/i.test(ua)) return "Android";
  if (/linux/i.test(ua)) return "Linux";
  return "Other";
}

// Order matters: several browsers spoof "Safari"/"Chrome" in their UA.
function browserName(ua: string): string {
  if (/edg\//i.test(ua)) return "Edge";
  if (/opr\/|opera/i.test(ua)) return "Opera";
  if (/chrome\//i.test(ua)) return "Chrome";
  if (/firefox\//i.test(ua)) return "Firefox";
  if (/safari\//i.test(ua)) return "Safari";
  return "Other";
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
    device: deviceType(ua),
    os: osName(ua),
    browser: browserName(ua),
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
