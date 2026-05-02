// =====================================================================
// BADGE SYSTEM — off-chain, KV-stored
//
// 3 badge types:
//   1. DAILY_TOP3   — top 3 stayers (by tap-amount %) on a given day
//   2. HAZARD_HERO  — tapped during a hazard's recovery window (saved the hat)
//   3. SURVIVOR     — was active on day N of an ongoing streak
//
// Storage:
//   hg:badges:user:<name|holder>  -> sorted set of (score=ts, member=JSON badge)
//   hg:badges:roll:hazard         -> last hazard event (so we know who saved)
//   hg:streak:active_users:<day>  -> set of names that tapped on streak-day N
// =====================================================================
import { kv } from "@vercel/kv";

export const BADGE_KEY_PREFIX = "hg:badges:user:";
export const HAZARD_TRACKER = "hg:badges:hazard:active";
export const STREAK_DAYS_KEY = "hg:badges:streak_days";

// =====================================================================
// BADGE DEFINITIONS
// =====================================================================
export const BADGE_TYPES = {
  DAILY_TOP3: {
    id: "daily_top3",
    name: "DAILY TOP 3",
    description: "Top 3 stayer on a given day",
    color: "yolk",
    icon: "T"
  },
  HAZARD_HERO: {
    id: "hazard_hero",
    name: "HAZARD HERO",
    description: "Saved the hat during a hazard event",
    color: "pink",
    icon: "H"
  },
  SURVIVOR: {
    id: "survivor",
    name: "SURVIVOR",
    description: "Was active during a long-running streak",
    color: "green",
    icon: "S"
  }
};

// =====================================================================
// KEY HELPERS
// =====================================================================
function userKey(memberId) {
  return BADGE_KEY_PREFIX + memberId;
}

// memberId combines name + holder flag — same string we use for leaderboards
function asMemberId(name, holder) {
  return JSON.stringify({ name: name || "anon", holder: !!holder });
}

// =====================================================================
// AWARD A BADGE
// =====================================================================
// Idempotent — won't double-award the same badge with the same context.
export async function awardBadge(memberId, type, context = {}) {
  if (!BADGE_TYPES[type]) return null;

  const ts = Date.now();
  // Dedup key: type + the most-distinguishing field of context (date, hazardId, streakDay)
  const dedupId =
    context.date ? type + ":" + context.date :
    context.hazardId ? type + ":" + context.hazardId :
    context.streakDay ? type + ":streakDay-" + context.streakDay :
    type + ":" + ts;

  // Check whether this user already has a badge with this dedup id
  const existing = await kv.zrange(userKey(memberId), 0, -1);
  for (const raw of existing || []) {
    let parsed;
    try { parsed = typeof raw === "string" ? JSON.parse(raw) : raw; }
    catch { continue; }
    if (parsed && parsed.dedupId === dedupId) return null;
  }

  const badge = {
    type,
    name: BADGE_TYPES[type].name,
    description: BADGE_TYPES[type].description,
    color: BADGE_TYPES[type].color,
    icon: BADGE_TYPES[type].icon,
    earnedAt: ts,
    dedupId,
    context
  };
  await kv.zadd(userKey(memberId), { score: ts, member: JSON.stringify(badge) });
  return badge;
}

// =====================================================================
// GET A USER'S BADGES
// =====================================================================
export async function getUserBadges(memberId) {
  const raw = await kv.zrange(userKey(memberId), 0, -1, { rev: true });
  return (raw || []).map(s => {
    try { return typeof s === "string" ? JSON.parse(s) : s; }
    catch { return null; }
  }).filter(Boolean);
}

// =====================================================================
// HAZARD HERO TRACKING
// =====================================================================
// When a hazard fires, we record its id + minimum meter it caused.
// If a player taps within 60s while meter is low, they get "saved" credit.
// First 5 saviors per hazard get the badge.
export async function recordHazard(hazardId, meterAfter) {
  await kv.set(HAZARD_TRACKER, JSON.stringify({
    id: hazardId,
    occurredAt: Date.now(),
    minMeter: meterAfter,
    saviors: []
  }), { ex: 90 });  // expire after 90s, only count tapping in window
}

// Called from the tap handler. Returns badge if awarded, else null.
export async function checkHazardHero(memberId, currentMeter) {
  const raw = await kv.get(HAZARD_TRACKER);
  if (!raw) return null;
  const info = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!info) return null;
  // Window: within 60s of hazard
  if (Date.now() - info.occurredAt > 60000) return null;
  // Must have tapped while meter was still under 30% (a real save)
  if (currentMeter > 30) return null;
  // Limit to first 5 saviors per hazard
  if ((info.saviors || []).length >= 5) return null;
  if ((info.saviors || []).includes(memberId)) return null;

  info.saviors = [...(info.saviors || []), memberId];
  // Reduce TTL so we don't clobber the original
  await kv.set(HAZARD_TRACKER, JSON.stringify(info), { ex: 90 });

  return await awardBadge(memberId, "HAZARD_HERO", {
    hazardId: info.id,
    meterAtSave: currentMeter
  });
}

// =====================================================================
// STREAK SURVIVOR TRACKING
// =====================================================================
// On every tap during a streak, if the streak is at least 1 day old,
// the user gets a SURVIVOR badge for THAT day. Idempotent.
export async function checkSurvivor(memberId, streakStart) {
  if (!streakStart) return null;
  const streakDayMs = Date.now() - streakStart;
  // Must be on day 1 or later (24+ hours into streak)
  if (streakDayMs < 24 * 60 * 60 * 1000) return null;
  const streakDay = Math.floor(streakDayMs / (24 * 60 * 60 * 1000));

  return await awardBadge(memberId, "SURVIVOR", {
    streakDay,
    streakStart
  });
}

// =====================================================================
// DAILY TOP 3 — called periodically (e.g. at midnight UTC by a cron)
// or on-demand when state.js runs. Awards yesterday's badges if not done.
// =====================================================================
const LAST_TOP3_KEY = "hg:badges:lastTop3:date";

export async function awardDailyTop3IfDue(lbDayKey, today) {
  // We only award yesterday's top 3 (today is in progress)
  const yesterday = isoYesterday(today);
  const lastAwarded = await kv.get(LAST_TOP3_KEY);
  if (lastAwarded === yesterday) return [];  // already done
  // Try to load yesterday's leaderboard
  const yesterdayKey = "hg:lb:day:" + yesterday;
  const raw = await kv.zrange(yesterdayKey, 0, 2, { rev: true, withScores: true });
  if (!raw || raw.length === 0) {
    // No yesterday data — record so we don't retry every state poll
    await kv.set(LAST_TOP3_KEY, yesterday);
    return [];
  }
  const top3 = [];
  for (let i = 0; i < raw.length; i += 2) {
    const memberStr = raw[i];
    const score = raw[i + 1];
    if (!memberStr || score === undefined) continue;
    const memberId = memberStr;
    const badge = await awardBadge(memberId, "DAILY_TOP3", {
      date: yesterday,
      rank: Math.floor(i / 2) + 1,
      score
    });
    if (badge) top3.push({ memberId, rank: Math.floor(i / 2) + 1, badge });
  }
  await kv.set(LAST_TOP3_KEY, yesterday);
  return top3;
}

function isoDate(date = new Date()) {
  return date.toISOString().slice(0, 10);
}
function isoYesterday(today) {
  const d = new Date(today + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
