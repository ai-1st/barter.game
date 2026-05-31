// Deal builder — the client-side, pure-logic core of N-party settlement.
//
// A *deal* is a set of transfers. Each transfer moves one Promise from a debit
// holder to a credit holder, and lives entirely at the Promise's issuer bank
// (debit + credit are both that bank's records). The proposing client is the
// only party that sees the whole deal; it builds the records + Tx here, then
// hands each bank ONLY its own slice (see PROTOCOL.md §2 Visibility, §7.1).
//
// This module has zero I/O. It is exercised by both the Bun and Deno test
// suites, same as canonical.ts, so the record/Tx bytes it produces are
// identical across runtimes.

import { hashDoc, newUlid } from "./crypto.ts";
import type { Base58PubKey, Base58SHA256, LedgerRecord, Tx } from "./schemas.ts";

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
  /** The user proposing + orchestrating the deal. Becomes `Tx.pubkey`. */
  proposer: Base58PubKey;
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
  /** Bodies of ONLY this bank's records (its issued Promise's movements). */
  records: LedgerRecord[];
};

export type BuiltDeal = {
  /** Full Tx doc: pubkey=proposer, records=ALL record hashes (in build order). */
  tx: Tx;
  txHash: Base58SHA256;
  /** Every record, for the proposer's own bookkeeping. */
  records: LedgerRecord[];
  /** Per-bank slices, ordered by settle (topological) order: leads first. */
  legs: BankLeg[];
  /** Settle order as bank pubkeys (leads first). */
  order: Base58PubKey[];
  /** holder pubkey → banks where the holder appears (debit or credit). The
   *  client delivers each holder's one `confirm` to every listed bank. */
  confirmsByHolder: Record<Base58PubKey, Base58PubKey[]>;
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
 * Build a deal into its records, Tx, and per-bank slices.
 *
 * Record ordering in `Tx.records[]` is `[t0.debit, t0.credit, t1.debit,
 * t1.credit, …]` — stable and reproducible from the transfer list.
 */
export function buildDeal(spec: DealSpec, opts: BuildDealOptions = {}): BuiltDeal {
  const ulid = opts.ulid ?? newUlid;
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

  // Build records (debit, credit) per transfer, in order.
  const records: LedgerRecord[] = [];
  for (const t of spec.transfers) {
    records.push({
      type: "debit",
      pubkey: t.issuerBank,
      ulid: ulid(),
      account: t.from.account,
      amount: t.amount,
    });
    records.push({
      type: "credit",
      pubkey: t.issuerBank,
      ulid: ulid(),
      account: t.to.account,
      amount: t.amount,
    });
  }
  const recordHashes = records.map((r) => hashDoc(r));

  const tx: Tx = {
    type: "tx",
    pubkey: spec.proposer,
    ulid: ulid(),
    records: recordHashes,
  };
  const txHash = hashDoc(tx);

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

  // Slice records per bank.
  const recordsByBank = new Map<string, LedgerRecord[]>();
  for (const r of records) {
    const owner = r.pubkey;
    if (!recordsByBank.has(owner)) recordsByBank.set(owner, []);
    recordsByBank.get(owner)!.push(r);
  }
  const legs: BankLeg[] = order.map((bank) => ({
    bank,
    role: leadSet.has(bank) ? "lead" : "follow",
    predecessors: predecessors[bank] ?? [],
    records: recordsByBank.get(bank) ?? [],
  }));

  // Which banks each holder must confirm at: any bank where they hold a record.
  const confirmsByHolder: Record<string, string[]> = {};
  for (const t of spec.transfers) {
    for (const holder of [t.from.holder, t.to.holder]) {
      if (!confirmsByHolder[holder]) confirmsByHolder[holder] = [];
      if (!confirmsByHolder[holder].includes(t.issuerBank)) {
        confirmsByHolder[holder].push(t.issuerBank);
      }
    }
  }

  return { tx, txHash, records, legs, order, confirmsByHolder };
}
