import { NextRequest } from "next/server";
import { redis } from "@/lib/redis";

// A minimal fixed-window rate limiter: one Redis counter per (bucket, id),
// expiring WINDOW_SECONDS after the window's first strike. Coarse, but plenty
// to blunt password guessing and challenge flooding on a single-admin site.

const WINDOW_SECONDS = 60;

const rlKey = (bucket: string, id: string) => `rl:${bucket}:${id}`;

// Best-effort caller identity. On Vercel the first x-forwarded-for entry is
// the real client IP; locally there's no proxy, so everything shares one
// bucket — fine for a limiter this coarse.
export function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

// Count one event; returns the window's running total. Compare against the
// returned count (INCR is atomic) rather than reading the counter separately —
// a read-then-increment lets a burst of concurrent requests all pass the check
// before any of their strikes land.
export async function strike(bucket: string, id: string): Promise<number> {
  const key = rlKey(bucket, id);
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, WINDOW_SECONDS);
  return count;
}

// Forget everything counted against (bucket, id) in the current window — e.g.
// after a successful unlock proves the caller isn't guessing.
export async function clearStrikes(bucket: string, id: string): Promise<void> {
  await redis.del(rlKey(bucket, id));
}
