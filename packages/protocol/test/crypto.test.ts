import { describe, expect, test } from "bun:test";
import {
  base58Decode,
  base58Encode,
  genKeyPair,
  hashDoc,
  newUlid,
  publicKeyOf,
  sha256,
  signBytes,
  signDoc,
  verifyBytes,
  verifyDoc,
} from "../src/crypto.ts";

describe("ed25519 sign / verify", () => {
  test("sign and verify a roundtrip on raw bytes", () => {
    const { privateKey, pubkeyBase58 } = genKeyPair();
    const msg = new TextEncoder().encode("hello");
    const sig = signBytes(msg, privateKey);
    expect(verifyBytes(msg, sig, pubkeyBase58)).toBe(true);
  });

  test("verify fails on tampered message", () => {
    const { privateKey, pubkeyBase58 } = genKeyPair();
    const msg = new TextEncoder().encode("hello");
    const sig = signBytes(msg, privateKey);
    const tampered = new TextEncoder().encode("hellp");
    expect(verifyBytes(tampered, sig, pubkeyBase58)).toBe(false);
  });

  test("verify fails on wrong pubkey", () => {
    const { privateKey } = genKeyPair();
    const { pubkeyBase58: wrongPub } = genKeyPair();
    const msg = new TextEncoder().encode("hello");
    const sig = signBytes(msg, privateKey);
    expect(verifyBytes(msg, sig, wrongPub)).toBe(false);
  });

  test("verify fails gracefully on malformed inputs", () => {
    const msg = new TextEncoder().encode("hello");
    expect(verifyBytes(msg, "not-base58!", "also-not-base58!")).toBe(false);
  });

  test("publicKeyOf is consistent with genKeyPair", () => {
    const { privateKey, pubkeyBase58 } = genKeyPair();
    const recovered = publicKeyOf(privateKey);
    expect(recovered.pubkeyBase58).toBe(pubkeyBase58);
  });
});

describe("signDoc / verifyDoc", () => {
  test("sign a doc, verify without the sig field", () => {
    const { privateKey, pubkeyBase58 } = genKeyPair();
    const doc = { type: "voucher", name: "1 logo", ulid: "01J84XCEPZ8B7K3NJ60ZBQX4K3" };
    const sig = signDoc(doc, privateKey);
    expect(verifyDoc(doc, sig, pubkeyBase58)).toBe(true);
    // Same doc with sig attached still verifies (sig is stripped before hashing)
    expect(verifyDoc({ ...doc, sig }, sig, pubkeyBase58)).toBe(true);
  });

  test("tampering with any field invalidates the signature", () => {
    const { privateKey, pubkeyBase58 } = genKeyPair();
    const doc = { type: "voucher", name: "1 logo" };
    const sig = signDoc(doc, privateKey);
    expect(verifyDoc({ ...doc, name: "1 logo!" }, sig, pubkeyBase58)).toBe(false);
  });

  test("two runs of signDoc on the same input produce the same signature (deterministic)", () => {
    const { privateKey } = genKeyPair();
    const doc = { type: "voucher", name: "1 logo" };
    expect(signDoc(doc, privateKey)).toBe(signDoc(doc, privateKey));
  });
});

describe("hashDoc / sha256", () => {
  test("hashDoc is deterministic and order-independent", () => {
    const a = { x: 1, y: 2 };
    const b = { y: 2, x: 1 };
    expect(hashDoc(a)).toBe(hashDoc(b));
  });

  test("hashDoc changes when content changes", () => {
    const a = { x: 1 };
    const b = { x: 2 };
    expect(hashDoc(a)).not.toBe(hashDoc(b));
  });

  test("sha256 of empty string is the standard value", () => {
    // base58(sha256("")) — the all-zeros input hash
    expect(sha256("")).toBe("GKot5hBsd81kMupNCXHaqbhv3huEbxAFMLnpcX2hniwn");
  });
});

describe("ULID + base58", () => {
  test("newUlid returns a 26-char Crockford-base32 string", () => {
    const id = newUlid();
    expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  test("base58 roundtrip", () => {
    const bytes = new Uint8Array([1, 2, 3, 255, 128]);
    expect(base58Decode(base58Encode(bytes))).toEqual(bytes);
  });
});
