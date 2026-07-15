import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import { startTestRedis } from "../test/redis-harness";

let rl: typeof import("./rate-limit");
let stopRedis: () => Promise<void>;

beforeAll(async () => {
  stopRedis = await startTestRedis();
  rl = await import("./rate-limit");
});

afterAll(() => stopRedis());

describe("clientIp", () => {
  it("takes the first x-forwarded-for entry", () => {
    const req = new NextRequest("http://test.local/", {
      headers: { "x-forwarded-for": " 1.2.3.4 , 10.0.0.1" },
    });
    expect(rl.clientIp(req)).toBe("1.2.3.4");
  });

  it("falls back to 'unknown' without a proxy header", () => {
    expect(rl.clientIp(new NextRequest("http://test.local/"))).toBe("unknown");
  });
});

describe("strike / clearStrikes", () => {
  it("counts per (bucket, id)", async () => {
    expect(await rl.strike("bucket-a", "1.1.1.1")).toBe(1);
    expect(await rl.strike("bucket-a", "1.1.1.1")).toBe(2);
    expect(await rl.strike("bucket-a", "2.2.2.2")).toBe(1);
    expect(await rl.strike("bucket-b", "1.1.1.1")).toBe(1);
  });

  it("clearStrikes restarts the window", async () => {
    await rl.strike("bucket-c", "1.1.1.1");
    await rl.strike("bucket-c", "1.1.1.1");
    await rl.clearStrikes("bucket-c", "1.1.1.1");
    expect(await rl.strike("bucket-c", "1.1.1.1")).toBe(1);
  });

  it("hands concurrent strikes distinct counts (INCR is atomic)", async () => {
    const counts = await Promise.all(
      Array.from({ length: 10 }, () => rl.strike("bucket-d", "1.1.1.1")),
    );
    expect([...counts].sort((a, b) => a - b)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10,
    ]);
  });
});
