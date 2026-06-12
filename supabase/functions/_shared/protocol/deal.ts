// GENERATED — do not edit. Source: packages/protocol/src/deal.ts
// Re-sync with: bun run scripts/sync-protocol.ts

// Deal builder — the client-side, pure-logic core of N-party settlement.
//
// A *deal* is a set of transfers. Each transfer moves one Promise from a debit
// holder to a credit holder, and lives entirely at the Promise's issuer bank
// (debit + credit are both that bank's records). The initiating client is the
// only party that sees the whole deal; it hands each bank ONLY its own slice
// (see PROTOCOL.md §2 Visibility, §7.1).
//
// Records are bank-minted: the client calls `create_records` on each bank,
// the bank assigns ULIDs, stores the records, and returns them. The client
// then assembles ONE Tx PER HOLDER from those ULIDs: each holder's Tx binds
// exactly the records sitting on that holder's accounts. The initiator signs
// their Tx with action "lead", every other holder signs theirs "follow", and
// each signed Tx is submitted to the banks owning any of its records. From
// there the banks self-advance through hold and settle.
//
// This module has zero I/O. It is exercised by both the Bun and Deno test
// suites, same as canonical.ts.

import { hashDoc, newUlid } from "./crypto.ts";
import type { Base58PubKey, Base58SHA256, Tx, ULID } from "./schemas.ts";

/** One leg of value movement: `from` gives `amount` of `promise` to `to`. */
export type TransferSpec = {
  /** Hash of the Promise doc being moved. */
  promise: Base58SHA256;
  /** Pubkey of the bank that issued `promise` — owns both records. */
  issuerBank: Base58PubKey;
  amount: number;
  /** The giver: account is debited. */
  from: { holder: Base58PubKey; account: Base58SHA256 };
  /** The receiver: account is credited. */
  to: { holder: Base58PubKey; account: Base58SHA256 };
};

export type DealSpec = {
  /** Client-generated grouping ULID — passed to `create_records` on every
   *  bank before the deal is built, so it must exist up front. */
  deal: ULID;
  /** The user initiating + orchestrating the deal. Must be a holder in the
   *  deal; their Tx is signed with action "lead". */
  initiator: Base58PubKey;
  transfers: TransferSpec[];
  /**
   * Banks that settle first, bearing the lead/follow risk. Their incoming
   * dependencies are cut so the settle graph is acyclic. Must be a set of
   * participating bank pubkeys large enough to break every cycle.
   */
  leadBanks: Base58PubKey[];
};

/** What one bank is told — and only this. */
export type BankLeg = {
  bank: Base58PubKey;
  role: "lead" | "follow";
  /** Bank pubkeys whose `settle` this bank must observe before settling. */
  predecessors: Base58PubKey[];
  /** ULIDs of this bank's records (in the order returned by create_records). */
  recordUlids: ULID[];
};

/** One holder's slice of the deal: the Tx they must sign and where to send it. */
export type HolderTxPlan = {
  holder: Base58PubKey;
  /** Unsigned Tx body: pubkey = holder, records = ULIDs on the holder's
   *  accounts, in transfer order. Authority comes from the holder's
   *  lead/follow Signature over `txHash`, not from the body itself. */
  tx: Tx;
  txHash: Base58SHA256;
  /** Holder-signature action: the initiator leads, everyone else follows.
   *  (Distinct concept from the bank settle-topology role on BankLeg.) */
  role: "lead" | "follow";
  /** Banks owning any of tx.records — where the signed Tx must be presented. */
  banks: Base58PubKey[];
};

export type BuiltDeal = {
  /** The grouping ULID from DealSpec, echoed for convenience. */
  deal: ULID;
  /** One plan per distinct holder. Their tx.records are a disjoint exact
   *  cover of every record ULID in the deal. */
  holderTxs: HolderTxPlan[];
  /** Per-bank slices, ordered by settle (topological) order: leads first. */
  legs: BankLeg[];
  /** Settle order as bank pubkeys (leads first). */
  order: Base58PubKey[];
};

export type BuildDealOptions = {
  /** Override the ULID source (tests inject a deterministic counter). */
  ulid?: () => string;
};

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

/**
 * Topological sort of banks by predecessor edges (Kahn's algorithm).
 * Leads (no predecessors) come first. Throws if a cycle remains — that means
 * the chosen lead set does not break every cycle.
 */
export function topoSortBanks(
  banks: Base58PubKey[],
  predecessors: Record<Base58PubKey, Base58PubKey[]>,
): Base58PubKey[] {
  const indeg = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // pred -> banks that depend on it
  for (const b of banks) {
    indeg.set(b, 0);
    dependents.set(b, []);
  }
  for (const b of banks) {
    for (const p of predecessors[b] ?? []) {
      if (!indeg.has(p)) continue; // ignore preds outside the participant set
      indeg.set(b, (indeg.get(b) ?? 0) + 1);
      dependents.get(p)!.push(b);
    }
  }
  // Stable seed: keep the input order among ready nodes.
  const ready = banks.filter((b) => (indeg.get(b) ?? 0) === 0);
  const order: string[] = [];
  while (ready.length > 0) {
    const b = ready.shift()!;
    order.push(b);
    for (const d of dependents.get(b)!) {
      indeg.set(d, (indeg.get(d) ?? 0) - 1);
      if (indeg.get(d) === 0) ready.push(d);
    }
  }
  if (order.length !== banks.length) {
    const stuck = banks.filter((b) => !order.includes(b));
    throw new Error(
      `deal settle graph has a cycle among banks [${stuck.join(", ")}]; ` +
        `add one of them to leadBanks to break it`,
    );
  }
  return order;
}

function validateTransfer(t: TransferSpec, i: number): void {
  const must = (cond: boolean, msg: string) => {
    if (!cond) throw new Error(`transfer[${i}]: ${msg}`);
  };
  must(typeof t.promise === "string" && t.promise.length > 0, "promise hash required");
  must(typeof t.issuerBank === "string" && t.issuerBank.length > 0, "issuerBank required");
  must(typeof t.amount === "number" && Number.isFinite(t.amount) && t.amount > 0, "amount must be positive");
  must(!!t.from && typeof t.from.holder === "string" && typeof t.from.account === "string", "from.{holder,account} required");
  must(!!t.to && typeof t.to.holder === "string" && typeof t.to.account === "string", "to.{holder,account} required");
}

/**
 * Group transfers by issuer bank, preserving the original relative order.
 */
function groupTransfersByBank(
  transfers: TransferSpec[],
): Map<Base58PubKey, { transfers: TransferSpec[]; indices: number[] }> {
  const groups = new Map<string, { transfers: TransferSpec[]; indices: number[] }>();
  for (let i = 0; i < transfers.length; i++) {
    const bank = transfers[i].issuerBank;
    if (!groups.has(bank)) groups.set(bank, { transfers: [], indices: [] });
    groups.get(bank)!.transfers.push(transfers[i]);
    groups.get(bank)!.indices.push(i);
  }
  return groups;
}

/**
 * Build a deal into its per-holder Txs and per-bank slices.
 *
 * The client must first call `create_records` on each participating bank,
 * passing that bank's transfers (and the deal ULID from the spec). The bank
 * returns record ULIDs in the same order (debit, credit per transfer). Those
 * ULIDs are fed back in via `bankRecordUlids`.
 *
 * Per transfer, the debit ULID lands in the giver's Tx and the credit ULID
 * in the receiver's Tx, in transfer order — so the holder Txs partition the
 * deal's records exactly (disjoint exact cover).
 */
export function buildDeal(
  spec: DealSpec,
  bankRecordUlids: Record<Base58PubKey, ULID[]>,
  opts: BuildDealOptions = {},
): BuiltDeal {
  const ulid = opts.ulid ?? newUlid;
  if (typeof spec.deal !== "string" || spec.deal.length === 0) {
    throw new Error("deal ULID required (generate before create_records)");
  }
  if (!spec.transfers || spec.transfers.length === 0) {
    throw new Error("deal needs at least one transfer");
  }
  spec.transfers.forEach(validateTransfer);

  const banks = uniq(spec.transfers.map((t) => t.issuerBank));
  for (const lead of spec.leadBanks) {
    if (!banks.includes(lead)) {
      throw new Error(`leadBank ${lead} is not an issuer bank in this deal`);
    }
  }
  const holders = uniq(spec.transfers.flatMap((t) => [t.from.holder, t.to.holder]));
  if (!holders.includes(spec.initiator)) {
    throw new Error("initiator must be a holder in the deal");
  }

  // Validate supplied record ULIDs match each bank's transfer count.
  const groups = groupTransfersByBank(spec.transfers);
  for (const [bank, g] of groups) {
    const supplied = bankRecordUlids[bank];
    if (!supplied) {
      throw new Error(`missing record ULIDs for bank ${bank}`);
    }
    const expected = g.transfers.length * 2; // one debit + one credit per transfer
    if (supplied.length !== expected) {
      throw new Error(
        `bank ${bank}: expected ${expected} record ULIDs (${g.transfers.length} transfers), got ${supplied.length}`,
      );
    }
  }

  // Map each transfer index to its bank-assigned debit/credit ULIDs.
  const debitUlid: ULID[] = new Array(spec.transfers.length);
  const creditUlid: ULID[] = new Array(spec.transfers.length);
  for (const [bank, g] of groups) {
    const ulids = bankRecordUlids[bank];
    for (let j = 0; j < g.indices.length; j++) {
      const idx = g.indices[j];
      debitUlid[idx] = ulids[j * 2];
      creditUlid[idx] = ulids[j * 2 + 1];
    }
  }

  // Partition records per holder, in transfer order: the debit ULID belongs
  // to the giver, the credit ULID to the receiver. Together the holder Txs
  // cover every record exactly once.
  const recordsByHolder = new Map<Base58PubKey, ULID[]>();
  const banksByHolder = new Map<Base58PubKey, Base58PubKey[]>();
  const push = (holder: Base58PubKey, rec: ULID, bank: Base58PubKey) => {
    if (!recordsByHolder.has(holder)) {
      recordsByHolder.set(holder, []);
      banksByHolder.set(holder, []);
    }
    recordsByHolder.get(holder)!.push(rec);
    if (!banksByHolder.get(holder)!.includes(bank)) {
      banksByHolder.get(holder)!.push(bank);
    }
  };
  spec.transfers.forEach((t, i) => {
    push(t.from.holder, debitUlid[i], t.issuerBank);
    push(t.to.holder, creditUlid[i], t.issuerBank);
  });

  const holderTxs: HolderTxPlan[] = holders.map((holder) => {
    const tx: Tx = {
      type: "tx",
      pubkey: holder,
      ulid: ulid(),
      records: recordsByHolder.get(holder)!,
    };
    return {
      holder,
      tx,
      txHash: hashDoc(tx),
      role: holder === spec.initiator ? "lead" : "follow",
      banks: banksByHolder.get(holder)!,
    };
  });

  // Predecessors: a bank waits for the banks that credit its debit-holders,
  // because once those settle the bank's giver has actually been paid. Lead
  // banks cut their incoming edges (they go first, bearing the risk).
  const debitHoldersByBank = new Map<string, Set<string>>();
  for (const t of spec.transfers) {
    if (!debitHoldersByBank.has(t.issuerBank)) debitHoldersByBank.set(t.issuerBank, new Set());
    debitHoldersByBank.get(t.issuerBank)!.add(t.from.holder);
  }
  const leadSet = new Set(spec.leadBanks);
  const predecessors: Record<string, string[]> = {};
  for (const bank of banks) {
    if (leadSet.has(bank)) {
      predecessors[bank] = [];
      continue;
    }
    const debitHolders = debitHoldersByBank.get(bank) ?? new Set();
    const preds = uniq(
      spec.transfers
        .filter((t) => debitHolders.has(t.to.holder) && t.issuerBank !== bank)
        .map((t) => t.issuerBank),
    );
    predecessors[bank] = preds;
  }

  const order = topoSortBanks(banks, predecessors);

  // Slice record ULIDs per bank.
  const legs: BankLeg[] = order.map((bank) => ({
    bank,
    role: leadSet.has(bank) ? "lead" : "follow",
    predecessors: predecessors[bank] ?? [],
    recordUlids: bankRecordUlids[bank] ?? [],
  }));

  return { deal: spec.deal, holderTxs, legs, order };
}
