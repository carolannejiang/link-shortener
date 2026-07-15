import { randomBytes } from "node:crypto";
import { NextRequest } from "next/server";
import type { AuthenticatorTransportFuture } from "@simplewebauthn/server";
import { redis } from "@/lib/redis";

// --- Relying Party (this site) -------------------------------------------

// A passkey is bound to a specific domain ("relying party"). We derive it from
// the request so it Just Works on localhost in dev and on the real domain in
// prod, but allow env overrides for edge cases (custom proxies, etc.).
export function relyingParty(req: NextRequest): {
  rpID: string;
  origin: string;
} {
  const host =
    req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? "";
  const proto =
    req.headers.get("x-forwarded-proto") ??
    (host.startsWith("localhost") ? "http" : "https");

  const origin = process.env.RP_ORIGIN ?? `${proto}://${host}`;
  const rpID = process.env.RP_ID ?? new URL(origin).hostname;
  return { rpID, origin };
}

export const RP_NAME = "carolanne.link";

// --- Stored credentials ---------------------------------------------------

// One Redis hash holds every registered passkey: field = credential id
// (base64url), value = JSON describing the credential.
const CREDS_KEY = "webauthn:creds";

// Upper bound on a credential's human label, so a hand-crafted request can't
// stuff the hash with junk.
export const MAX_LABEL_LEN = 64;

export type StoredCredential = {
  id: string; // base64url credential ID
  publicKey: string; // base64url COSE public key
  counter: number;
  transports?: AuthenticatorTransportFuture[];
  label: string; // human label, e.g. "MacBook"
  createdAt: number;
};

export async function listCredentials(): Promise<StoredCredential[]> {
  const all =
    (await redis.hgetall<Record<string, StoredCredential>>(CREDS_KEY)) ?? {};
  return Object.values(all);
}

export async function hasCredentials(): Promise<boolean> {
  return (await redis.hlen(CREDS_KEY)) > 0;
}

export async function getCredential(
  id: string,
): Promise<StoredCredential | null> {
  return (await redis.hget<StoredCredential>(CREDS_KEY, id)) ?? null;
}

export async function saveCredential(cred: StoredCredential): Promise<void> {
  await redis.hset(CREDS_KEY, { [cred.id]: cred });
}

export async function updateCounter(
  id: string,
  counter: number,
): Promise<void> {
  const cred = await getCredential(id);
  if (!cred) return;
  await redis.hset(CREDS_KEY, { [id]: { ...cred, counter } });
}

// --- One-time challenges --------------------------------------------------

// Each register/login flow gets a random id. We stash the server's challenge in
// Redis under that id (short TTL) and hand the id back to the browser, which
// returns it on the verify step. This keeps concurrent tabs/devices from
// clobbering each other's challenge.
const challengeKey = (flowId: string) => `webauthn:chal:${flowId}`;
const CHALLENGE_TTL_SECONDS = 300; // 5 minutes

export async function storeChallenge(challenge: string): Promise<string> {
  const flowId = randomBytes(16).toString("base64url");
  await redis.set(challengeKey(flowId), challenge, {
    ex: CHALLENGE_TTL_SECONDS,
  });
  return flowId;
}

// Fetch and consume (delete) the challenge for a flow. Null if expired/unknown.
// GETDEL is atomic, so two concurrent verify attempts can never both get the
// same challenge — the loser sees null and fails cleanly.
export async function takeChallenge(flowId: string): Promise<string | null> {
  return redis.getdel<string>(challengeKey(flowId));
}

// --- base64url <-> bytes helpers -----------------------------------------

export function toBase64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function fromBase64url(str: string): Uint8Array<ArrayBuffer> {
  const buf = Buffer.from(str, "base64url");
  const out = new Uint8Array(new ArrayBuffer(buf.byteLength));
  out.set(buf);
  return out;
}
