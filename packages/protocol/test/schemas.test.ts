import { describe, expect, test } from "bun:test";
import {
  hashPromise,
  validateAccount,
  validateDoc,
  validateOffer,
  validateOrder,
  validatePocket,
  validatePromise,
  validateRecord,
  validateSignature,
  validateSubscription,
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

  test("account needs holder + pocket + promise hashes", () => {
    expect(() =>
      validateAccount({
        type: "account",
        holder: PUBKEY,
        pocket: HASH,
        promise: HASH,
      }),
    ).not.toThrow();
  });

  test("account rejects old BaseDoc fields", () => {
    expect(() =>
      validateAccount({
        type: "account",
        pubkey: PUBKEY,
        ulid: ULID,
        pocket: HASH,
        promise: HASH,
      }),
    ).toThrow(/pubkey/);
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
  };

  test("accepts credit record", () => {
    expect(() => validateRecord(valid)).not.toThrow();
  });

  test("accepts debit record", () => {
    expect(() => validateRecord({ ...valid, type: "debit" })).not.toThrow();
  });

  test("rejects missing pair (mandatory, bank-set)", () => {
    const { pair: _pair, ...noPair } = valid;
    expect(() => validateRecord(noPair)).toThrow(/pair/);
  });

  test("rejects hash in pair (must be ULID)", () => {
    expect(() => validateRecord({ ...valid, pair: HASH })).toThrow(/ULID/);
  });

  test("rejects a tx back-reference in the doc body", () => {
    expect(() => validateRecord({ ...valid, tx: ULID })).toThrow(/record.tx/);
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

  test("tx accepts optional order or offer hash, but not both", () => {
    expect(() =>
      validateTx({ type: "tx", pubkey: PUBKEY, ulid: ULID, records: [ULID], order: HASH }),
    ).not.toThrow();
    expect(() =>
      validateTx({ type: "tx", pubkey: PUBKEY, ulid: ULID, records: [ULID], offer: HASH }),
    ).not.toThrow();
    expect(() =>
      validateTx({ type: "tx", pubkey: PUBKEY, ulid: ULID, records: [ULID], order: HASH, offer: HASH }),
    ).toThrow(/at most one/);
  });

  test("signature accepts known actions including 'timeout'", () => {
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

  test("signature accepts per-record and per-deal targets", () => {
    expect(() =>
      validateSignature({
        type: "signature", pubkey: PUBKEY, ulid: ULID, action: "ready", record: ULID,
      }),
    ).not.toThrow();
    expect(() =>
      validateSignature({
        type: "signature", pubkey: PUBKEY, ulid: ULID, action: "settle", deal: ULID, seen: [HASH],
      }),
    ).not.toThrow();
  });

  test("signature with action requires exactly one of hash|record|deal", () => {
    expect(() =>
      validateSignature({
        type: "signature", pubkey: PUBKEY, ulid: ULID, action: "ready",
      }),
    ).toThrow(/exactly one/);
    expect(() =>
      validateSignature({
        type: "signature", pubkey: PUBKEY, ulid: ULID, action: "ready", hash: HASH, record: ULID,
      }),
    ).toThrow(/exactly one/);
  });

  test("signature accepts 'ack' and rejects removed 'approve'", () => {
    expect(() =>
      validateSignature({
        type: "signature", pubkey: PUBKEY, ulid: ULID, action: "ack", hash: HASH,
      }),
    ).not.toThrow();
    expect(() =>
      validateSignature({
        type: "signature", pubkey: PUBKEY, ulid: ULID, action: "approve", record: ULID,
      }),
    ).toThrow();
    expect(() =>
      validateSignature({
        type: "signature",
        pubkey: PUBKEY,
        ulid: ULID,
        action: "bogus",
      }),
    ).toThrow();
  });

  test("signature rejects a hash where record/deal ULID is expected", () => {
    expect(() =>
      validateSignature({
        type: "signature", pubkey: PUBKEY, ulid: ULID, action: "ready", record: HASH,
      }),
    ).toThrow(/ULID/);
  });
});

describe("Subscription validator", () => {
  const valid = {
    type: "subscription" as const,
    pubkey: PUBKEY,
    ulid: ULID,
    deals: [ULID],
    url: "https://bank.example/rpc",
  };

  test("accepts a minimal valid subscription", () => {
    expect(() => validateSubscription(valid)).not.toThrow();
  });

  test("accepts all three watch lists and until", () => {
    expect(() =>
      validateSubscription({
        ...valid,
        records: [ULID],
        hashes: [HASH],
        until: "2026-12-31",
      }),
    ).not.toThrow();
  });

  test("rejects when no watch keys at all", () => {
    const { deals: _deals, ...noWatch } = valid;
    expect(() => validateSubscription(noWatch)).toThrow(/at least one/);
    expect(() => validateSubscription({ ...noWatch, records: [] })).toThrow(/at least one/);
  });

  test("rejects non-http(s) or invalid urls", () => {
    expect(() => validateSubscription({ ...valid, url: "not a url" })).toThrow(/URL/);
    expect(() => validateSubscription({ ...valid, url: "ftp://x.example" })).toThrow(/http/);
  });

  test("rejects hashes in records/deals (must be ULIDs)", () => {
    expect(() => validateSubscription({ ...valid, records: [HASH] })).toThrow(/ULID/);
    expect(() => validateSubscription({ ...valid, deals: [HASH] })).toThrow(/ULID/);
  });

  test("rejects bad until", () => {
    expect(() => validateSubscription({ ...valid, until: "soon" })).toThrow(/date/);
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

describe("Offer validator", () => {
  const valid = {
    type: "offer" as const,
    pubkey: PUBKEY,
    ulid: ULID,
    order: HASH,
    rate: 1.5,
    lead: true,
  };

  test("accepts a minimal valid offer", () => {
    expect(() => validateOffer(valid)).not.toThrow();
  });

  test("accepts debit/credit sides", () => {
    expect(() =>
      validateOffer({
        ...valid,
        debit: { promise: HASH, min: 0.1, max: 10 },
        credit: { promise: HASH, min: 0.1, max: 10 },
      }),
    ).not.toThrow();
  });

  test("rejects missing order hash", () => {
    expect(() => validateOffer({ ...valid, order: "" })).toThrow();
  });

  test("rejects non-positive rate", () => {
    expect(() => validateOffer({ ...valid, rate: 0 })).toThrow();
  });

  test("rejects invalid side shape", () => {
    expect(() => validateOffer({ ...valid, debit: { promise: HASH, min: -1, max: 0 } })).toThrow();
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
