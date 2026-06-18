// CLI user profile — stored at ~/.barter/profile.json.
//
// v1 stores the private key in plaintext on disk. Encryption + key recovery
// land in v1.5+ (see TODOS.md). For now, a friendly warning on `genkey` and
// a strict file mode (0600) is the protection.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import {
  base58Decode,
  base58Encode,
  genKeyPair,
} from "../../../packages/protocol/src/index.ts";

export type Profile = {
  pubkey: string;
  privateKey: string;        // base58, NOT encrypted in v1
  defaultBankUrl: string;
  defaultAccount?: string;    // optional account hash for mint/transfer
};

const DEFAULT_PATH = join(homedir(), ".barter", "profile.json");

export function profilePath(): string {
  return process.env.BARTER_PROFILE ?? DEFAULT_PATH;
}

export function loadProfile(path = profilePath()): Profile {
  if (!existsSync(path)) {
    throw new Error(
      `no profile at ${path}. Run 'barter init [--bank <url>]' to create one.`,
    );
  }
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as Profile;
  if (
    typeof parsed.pubkey !== "string" ||
    typeof parsed.privateKey !== "string" ||
    typeof parsed.defaultBankUrl !== "string"
  ) {
    throw new Error(`profile at ${path} missing required fields`);
  }
  return parsed;
}

export function saveProfile(p: Profile, path = profilePath()): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, JSON.stringify(p, null, 2), { mode: 0o600 });
}

export function createProfile(opts: { bankUrl: string; path?: string }): Profile {
  const { privateKey, pubkeyBase58 } = genKeyPair();
  const profile: Profile = {
    pubkey: pubkeyBase58,
    privateKey: base58Encode(privateKey),
    defaultBankUrl: opts.bankUrl,
  };
  saveProfile(profile, opts.path);
  return profile;
}

export function profilePrivateKeyBytes(p: Profile): Uint8Array {
  return base58Decode(p.privateKey);
}
