import { describe, expect, test } from "bun:test";
import { genKeyPair } from "../src/crypto.ts";
import {
  encodeDealToken,
  encodeInvite,
  isInviteExpired,
  parseDealToken,
  parseInvite,
  signDealToken,
  signInvite,
  verifyDealToken,
  verifyInvite,
  type DealToken,
  type Invite,
} from "../src/invite.ts";

const PROMISE_A = "8QGcXKZj7w9N6yj2HCkXyJZj7w9N6yj2HCkXyJZj7w9N";
const PROMISE_B = "9RhDYLak8x0O7zk3IDlYzKak8x0O7zk3IDlYzKak8x0O";
const ACCOUNT_A = "7PFbWJYi6v8M5xi1GBjWxIYi6v8M5xi1GBjWxIYi6v8M";
const ACCOUNT_B = "6OEaVIXh5u7L4wh0FAiVwHXh5u7L4wh0FAiVwHXh5u7L";

function makeInvite(pubkey: string): Invite {
  return {
    pubkey,
    bankUrl: "https://barter.game/functions/v1/bank-alice/rpc",
    give: { voucher: PROMISE_A, amount: 1, account: ACCOUNT_A },
    get: { voucher: PROMISE_B, amount: 1, account: ACCOUNT_B },
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
      parseInvite("barter://pk@host?give=noamount&get=y:1:a&exp=1&sig=s"),
    ).toThrow(/give/);
  });

  test("rejects a leg without an account hash", () => {
    expect(() =>
      parseInvite(`barter://pk@host?give=${PROMISE_A}:1&get=${PROMISE_B}:1:${ACCOUNT_B}&exp=1&sig=s`),
    ).toThrow(/give/);
  });

  test("rejects non-positive amount", () => {
    expect(() =>
      parseInvite(`barter://pk@host?give=${PROMISE_A}:0:${ACCOUNT_A}&get=${PROMISE_B}:1:${ACCOUNT_B}&exp=1&sig=s`),
    ).toThrow(/positive/);
  });
});

describe("deal token", () => {
  const ULID_1 = "01J84XCEPZ8B7K3NJ60ZBQX4K3";
  const ULID_2 = "01J84XCEPZ8B7K3NJ60ZBQX4K4";

  function makeToken(pubkey: string, holder: string): DealToken {
    return {
      pubkey,
      deal: ULID_1,
      tx: { type: "tx", pubkey: holder, ulid: ULID_2, records: [ULID_1, ULID_2] },
      records: [
        { type: "debit", pubkey, ulid: ULID_1, amount: 1, account: ACCOUNT_A, pair: ULID_2 },
        { type: "credit", pubkey, ulid: ULID_2, amount: 1, account: ACCOUNT_B, pair: ULID_1 },
      ],
      banks: [{ pubkey, url: "https://barter.game/functions/v1/bank-alice/rpc" }],
      exp: Math.floor(Date.now() / 1000) + 3600,
    };
  }

  test("sign → encode → parse → verify roundtrip", () => {
    const { privateKey, pubkeyBase58 } = genKeyPair();
    const { pubkeyBase58: holder } = genKeyPair();
    const signed = signDealToken(makeToken(pubkeyBase58, holder), privateKey);
    const encoded = encodeDealToken(signed);
    expect(encoded.startsWith("barterdeal:")).toBe(true);
    const parsed = parseDealToken(encoded);
    expect(parsed).toEqual(signed);
    expect(verifyDealToken(parsed)).toBe(true);
  });

  test("tampering with the tx invalidates the signature", () => {
    const { privateKey, pubkeyBase58 } = genKeyPair();
    const { pubkeyBase58: holder } = genKeyPair();
    const signed = signDealToken(makeToken(pubkeyBase58, holder), privateKey);
    const tampered = {
      ...signed,
      tx: { ...signed.tx, records: [ULID_2, ULID_1] },
    };
    expect(verifyDealToken(tampered)).toBe(false);
  });

  test("rejects strings without the barterdeal: prefix", () => {
    expect(() => parseDealToken("barter://x")).toThrow(/barterdeal:/);
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
