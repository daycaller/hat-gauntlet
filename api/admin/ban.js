import {
  verifyAdmin, getBans,
  banName, unbanName, banIp, unbanIp
} from "../../lib/admin.js";
export default async function handler(req) {
  if (!(await verifyAdmin(req))) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  if (req.method === "GET") {
    return jsonResponse(await getBans());
  }
  if (req.method === "POST") {
    let body;
    try { body = await req.json(); }
    catch { return jsonResponse({ error: "bad_json" }, 400); }

    const { type, value, action } = body || {};
    if (!["name", "ip"].includes(type) ||
        !["ban", "unban"].includes(action) ||
        !value) {
      return jsonResponse({ error: "invalid_request" }, 400);
    }

    if (type === "name") {
      if (action === "ban") await banName(value);
      else await unbanName(value);
    } else {
      if (action === "ban") await banIp(value);
      else await unbanIp(value);
    }
    return jsonResponse({ ok: true });
  }
  return jsonResponse({ error: "method_not_allowed" }, 405);
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
