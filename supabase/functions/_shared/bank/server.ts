// Bank Edge Function bootstrap. Both bank-alice and bank-bob (and any future
// bank running the v1 codebase) call `startBank({name})`; the only thing that
// differs per-bank is its name + secret env var.

import * as ed from "npm:@noble/ed25519@^3.1.0";
import { sha512 } from "npm:@noble/hashes@^2.2.0/sha2.js";
import { base58 } from "npm:@scure/base@^2.2.0";

import { handleRpc } from "./rpc.ts";
import { bankDbFromEnv } from "./db.ts";
import { v1Registry } from "./registry.ts";

ed.hashes.sha512 = sha512;

function loadBankKey(envVar: string): { privateKey: Uint8Array; pubkey: string } {
  const raw = Deno.env.get(envVar);
  if (!raw) {
    throw new Error(
      `${envVar} not set. Run: supabase secrets set ${envVar}=<base58-key>`,
    );
  }
  const privateKey = base58.decode(raw);
  if (privateKey.length !== 32) {
    throw new Error(
      `${envVar}: expected 32-byte ed25519 secret, got ${privateKey.length} bytes`,
    );
  }
  const publicKey = ed.getPublicKey(privateKey);
  return { privateKey, pubkey: base58.encode(publicKey) };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export function startBank(opts: { name: string }): void {
  // Env var derivation: "bank-alice" → "BANK_ALICE_PRIV_KEY". Strip the
  // "bank-" prefix so we don't double it.
  const shortName = opts.name.replace(/^bank-/, "");
  const envVar = `BANK_${shortName.toUpperCase().replace(/-/g, "_")}_PRIV_KEY`;
  let keyState: { privateKey: Uint8Array; pubkey: string } | null = null;
  let keyLoadError: string | null = null;
  try {
    keyState = loadBankKey(envVar);
  } catch (err) {
    keyLoadError = err instanceof Error ? err.message : String(err);
  }

  function canonicalBankUrl(req: Request): string {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    if (supabaseUrl) {
      return `${supabaseUrl}/functions/v1/${opts.name}`;
    }
    const u = new URL(req.url);
    return `${u.origin}/${opts.name}`;
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
        name: opts.name,
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
      return await handleRpc(req, {
        bankPubkey: keyState.pubkey,
        bankPrivateKey: keyState.privateKey,
        db,
        registry: v1Registry,
      });
    }

    // Default: hello + signed challenge (smoke test).
    const challenge = `barter.game v1 hello @ ${new Date().toISOString()}`;
    const challengeBytes = new TextEncoder().encode(challenge);
    const sig = ed.sign(challengeBytes, keyState.privateKey);
    return json({
      hello: opts.name,
      pubkey: keyState.pubkey,
      challenge,
      sig: base58.encode(sig),
      methods: Object.keys(v1Registry),
    });
  });
}
