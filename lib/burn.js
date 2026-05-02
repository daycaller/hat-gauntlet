// =====================================================================
// BURN VAULT — KV operations only.
//
// IMPORTANT: This file is imported by Edge runtime functions
// (api/state.js, api/tap.js, api/burns.js). It must NOT import
// any Node-only packages (no @solana/web3.js, no spl-token, no bs58).
//
// The on-chain transaction logic lives in lib/burn-onchain.js,
// which is only imported by api/admin/burn.js (Node.js runtime).
//
// Mechanics:
//   1. Every tap contributes a small amount to the burn pool (off-chain counter in KV)
//      - Anon: BURN_PER_TAP_ANON
//      - Holder: BURN_PER_TAP_HOLDER (4x boost)
//   2. When the pool reaches BURN_THRESHOLD (10,000 by default), the admin panel
//      shows a "READY TO BURN" button. Admin clicks → server signs and broadcasts
//      a token-burn transaction from the vault wallet to the Solana burn address.
//   3. After a successful burn, pool resets and burn is logged to the burn history.
//
// Custody:
//   The vault keypair is stored in the VAULT_PRIVATE_KEY env var (base58). Whoever
//   has access to that env var custodies the community vault. Document this clearly
//   on the public /burns page so users understand the trust model.
// =====================================================================
import { kv } from "@vercel/kv";

// =====================================================================
// CONFIG
// =====================================================================
export const BURN_PER_TAP_ANON = 0.020;   // tokens contributed per non-holder tap
export const BURN_PER_TAP_HOLDER = 0.080; // tokens per holder tap (4x)
export const BURN_THRESHOLD = 10000;      // tokens needed before a burn can fire
export const SOLANA_BURN_ADDRESS = "1nc1nerator11111111111111111111111111111111";

// =====================================================================
// KV KEYS
// =====================================================================
export const BURN_KEYS = {
  POOL: "hg:burn:pool",            // current pool balance (number)
  TOTAL_BURNED: "hg:burn:total",   // lifetime burned (number)
  BURNS: "hg:burn:history",        // sorted set: ts -> JSON {amount, txSig, burnedAt}
  LAST_BURN_TS: "hg:burn:last_ts", // timestamp of last successful burn
  BURN_LOCK: "hg:burn:lock"        // mutex to prevent concurrent burns
};

// =====================================================================
// CORE OPERATIONS (Edge-safe)
// =====================================================================

// Increment the burn pool. Returns the new pool size.
// Called from /api/tap on every successful tap.
export async function addToBurnPool(amount) {
  if (!amount || amount <= 0) return null;
  const newPool = await kv.incrbyfloat(BURN_KEYS.POOL, amount);
  return Number(newPool);
}

// Get current pool + total + last burn info for display.
export async function getBurnState() {
  const [pool, total, lastTs, recent] = await Promise.all([
    kv.get(BURN_KEYS.POOL),
    kv.get(BURN_KEYS.TOTAL_BURNED),
    kv.get(BURN_KEYS.LAST_BURN_TS),
    kv.zrange(BURN_KEYS.BURNS, 0, 9, { rev: true })
  ]);

  const burns = (recent || []).map(s => {
    try { return typeof s === "string" ? JSON.parse(s) : s; }
    catch { return null; }
  }).filter(Boolean);

  return {
    pool: Number(pool) || 0,
    threshold: BURN_THRESHOLD,
    totalBurned: Number(total) || 0,
    lastBurnTs: lastTs ? Number(lastTs) : null,
    recentBurns: burns,
    isReady: (Number(pool) || 0) >= BURN_THRESHOLD,
    vaultConfigured: hasVaultKey()
  };
}

export function hasVaultKey() {
  return !!process.env.VAULT_PRIVATE_KEY;
}

// =====================================================================
// EXECUTE BURN — orchestration only.
//
// The actual on-chain signing happens in lib/burn-onchain.js.
// Called from POST /api/admin/burn (Node.js runtime).
// We accept the sender function as a parameter so this file stays Edge-safe
// and never statically imports anything Solana-related.
// =====================================================================
export async function executeBurn(sendOnchain, amountOverride = null) {
  if (!hasVaultKey()) {
    return { ok: false, error: "vault_not_configured" };
  }

  // Prevent concurrent execution
  const acquired = await kv.set(BURN_KEYS.BURN_LOCK, Date.now(), { nx: true, ex: 60 });
  if (!acquired) return { ok: false, error: "burn_in_progress" };

  try {
    const pool = Number(await kv.get(BURN_KEYS.POOL)) || 0;
    const amount = amountOverride !== null ? amountOverride : pool;

    if (amount <= 0) {
      return { ok: false, error: "empty_pool" };
    }

    // Check pool meets threshold (unless override)
    if (amountOverride === null && pool < BURN_THRESHOLD) {
      return { ok: false, error: "below_threshold", pool, threshold: BURN_THRESHOLD };
    }

    // Sign and send the burn transaction (function passed in by caller — Node.js only)
    const result = await sendOnchain(amount);
    if (!result.ok) {
      return { ok: false, error: result.error || "tx_failed", details: result };
    }

    // Success — update pool, total, history
    const burnedAt = Date.now();
    const burnRecord = {
      amount,
      txSig: result.txSig,
      burnedAt,
      explorerUrl: "https://solscan.io/tx/" + result.txSig
    };

    // Decrement pool by burned amount, increment total
    await kv.incrbyfloat(BURN_KEYS.POOL, -amount);
    await kv.incrbyfloat(BURN_KEYS.TOTAL_BURNED, amount);
    await kv.set(BURN_KEYS.LAST_BURN_TS, burnedAt);
    await kv.zadd(BURN_KEYS.BURNS, { score: burnedAt, member: JSON.stringify(burnRecord) });
    // Keep last 100 burns
    await kv.zremrangebyrank(BURN_KEYS.BURNS, 0, -101);

    return { ok: true, burn: burnRecord };
  } finally {
    // Always release the lock
    await kv.del(BURN_KEYS.BURN_LOCK);
  }
}
