// Load bank private keys from environment variables.
//
// One Deno Deploy process can serve multiple banks. Each bank is named by a
// short name (e.g. "alice") and its private key comes from
// BANK_<NAME>_PRIV_KEY. The public key is derived from the private key.

import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";

ed.hashes.sha512 = sha512;

export type BankKey = {
  name: string;
  pubkey: string;
  privateKey: Uint8Array;
};

const ENV_VAR_RE = /^BANK_([A-Z0-9_]+)_PRIV_KEY$/;

function derivePublicKey(privateKey: Uint8Array): string {
  return base58.encode(ed.getPublicKey(privateKey));
}

/** Scan Deno.env for BANK_*_PRIV_KEY variables and return a map of served banks. */
export function loadBanksFromEnv(): Map<string, BankKey> {
  const banks = new Map<string, BankKey>();
  for (const [key, value] of Object.entries(Deno.env.toObject())) {
    const match = key.match(ENV_VAR_RE);
    if (!match || !value) continue;
    const name = match[1]!.toLowerCase().replace(/_/g, "-");
    const privateKey = base58.decode(value);
    if (privateKey.length !== 32) {
      throw new Error(`${key}: expected 32-byte ed25519 secret, got ${privateKey.length} bytes`);
    }
    banks.set(name, {
      name,
      pubkey: derivePublicKey(privateKey),
      privateKey,
    });
  }
  return banks;
}
