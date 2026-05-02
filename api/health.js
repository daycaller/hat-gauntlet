// Health check + Redis diagnostic.
// Hit this URL to see exactly what's working and what's not.
// Built to fail fast (5s max for any single operation).

import { Redis } from "@upstash/redis";

export default async function handler(req) {
  const result = {
    ok: true,
    time: new Date().toISOString(),
    nodeVersion: process.version,
    envCheck: {
      ADMIN_PASSWORD: !!process.env.ADMIN_PASSWORD,
      KV_REST_API_URL: !!process.env.KV_REST_API_URL,
      KV_REST_API_TOKEN: !!process.env.KV_REST_API_TOKEN,
      UPSTASH_REDIS_REST_URL: !!process.env.UPSTASH_REDIS_REST_URL,
      UPSTASH_REDIS_REST_TOKEN: !!process.env.UPSTASH_REDIS_REST_TOKEN,
      REDIS_URL: !!process.env.REDIS_URL,
      KV_URL: !!process.env.KV_URL,
      VAULT_PRIVATE_KEY: !!process.env.VAULT_PRIVATE_KEY
    },
    urlPreview: null,
    redisCheck: { ok: false, message: null, durationMs: null }
  };

  // Pick the best URL
  let url = null;
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_URL.startsWith("https://")) {
    url = process.env.UPSTASH_REDIS_REST_URL;
  } else if (process.env.KV_REST_API_URL && process.env.KV_REST_API_URL.startsWith("https://")) {
    url = process.env.KV_REST_API_URL;
  }
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

  if (url) result.urlPreview = url.slice(0, 35) + "...";

  if (!url || !token) {
    result.ok = false;
    result.redisCheck.message = "Missing env vars (no https url or no token)";
  } else {
    // Test Redis with hard 5s timeout
    const start = Date.now();
    try {
      const redis = new Redis({
        url,
        token,
        retry: { retries: 1, backoff: () => 200 }
      });

      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Redis call timed out after 5s")), 5000)
      );
      const value = await Promise.race([redis.get("__healthcheck__"), timeout]);

      result.redisCheck.ok = true;
      result.redisCheck.message = "Redis OK. Got value: " + JSON.stringify(value);
      result.redisCheck.durationMs = Date.now() - start;
    } catch (err) {
      result.ok = false;
      result.redisCheck.message = "Redis FAILED: " + String(err?.message || err);
      result.redisCheck.durationMs = Date.now() - start;
      result.redisCheck.errorStack = String(err?.stack || "").split("\n").slice(0, 3).join(" | ");
    }
  }

  return new Response(JSON.stringify(result, null, 2), {
    status: result.ok ? 200 : 500,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
