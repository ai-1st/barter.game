// Client-side orchestration of an N-party deal.
//
// The proposing user is the coordinator (PROTOCOL.md §2 Visibility): it holds
// the whole deal, hands each bank only its own slice, and relays signatures.
// Banks never call each other. This module drives create_records → propose_leg
// → hold_leg, and later the settle_leg cascade, signing every call as the
// proposer.

import { buildDeal, newUlid, signDoc, type DealSpec } from "../../../packages/protocol/src/index.ts";
import { call } from "./client.ts";
import type { Profile } from "./profile.ts";
import { profilePrivateKeyBytes } from "./profile.ts";

/** bank pubkey → RPC URL. The proposer is the only party that needs all of them. */
export type BankMap = Record<string, string>;

/** Persisted by the proposer between propose-time and settle-time. */
export type DealState = {
  txHash: string;
  proposer: string;
  order: string[];
  banks: BankMap;
  legs: Array<{ bank: string; role: "lead" | "follow"; predecessors: string[] }>;
  confirmsByHolder: Record<string, string[]>;
};

function proposerApprove(profile: Profile, txHash: string): Record<string, unknown> {
  const approve: Record<string, unknown> = {
    type: "signature",
    pubkey: profile.pubkey,
    ulid: newUlid(),
    hash: txHash,
    action: "approve",
  };
  approve.sig = signDoc(approve, profilePrivateKeyBytes(profile));
  return approve;
}

/**
 * Call create_records on every participating bank, assemble the record ULIDs
 * into a Tx, propose every leg, then lock every leg. On any failure,
 * reject every leg already touched and rethrow. Returns the DealState the
 * proposer persists for the later settle cascade.
 */
export async function proposeAndHold(
  profile: Profile,
  spec: DealSpec,
  banks: BankMap,
): Promise<DealState> {
  // Phase 0: create records at each bank. The bank assigns ULIDs.
  const bankRecordUlids: Record<string, string[]> = {};
  const touchedCreate: string[] = [];
  try {
    // Group transfers by bank so we can call create_records per bank.
    const groups = new Map<string, Array<{ amount: number; from_account: string; to_account: string }>>();
    for (const t of spec.transfers) {
      if (!groups.has(t.issuerBank)) groups.set(t.issuerBank, []);
      groups.get(t.issuerBank)!.push({
        amount: t.amount,
        from_account: t.from.account,
        to_account: t.to.account,
      });
    }

    for (const [bank, transfers] of groups) {
      if (!banks[bank]) throw new Error(`no URL configured for participating bank ${bank}`);
      const res = (await call(
        profile,
        "create_records",
        { transfers },
        { bankUrl: banks[bank], toBankPubkey: bank },
      )) as { records: Array<Record<string, unknown>> };
      bankRecordUlids[bank] = res.records.map((r) => r.ulid as string);
      touchedCreate.push(bank);
    }
  } catch (err) {
    // Best-effort cleanup: if create_records fails partway through, we can't
    // really undo the records already created (they're bank-minted). The
    // client just rethrows and the deal is abandoned.
    throw err;
  }

  // Build the Tx from the collected ULIDs.
  const built = buildDeal(spec, bankRecordUlids);
  const approve = proposerApprove(profile, built.txHash);

  const touched: string[] = [];
  try {
    // Phase 1: propose each leg with ONLY that bank's record ULIDs.
    for (const leg of built.legs) {
      await call(
        profile,
        "propose_leg",
        { tx: built.tx, record_ulids: leg.recordUlids, proposer_approve: approve, role: leg.role, predecessors: leg.predecessors },
        { bankUrl: banks[leg.bank], toBankPubkey: leg.bank },
      );
      touched.push(leg.bank);
    }
    // Phase 2: lock each leg's debit accounts.
    for (const leg of built.legs) {
      await call(profile, "hold_leg", { tx_hash: built.txHash }, { bankUrl: banks[leg.bank], toBankPubkey: leg.bank });
    }
  } catch (err) {
    await Promise.allSettled(
      touched.map((bank) =>
        call(profile, "reject_leg", { tx_hash: built.txHash, reason: "propose/hold failed" }, { bankUrl: banks[bank], toBankPubkey: bank }),
      ),
    );
    throw err;
  }

  return {
    txHash: built.txHash,
    proposer: profile.pubkey,
    order: built.order,
    banks,
    legs: built.legs.map((l) => ({ bank: l.bank, role: l.role, predecessors: l.predecessors })),
    confirmsByHolder: built.confirmsByHolder,
  };
}

/**
 * Run the settle cascade in topological order. Each follower is called only
 * after the proposer holds valid `settle` sigs from all its predecessors, which
 * are relayed in as `upstream_settles`. Returns per-bank settle results.
 */
export async function settleCascade(
  profile: Profile,
  state: DealState,
): Promise<Array<{ bank: string; state: string }>> {
  const settles: Record<string, Record<string, unknown>> = {};
  const results: Array<{ bank: string; state: string }> = [];
  for (const bank of state.order) {
    const leg = state.legs.find((l) => l.bank === bank);
    if (!leg) throw new Error(`deal state missing leg for bank ${bank}`);
    const upstream = leg.predecessors.map((p) => {
      const s = settles[p];
      if (!s) throw new Error(`missing predecessor settle from ${p} for ${bank}`);
      return s;
    });
    const res = (await call(
      profile,
      "settle_leg",
      { tx_hash: state.txHash, upstream_settles: upstream },
      { bankUrl: state.banks[bank], toBankPubkey: bank },
    )) as { settle: Record<string, unknown>; state: string };
    settles[bank] = res.settle;
    results.push({ bank, state: res.state });
  }
  return results;
}
