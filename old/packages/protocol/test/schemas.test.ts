import { describe, expect, test } from "bun:test";
import {
  hashVoucher,
  validateAccount,
  validateAddress,
  validateDoc,
  validateOffer,
  validateOrder,
  validateAccount,
  validateVoucher,
  validateRecord,
  validateSignature,
  validateSubscription,
  validateTx,
} from "../src/schemas.ts";

const PUBKEY = "CqPmMncin5kkUJpLgUmy78mfp1GQiaxvDpjwihgnmiza";
const ULID = "01J84XCEPZ8B7K3NJ60ZBQX4K3";
const HASH = "8QGcXKZj7w9N6yj2HCkXyJZj7w9N6yj2HCkXyJZj7w9N";

describe("Voucher validator", () => {
  const valid = {
    type: "voucher" as const,
    pubkey: PUBKEY,
    ulid: ULID,
    bank: PUBKEY,
    name: "1 logo",
  };

  test("accepts a minimal valid voucher", () => {
    expect(() => validateVoucher(valid)).not.toThrow();
  });

  test("accepts optional fields when valid", () => {
    expect(() =>
      validateVoucher({ ...valid, due: "2026-12-31", limit: 100, integer: true }),
    ).not.toThrow();
  });

  test("rejects wrong type", () => {
    expect(() => validateVoucher({ ...valid, type: "account" })).toThrow();
  });

  test("rejects missing name", () => {
    expect(() => validateVoucher({ ...valid, name: "" })).toThrow();
  });

  test("rejects invalid due date", () => {
    expect(() => validateVoucher({ ...valid, due: "tomorrow" })).toThrow();
  });

  test("rejects non-positive limit", () => {
    expect(() => validateVoucher({ ...valid, limit: 0 })).toThrow();
    expect(() => validateVoucher({ ...valid, limit: -5 })).toThrow();
  });
});

describe("Account / Account validators", () => {
  test("account needs name", () => {
    expect(() =>
      validateAccount({ type: "account", pubkey: PUBKEY, ulid: ULID, name: "default" }),
    ).not.toThrow();
    expect(() =>
      validateAccount({ type: "account", pubkey: PUBKEY, ulid: ULID }),
    ).toThrow();
  });

  test("account needs holder + account + voucher hashes", () => {
    expect(() =>
      validateAccount({
        type: "account",
        holder: PUBKEY,
        account: HASH,
        voucher: HASH,
      }),
    ).not.toThrow();
  });

  test("account rejects old BaseDoc fields", () => {
    expect(() =>
      validateAccount({
        type: "account",
        pubkey: PUBKEY,
        ulid: ULID,
        account: HASH,
        voucher: HASH,
      }),
    ).toThrow(/pubkey/);
  });

  test("account rejects a sig field (accounts are unsigned)", () => {
    expect(() =>
      validateAccount({
        type: "account",
        holder: PUBKEY,
        account: HASH,
        voucher: HASH,
        sig: "abc",
      }),
    ).toThrow(/sig/);
  });

  test("account rejects a sig field (accounts are unsigned)", () => {
    expect(() =>
      validateAccount({
        type: "account",
        pubkey: PUBKEY,
        ulid: ULID,
        name: "default",
        sig: "abc",
      }),
    ).toThrow(/sig/);
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
  test("tx requires non-empty records array of record hashes", () => {
    expect(() =>
      validateTx({ type: "tx", pubkey: PUBKEY, ulid: ULID, records: [HASH, HASH] }),
    ).not.toThrow();
    expect(() =>
      validateTx({ type: "tx", pubkey: PUBKEY, ulid: ULID, records: [] }),
    ).toThrow();
    expect(() =>
      validateTx({ type: "tx", pubkey: PUBKEY, ulid: ULID, records: [ULID] }),
    ).toThrow(/base58/);
  });

  test("tx accepts optional order or offer hash, but not both", () => {
    expect(() =>
      validateTx({ type: "tx", pubkey: PUBKEY, ulid: ULID, records: [HASH], order: HASH }),
    ).not.toThrow();
    expect(() =>
      validateTx({ type: "tx", pubkey: PUBKEY, ulid: ULID, records: [HASH], offer: HASH }),
    ).not.toThrow();
    expect(() =>
      validateTx({ type: "tx", pubkey: PUBKEY, ulid: ULID, records: [HASH], order: HASH, offer: HASH }),
    ).toThrow(/at most one/);
  });

  test("signature accepts bank actions over record hashes", () => {
    expect(() =>
      validateSignature({
        type: "signature",
        pubkey: PUBKEY,
        ulid: ULID,
        action: "ready",
        hash: HASH,
      }),
    ).not.toThrow();
    expect(() =>
      validateSignature({
        type: "signature", pubkey: PUBKEY, ulid: ULID, action: "settle", hash: HASH, seen: [HASH],
      }),
    ).not.toThrow();
  });

  test("signature accepts holder lead/follow over tx hash", () => {
    expect(() =>
      validateSignature({
        type: "signature", pubkey: PUBKEY, ulid: ULID, action: "lead", hash: HASH,
      }),
    ).not.toThrow();
    expect(() =>
      validateSignature({
        type: "signature", pubkey: PUBKEY, ulid: ULID, action: "follow", hash: HASH,
      }),
    ).not.toThrow();
  });

  test("signature accepts hash-only attestation for Voucher/Address", () => {
    expect(() =>
      validateSignature({
        type: "signature", pubkey: PUBKEY, ulid: ULID, hash: HASH,
      }),
    ).not.toThrow();
  });

  test("signature with action requires a hash target", () => {
    expect(() =>
      validateSignature({
        type: "signature", pubkey: PUBKEY, ulid: ULID, action: "ready",
      }),
    ).toThrow(/hash/);
  });

  test("signature requires a hash target even without action", () => {
    expect(() =>
      validateSignature({
        type: "signature", pubkey: PUBKEY, ulid: ULID,
      }),
    ).toThrow(/hash/);
  });

  test("signature rejects removed ack/timeout actions and deal/session targets", () => {
    expect(() =>
      validateSignature({
        type: "signature", pubkey: PUBKEY, ulid: ULID, action: "ack", hash: HASH,
      }),
    ).toThrow();
    expect(() =>
      validateSignature({
        type: "signature", pubkey: PUBKEY, ulid: ULID, action: "timeout", hash: HASH,
      }),
    ).toThrow();
    expect(() =>
      validateSignature({
        type: "signature", pubkey: PUBKEY, ulid: ULID, action: "ready", record: ULID,
      } as unknown as Record<string, unknown>),
    ).toThrow();
  });
});

describe("Subscription validator", () => {
  const valid = {
    type: "subscription" as const,
    pubkey: PUBKEY,
    ulid: ULID,
    hashes: [HASH],
    url: "https://bank.example/rpc",
  };

  test("accepts a minimal valid subscription", () => {
    expect(() => validateSubscription(valid)).not.toThrow();
  });

  test("accepts hashes and until", () => {
    expect(() =>
      validateSubscription({
        ...valid,
        hashes: [HASH, HASH],
        until: "2026-12-31",
      }),
    ).not.toThrow();
  });

  test("rejects when no hashes", () => {
    const { hashes: _hashes, ...noWatch } = valid;
    expect(() => validateSubscription(noWatch)).toThrow(/hashes/);
    expect(() => validateSubscription({ ...noWatch, hashes: [] })).toThrow(/hashes/);
  });

  test("rejects non-http(s) or invalid urls", () => {
    expect(() => validateSubscription({ ...valid, url: "not a url" })).toThrow(/URL/);
    expect(() => validateSubscription({ ...valid, url: "ftp://x.example" })).toThrow(/http/);
  });

  test("rejects ULIDs in hashes (must be base58 hashes)", () => {
    expect(() => validateSubscription({ ...valid, hashes: [ULID] })).toThrow(/base58/);
  });

  test("rejects bad until", () => {
    expect(() => validateSubscription({ ...valid, until: "soon" })).toThrow(/date/);
  });
});

describe("Address validator", () => {
  const valid = {
    type: "address" as const,
    pubkey: PUBKEY,
    ulid: ULID,
    url: "https://bank.example/rpc",
  };

  test("accepts a minimal valid address", () => {
    expect(() => validateAddress(valid)).not.toThrow();
  });

  test("rejects missing or invalid url", () => {
    expect(() => validateAddress({ ...valid, url: undefined } as unknown as Record<string, unknown>)).toThrow(/url/);
    expect(() => validateAddress({ ...valid, url: "not a url" })).toThrow(/URL/);
    expect(() => validateAddress({ ...valid, url: "ftp://x.example" })).toThrow(/http/);
  });

  test("rejects a BaseDoc field mismatch", () => {
    expect(() => validateAddress({ type: "address", pubkey: "0bad", ulid: ULID, url: "https://x" })).toThrow();
  });
});

describe("Order validator", () => {
  const valid = {
    type: "order" as const,
    pubkey: PUBKEY,
    ulid: ULID,
    rate: 1.5,
    lead: false,
    debit: { account: HASH, voucher: HASH, min: 0.1, max: 10 },
    credit: { account: HASH, voucher: HASH, min: 0.1, max: 10 },
  };

  test("accepts a minimal valid order", () => {
    expect(() => validateOrder(valid)).not.toThrow();
  });

  test("accepts invoice/cheque specializations (one side omitted)", () => {
    expect(() => validateOrder({ ...valid, debit: undefined })).not.toThrow();
    expect(() => validateOrder({ ...valid, credit: undefined })).not.toThrow();
  });

  test("rejects non-positive rate", () => {
    expect(() => validateOrder({ ...valid, rate: 0 })).toThrow();
    expect(() => validateOrder({ ...valid, rate: -1 })).toThrow();
  });

  test("rejects negative min", () => {
    expect(() => validateOrder({ ...valid, debit: { ...valid.debit, min: -0.1 } })).toThrow();
  });

  test("rejects min > max", () => {
    expect(() => validateOrder({ ...valid, debit: { ...valid.debit, min: 20, max: 10 } })).toThrow();
  });

  test("rejects non-boolean lead", () => {
    expect(() => validateOrder({ ...valid, lead: "yes" as unknown as boolean })).toThrow();
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
        debit: { voucher: HASH, min: 0.1, max: 10 },
        credit: { voucher: HASH, min: 0.1, max: 10 },
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
    expect(() => validateOffer({ ...valid, debit: { voucher: HASH, min: -1, max: 0 } })).toThrow();
  });
});

describe("validateDoc dispatch", () => {
  test("routes voucher to validateVoucher", () => {
    expect(() =>
      validateDoc({
        type: "voucher",
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
        rate: 1,
        lead: true,
      }),
    ).not.toThrow();
  });

  test("routes address to validateAddress", () => {
    expect(() =>
      validateDoc({
        type: "address",
        pubkey: PUBKEY,
        ulid: ULID,
        url: "https://bank.example/rpc",
      }),
    ).not.toThrow();
  });

  test("rejects unknown doc type", () => {
    expect(() =>
      validateDoc({ type: "bogus", pubkey: PUBKEY, ulid: ULID }),
    ).toThrow();
  });
});

describe("hashVoucher", () => {
  test("hash is stable across reorderings of optional fields", () => {
    const a = {
      type: "voucher" as const,
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
      type: "voucher" as const,
    };
    expect(hashVoucher(a)).toBe(hashVoucher(b));
  });
});
