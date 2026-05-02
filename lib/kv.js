import { kv } from "./redis.js";

// =====================================================================
// CONFIG
// =====================================================================
export const TOKEN_CA = "9tCjcZFwaqMFSFkiYDRAGd3kxChxVguHDCREb6eSpump";

// Tap rules
export const TAP_BASE_AMT = 0.5;
export const TAP_HOLDER_AMT = 2.0;
export const TAP_COOLDOWN_MS = 60 * 1000; // 60s in production

// Drain rules
export const DRAIN_PER_MIN = 1.0; // 1% per minute = 100min from full to empty if untouched
export const FALL_RESET_DELAY_MS = 60 * 1000; // 1 min mourning
export const FALL_RESET_TO = 50;

// Hazard rules
export const HAZARD_MIN_INTERVAL_MS = 5 * 60 * 1000;  // 5 min
export const HAZARD_MAX_INTERVAL_MS = 15 * 60 * 1000; // 15 min

// Chat
export const CHAT_RATE_LIMIT_MS = 5 * 1000; // 1 message / 5s
export const CHAT_MAX_LEN = 200;
export const CHAT_HISTORY_SIZE = 100;
export const NAME_MAX_LEN = 20;

// =====================================================================
// KV KEYS
// =====================================================================
export const K = {
  STATE: "hg:state",                    // { meter, lastUpdate, streakStart, longestStreak, falls, totalTaps, fallenAt? }
  CHAT: "hg:chat",                      // sorted set of messages (json strings)
  LB_DAY: "hg:lb:day:" + isoDate(),     // sorted set, score = taps today
  LB_ALL: "hg:lb:all",                  // sorted set, score = all-time taps
  LB_STREAK: "hg:lb:streak",            // sorted set, score = streak duration ms
  TAP_LOCK: (id) => "hg:tap_lock:" + id, // per-id cooldown lock
  CHAT_LOCK: (id) => "hg:chat_lock:" + id,
  HAZARD_NEXT: "hg:hazard:next",        // timestamp of next scheduled hazard
  HOLDER_CACHE: (wallet) => "hg:holder:" + wallet, // cached "is holder" per wallet (10 min TTL)
  EVENTS: "hg:events"                   // recent system events (sorted set)
};

function isoDate() {
  return new Date().toISOString().slice(0, 10);
}

// =====================================================================
// RATE LIMIT
// =====================================================================
// Returns { ok: true } if allowed, { ok: false, waitMs } if rate-limited.
// Uses NX SET pattern to atomically claim the cooldown window.
export async function rateLimit(lockKey, windowMs) {
  // SET NX with PX — atomic lock for windowMs
  const acquired = await kv.set(lockKey, Date.now(), { nx: true, px: windowMs });
  if (acquired) return { ok: true };
  const lockedAt = await kv.get(lockKey);
  const waitMs = Math.max(0, windowMs - (Date.now() - Number(lockedAt || Date.now())));
  return { ok: false, waitMs };
}

// =====================================================================
// PROFANITY / SPAM FILTER
// =====================================================================
// Basic blocklist. Not exhaustive — we also strip URLs and limit length.
// Word boundaries to avoid catching legitimate substrings.
const BAD_WORDS = [
  "nigger", "nigga", "faggot", "retard", "tranny", "kike",
  // common slur variants and obfuscations
  "n1gger", "n!gger", "f4ggot",
  // crypto-specific spam patterns
  "rugpull guarantee", "1000x guaranteed"
];

const URL_RE = /https?:\/\/[^\s]+|www\.[^\s]+/gi;

export function sanitizeMessage(rawText) {
  if (typeof rawText !== "string") return null;
  let text = rawText.replace(/\s+/g, " ").trim();
  if (!text) return null;
  if (text.length > CHAT_MAX_LEN) text = text.slice(0, CHAT_MAX_LEN);

  // strip URLs
  text = text.replace(URL_RE, "[link removed]");

  // case-insensitive word-boundary check
  const lower = text.toLowerCase();
  for (const bad of BAD_WORDS) {
    const re = new RegExp("\\b" + bad.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\b", "i");
    if (re.test(lower)) return null;
  }

  return text;
}

export function sanitizeName(rawName) {
  if (typeof rawName !== "string") return "anon";
  let n = rawName.replace(/[^\w\d\s\-_.]/g, "").trim();
  if (!n) return "anon";
  if (n.length > NAME_MAX_LEN) n = n.slice(0, NAME_MAX_LEN);
  // No impersonation of system/admin
  const lower = n.toLowerCase();
  if (lower === "admin" || lower === "system" || lower === "mod") return n + "_";
  return n;
}

// =====================================================================
// HOLDER VERIFICATION (Solana RPC)
// =====================================================================
// Calls Solana RPC's getTokenAccountsByOwner to check if wallet holds $WIF2.
// Cached per-wallet for 10 minutes to avoid hammering RPC.
const RPC_ENDPOINTS = [
  "https://api.mainnet-beta.solana.com",
  "https://rpc.ankr.com/solana",
  "https://solana.public-rpc.com"
];

export async function isHolder(wallet) {
  if (!wallet || typeof wallet !== "string") return false;
  // Basic Solana address sanity
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) return false;

  // Cache check
  const cacheKey = K.HOLDER_CACHE(wallet);
  const cached = await kv.get(cacheKey);
  if (cached !== null && cached !== undefined) return cached === "1" || cached === 1 || cached === true;

  for (const rpc of RPC_ENDPOINTS) {
    try {
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0", id: 1, method: "getTokenAccountsByOwner",
          params: [
            wallet,
            { mint: TOKEN_CA },
            { encoding: "jsonParsed" }
          ]
        }),
        // 5s timeout via AbortController
        signal: AbortSignal.timeout(5000)
      });
      if (!res.ok) continue;
      const data = await res.json();
      const accounts = (data && data.result && data.result.value) || [];
      let total = 0;
      for (const acc of accounts) {
        const amt = acc?.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
        if (typeof amt === "number") total += amt;
      }
      const holds = total > 0;
      // Cache for 10 min
      await kv.set(cacheKey, holds ? "1" : "0", { ex: 600 });
      return holds;
    } catch (e) {
      // try next RPC
    }
  }
  // All RPCs failed — don't cache, return false (we can't verify)
  return false;
}

// =====================================================================
// STATE HELPERS
// =====================================================================
export function defaultState() {
  return {
    meter: 50,
    lastUpdate: Date.now(),
    streakStart: Date.now(),
    longestStreak: 0,
    falls: 0,
    totalTaps: 0,
    fallenAt: null
  };
}

// Apply elapsed-time drain to the state object. Returns the (mutated) state.
// If the meter hits 0, marks fallen and records the streak.
export function applyDrain(state, now = Date.now()) {
  if (!state) state = defaultState();
  if (state.fallenAt) {
    // Currently fallen — check if mourning period is over
    if (now - state.fallenAt >= FALL_RESET_DELAY_MS) {
      state.meter = FALL_RESET_TO;
      state.streakStart = now;
      state.fallenAt = null;
      state.lastUpdate = now;
    }
    return state;
  }
  const elapsedMs = now - (state.lastUpdate || now);
  const drainAmt = (elapsedMs / 60000) * DRAIN_PER_MIN;
  state.meter = Math.max(0, state.meter - drainAmt);
  state.lastUpdate = now;
  if (state.meter <= 0) {
    state.meter = 0;
    state.fallenAt = now;
    const streakDur = now - (state.streakStart || now);
    if (streakDur > (state.longestStreak || 0)) {
      state.longestStreak = streakDur;
    }
    state.falls = (state.falls || 0) + 1;
  }
  return state;
}

// =====================================================================
// HAZARDS
// =====================================================================
const HAZARDS = [
  { headline: "WIND GUST", sub: "the air itself wants the hat off", drop: 8 },
  { headline: "A CAT APPEARS", sub: "the cat will not be reasoned with", drop: 12 },
  { headline: "GRAVITY", sub: "as it has always done", drop: 5 },
  { headline: "FED RAISES RATES", sub: "hat is risk-on asset", drop: 7 },
  { headline: "CROCHET HOOK INCIDENT", sub: "loose stitch detected", drop: 6 },
  { headline: "ETF REJECTED", sub: "morale plummets, hat sags", drop: 10 },
  { headline: "RUG DEMON SUMMONED", sub: "ancient rugger appears from the deep", drop: 14 },
  { headline: "THE DOG SNEEZES", sub: "achooooooo", drop: 8 },
  { headline: "STATIC ELECTRICITY", sub: "winter happened", drop: 5 }
];

// Returns a hazard if one is due, else null. Mutates state and KV.
export async function rollHazard(state, now = Date.now()) {
  const nextStr = await kv.get(K.HAZARD_NEXT);
  const nextAt = nextStr ? Number(nextStr) : null;

  if (!nextAt) {
    // Schedule first one
    await scheduleNextHazard(now);
    return null;
  }
  if (now < nextAt) return null;

  // Fire it
  const hazard = HAZARDS[Math.floor(Math.random() * HAZARDS.length)];
  state.meter = Math.max(0, state.meter - hazard.drop);
  state.lastUpdate = now;

  if (state.meter <= 0 && !state.fallenAt) {
    state.meter = 0;
    state.fallenAt = now;
    const streakDur = now - (state.streakStart || now);
    if (streakDur > (state.longestStreak || 0)) state.longestStreak = streakDur;
    state.falls = (state.falls || 0) + 1;
  }

  // Generate a unique hazard id (used by the badge system to dedup saviors)
  const hazardId = now.toString(36) + "-" + Math.random().toString(36).slice(2, 8);

  await scheduleNextHazard(now);
  await pushEvent({
    type: "hazard",
    text: "⚠ " + hazard.headline + " (-" + hazard.drop + "%)",
    headline: hazard.headline,
    sub: hazard.sub,
    drop: hazard.drop,
    hazardId,
    ts: now
  });

  // Record the hazard so taps within 60s while meter is low can earn HAZARD_HERO badges
  try {
    const { recordHazard } = await import("./badges.js");
    await recordHazard(hazardId, state.meter);
  } catch (e) { /* badges module optional */ }

  return { ...hazard, hazardId };
}

async function scheduleNextHazard(now) {
  const delay = HAZARD_MIN_INTERVAL_MS + Math.random() * (HAZARD_MAX_INTERVAL_MS - HAZARD_MIN_INTERVAL_MS);
  await kv.set(K.HAZARD_NEXT, now + delay);
}

// =====================================================================
// EVENT LOG
// =====================================================================
export async function pushEvent(event) {
  await kv.zadd(K.EVENTS, { score: event.ts || Date.now(), member: JSON.stringify(event) });
  // Keep only most recent 30
  await kv.zremrangebyrank(K.EVENTS, 0, -31);
}

export async function getRecentEvents(limit = 20) {
  const items = await kv.zrange(K.EVENTS, 0, limit - 1, { rev: true });
  return (items || []).map(s => {
    try { return typeof s === "string" ? JSON.parse(s) : s; } catch { return null; }
  }).filter(Boolean);
}

// =====================================================================
// REQUEST IDENTITY (for rate limiting)
// =====================================================================
// Combines IP + name/wallet for rate-limit keys, so two devices with the
// same name still get separate cooldowns, and changing names doesn't bypass.
export function rateLimitId(req, suffix) {
  const ip = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
             req.headers.get("x-real-ip") ||
             "unknown";
  return ip + ":" + (suffix || "default");
}
