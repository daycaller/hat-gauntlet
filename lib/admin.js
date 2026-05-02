// =====================================================================
// ADMIN AUTH
//
// Simple password-gate. Admin enters password via /admin login form.
// Server verifies against ADMIN_PASSWORD env var. On success, returns a
// signed token (HMAC-SHA256 of expiry + secret). Token sent in subsequent
// admin requests as `Authorization: Bearer <token>`.
//
// This is intentionally simple — no user accounts, no rotation. It's a
// single-admin moderator panel, not a multi-tenant identity system.
// =====================================================================

import { kv } from "@vercel/kv";

const TOKEN_TTL_SEC = 12 * 60 * 60;  // 12-hour sessions

// HMAC-SHA256 using Web Crypto API (available in Edge runtime)
async function hmac(secret, message) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  return bufToHex(sig);
}

function bufToHex(buf) {
  return Array.from(new Uint8Array(buf))
    .map(b => b.toString(16).padStart(2, "0"))
    .join("");
}

export function getAdminPassword() {
  return process.env.ADMIN_PASSWORD || null;
}

export function getAdminSecret() {
  // Fall back to using the password as the secret if a separate one isn't set
  return process.env.ADMIN_SECRET || process.env.ADMIN_PASSWORD || null;
}

// =====================================================================
// LOGIN — verify password, issue token
// =====================================================================
export async function verifyPassword(password) {
  const expected = getAdminPassword();
  if (!expected) return false;
  if (typeof password !== "string") return false;
  // Constant-time-ish: compare equal-length strings
  if (password.length !== expected.length) return false;
  let result = 0;
  for (let i = 0; i < password.length; i++) {
    result |= password.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return result === 0;
}

export async function issueToken() {
  const secret = getAdminSecret();
  if (!secret) return null;
  const expiry = Date.now() + TOKEN_TTL_SEC * 1000;
  const sig = await hmac(secret, expiry.toString());
  return expiry.toString(36) + "." + sig;
}

// =====================================================================
// VERIFY a token from an Authorization header
// =====================================================================
export async function verifyAdmin(req) {
  const authHeader = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/.exec(authHeader);
  if (!m) return false;
  const token = m[1];
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const expiryStr = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expiry = parseInt(expiryStr, 36);
  if (!expiry || isNaN(expiry) || expiry < Date.now()) return false;
  const secret = getAdminSecret();
  if (!secret) return false;
  const expected = await hmac(secret, expiry.toString());
  return expected === sig;
}

// =====================================================================
// BANS (names + IPs)
// =====================================================================
export const BANNED_NAMES_KEY = "hg:banned:names";
export const BANNED_IPS_KEY = "hg:banned:ips";

export async function isBanned(name, ip) {
  const [bn, bi] = await Promise.all([
    kv.smembers(BANNED_NAMES_KEY),
    kv.smembers(BANNED_IPS_KEY)
  ]);
  if (name && (bn || []).includes(String(name).toLowerCase())) return "name";
  if (ip && (bi || []).includes(ip)) return "ip";
  return null;
}

export async function banName(name) {
  if (!name) return;
  await kv.sadd(BANNED_NAMES_KEY, String(name).toLowerCase());
}
export async function unbanName(name) {
  if (!name) return;
  await kv.srem(BANNED_NAMES_KEY, String(name).toLowerCase());
}
export async function banIp(ip) {
  if (!ip) return;
  await kv.sadd(BANNED_IPS_KEY, ip);
}
export async function unbanIp(ip) {
  if (!ip) return;
  await kv.srem(BANNED_IPS_KEY, ip);
}

export async function getBans() {
  const [names, ips] = await Promise.all([
    kv.smembers(BANNED_NAMES_KEY),
    kv.smembers(BANNED_IPS_KEY)
  ]);
  return { names: names || [], ips: ips || [] };
}
