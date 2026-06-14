// Deal builder — the client-side, pure-logic core of N-party settlement.
//
// A *deal* is a set of transfers. Each transfer moves one Promise from a debit
// holder to a credit holder, and lives entirely at the Promise's issuer bank
// (debit + credit are both that bank's records). The initiating client is the
// only party that sees the whole deal; it hands each bank ONLY its own slice
// (see PROTOCOL.md §2 Visibility).
//
// Records are bank-minted and content-addressed by hash. The client calls
// `create_records` on each bank; the bank assigns ULIDs, stores the records as
// drafts, and returns the record bodies. The client hashes the bodies and
// assembles ONE Tx PER HOLDER from those hashes: each holder's Tx binds
// exactly the records sitting on that holder's accounts. The initiator signs
// their Tx with action "lead", every other holder signs theirs "follow", and
// each signed Tx is submitted to the banks owning any of its records. From
// there the banks self-advance through hold and settle per record pair.
//
// This module has zero I/O. It is exercised by both the Bun and Deno test
// suites, same as canonical.ts.

import { hashDoc, newUlid } from "./crypto.ts";
import type { Base58PubKey, Base58SHA256, RecordDoc, Tx, ULID } from "./schemas.ts";
import { hashRecord } from "./schemas.ts";

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
  /** The user initiating + orchestrating the deal. Must be a holder in the
   *  deal; their Tx is signed with action "lead". */
  initiator: Base58PubKey;
  transfers: TransferSpec[];
};

/** What one bank is told — and only this. */
export type BankLeg = {
  bank: Base58PubKey;
  /** Content-addressed hashes of this bank's records (debit, credit per
   *  transfer, in transfer order). */
  recordHashes: Base58SHA256[];
};

/** One holder's slice of the deal: the Tx they must sign and where to send it. */
export type HolderTxPlan = {
  holder: Base58PubKey;
  /** Unsigned Tx body: pubkey = holder, records = record hashes on the
   *  holder's accounts, in transfer order. Authority comes from the holder's
   *  lead/follow Signature over `txHash`, not from the body itself. */
  tx: Tx;
  txHash: Base58SHA256;
  /** Holder-signature action: the initiator leads, everyone else follows. */
  role: "lead" | "follow";
  /** Banks owning any of tx.records — where the signed Tx must be presented. */
  banks: Base58PubKey[];
};

export type BuiltDeal = {
  /** One plan per distinct holder. Their tx.records are a disjoint exact
   *  cover of every record hash in the deal. */
  holderTxs: HolderTxPlan[];
  /** Per-bank slices, in the order banks first appear in transfers. */
  legs: BankLeg[];
  /** Bank pubkeys in the order they first appear in transfers. */
  order: Base58PubKey[];
};

export type BuildDealOptions = {
  /** Override the ULID source (tests inject a deterministic counter). */
  ulid?: () => string;
};

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
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
    const transfer = transfers[i]!;
    const bank = transfer.issuerBank;
    if (!groups.has(bank)) groups.set(bank, { transfers: [], indices: [] });
    const g = groups.get(bank)!;
    g.transfers.push(transfer);
    g.indices.push(i);
  }
  return groups;
}

/**
 * Build a deal into its per-holder Txs and per-bank slices.
 *
 * The client must first call `create_records` on each participating bank.
 * The bank returns record bodies in transfer order, one debit + one credit
 * per transfer. Those bodies are fed back in via `bankRecords`.
 *
 * Per transfer, the debit record lands in the giver's Tx and the credit
 * record in the receiver's Tx, in transfer order — so the holder Txs
 * partition the deal's records exactly (disjoint exact cover).
 */
export function buildDeal(
  spec: DealSpec,
  bankRecords: Record<Base58PubKey, RecordDoc[]>,
  opts: BuildDealOptions = {},
): BuiltDeal {
  const ulid = opts.ulid ?? newUlid;
  if (!spec.transfers || spec.transfers.length === 0) {
    throw new Error("deal needs at least one transfer");
  }
  spec.transfers.forEach(validateTransfer);

  const banks = uniq(spec.transfers.map((t) => t.issuerBank));
  const holders = uniq(spec.transfers.flatMap((t) => [t.from.holder, t.to.holder]));
  if (!holders.includes(spec.initiator)) {
    throw new Error("initiator must be a holder in the deal");
  }

  // Validate supplied record bodies match each bank's transfer count.
  const groups = groupTransfersByBank(spec.transfers);
  for (const [bank, g] of groups) {
    const supplied = bankRecords[bank];
    if (!supplied) {
      throw new Error(`missing record bodies for bank ${bank}`);
    }
    const expected = g.transfers.length * 2; // one debit + one credit per transfer
    if (supplied.length !== expected) {
      throw new Error(
        `bank ${bank}: expected ${expected} record bodies (${g.transfers.length} transfers), got ${supplied.length}`,
      );
    }
  }

  // Map each transfer index to its bank-assigned debit/credit record hashes.
  const debitHash: Base58SHA256[] = new Array(spec.transfers.length);
  const creditHash: Base58SHA256[] = new Array(spec.transfers.length);
  for (const [bank, g] of groups) {
    const records = bankRecords[bank]!;
    for (let j = 0; j < g.indices.length; j++) {
      const idx = g.indices[j]!;
      const debit = records[j * 2]!;
      const credit = records[j * 2 + 1]!;
      if (debit.type !== "debit" || credit.type !== "credit") {
        throw new Error(`bank ${bank}: expected debit/credit pair at transfer ${j}`);
      }
      debitHash[idx] = hashRecord(debit);
      creditHash[idx] = hashRecord(credit);
    }
  }

  // Partition records per holder, in transfer order: the debit record belongs
  // to the giver, the credit record to the receiver. Together the holder Txs
  // cover every record exactly once.
  const recordsByHolder = new Map<Base58PubKey, Base58SHA256[]>();
  const banksByHolder = new Map<Base58PubKey, Base58PubKey[]>();
  const push = (holder: Base58PubKey, rec: Base58SHA256, bank: Base58PubKey) => {
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
    push(t.from.holder, debitHash[i]!, t.issuerBank);
    push(t.to.holder, creditHash[i]!, t.issuerBank);
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

  // Slice record hashes per bank.
  const legs: BankLeg[] = banks.map((bank) => ({
    bank,
    recordHashes: bankRecords[bank]!.map((r) => hashRecord(r)),
  }));

  return { holderTxs, legs, order: banks };
}
