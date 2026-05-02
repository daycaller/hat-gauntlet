import { isHolder } from "../lib/kv.js";
export default async function handler(req) {
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  let body;
  try { body = await req.json(); }
  catch { return jsonResponse({ error: "bad_json" }, 400); }

  const wallet = typeof body?.wallet === "string" ? body.wallet.trim() : null;
  if (!wallet) return jsonResponse({ error: "no_wallet" }, 400);

  const holder = await isHolder(wallet);
  return jsonResponse({ wallet, holder });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
