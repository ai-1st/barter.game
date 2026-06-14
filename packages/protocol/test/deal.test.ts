import { describe, expect, test } from "bun:test";
import { buildDeal, type DealSpec } from "../src/deal.ts";
import { hashRecord } from "../src/schemas.ts";

// Deterministic ULID factory so a build is reproducible within a run.
function counterUlid() {
  let n = 0;
  return () => ("01TEST" + String(n++).padStart(20, "0")).slice(0, 26);
}

function recordBody(
  type: "credit" | "debit",
  pubkey: string,
  ulid: string,
  account: string,
  pair: string,
  amount = 1,
) {
  return { type, pubkey, ulid, amount, account, pair };
}

// The branching/merging multi-party deal from PROTOCOL.md §2:
//   A → C, B → C, C → D, D → A, D → B
function demoDeal(): DealSpec {
  return {
    initiator: "hA",
    transfers: [
      { promise: "pA", issuerBank: "bankA", amount: 1, from: { holder: "hA", account: "accA_A" }, to: { holder: "hC", account: "accC_A" } },
      { promise: "pB", issuerBank: "bankB", amount: 1, from: { holder: "hB", account: "accB_B" }, to: { holder: "hC", account: "accC_B" } },
      { promise: "pC", issuerBank: "bankC", amount: 2, from: { holder: "hC", account: "accC_C" }, to: { holder: "hD", account: "accD_C" } },
      { promise: "pD", issuerBank: "bankD", amount: 1, from: { holder: "hD", account: "accD_D" }, to: { holder: "hA", account: "accA_D" } },
      { promise: "pD", issuerBank: "bankD", amount: 1, from: { holder: "hD", account: "accD_D" }, to: { holder: "hB", account: "accB_D" } },
    ],
  };
}

/** Produce deterministic record bodies for each bank.
 *  Order matches the transfer order within each bank: debit, credit per transfer. */
function makeRecords(spec: DealSpec, ulid: () => string, bankPub: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  for (const t of spec.transfers) {
    if (t.issuerBank !== bankPub) continue;
    const debitUlid = ulid();
    const creditUlid = ulid();
    records.push(recordBody("debit", bankPub, debitUlid, t.from.account, creditUlid, t.amount));
    records.push(recordBody("credit", bankPub, creditUlid, t.to.account, debitUlid, t.amount));
  }
  return records;
}

describe("buildDeal — multi-party branching/merging", () => {
  test("holder Txs are a disjoint exact cover of all record hashes", () => {
    const spec = demoDeal();
    const ulid = counterUlid();
    const bankRecords = {
      bankA: makeRecords(spec, ulid, "bankA"),
      bankB: makeRecords(spec, ulid, "bankB"),
      bankC: makeRecords(spec, ulid, "bankC"),
      bankD: makeRecords(spec, ulid, "bankD"),
    } as Record<string, Record<string, unknown>[]>;
    const d = buildDeal(spec, bankRecords, { ulid });

    const allHashes = Object.values(bankRecords).flat().map((r) => hashRecord(r as never));
    const fromTxs = d.holderTxs.flatMap((h) => h.tx.records);
    expect(fromTxs).toHaveLength(allHashes.length);
    expect([...fromTxs].sort()).toEqual([...allHashes].sort());
    expect(new Set(fromTxs).size).toBe(fromTxs.length);
  });

  test("each holder's Tx binds exactly the records on their own accounts", () => {
    const spec = demoDeal();
    const ulid = counterUlid();
    const bankRecords = {
      bankA: makeRecords(spec, ulid, "bankA"),
      bankB: makeRecords(spec, ulid, "bankB"),
      bankC: makeRecords(spec, ulid, "bankC"),
      bankD: makeRecords(spec, ulid, "bankD"),
    } as Record<string, Record<string, unknown>[]>;
    const d = buildDeal(spec, bankRecords, { ulid });
    const plan = (h: string) => d.holderTxs.find((p) => p.holder === h)!;

    const h = (bank: string, idx: number) => hashRecord(bankRecords[bank]![idx] as never);

    // hA: debit of t0 (bankA), credit of t3 (bankD)
    expect(plan("hA").tx.records).toEqual([h("bankA", 0), h("bankD", 1)]);
    // hB: debit of t1 (bankB), credit of t4 (bankD)
    expect(plan("hB").tx.records).toEqual([h("bankB", 0), h("bankD", 3)]);
    // hC: credit of t0, credit of t1, debit of t2
    expect(plan("hC").tx.records).toEqual([h("bankA", 1), h("bankB", 1), h("bankC", 0)]);
    // hD: credit of t2, debit of t3, debit of t4
    expect(plan("hD").tx.records).toEqual([h("bankC", 1), h("bankD", 0), h("bankD", 2)]);
    // Tx.pubkey is the holder
    expect(plan("hA").tx.pubkey).toBe("hA");
  });

  test("initiator's plan is lead, everyone else follows", () => {
    const spec = demoDeal();
    const ulid = counterUlid();
    const bankRecords = {
      bankA: makeRecords(spec, ulid, "bankA"),
      bankB: makeRecords(spec, ulid, "bankB"),
      bankC: makeRecords(spec, ulid, "bankC"),
      bankD: makeRecords(spec, ulid, "bankD"),
    } as Record<string, Record<string, unknown>[]>;
    const d = buildDeal(spec, bankRecords, { ulid });
    const roles = Object.fromEntries(d.holderTxs.map((h) => [h.holder, h.role]));
    expect(roles).toEqual({ hA: "lead", hB: "follow", hC: "follow", hD: "follow" });
  });

  test("per-holder banks list every bank the holder's records live at", () => {
    const spec = demoDeal();
    const ulid = counterUlid();
    const bankRecords = {
      bankA: makeRecords(spec, ulid, "bankA"),
      bankB: makeRecords(spec, ulid, "bankB"),
      bankC: makeRecords(spec, ulid, "bankC"),
      bankD: makeRecords(spec, ulid, "bankD"),
    } as Record<string, Record<string, unknown>[]>;
    const d = buildDeal(spec, bankRecords, { ulid });
    const banks = (h: string) => [...d.holderTxs.find((p) => p.holder === h)!.banks].sort();
    expect(banks("hA")).toEqual(["bankA", "bankD"]);
    expect(banks("hB")).toEqual(["bankB", "bankD"]);
    expect(banks("hC")).toEqual(["bankA", "bankB", "bankC"]);
    expect(banks("hD")).toEqual(["bankC", "bankD"]);
  });

  test("slices record hashes per bank (visibility: a leg holds only its own)", () => {
    const spec = demoDeal();
    const ulid = counterUlid();
    const bankRecords = {
      bankA: makeRecords(spec, ulid, "bankA"),
      bankB: makeRecords(spec, ulid, "bankB"),
      bankC: makeRecords(spec, ulid, "bankC"),
      bankD: makeRecords(spec, ulid, "bankD"),
    } as Record<string, Record<string, unknown>[]>;
    const d = buildDeal(spec, bankRecords, { ulid });
    const byBank = Object.fromEntries(d.legs.map((l) => [l.bank, l.recordHashes.length]));
    expect(byBank).toEqual({ bankA: 2, bankB: 2, bankC: 2, bankD: 4 });
  });

  test("order follows first appearance of banks in transfers", () => {
    const spec = demoDeal();
    const ulid = counterUlid();
    const bankRecords = {
      bankA: makeRecords(spec, ulid, "bankA"),
      bankB: makeRecords(spec, ulid, "bankB"),
      bankC: makeRecords(spec, ulid, "bankC"),
      bankD: makeRecords(spec, ulid, "bankD"),
    } as Record<string, Record<string, unknown>[]>;
    const d = buildDeal(spec, bankRecords, { ulid });
    expect(d.order).toEqual(["bankA", "bankB", "bankC", "bankD"]);
  });

  test("is reproducible with a fixed ULID source", () => {
    const spec = demoDeal();
    const ulidA = counterUlid();
    const bankRecordsA = {
      bankA: makeRecords(spec, ulidA, "bankA"),
      bankB: makeRecords(spec, ulidA, "bankB"),
      bankC: makeRecords(spec, ulidA, "bankC"),
      bankD: makeRecords(spec, ulidA, "bankD"),
    } as Record<string, Record<string, unknown>[]>;
    const a = buildDeal(spec, bankRecordsA, { ulid: ulidA });

    const ulidB = counterUlid();
    const bankRecordsB = {
      bankA: makeRecords(spec, ulidB, "bankA"),
      bankB: makeRecords(spec, ulidB, "bankB"),
      bankC: makeRecords(spec, ulidB, "bankC"),
      bankD: makeRecords(spec, ulidB, "bankD"),
    } as Record<string, Record<string, unknown>[]>;
    const b = buildDeal(spec, bankRecordsB, { ulid: ulidB });

    const hashes = (d: typeof a) => d.holderTxs.map((h) => h.txHash);
    expect(hashes(a)).toEqual(hashes(b));
  });

  test("rejects missing record bodies for a bank", () => {
    const spec = demoDeal();
    const ulid = counterUlid();
    const bankRecords = {
      bankA: makeRecords(spec, ulid, "bankA"),
      bankB: makeRecords(spec, ulid, "bankB"),
      bankC: makeRecords(spec, ulid, "bankC"),
      bankD: makeRecords(spec, ulid, "bankD"),
    } as Record<string, Record<string, unknown>[]>;
    delete (bankRecords as Record<string, Record<string, unknown>[]>).bankC;
    expect(() => buildDeal(spec, bankRecords, { ulid })).toThrow(/missing record bodies for bank bankC/);
  });

  test("rejects wrong count of record bodies for a bank", () => {
    const spec = demoDeal();
    const ulid = counterUlid();
    const bankRecords = {
      bankA: makeRecords(spec, ulid, "bankA"),
      bankB: makeRecords(spec, ulid, "bankB"),
      bankC: makeRecords(spec, ulid, "bankC"),
      bankD: makeRecords(spec, ulid, "bankD"),
    } as Record<string, Record<string, unknown>[]>;
    bankRecords["bankD"] = bankRecords["bankD"]!.slice(0, 2); // only 2 instead of 4
    expect(() => buildDeal(spec, bankRecords, { ulid })).toThrow(/expected 4 record bodies/);
  });
});

describe("buildDeal — bilateral degenerate case", () => {
  test("two transfers across two banks, one Tx per holder", () => {
    const spec: DealSpec = {
      initiator: "alice",
      transfers: [
        { promise: "logo", issuerBank: "bankAlice", amount: 1, from: { holder: "alice", account: "a1" }, to: { holder: "bob", account: "b1" } },
        { promise: "hour", issuerBank: "bankBob", amount: 1, from: { holder: "bob", account: "b2" }, to: { holder: "alice", account: "a2" } },
      ],
    };
    const ulid = counterUlid();
    const bankRecords = {
      bankAlice: [
        recordBody("debit", "bankAlice", ulid(), "a1", ulid(), 1),
        recordBody("credit", "bankAlice", ulid(), "b1", "01UNUSED", 1),
      ],
      bankBob: [
        recordBody("debit", "bankBob", ulid(), "b2", ulid(), 1),
        recordBody("credit", "bankBob", ulid(), "a2", "01UNUSED", 1),
      ],
    };
    // Fix pair refs for a clean hash (bankAlice credit pairs with its debit, etc.)
    bankRecords.bankAlice[1]!.pair = (bankRecords.bankAlice[0] as { ulid: string }).ulid;
    bankRecords.bankBob[1]!.pair = (bankRecords.bankBob[0] as { ulid: string }).ulid;
    bankRecords.bankAlice[0]!.pair = (bankRecords.bankAlice[1] as { ulid: string }).ulid;
    bankRecords.bankBob[0]!.pair = (bankRecords.bankBob[1] as { ulid: string }).ulid;

    const d = buildDeal(spec, bankRecords, { ulid });
    expect(d.order).toEqual(["bankAlice", "bankBob"]);

    const alice = d.holderTxs.find((h) => h.holder === "alice")!;
    const bob = d.holderTxs.find((h) => h.holder === "bob")!;
    expect(alice.role).toBe("lead");
    expect(bob.role).toBe("follow");
    expect([...alice.banks].sort()).toEqual(["bankAlice", "bankBob"]);
    expect([...bob.banks].sort()).toEqual(["bankAlice", "bankBob"]);
  });
});

describe("buildDeal — validation", () => {
  test("rejects an initiator who is not a holder", () => {
    const ulid = counterUlid();
    expect(() =>
      buildDeal(
        {
          initiator: "stranger",
          transfers: [
            { promise: "p1", issuerBank: "bankX", amount: 1, from: { holder: "x", account: "x1" }, to: { holder: "y", account: "y1" } },
          ],
        },
        { bankX: [recordBody("debit", "bankX", ulid(), "x1", ulid(), 1), recordBody("credit", "bankX", ulid(), "y1", "01UNUSED", 1)] },
      ),
    ).toThrow(/initiator must be a holder/);
  });

  test("rejects empty transfers", () => {
    expect(() => buildDeal({ initiator: "x", transfers: [] }, {})).toThrow(/at least one transfer/);
  });

  test("rejects a non-positive amount", () => {
    const ulid = counterUlid();
    expect(() =>
      buildDeal(
        {
          initiator: "x",
          transfers: [
            { promise: "p1", issuerBank: "bankX", amount: 0, from: { holder: "x", account: "x1" }, to: { holder: "y", account: "y1" } },
          ],
        },
        { bankX: [recordBody("debit", "bankX", ulid(), "x1", ulid(), 1), recordBody("credit", "bankX", ulid(), "y1", "01UNUSED", 1)] },
      ),
    ).toThrow(/amount must be positive/);
  });
});
