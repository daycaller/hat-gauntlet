import { verifyAdmin } from "../../lib/admin.js";
import { executeBurn, hasVaultKey } from "../../lib/burn.js";
import { sendBurnTransaction } from "../../lib/burn-onchain.js";

// This route runs on the Node.js runtime (the default for Vercel functions),
// because @solana/web3.js uses Buffer and crypto APIs that aren't in Edge.
// We don't set `config.runtime` because Node.js IS the default — setting it
// explicitly to "nodejs" can confuse the build.

export default async function handler(req) {
  if (!(await verifyAdmin(req))) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "method_not_allowed" }, 405);
  }

  if (!hasVaultKey()) {
    return jsonResponse({
      error: "vault_not_configured",
      message: "Set VAULT_PRIVATE_KEY env var in Vercel"
    }, 503);
  }

  let body = {};
  try { body = await req.json(); }
  catch { /* no body is OK — defaults to "burn current pool" */ }

  // Optional override: admin can specify a custom burn amount
  // (e.g. partial burn, or burn before threshold reached for a special event)
  const amountOverride = typeof body?.amount === "number" && body.amount > 0
    ? body.amount
    : null;

  // Inject the on-chain sender — keeps lib/burn.js Edge-safe by not importing
  // any Solana code there. Solana code is only imported here, in this file,
  // which only ever runs on Node.js runtime.
  const result = await executeBurn(sendBurnTransaction, amountOverride);

  if (!result.ok) {
    const status =
      result.error === "below_threshold" ? 409 :
      result.error === "burn_in_progress" ? 423 :
      result.error === "empty_pool" ? 409 :
      result.error === "insufficient_balance" ? 402 :
      500;
    return jsonResponse({
      error: result.error,
      ...result
    }, status);
  }

  return jsonResponse({ ok: true, burn: result.burn });
}

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store" }
  });
}
