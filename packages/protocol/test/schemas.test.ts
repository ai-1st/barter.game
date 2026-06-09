import { describe, expect, test } from "bun:test";
import {
  hashPromise,
  validateAccount,
  validateDoc,
  validateOrder,
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
    pair: ULID,
    tx: ULID,
  };

  test("accepts credit record", () => {
    expect(() => validateRecord(valid)).not.toThrow();
  });

  test("accepts debit record", () => {
    expect(() => validateRecord({ ...valid, type: "debit" })).not.toThrow();
  });

  test("rejects hash in pair / tx (must be ULID)", () => {
    expect(() => validateRecord({ ...valid, pair: HASH })).toThrow(/ULID/);
    expect(() => validateRecord({ ...valid, tx: HASH })).toThrow(/ULID/);
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
  test("tx requires non-empty records array of ULIDs", () => {
    expect(() =>
      validateTx({ type: "tx", pubkey: PUBKEY, ulid: ULID, records: [ULID, ULID] }),
    ).not.toThrow();
    expect(() =>
      validateTx({ type: "tx", pubkey: PUBKEY, ulid: ULID, records: [] }),
    ).toThrow();
    expect(() =>
      validateTx({ type: "tx", pubkey: PUBKEY, ulid: ULID, records: [HASH] }),
    ).toThrow(/ULID/);
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

describe("Order validator", () => {
  const valid = {
    type: "order" as const,
    pubkey: PUBKEY,
    ulid: ULID,
    credit: HASH,
    debit: HASH,
    rate: 1.5,
    min: 0.1,
    limit: 100,
    lead: false,
  };

  test("accepts a minimal valid order", () => {
    expect(() => validateOrder(valid)).not.toThrow();
  });

  test("accepts approvers when valid", () => {
    expect(() =>
      validateOrder({ ...valid, approvers: [PUBKEY] }),
    ).not.toThrow();
  });

  test("rejects missing credit hash", () => {
    expect(() => validateOrder({ ...valid, credit: "" })).toThrow();
  });

  test("rejects non-positive rate", () => {
    expect(() => validateOrder({ ...valid, rate: 0 })).toThrow();
    expect(() => validateOrder({ ...valid, rate: -1 })).toThrow();
  });

  test("rejects negative min", () => {
    expect(() => validateOrder({ ...valid, min: -0.1 })).toThrow();
  });

  test("rejects non-positive limit", () => {
    expect(() => validateOrder({ ...valid, limit: 0 })).toThrow();
  });

  test("rejects non-boolean lead", () => {
    expect(() => validateOrder({ ...valid, lead: "yes" as unknown as boolean })).toThrow();
  });

  test("rejects invalid approvers", () => {
    expect(() => validateOrder({ ...valid, approvers: ["0bad"] })).toThrow();
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

  test("routes order to validateOrder", () => {
    expect(() =>
      validateDoc({
        type: "order",
        pubkey: PUBKEY,
        ulid: ULID,
        credit: HASH,
        debit: HASH,
        rate: 1,
        min: 0,
        limit: 10,
        lead: true,
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
