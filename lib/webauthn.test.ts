import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NextRequest } from "next/server";
import type { StoredCredential } from "./webauthn";
import { startTestRedis } from "../test/redis-harness";

let wa: typeof import("./webauthn");
let stopRedis: () => Promise<void>;

beforeAll(async () => {
  stopRedis = await startTestRedis();
  wa = await import("./webauthn");
});

afterAll(() => stopRedis());

describe("challenges", () => {
  it("stores a challenge and hands it back exactly once", async () => {
    const flowId = await wa.storeChallenge("challenge-abc");
    expect(await wa.takeChallenge(flowId)).toBe("challenge-abc");
    expect(await wa.takeChallenge(flowId)).toBeNull(); // consumed
  });

  it("returns null for a flow it never issued", async () => {
    expect(await wa.takeChallenge("no-such-flow")).toBeNull();
  });

  it("gives concurrent takers at most one winner", async () => {
    const flowId = await wa.storeChallenge("challenge-xyz");
    const results = await Promise.all([
      wa.takeChallenge(flowId),
      wa.takeChallenge(flowId),
      wa.takeChallenge(flowId),
    ]);
    expect(results.filter((r) => r === "challenge-xyz")).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(2);
  });

  it("keeps concurrent flows separate", async () => {
    const a = await wa.storeChallenge("c1");
    const b = await wa.storeChallenge("c2");
    expect(a).not.toBe(b);
    expect(await wa.takeChallenge(a)).toBe("c1");
    expect(await wa.takeChallenge(b)).toBe("c2");
  });
});

describe("credentials", () => {
  const cred: StoredCredential = {
    id: "cred-1",
    publicKey: "cGtleQ",
    counter: 0,
    transports: ["internal"],
    label: "MacBook",
    createdAt: 1700000000000,
  };

  it("round-trips a credential", async () => {
    expect(await wa.hasCredentials()).toBe(false);
    await wa.saveCredential(cred);
    expect(await wa.hasCredentials()).toBe(true);
    expect(await wa.getCredential("cred-1")).toEqual(cred);
    expect(await wa.listCredentials()).toEqual([cred]);
  });

  it("updateCounter bumps only the counter", async () => {
    await wa.updateCounter("cred-1", 42);
    expect(await wa.getCredential("cred-1")).toEqual({ ...cred, counter: 42 });
  });

  it("updateCounter ignores unknown credentials", async () => {
    await expect(wa.updateCounter("missing", 1)).resolves.toBeUndefined();
  });

  it("getCredential returns null for unknown ids", async () => {
    expect(await wa.getCredential("missing")).toBeNull();
  });
});

describe("base64url helpers", () => {
  it("round-trips bytes", () => {
    const bytes = new Uint8Array([0, 1, 2, 127, 250, 251, 252]);
    expect(Array.from(wa.fromBase64url(wa.toBase64url(bytes)))).toEqual(
      Array.from(bytes),
    );
  });
});

describe("relyingParty", () => {
  it("derives rpID and origin from forwarded headers", () => {
    const req = new NextRequest("http://internal/", {
      headers: {
        "x-forwarded-host": "carolanne.link",
        "x-forwarded-proto": "https",
      },
    });
    expect(wa.relyingParty(req)).toEqual({
      rpID: "carolanne.link",
      origin: "https://carolanne.link",
    });
  });

  it("assumes http for localhost", () => {
    const req = new NextRequest("http://internal/", {
      headers: { "x-forwarded-host": "localhost:3000" },
    });
    expect(wa.relyingParty(req)).toEqual({
      rpID: "localhost",
      origin: "http://localhost:3000",
    });
  });
});
