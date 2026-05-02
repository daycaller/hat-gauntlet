// =====================================================================
// REDIS CLIENT — replaces @vercel/kv (sunset by Vercel in 2024).
//
// We use @upstash/redis directly. The env vars depend on how the user
// connected the database in Vercel:
//
//   - Vercel Marketplace Upstash integration (the modern way) sets:
//     KV_REST_API_URL + KV_REST_API_TOKEN (legacy compat names)
//     and may also set UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
//
//   - Direct Upstash account integration sets:
//     UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN
//
// Redis.fromEnv() only looks at UPSTASH_REDIS_REST_*, so we try both
// pairs explicitly to cover all cases.
// =====================================================================
import { Redis } from "@upstash/redis";

const url =
  process.env.UPSTASH_REDIS_REST_URL ||
  process.env.KV_REST_API_URL ||
  process.env.REDIS_URL;

const token =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.KV_REST_API_TOKEN;

if (!url || !token) {
  // Throw a clear error early. Vercel will surface this in function logs.
  console.error("[redis] Missing env vars. Need either:");
  console.error("  - UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN, or");
  console.error("  - KV_REST_API_URL + KV_REST_API_TOKEN");
  console.error("Available env vars:", Object.keys(process.env).filter(k =>
    k.includes("KV") || k.includes("UPSTASH") || k.includes("REDIS")
  ));
}

export const kv = new Redis({ url, token });
