import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { startTestRedis } from "../test/redis-harness";

const PASSWORD = "correct horse battery staple";

let auth: typeof import("./auth");
let stopRedis: () => Promise<void>;

beforeAll(async () => {
  stopRedis = await startTestRedis();
  process.env.ADMIN_PASSWORD = PASSWORD;
  auth = await import("./auth");
});

afterAll(() => stopRedis());

// Every test gets its own IP so the per-IP rate-limit windows don't interfere.
function withPassword(password: string, ip: string) {
  return new NextRequest("http://test.local/api/links", {
    headers: { "x-admin-password": password, "x-forwarded-for": ip },
  });
}

describe("authorized (password)", () => {
  it("accepts the configured password", async () => {
    expect(await auth.authorized(withPassword(PASSWORD, "10.0.0.1"))).toBe(true);
  });

  it("rejects a wrong password", async () => {
    expect(await auth.authorized(withPassword("nope", "10.0.0.2"))).toBe(false);
  });

  it("rejects a request with no password and no session", async () => {
    expect(await auth.authorized(new NextRequest("http://test.local/"))).toBe(
      false,
    );
  });

  it("stops comparing once the window's attempts are spent", async () => {
    const ip = "10.0.0.3";
    for (let i = 0; i < 10; i++) {
      expect(await auth.authorized(withPassword("guess", ip))).toBe(false);
    }
    // Budget exhausted: even the correct password is refused this window.
    expect(await auth.authorized(withPassword(PASSWORD, ip))).toBe(false);
  });

  it("resets the failure count after a successful unlock", async () => {
    const ip = "10.0.0.4";
    for (let i = 0; i < 9; i++) {
      await auth.authorized(withPassword("guess", ip));
    }
    expect(await auth.authorized(withPassword(PASSWORD, ip))).toBe(true);
    // Without the reset, these nine would tip the window over its limit.
    for (let i = 0; i < 9; i++) {
      await auth.authorized(withPassword("guess", ip));
    }
    expect(await auth.authorized(withPassword(PASSWORD, ip))).toBe(true);
  });
});

describe("sessions", () => {
  async function login(): Promise<string> {
    const res = NextResponse.json({ ok: true });
    await auth.startSession(res);
    return res.cookies.get("cl_session")!.value;
  }

  const asSession = (token: string) =>
    new NextRequest("http://test.local/", {
      headers: { cookie: `cl_session=${token}` },
    });

  it("startSession hands out a cookie that authorizes requests", async () => {
    const token = await login();
    expect(token.length).toBeGreaterThan(20);
    expect(await auth.hasValidSession(asSession(token))).toBe(true);
    expect(await auth.authorized(asSession(token))).toBe(true);
  });

  it("rejects a token it never issued", async () => {
    expect(await auth.hasValidSession(asSession("forged-token"))).toBe(false);
  });

  it("endSession revokes the session and clears the cookie", async () => {
    const token = await login();
    const res = NextResponse.json({ ok: true });
    await auth.endSession(asSession(token), res);
    expect(await auth.hasValidSession(asSession(token))).toBe(false);
    expect(res.cookies.get("cl_session")?.value).toBe("");
  });
});
