import { describe, expect, test } from "bun:test";
import {
  hashPromise,
  validateAccount,
  validateDoc,
  validatePocket,
  validatePromise,
  validateRecord,
  validateSignature,
  validateTx,
} from "../src/schemas.ts";

const PUBKEY = "CqPmMncin5kkUJpLgUmy78mfp1GQiaxvDpjwihgnmiza";
const ULID = "01J84XCEPZ8B7K3NJ60ZBQX4K3";
const HASH = "8QGcXKZj7w9N6yj2HCkXyJZj7w9N6yj2HCkXyJZj7w9N";

describe("Promise validator", () => {
  const valid = {
    type: "promise" as const,
    pubkey: PUBKEY,
    ulid: ULID,
    bank: PUBKEY,
    name: "1 logo",
  };

  test("accepts a minimal valid promise", () => {
    expect(() => validatePromise(valid)).not.toThrow();
  });

  test("accepts optional fields when valid", () => {
    expect(() =>
      validatePromise({ ...valid, due: "2026-12-31", limit: 100, integer: true }),
    ).not.toThrow();
  });

  test("rejects wrong type", () => {
    expect(() => validatePromise({ ...valid, type: "pocket" })).toThrow();
  });

  test("rejects missing name", () => {
    expect(() => validatePromise({ ...valid, name: "" })).toThrow();
  });

  test("rejects invalid due date", () => {
    expect(() => validatePromise({ ...valid, due: "tomorrow" })).toThrow();
  });

  test("rejects non-positive limit", () => {
    expect(() => validatePromise({ ...valid, limit: 0 })).toThrow();
    expect(() => validatePromise({ ...valid, limit: -5 })).toThrow();
  });
});

describe("Pocket / Account validators", () => {
  test("pocket needs name", () => {
    expect(() =>
      validatePocket({ type: "pocket", pubkey: PUBKEY, ulid: ULID, name: "default" }),
    ).not.toThrow();
    expect(() =>
      validatePocket({ type: "pocket", pubkey: PUBKEY, ulid: ULID }),
    ).toThrow();
  });

  test("account needs pocket + promise hashes", () => {
    expect(() =>
      validateAccount({
        type: "account",
        pubkey: PUBKEY,
        ulid: ULID,
        pocket: HASH,
        promise: HASH,
      }),
    ).not.toThrow();
  });
});

describe("Record validator", () => {
  const valid = {
    type: "credit" as const,
    pubkey: PUBKEY,
    ulid: ULID,
    amount: 1,
    account: HASH,
    pair: HASH,
    tx: HASH,
  };

  test("accepts credit record", () => {
    expect(() => validateRecord(valid)).not.toThrow();
  });

  test("accepts debit record", () => {
    expect(() => validateRecord({ ...valid, type: "debit" })).not.toThrow();
  });

  test("rejects negative amount", () => {
    expect(() => validateRecord({ ...valid, amount: -1 })).toThrow();
  });

  test("rejects zero amount", () => {
    expect(() => validateRecord({ ...valid, amount: 0 })).toThrow();
  });

  test("rejects Infinity / NaN amounts", () => {
    expect(() => validateRecord({ ...valid, amount: Infinity })).toThrow();
    expect(() => validateRecord({ ...valid, amount: NaN })).toThrow();
  });
});

describe("Tx + Signature validators", () => {
  test("tx requires non-empty records array", () => {
    expect(() =>
      validateTx({ type: "tx", pubkey: PUBKEY, ulid: ULID, records: [HASH, HASH] }),
    ).not.toThrow();
    expect(() =>
      validateTx({ type: "tx", pubkey: PUBKEY, ulid: ULID, records: [] }),
    ).toThrow();
  });

  test("signature accepts known actions including v1's new 'timeout'", () => {
    expect(() =>
      validateSignature({
        type: "signature",
        pubkey: PUBKEY,
        ulid: ULID,
        action: "timeout",
        hash: HASH,
      }),
    ).not.toThrow();
  });

  test("signature rejects unknown action", () => {
    expect(() =>
      validateSignature({
        type: "signature",
        pubkey: PUBKEY,
        ulid: ULID,
        action: "bogus",
      }),
    ).toThrow();
  });
});

describe("validateDoc dispatch", () => {
  test("routes promise to validatePromise", () => {
    expect(() =>
      validateDoc({
        type: "promise",
        pubkey: PUBKEY,
        ulid: ULID,
        bank: PUBKEY,
        name: "x",
      }),
    ).not.toThrow();
  });

  test("rejects unknown doc type", () => {
    expect(() =>
      validateDoc({ type: "bogus", pubkey: PUBKEY, ulid: ULID }),
    ).toThrow();
  });
});

describe("hashPromise", () => {
  test("hash is stable across reorderings of optional fields", () => {
    const a = {
      type: "promise" as const,
      pubkey: PUBKEY,
      ulid: ULID,
      bank: PUBKEY,
      name: "1 logo",
      integer: true,
    };
    const b = {
      integer: true,
      name: "1 logo",
      bank: PUBKEY,
      ulid: ULID,
      pubkey: PUBKEY,
      type: "promise" as const,
    };
    expect(hashPromise(a)).toBe(hashPromise(b));
  });
});
