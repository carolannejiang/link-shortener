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

// Has this (bucket, id) used up its budget for the current window?
export async function overLimit(
  bucket: string,
  id: string,
  limit: number,
): Promise<boolean> {
  const count = await redis.get<number>(rlKey(bucket, id));
  return (count ?? 0) >= limit;
}

// Count one event; returns the window's running total.
export async function strike(bucket: string, id: string): Promise<number> {
  const key = rlKey(bucket, id);
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, WINDOW_SECONDS);
  return count;
}
