import { describe, expect, test } from "bun:test";
import { genKeyPair } from "../src/crypto.ts";
import {
  encodeInvite,
  isInviteExpired,
  parseInvite,
  signInvite,
  verifyInvite,
  type Invite,
} from "../src/invite.ts";

const PROMISE_A = "8QGcXKZj7w9N6yj2HCkXyJZj7w9N6yj2HCkXyJZj7w9N";
const PROMISE_B = "9RhDYLak8x0O7zk3IDlYzKak8x0O7zk3IDlYzKak8x0O";

function makeInvite(pubkey: string): Invite {
  return {
    pubkey,
    bankUrl: "https://barter.game/functions/v1/bank-alice/rpc",
    give: { promise: PROMISE_A, amount: 1 },
    get: { promise: PROMISE_B, amount: 1 },
    exp: Math.floor(Date.now() / 1000) + 3600,
  };
}

describe("invite roundtrip", () => {
  test("sign → encode → parse → verify", () => {
    const { privateKey, pubkeyBase58 } = genKeyPair();
    const inv = makeInvite(pubkeyBase58);
    const signed = signInvite(inv, privateKey);
    const url = encodeInvite(signed);
    const parsed = parseInvite(url);
    expect(parsed.pubkey).toBe(signed.pubkey);
    expect(parsed.bankUrl).toBe(signed.bankUrl);
    expect(parsed.give).toEqual(signed.give);
    expect(parsed.get).toEqual(signed.get);
    expect(parsed.exp).toBe(signed.exp);
    expect(parsed.sig).toBe(signed.sig);
    expect(verifyInvite(parsed)).toBe(true);
  });

  test("encoded URL starts with barter:// and contains pubkey", () => {
    const { privateKey, pubkeyBase58 } = genKeyPair();
    const signed = signInvite(makeInvite(pubkeyBase58), privateKey);
    const url = encodeInvite(signed);
    expect(url.startsWith("barter://")).toBe(true);
    expect(url).toContain(pubkeyBase58);
  });
});

describe("invite tampering detection", () => {
  test("tampering with give amount invalidates the signature", () => {
    const { privateKey, pubkeyBase58 } = genKeyPair();
    const signed = signInvite(makeInvite(pubkeyBase58), privateKey);
    const tampered = { ...signed, give: { ...signed.give, amount: 999 } };
    expect(verifyInvite(tampered)).toBe(false);
  });

  test("tampering with bankUrl invalidates the signature", () => {
    const { privateKey, pubkeyBase58 } = genKeyPair();
    const signed = signInvite(makeInvite(pubkeyBase58), privateKey);
    const tampered = { ...signed, bankUrl: "https://evil.example.com/rpc" };
    expect(verifyInvite(tampered)).toBe(false);
  });

  test("swapping in a different pubkey invalidates the signature", () => {
    const { privateKey, pubkeyBase58 } = genKeyPair();
    const { pubkeyBase58: otherPub } = genKeyPair();
    const signed = signInvite(makeInvite(pubkeyBase58), privateKey);
    expect(verifyInvite({ ...signed, pubkey: otherPub })).toBe(false);
  });
});

describe("invite parsing errors", () => {
  test("rejects strings without barter:// prefix", () => {
    expect(() => parseInvite("https://something")).toThrow(/barter:\/\//);
  });

  test("rejects missing query string", () => {
    expect(() => parseInvite("barter://pubkey@host")).toThrow(/query/);
  });

  test("rejects missing pubkey@host", () => {
    expect(() => parseInvite("barter://nopubkey?give=x:1&get=y:1&exp=1&sig=s")).toThrow(/pubkey@host/);
  });

  test("rejects malformed leg", () => {
    expect(() =>
      parseInvite("barter://pk@host?give=noamount&get=y:1&exp=1&sig=s"),
    ).toThrow(/give/);
  });

  test("rejects non-positive amount", () => {
    expect(() =>
      parseInvite(`barter://pk@host?give=${PROMISE_A}:0&get=${PROMISE_B}:1&exp=1&sig=s`),
    ).toThrow(/positive/);
  });
});

describe("invite expiry", () => {
  test("isInviteExpired is true past exp", () => {
    expect(isInviteExpired({ exp: 1 })).toBe(true);
  });

  test("isInviteExpired is false in the future", () => {
    expect(isInviteExpired({ exp: Math.floor(Date.now() / 1000) + 3600 })).toBe(false);
  });
});
