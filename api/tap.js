import { kv } from "../lib/redis.js";
import {
  K, defaultState, applyDrain, rollHazard,
  TAP_BASE_AMT, TAP_HOLDER_AMT, TAP_COOLDOWN_MS,
  rateLimit, rateLimitId, sanitizeName, isHolder
} from "../lib/kv.js";
import { isBanned } from "../lib/admin.js";
import { checkHazardHero, checkSurvivor } from "../lib/badges.js";
import { addToBurnPool, BURN_PER_TAP_ANON, BURN_PER_TAP_HOLDER } from "../lib/burn.js";
export default async function handler(req) {
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  let body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "bad_json" }, 400);
  }

  const name = sanitizeName(body?.name);
  const wallet = typeof body?.wallet === "string" ? body.wallet : null;
  const ip = (req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "")
    .split(",")[0].trim();

  // Ban check
  const banReason = await isBanned(name, ip);
  if (banReason) {
    return jsonResponse({ error: "banned", reason: banReason }, 403);
  }

  // Rate limit per (ip + name)
  const id = rateLimitId(req, name);
  const rl = await rateLimit(K.TAP_LOCK(id), TAP_COOLDOWN_MS);
  if (!rl.ok) {
    return jsonResponse({ error: "cooldown", waitMs: rl.waitMs }, 429);
  }

  // Verify holder if a wallet was sent (cached for 10min in lib)
  let holder = false;
  if (wallet) {
    holder = await isHolder(wallet);
  }

  // Update state
  let state = await kv.get(K.STATE);
  if (!state) state = defaultState();

  const now = Date.now();
  state = applyDrain(state, now);

  if (state.fallenAt) {
    return jsonResponse({ error: "hat_fallen", state }, 409);
  }

  if (state.meter >= 100) {
    return jsonResponse({ error: "max_stability", state }, 409);
  }

  const meterBeforeTap = state.meter;
  const amt = holder ? TAP_HOLDER_AMT : TAP_BASE_AMT;
  state.meter = Math.min(100, state.meter + amt);
  state.totalTaps = (state.totalTaps || 0) + 1;
  state.lastUpdate = now;

  // Roll a hazard while we're here (so hazard scheduling doesn't depend on state polls)
  await rollHazard(state, now);

  await kv.set(K.STATE, state);

  // Update leaderboards
  const memberId = JSON.stringify({ name, holder });
  await kv.zincrby(K.LB_DAY, amt, memberId);
  await kv.zincrby(K.LB_ALL, amt, memberId);
  const currentStreak = now - (state.streakStart || now);
  await kv.zadd(K.LB_STREAK, { score: currentStreak, member: memberId });

  // === BADGE CHECKS ===
  const newBadges = [];
  try {
    const heroBadge = await checkHazardHero(memberId, meterBeforeTap);
    if (heroBadge) newBadges.push(heroBadge);
  } catch (e) {}
  try {
    const survivorBadge = await checkSurvivor(memberId, state.streakStart);
    if (survivorBadge) newBadges.push(survivorBadge);
  } catch (e) {}

  // === BURN POOL CONTRIBUTION ===
  // Each tap adds a small amount to the burn pool. When the pool reaches
  // BURN_THRESHOLD (10k tokens), an admin can trigger a burn.
  let burnContribution = 0;
  let burnPool = null;
  try {
    burnContribution = holder ? BURN_PER_TAP_HOLDER : BURN_PER_TAP_ANON;
    burnPool = await addToBurnPool(burnContribution);
  } catch (e) { /* don't fail tap if burn KV fails */ }

  return jsonResponse({
    ok: true,
    amount: amt,
    holder,
    state,
    cooldownMs: TAP_COOLDOWN_MS,
    newBadges,
    burn: {
      contributed: burnContribution,
      pool: burnPool
    }
  });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
