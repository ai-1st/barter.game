// Client-side orchestration of an N-party deal.
//
// The proposing user is the coordinator (PROTOCOL.md §2 Visibility): it holds
// the whole deal, hands each bank only its own slice, and relays signatures.
// Banks never call each other. This module drives propose_leg → hold_leg, and
// later the settle_leg cascade, signing every call as the proposer.

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
 * Build the deal, propose every leg, then lock every leg. On any failure,
 * reject every leg already touched and rethrow. Returns the DealState the
 * proposer persists for the later settle cascade.
 */
export async function proposeAndHold(
  profile: Profile,
  spec: DealSpec,
  banks: BankMap,
): Promise<DealState> {
  const built = buildDeal(spec);
  const approve = proposerApprove(profile, built.txHash);

  for (const bank of built.order) {
    if (!banks[bank]) throw new Error(`no URL configured for participating bank ${bank}`);
  }

  const touched: string[] = [];
  try {
    // Phase 1: propose each leg with ONLY that bank's records.
    for (const leg of built.legs) {
      await call(
        profile,
        "propose_leg",
        { tx: built.tx, records: leg.records, proposer_approve: approve, role: leg.role, predecessors: leg.predecessors },
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
