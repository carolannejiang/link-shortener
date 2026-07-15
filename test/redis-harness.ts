import type { AddressInfo } from "node:net";
import { createLocalRedis } from "../scripts/local-redis.mjs";

// Boot the same in-memory Upstash shim `npm run dev` can use, on an ephemeral
// port, and point the app's Redis client at it. lib/redis.ts reads the
// connection env at import time, so tests must call this BEFORE importing
// anything under lib/ that touches Redis (use `await import(...)` in
// beforeAll). Returns a function that shuts the shim down.
export async function startTestRedis(): Promise<() => Promise<void>> {
  const server = createLocalRedis();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;

  process.env.KV_REST_API_URL = `http://127.0.0.1:${port}`;
  process.env.KV_REST_API_TOKEN = "test-token";

  return () =>
    new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
}
