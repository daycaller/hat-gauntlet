import { sanitizeName } from "../lib/kv.js";
import { getUserBadges } from "../lib/badges.js";
export default async function handler(req) {
  if (req.method !== "GET") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  const url = new URL(req.url);
  const name = sanitizeName(url.searchParams.get("name"));
  const holder = url.searchParams.get("holder") === "true";

  if (!name) return jsonResponse({ badges: [] });

  const memberId = JSON.stringify({ name, holder });
  const badges = await getUserBadges(memberId);

  // Aggregate counts by type for a summary
  const counts = badges.reduce((acc, b) => {
    acc[b.type] = (acc[b.type] || 0) + 1;
    return acc;
  }, {});

  return jsonResponse({ badges, counts });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
