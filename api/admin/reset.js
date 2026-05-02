import { kv } from "../../lib/redis.js";
import { K, defaultState } from "../../lib/kv.js";
import { verifyAdmin } from "../../lib/admin.js";
export default async function handler(req) {
  if (!(await verifyAdmin(req))) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  let body;
  try { body = await req.json(); }
  catch { return jsonResponse({ error: "bad_json" }, 400); }

  const { action, value } = body || {};

  if (action === "set_meter") {
    const v = Math.max(0, Math.min(100, Number(value) || 0));
    let state = await kv.get(K.STATE);
    if (!state) state = defaultState();
    state.meter = v;
    state.lastUpdate = Date.now();
    state.fallenAt = null;  // clear any fallen state on manual set
    await kv.set(K.STATE, state);
    return jsonResponse({ ok: true, state });
  }

  if (action === "reset_state") {
    const state = defaultState();
    await kv.set(K.STATE, state);
    return jsonResponse({ ok: true, state });
  }

  if (action === "clear_lb") {
    // Clear all-time leaderboards (caution: irreversible)
    await Promise.all([
      kv.del(K.LB_DAY),
      kv.del(K.LB_ALL),
      kv.del(K.LB_STREAK)
    ]);
    return jsonResponse({ ok: true });
  }

  if (action === "clear_chat") {
    await kv.del(K.CHAT);
    return jsonResponse({ ok: true });
  }

  return jsonResponse({ error: "unknown_action" }, 400);
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
