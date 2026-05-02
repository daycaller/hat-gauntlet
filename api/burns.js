import { kv } from "@vercel/kv";
import { BURN_KEYS, BURN_THRESHOLD, SOLANA_BURN_ADDRESS, hasVaultKey } from "../lib/burn.js";
export default async function handler(req) {
  if (req.method !== "GET") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  try {
    const [pool, total, lastTs, allBurns] = await Promise.all([
      kv.get(BURN_KEYS.POOL),
      kv.get(BURN_KEYS.TOTAL_BURNED),
      kv.get(BURN_KEYS.LAST_BURN_TS),
      kv.zrange(BURN_KEYS.BURNS, 0, 99, { rev: true })
    ]);

    const burns = (allBurns || []).map(s => {
      try { return typeof s === "string" ? JSON.parse(s) : s; }
      catch { return null; }
    }).filter(Boolean);

    return jsonResponse({
      pool: Number(pool) || 0,
      threshold: BURN_THRESHOLD,
      totalBurned: Number(total) || 0,
      lastBurnTs: lastTs ? Number(lastTs) : null,
      burnCount: burns.length,
      burns,
      burnAddress: SOLANA_BURN_ADDRESS,
      vaultConfigured: hasVaultKey(),
      vaultAddress: process.env.VAULT_PUBLIC_ADDRESS || null
    });
  } catch (err) {
    return jsonResponse({ error: "burns_failed", message: String(err?.message || err) }, 500);
  }
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
