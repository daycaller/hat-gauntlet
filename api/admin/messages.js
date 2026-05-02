import { kv } from "@vercel/kv";
import { K, CHAT_HISTORY_SIZE } from "../../lib/kv.js";
import { verifyAdmin } from "../../lib/admin.js";
export default async function handler(req) {
  if (!(await verifyAdmin(req))) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  if (req.method === "GET") return list();
  if (req.method === "POST") return mutate(req);
  return jsonResponse({ error: "method_not_allowed" }, 405);
}

async function list() {
  const items = await kv.zrange(K.CHAT, 0, CHAT_HISTORY_SIZE - 1, { rev: true });
  const messages = (items || []).map(s => {
    try { return typeof s === "string" ? JSON.parse(s) : s; }
    catch { return null; }
  }).filter(Boolean);
  return jsonResponse({ messages });
}

async function mutate(req) {
  let body;
  try { body = await req.json(); }
  catch { return jsonResponse({ error: "bad_json" }, 400); }

  const { id, action } = body || {};
  if (!id || !["hide", "unhide", "delete"].includes(action)) {
    return jsonResponse({ error: "invalid_request" }, 400);
  }

  const items = await kv.zrange(K.CHAT, 0, CHAT_HISTORY_SIZE - 1, { rev: true });
  let target = null;
  let targetRaw = null;
  for (const raw of (items || [])) {
    try {
      const m = typeof raw === "string" ? JSON.parse(raw) : raw;
      if (m && m.id === id) { target = m; targetRaw = raw; break; }
    } catch {}
  }
  if (!target || !targetRaw) {
    return jsonResponse({ error: "not_found" }, 404);
  }

  if (action === "delete") {
    await kv.zrem(K.CHAT, targetRaw);
    return jsonResponse({ ok: true, action });
  }

  // hide / unhide: rewrite the message
  await kv.zrem(K.CHAT, targetRaw);
  target.hidden = action === "hide";
  await kv.zadd(K.CHAT, { score: target.ts, member: JSON.stringify(target) });

  return jsonResponse({ ok: true, action, message: target });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
