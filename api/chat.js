import { kv } from "@vercel/kv";
import {
  K, sanitizeName, sanitizeMessage,
  CHAT_RATE_LIMIT_MS, CHAT_HISTORY_SIZE,
  rateLimit, rateLimitId, isHolder
} from "../lib/kv.js";
import { isBanned } from "../lib/admin.js";
export default async function handler(req) {
  if (req.method === "GET") return handleGet(req);
  if (req.method === "POST") return handlePost(req);
  return jsonResponse({ error: "method_not_allowed" }, 405);
}

async function handleGet(req) {
  const url = new URL(req.url);
  const since = Number(url.searchParams.get("since")) || 0;
  const limit = Number(url.searchParams.get("limit")) || 50;
  const items = await kv.zrange(K.CHAT, 0, Math.min(limit, CHAT_HISTORY_SIZE) - 1, { rev: true });

  let messages = (items || []).map(s => {
    try { return typeof s === "string" ? JSON.parse(s) : s; }
    catch { return null; }
  }).filter(Boolean);

  if (since > 0) {
    messages = messages.filter(m => (m.ts || 0) > since);
  }

  // Hide messages flagged hidden by admin
  messages = messages.filter(m => !m.hidden);

  // Oldest first for client convenience
  messages.reverse();

  return jsonResponse({ messages });
}

async function handlePost(req) {
  let body;
  try { body = await req.json(); }
  catch { return jsonResponse({ error: "bad_json" }, 400); }

  const name = sanitizeName(body?.name);
  const text = sanitizeMessage(body?.text);
  const wallet = typeof body?.wallet === "string" ? body.wallet : null;
  const ip = (req.headers.get("x-forwarded-for") || req.headers.get("x-real-ip") || "")
    .split(",")[0].trim();

  if (!text) return jsonResponse({ error: "invalid_message" }, 400);

  // Ban check
  const banReason = await isBanned(name, ip);
  if (banReason) return jsonResponse({ error: "banned", reason: banReason }, 403);

  // Rate limit
  const id = rateLimitId(req, name);
  const rl = await rateLimit(K.CHAT_LOCK(id), CHAT_RATE_LIMIT_MS);
  if (!rl.ok) {
    return jsonResponse({ error: "rate_limit", waitMs: rl.waitMs }, 429);
  }

  let holder = false;
  if (wallet) holder = await isHolder(wallet);

  const now = Date.now();
  const message = {
    id: now.toString(36) + Math.random().toString(36).slice(2, 8),
    name,
    text,
    holder,
    ts: now
  };

  await kv.zadd(K.CHAT, { score: now, member: JSON.stringify(message) });
  await kv.zremrangebyrank(K.CHAT, 0, -CHAT_HISTORY_SIZE - 1);

  return jsonResponse({ ok: true, message });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
