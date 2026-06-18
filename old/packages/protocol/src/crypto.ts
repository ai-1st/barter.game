// Crypto primitives for the barter.game protocol.
//
// Goals:
//   - Identical output under Bun, Node, Deno, and browser.
//   - Zero ambient dependency on Node's crypto module — everything goes
//     through @noble libraries, which are pure JS and ship browser builds.
//   - Deno consumes these via npm: specifier in deno.json (the noble libs
//     pass that gate cleanly because they are pure JS with no built-in
//     Node imports in the entry path).
//
// The cross-runtime canonical-JSON test (test/canonical.test.ts +
// test-deno/canonical.test.ts) verifies that every doc gets the same
// signed bytes everywhere. ed25519 sign/verify is deterministic, so as
// long as canonical bytes match, signatures verify across runtimes.

import * as ed from "@noble/ed25519";
import { sha256 as sha256hash, sha512 } from "@noble/hashes/sha2.js";
import { base58 } from "@scure/base";
import { ulid } from "ulid";

import { canonicalBytes, canonicalizeWithoutSig } from "./canonical.ts";

// @noble/ed25519 v3 sync sign/verify need sha512 plumbed in via hashes.sha512.
// Wire it up once at module load.
ed.hashes.sha512 = sha512;

export type Base58PubKey = string;
export type Base58Signature = string;
export type Base58SHA256 = string;
export type ULIDString = string;

/** Generate a new ed25519 keypair. */
export function genKeyPair(): {
  privateKey: Uint8Array;
  publicKey: Uint8Array;
  pubkeyBase58: Base58PubKey;
} {
  const privateKey = ed.etc.randomBytes(32);
  const publicKey = ed.getPublicKey(privateKey);
  return { privateKey, publicKey, pubkeyBase58: base58.encode(publicKey) };
}

/** Recover the public key for a given private key. */
export function publicKeyOf(privateKey: Uint8Array): {
  publicKey: Uint8Array;
  pubkeyBase58: Base58PubKey;
} {
  const publicKey = ed.getPublicKey(privateKey);
  return { publicKey, pubkeyBase58: base58.encode(publicKey) };
}

/** Sign raw bytes. Returns base58-encoded signature. */
export function signBytes(message: Uint8Array, privateKey: Uint8Array): Base58Signature {
  const sig = ed.sign(message, privateKey);
  return base58.encode(sig);
}

/** Verify a base58 signature over raw bytes. */
export function verifyBytes(
  message: Uint8Array,
  signatureBase58: Base58Signature,
  pubkeyBase58: Base58PubKey,
): boolean {
  try {
    const sig = base58.decode(signatureBase58);
    const pub = base58.decode(pubkeyBase58);
    return ed.verify(sig, message, pub);
  } catch {
    return false;
  }
}

/**
 * Sign a JSON-serializable doc. The doc is canonicalized WITHOUT its `sig`
 * field, then SHA-256 hashed, then ed25519-signed. Returns the base58 sig.
 *
 * This matches the legacy `signDoc` flow in `docs/legacy/server.ts` but uses
 * canonical JSON instead of json-stable-stringify, per the post-review tech
 * stack decision.
 */
export function signDoc(doc: unknown, privateKey: Uint8Array): Base58Signature {
  const canonical = canonicalizeWithoutSig(doc);
  const bytes = new TextEncoder().encode(canonical);
  const hash = sha256hash(bytes);
  return signBytes(hash, privateKey);
}

/** Verify a doc's signature. */
export function verifyDoc(
  doc: unknown,
  signatureBase58: Base58Signature,
  pubkeyBase58: Base58PubKey,
): boolean {
  const canonical = canonicalizeWithoutSig(doc);
  const bytes = new TextEncoder().encode(canonical);
  const hash = sha256hash(bytes);
  return verifyBytes(hash, signatureBase58, pubkeyBase58);
}

/**
 * Compute the canonical content hash of a doc — base58(SHA-256(canonical JSON)).
 * Used to reference docs from other docs (e.g. Record.account, Tx.records[]).
 *
 * IMPORTANT: this hashes the doc WITH any sig field included. To hash for
 * signing, use signDoc / verifyDoc which strip the top-level sig first.
 */
export function hashDoc(doc: unknown): Base58SHA256 {
  const bytes = canonicalBytes(doc);
  return base58.encode(sha256hash(bytes));
}

/** Raw SHA-256 over UTF-8 bytes of a string. Useful for invite-string hashing. */
export function sha256(s: string): Base58SHA256 {
  return base58.encode(sha256hash(new TextEncoder().encode(s)));
}

export function newUlid(): ULIDString {
  return ulid();
}

export const base58Encode = (b: Uint8Array): string => base58.encode(b);
export const base58Decode = (s: string): Uint8Array => base58.decode(s);
