// =====================================================================
// REDIS CLIENT — uses @upstash/redis (HTTPS REST protocol).
//
// We ONLY accept https:// URLs. The Upstash client cannot speak the
// raw redis:// TCP protocol that Redis Cloud / Redis Labs uses.
//
// Vercel Marketplace Upstash integration sets these env vars:
//   - UPSTASH_REDIS_REST_URL  + UPSTASH_REDIS_REST_TOKEN  (preferred)
//   - KV_REST_API_URL         + KV_REST_API_TOKEN         (legacy compat)
//
// If you only see REDIS_URL (TCP url starting with redis://), you
// connected the WRONG database type. Disconnect Redis Cloud / Redis Labs
// and connect "Upstash → Redis" from the Storage marketplace instead.
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

if (!url || !token) {
  // Log helpful diagnostics — these show up in Vercel function logs
  console.error("[redis] FATAL: missing Upstash HTTPS env vars.");
  console.error("[redis] Need UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN,");
  console.error("[redis] or KV_REST_API_URL + KV_REST_API_TOKEN (legacy compat).");
  console.error("[redis] DO NOT use REDIS_URL — that's a TCP redis:// URL from Redis Cloud, incompatible.");
  console.error("[redis] Available env vars matching KV/UPSTASH/REDIS:",
    Object.keys(process.env).filter(k =>
      k.includes("KV") || k.includes("UPSTASH") || k.includes("REDIS")
    )
  );
  console.error("[redis] Got url:", url ? url.slice(0, 30) + "..." : "(missing)");
  console.error("[redis] Got token:", token ? "(set)" : "(missing)");
}

// We construct the client even if env vars are missing so module load doesn't crash.
// Operations will fail with a clear error at call time instead.
export const kv = new Redis({
  url: url || "https://invalid-please-configure-upstash.example.com",
  token: token || "missing-token"
});
