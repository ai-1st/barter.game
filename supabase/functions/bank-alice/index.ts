// Bank Alice — Edge Function entrypoint.
//
// v1 layout: one Supabase project, multiple bank functions, all sharing the
// same Postgres database via the `bank_pubkey` column. Each function is
// uniquely identified by its ed25519 pubkey (loaded from
// BANK_ALICE_PRIV_KEY env at cold start) and routes JSON-RPC under /rpc.
//
// Endpoints:
//   GET  /                                         hello + signed challenge
//   GET  /.well-known/barter-bank.json             pubkey publication
//   POST /rpc                                      JSON-RPC dispatch (W2+)

import * as ed from "npm:@noble/ed25519@^3.1.0";
import { sha512 } from "npm:@noble/hashes@^2.2.0/sha2.js";
import { base58 } from "npm:@scure/base@^2.2.0";

import { handleRpc } from "../_shared/bank/rpc.ts";
import { bankDbFromEnv } from "../_shared/bank/db.ts";
import { v1Registry } from "../_shared/bank/registry.ts";

ed.hashes.sha512 = sha512;

const BANK_NAME = "bank-alice";
const PRIV_KEY_ENV = "BANK_ALICE_PRIV_KEY";

function loadBankKey(): { privateKey: Uint8Array; pubkey: string } {
  const raw = Deno.env.get(PRIV_KEY_ENV);
  if (!raw) {
    throw new Error(
      `${PRIV_KEY_ENV} not set. Run: supabase secrets set ${PRIV_KEY_ENV}=<base58-key>`,
    );
  }
  const privateKey = base58.decode(raw);
  if (privateKey.length !== 32) {
    throw new Error(
      `${PRIV_KEY_ENV}: expected 32-byte ed25519 secret, got ${privateKey.length} bytes`,
    );
  }
  const publicKey = ed.getPublicKey(privateKey);
  return { privateKey, pubkey: base58.encode(publicKey) };
}

let keyState: { privateKey: Uint8Array; pubkey: string } | null = null;
let keyLoadError: string | null = null;
try {
  keyState = loadBankKey();
} catch (err) {
  keyLoadError = err instanceof Error ? err.message : String(err);
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function canonicalBankUrl(req: Request): string {
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (supabaseUrl) {
    return `${supabaseUrl}/functions/v1/${BANK_NAME}`;
  }
  const u = new URL(req.url);
  return `${u.origin}/${BANK_NAME}`;
}

Deno.serve(async (req: Request) => {
  if (!keyState) {
    return json({ error: "bank-key-unset", detail: keyLoadError ?? "unknown" }, 500);
  }
  const url = new URL(req.url);

  if (url.pathname.endsWith("/.well-known/barter-bank.json")) {
    return json({
      pubkey: keyState.pubkey,
      url: canonicalBankUrl(req),
      name: BANK_NAME,
      protocol_version: "barter.game/v1",
    });
  }

  if (req.method === "POST" && url.pathname.endsWith("/rpc")) {
    let db;
    try {
      db = bankDbFromEnv(keyState.pubkey);
    } catch (err) {
      return json({ error: "db-init-failed", detail: String(err) }, 500);
    }
    return handleRpc(req, {
      bankPubkey: keyState.pubkey,
      bankPrivateKey: keyState.privateKey,
      db,
      registry: v1Registry,
    });
  }

  // Default: hello + signed challenge (W1 smoke-test endpoint).
  const challenge = `barter.game v1 hello @ ${new Date().toISOString()}`;
  const challengeBytes = new TextEncoder().encode(challenge);
  const sig = ed.sign(challengeBytes, keyState.privateKey);
  return json({
    hello: BANK_NAME,
    pubkey: keyState.pubkey,
    challenge,
    sig: base58.encode(sig),
    methods: Object.keys(v1Registry),
  });
});
