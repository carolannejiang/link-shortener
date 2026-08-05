import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { NextRequest, type NextFetchEvent } from "next/server";
import { startTestRedis } from "./test/redis-harness";
import type { HitEvent } from "./lib/links";

// lib/redis.ts reads its connection env at import time, so everything that
// touches it is imported dynamically in beforeAll, after the shim is up.
let stop: () => Promise<void>;
let proxy: typeof import("./proxy").proxy;
let r: typeof import("./lib/redis");

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_4 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/18.4 Mobile/15E148 Safari/604.1";

beforeAll(async () => {
  stop = await startTestRedis();
  ({ proxy } = await import("./proxy"));
  r = await import("./lib/redis");
});

afterAll(() => stop());

// The shim has no FLUSHALL; clear the app's keys (and every event log the
// tests touch) so state can't leak between tests.
const SLUGS = ["career", "party", "sale", "fiesta", "nope"];
beforeEach(async () => {
  await r.redis.del(
    r.LINKS_KEY,
    r.ALIASES_KEY,
    r.CLICKS_KEY,
    r.SCANS_KEY,
    r.DISABLED_KEY,
    r.EXPIRES_KEY,
    ...SLUGS.map((s) => r.eventsKey(s)),
  );
});

// The proxy takes a NextFetchEvent only for waitUntil; capture the promises
// so tests can await the deferred hit recording.
function fakeEvent() {
  const tasks: Promise<unknown>[] = [];
  return {
    event: {
      waitUntil: (p: Promise<unknown>) => tasks.push(p),
    } as unknown as NextFetchEvent,
    flush: () => Promise.all(tasks),
  };
}

function request(path: string): NextRequest {
  return new NextRequest(`https://carolanne.link${path}`, {
    headers: { "user-agent": IPHONE_UA },
  });
}

async function loggedEvents(slug: string): Promise<HitEvent[]> {
  const raw = await r.redis.lrange(r.eventsKey(slug), 0, -1);
  return (raw ?? []).map((e) =>
    typeof e === "string" ? (JSON.parse(e) as HitEvent) : (e as HitEvent),
  );
}

describe("proxy hit recording", () => {
  it("redirects a live link and counts the click (and QR scan)", async () => {
    await r.redis.hset(r.LINKS_KEY, { career: "https://example.com/x" });
    const { event, flush } = fakeEvent();

    const res = await proxy(request("/career?src=qr"), event);
    await flush();

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://example.com/x");
    expect(Number(await r.redis.hget(r.CLICKS_KEY, "career"))).toBe(1);
    expect(Number(await r.redis.hget(r.SCANS_KEY, "career"))).toBe(1);
    const [hit] = await loggedEvents("career");
    expect(hit.src).toBe("qr");
    expect(hit.denied).toBeUndefined();
  });

  it("logs a denied hit for a disabled link without counting it", async () => {
    await r.redis.hset(r.LINKS_KEY, { party: "https://example.com/p" });
    await r.redis.sadd(r.DISABLED_KEY, "party");
    const { event, flush } = fakeEvent();

    const res = await proxy(request("/party?src=qr"), event);
    await flush();

    // Falls through to the app's 404 page rather than redirecting.
    expect(res.headers.get("location")).toBeNull();
    expect(await r.redis.hget(r.CLICKS_KEY, "party")).toBeNull();
    expect(await r.redis.hget(r.SCANS_KEY, "party")).toBeNull();
    const [hit] = await loggedEvents("party");
    expect(hit.denied).toBe(true);
    expect(hit.src).toBe("qr");
  });

  it("logs a denied hit for an expired link", async () => {
    await r.redis.hset(r.LINKS_KEY, { sale: "https://example.com/s" });
    await r.redis.hset(r.EXPIRES_KEY, { sale: Date.now() - 1000 });
    const { event, flush } = fakeEvent();

    const res = await proxy(request("/sale"), event);
    await flush();

    expect(res.headers.get("location")).toBeNull();
    expect(await r.redis.hget(r.CLICKS_KEY, "sale")).toBeNull();
    const [hit] = await loggedEvents("sale");
    expect(hit.denied).toBe(true);
  });

  it("logs a denied hit under the alias when its target is disabled", async () => {
    await r.redis.hset(r.LINKS_KEY, { party: "https://example.com/p" });
    await r.redis.hset(r.ALIASES_KEY, { fiesta: "party" });
    await r.redis.sadd(r.DISABLED_KEY, "party");
    const { event, flush } = fakeEvent();

    const res = await proxy(request("/fiesta"), event);
    await flush();

    expect(res.headers.get("location")).toBeNull();
    expect(await loggedEvents("fiesta")).toHaveLength(1);
    expect((await loggedEvents("fiesta"))[0].denied).toBe(true);
    expect(await loggedEvents("party")).toHaveLength(0);
  });

  it("records nothing for a slug that doesn't exist", async () => {
    const { event, flush } = fakeEvent();

    const res = await proxy(request("/nope"), event);
    await flush();

    expect(res.headers.get("location")).toBeNull();
    expect(await loggedEvents("nope")).toHaveLength(0);
  });
});
