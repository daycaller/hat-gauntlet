import { verifyPassword, issueToken } from "../../lib/admin.js";
export default async function handler(req) {
  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  let body;
  try { body = await req.json(); }
  catch { return jsonResponse({ error: "bad_json" }, 400); }

  const password = body?.password;
  if (!password) return jsonResponse({ error: "no_password" }, 400);

  const ok = await verifyPassword(password);
  if (!ok) return jsonResponse({ error: "wrong_password" }, 401);

  const token = await issueToken();
  if (!token) return jsonResponse({ error: "no_secret_configured" }, 500);

  return jsonResponse({ token });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
