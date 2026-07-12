import { NextFetchEvent, NextRequest, NextResponse } from "next/server";
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
import { SLUG_RE, MAX_SLUG_LEN, type HitEvent } from "@/lib/links";

// Full user-agent parse: precise browser/OS versions, device vendor + model,
// and crawler detection (bots come back with browser.type === "crawler"). The
// Bots extension adds the crawler signatures on top of the default matchers.
function parseUa(ua: string): Pick<HitEvent, "device" | "os" | "browser" | "model"> {
  const r = new UAParser(ua, Bots).getResult();
  // The Bots extension tags search engines as "crawler" and link unfurlers
  // (Slackbot, WhatsApp, iMessage previews, …) as "fetcher" — both are bots.
  const isBot = r.browser.type === "crawler" || r.browser.type === "fetcher";
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

// Everything a hit record needs from the request, captured before the
// response goes out. The expensive parts (UA parsing, Redis writes) run
// afterwards, off the visitor's clock.
type HitContext = {
  t: number;
  fromQr: boolean;
  ua: string;
  referer: string | null;
  country: string | null;
  city: string | null;
};

// Counters for quick totals + a capped log of individual hits, all in one
// round trip. LTRIM keeps only the most recent EVENTS_LIMIT entries.
async function recordHit(slug: string, ctx: HitContext) {
  const parsed = parseUa(ctx.ua);
  const event: HitEvent = {
    t: ctx.t,
    src: ctx.fromQr ? "qr" : "direct",
    ...parsed,
    ref: refHost(ctx.referer),
    country: geoValue(ctx.country),
    city: geoValue(ctx.city),
  };
  const pipe = redis.pipeline();
  // Link-preview crawlers (iMessage, Slack, WhatsApp, …) fetch every shared
  // link. They stay visible in the event log, but don't inflate the human
  // click/scan counters.
  if (parsed.device !== "bot") {
    pipe.hincrby(CLICKS_KEY, slug, 1);
    if (ctx.fromQr) pipe.hincrby(SCANS_KEY, slug, 1);
  }
  pipe.lpush(eventsKey(slug), event);
  pipe.ltrim(eventsKey(slug), 0, EVENTS_LIMIT - 1);
  await pipe.exec();
}

// This runs on the server before the request reaches a page. For any path like
// /career it looks the slug up in Redis and, if found, fires a redirect to the
// real destination. Unknown paths fall through.
export async function proxy(req: NextRequest, event: NextFetchEvent) {
  let slug: string;
  try {
    // Lowercased so hand-typed links like /Career still resolve — slugs are
    // always stored lowercase.
    slug = decodeURIComponent(req.nextUrl.pathname.slice(1)).toLowerCase(); // drop leading "/"
  } catch {
    return NextResponse.next(); // malformed %-encoding can't be a slug
  }

  if (!slug) return NextResponse.next(); // homepage

  // Paths that can't possibly be a slug skip the Redis lookup entirely.
  if (slug.length > MAX_SLUG_LEN || !SLUG_RE.test(slug)) {
    return NextResponse.next();
  }

  // Look up the destination and the disabled flag together; auto-pipelining
  // folds the pair into a single round trip.
  const [url, disabled] = await Promise.all([
    redis.hget<string>(LINKS_KEY, slug),
    redis.sismember(DISABLED_KEY, slug),
  ]);

  // Unknown slug, or one that's been disabled → fall through to the 404 page.
  if (!url || disabled) return NextResponse.next();

  // Defensive: a stored URL should always parse (the API validates it), but a
  // hand-edited Redis value shouldn't take the whole route down.
  let dest: URL;
  try {
    dest = new URL(url);
  } catch {
    return NextResponse.next();
  }

  // Forward the visitor's query params to the destination — minus our
  // internal ?src marker — so things like UTM tags survive the hop. Params
  // the visitor supplies win over ones baked into the stored URL.
  for (const [key, value] of req.nextUrl.searchParams) {
    if (key !== "src") dest.searchParams.set(key, value);
  }

  // Record the hit without making the visitor wait for it: waitUntil keeps
  // the function alive after the redirect is sent, so the write still isn't
  // dropped when the runtime freezes. A ?src=qr marker (set by the generated
  // QR code) also bumps a separate scan counter, so scans are a tracked
  // subset of total clicks.
  event.waitUntil(
    recordHit(slug, {
      t: Date.now(),
      fromQr: req.nextUrl.searchParams.get("src") === "qr",
      ua: req.headers.get("user-agent") ?? "",
      referer: req.headers.get("referer"),
      country: req.headers.get("x-vercel-ip-country"),
      city: req.headers.get("x-vercel-ip-city"),
    }).catch((err) => console.error(`failed to record hit for /${slug}`, err)),
  );

  // 307 = temporary redirect. We deliberately avoid 301/308 (permanent),
  // because browsers cache those hard — if you ever repoint /career to a
  // new URL, a permanent redirect could keep sending people to the old one.
  return NextResponse.redirect(dest, 307);
}

// Don't run the proxy on framework internals, the admin UI, the API, or any
// path containing a dot (favicon.ico, wp-login.php probes, … — real slugs
// never contain one). "admin" is anchored so slugs that merely start with it
// (e.g. /admin-panel) still resolve.
export const config = {
  matcher: ["/((?!_next/|admin$|api$|api/)[^.]*)"],
};
