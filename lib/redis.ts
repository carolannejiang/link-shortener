import { Redis } from "@upstash/redis";

// Vercel's Redis Marketplace integrations expose their credentials under one of
// two naming schemes depending on the provider. We accept either so you don't
// have to care which one you picked.
const url = process.env.KV_REST_API_URL ?? process.env.UPSTASH_REDIS_REST_URL;
const token =
  process.env.KV_REST_API_TOKEN ?? process.env.UPSTASH_REDIS_REST_TOKEN;

if (!url || !token) {
  throw new Error(
    "Missing Redis credentials. Set KV_REST_API_URL + KV_REST_API_TOKEN " +
      "(or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN).",
  );
}

export const redis = new Redis({ url, token });

// Every link is one field in a single Redis hash: field = slug, value = URL.
export const LINKS_KEY = "links";
