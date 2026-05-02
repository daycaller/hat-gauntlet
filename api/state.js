import { kv } from "../lib/redis.js";
import { K, defaultState, applyDrain, rollHazard, getRecentEvents } from "../lib/kv.js";
import { awardDailyTop3IfDue } from "../lib/badges.js";
import { getBurnState } from "../lib/burn.js";
export default async function handler(req) {
  if (req.method !== "GET") {
    return new Response("Method not allowed", { status: 405 });
  }

  try {
    console.log("[state] handler start");
    let state = await kv.get(K.STATE);
    console.log("[state] got state:", state ? "exists" : "null");
    if (!state) state = defaultState();

    const now = Date.now();
    state = applyDrain(state, now);
    console.log("[state] applied drain");
    await rollHazard(state, now);
    console.log("[state] rolled hazard");

    await kv.set(K.STATE, state);
    console.log("[state] saved state");

    // Top 10 leaderboards
    const lbDayRaw = await kv.zrange(K.LB_DAY, 0, 9, { rev: true, withScores: true });
    const lbAllRaw = await kv.zrange(K.LB_ALL, 0, 9, { rev: true, withScores: true });
    const lbStreakRaw = await kv.zrange(K.LB_STREAK, 0, 9, { rev: true, withScores: true });
    console.log("[state] got leaderboards");

    const lbDay = parseLeaderboard(lbDayRaw);
    const lbAll = parseLeaderboard(lbAllRaw);
    const lbStreak = parseLeaderboard(lbStreakRaw);

    const events = await getRecentEvents(15);

    // Award daily top 3 badges if a new day has rolled over
    const today = new Date(now).toISOString().slice(0, 10);
    try { await awardDailyTop3IfDue(K.LB_DAY, today); } catch (e) {}

    // Burn pool / vault state (lightweight read)
    let burn = null;
    try { burn = await getBurnState(); } catch (e) {}

    return jsonResponse({
      state,
      leaderboards: { day: lbDay, all: lbAll, streak: lbStreak },
      events,
      burn,
      serverTime: now
    });
  } catch (err) {
    return jsonResponse({
      error: "state_failed",
      message: String(err?.message || err)
    }, 500);
  }
}

function parseLeaderboard(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (let i = 0; i < raw.length; i += 2) {
    const memberStr = raw[i];
    const score = raw[i + 1];
    let entry;
    try {
      entry = typeof memberStr === "string" ? JSON.parse(memberStr) : memberStr;
    } catch {
      entry = { name: String(memberStr) };
    }
    out.push({ ...entry, score: Number(score) });
  }
  return out;
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
