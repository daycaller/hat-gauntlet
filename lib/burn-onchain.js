// =====================================================================
// ON-CHAIN BURN — Solana transaction signing.
//
// IMPORTANT: This file imports @solana/web3.js, @solana/spl-token, and bs58.
// These packages use Node-only modules (Buffer, http, https, fs, path).
// Therefore this file MUST ONLY be imported by Node.js runtime functions
// — never from Edge functions.
//
// Currently used only by /api/admin/burn.js (which is a Node.js function).
// =====================================================================

import * as web3 from "@solana/web3.js";
import * as splToken from "@solana/spl-token";
import bs58 from "bs58";

const TOKEN_CA = "9tCjcZFwaqMFSFkiYDRAGd3kxChxVguHDCREb6eSpump";
const BURN_ADDR = "1nc1nerator11111111111111111111111111111111";
const TOKEN_DECIMALS = 6;

const RPC_ENDPOINTS = [
  "https://api.mainnet-beta.solana.com",
  "https://rpc.ankr.com/solana",
  "https://solana.public-rpc.com"
];

// Build, sign, broadcast a token-transfer-to-burn-address tx.
// Returns { ok, txSig?, error?, ...details }.
export async function sendBurnTransaction(amountTokens) {
  const privKeyB58 = process.env.VAULT_PRIVATE_KEY;
  if (!privKeyB58) return { ok: false, error: "no_vault_key" };

  let payer;
  try {
    const secretKey = bs58.decode(privKeyB58);
    payer = web3.Keypair.fromSecretKey(secretKey);
  } catch (e) {
    return { ok: false, error: "invalid_key", message: String(e?.message || e) };
  }

  const mint = new web3.PublicKey(TOKEN_CA);
  const burnPubkey = new web3.PublicKey(BURN_ADDR);
  const amountRaw = BigInt(Math.floor(amountTokens * Math.pow(10, TOKEN_DECIMALS)));

  for (const rpcUrl of RPC_ENDPOINTS) {
    try {
      const conn = new web3.Connection(rpcUrl, "confirmed");

      // Vault's associated token account (source)
      const sourceATA = await splToken.getAssociatedTokenAddress(mint, payer.publicKey);

      // Verify source account exists and has enough balance
      let balance;
      try {
        balance = await conn.getTokenAccountBalance(sourceATA);
      } catch (e) {
        return { ok: false, error: "vault_no_token_account", details: String(e?.message || e) };
      }
      const balRaw = BigInt(balance.value.amount);
      if (balRaw < amountRaw) {
        return {
          ok: false,
          error: "insufficient_balance",
          have: Number(balance.value.uiAmount),
          need: amountTokens
        };
      }

      // Burn destination — the burn address may not have a token account yet.
      // createAssociatedTokenAccountIdempotent creates it if missing, no-ops if exists.
      const destATA = await splToken.getAssociatedTokenAddress(mint, burnPubkey, true);

      const tx = new web3.Transaction();
      tx.add(splToken.createAssociatedTokenAccountIdempotentInstruction(
        payer.publicKey,  // funder (pays rent if account is new)
        destATA,
        burnPubkey,
        mint
      ));
      tx.add(splToken.createTransferInstruction(
        sourceATA,
        destATA,
        payer.publicKey,
        amountRaw,
        [],
        splToken.TOKEN_PROGRAM_ID
      ));

      const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash("confirmed");
      tx.recentBlockhash = blockhash;
      tx.feePayer = payer.publicKey;
      tx.sign(payer);

      const rawTx = tx.serialize();
      const sig = await conn.sendRawTransaction(rawTx, { skipPreflight: false });
      const conf = await conn.confirmTransaction({
        signature: sig,
        blockhash,
        lastValidBlockHeight
      }, "confirmed");

      if (conf.value.err) {
        return { ok: false, error: "tx_failed_onchain", details: JSON.stringify(conf.value.err) };
      }

      return { ok: true, txSig: sig, rpc: rpcUrl };
    } catch (e) {
      // try next RPC
      console.error("[burn] rpc failed:", rpcUrl, e?.message);
      continue;
    }
  }

  return { ok: false, error: "all_rpcs_failed" };
}
