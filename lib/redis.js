// =====================================================================
// REDIS CLIENT — uses @upstash/redis (HTTPS REST protocol).
//
// Configured to fail fast (1 retry max, no exponential backoff) so
// problems are visible immediately rather than hanging for minutes.
// =====================================================================
import { Redis } from "@upstash/redis";

function pickHttpsUrl() {
  const candidates = [
    process.env.UPSTASH_REDIS_REST_URL,
    process.env.KV_REST_API_URL
  ];
  for (const c of candidates) {
    if (c && c.startsWith("https://")) return c;
  }
  return null;
}

const url = pickHttpsUrl();
const token =
  process.env.UPSTASH_REDIS_REST_TOKEN ||
  process.env.KV_REST_API_TOKEN ||
  null;

// Log on every cold start so we can see what env vars are visible
console.log("[redis] init — url:", url ? url.slice(0, 30) + "..." : "(MISSING)",
            "| token:", token ? "(set, " + token.length + " chars)" : "(MISSING)");

if (!url || !token) {
  console.error("[redis] FATAL: cannot connect — env vars missing.");
  console.error("[redis] Available env keys matching KV/UPSTASH/REDIS:",
    Object.keys(process.env).filter(k =>
      k.includes("KV") || k.includes("UPSTASH") || k.includes("REDIS")
    )
  );
}

// Construct client with aggressive failure mode:
// - retries: 1 (default is 5)
// - simple backoff (default is exponential)
// This way operations fail in ~1-2 seconds instead of ~12+ seconds when broken.
export const kv = new Redis({
  url: url || "https://placeholder-not-configured.example.com",
  token: token || "placeholder-token",
  retry: {
    retries: 1,
    backoff: () => 200
  }
});
