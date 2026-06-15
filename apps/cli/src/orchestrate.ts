// Client-side orchestration of a direct-approval deal.
//
// The initiating user holds the whole deal and hands each bank only its own
// slice (PROTOCOL.md §2 Visibility). The client's job ends early: it creates
// the records on every bank (create_records), cross-subscribes the banks to
// each other's record signatures, and submits the holder Txs it has (its own
// signed "lead"; others arrive via deal tokens and `barter accept`). From
// there the BANKS self-advance through hold and settle — there is no client
// hold/settle call. If a push gets lost, `relayAll` (barter nudge) carries
// signatures by hand; they hold their own authority.

import {
  buildDeal,
  hashDoc,
  newUlid,
  signDoc,
  signDealToken,
  encodeDealToken,
  type BuiltDeal,
  type DealSpec,
  type RecordDoc,
  type Tx,
} from "../../../packages/protocol/src/index.ts";
import { call } from "./client.ts";
import type { Profile } from "./profile.ts";
import { profilePrivateKeyBytes } from "./profile.ts";

/** bank pubkey → RPC base URL. The initiator is the only party that needs all of them. */
export type BankMap = Record<string, string>;

export type HolderTxState = {
  holder: string;
  tx: Tx;
  txHash: string;
  role: "lead" | "follow";
  banks: string[];
};

/** Persisted by the initiator, keyed by the user-facing deal ULID. */
export type DealState = {
  deal: string;
  initiator: string;
  order: string[];
  banks: BankMap;
  holderTxs: HolderTxState[];
  /** Record bodies returned by create_records, keyed by content hash. */
  records: Record<string, RecordDoc>;
  /** Record hashes grouped by owning bank, in transfer order. */
  recordsByBank: Record<string, string[]>;
};

const rpcUrl = (bankUrl: string) => `${bankUrl.replace(/\/$/, "")}/rpc`;

function bankOrder(spec: DealSpec): string[] {
  const order: string[] = [];
  for (const t of spec.transfers) {
    if (!order.includes(t.issuerBank)) order.push(t.issuerBank);
  }
  return order;
}

function holderSig(profile: Profile, txHash: string, action: "lead" | "follow"): Record<string, unknown> {
  const sig: Record<string, unknown> = {
    type: "signature",
    pubkey: profile.pubkey,
    ulid: newUlid(),
    hash: txHash,
    action,
  };
  sig.sig = signDoc(sig, profilePrivateKeyBytes(profile));
  return sig;
}

/**
 * Wave 1, initiator side: create_records on every bank (attaching any
 * supporting docs), cross-subscribe the banks to each other, sign and submit
 * the initiator's own Tx as "lead". Returns the DealState to persist; the
 * remaining holders sign via deal tokens (`barter accept`).
 */
export async function createRecordsAndLead(
  profile: Profile,
  spec: DealSpec,
  banks: BankMap,
  docsByBank: Record<string, Array<Record<string, unknown>>> = {},
): Promise<DealState> {
  const order = bankOrder(spec);
  for (const bank of order) {
    if (!banks[bank]) throw new Error(`no URL configured for participating bank ${bank}`);
  }

  // Phase 0: create records at each bank. The bank assigns ULIDs and returns
  // the record bodies in transfer order (debit, credit per transfer).
  const recordsByBank: Record<string, string[]> = {};
  const records: Record<string, RecordDoc> = {};
  const bankRecords: Record<string, RecordDoc[]> = {};

  for (const bank of order) {
    const transfers = spec.transfers.filter((t) => t.issuerBank === bank);
    const requests = transfers.map((t) => ({
      type: "transfer" as const,
      promise_hash: t.promise,
      amount: t.amount,
      debit_account_hash: t.from.account,
      credit_account_hash: t.to.account,
    }));
    const res = (await call(
      profile,
      "create_records",
      { requests, docs: docsByBank[bank] ?? [] },
      { bankUrl: banks[bank], toBankPubkey: bank },
    )) as { records: RecordDoc[] };

    const hashes: string[] = [];
    for (const r of res.records) {
      const h = hashDoc(r);
      records[h] = r;
      hashes.push(h);
    }
    recordsByBank[bank] = hashes;
    bankRecords[bank] = res.records;
  }

  const built = buildDeal(spec, bankRecords);
  const allRecordHashes = Object.values(recordsByBank).flat();

  // Cross-subscribe the banks to each other's record signatures, so peer
  // settle signatures fan out and follower banks can advance. For each ordered
  // pair (thisBank, peerBank), thisBank watches all record hashes and pushes
  // to peerBank's URL. Client relay (`barter nudge`) is the fallback.
  for (const bank of order) {
    for (const peer of order) {
      if (peer === bank) continue;
      const sub: Record<string, unknown> = {
        type: "subscription",
        pubkey: profile.pubkey,
        ulid: newUlid(),
        hashes: allRecordHashes,
        url: rpcUrl(banks[peer]!),
        to: peer,
      };
      await call(profile, "subscribe", { subscription: sub }, { bankUrl: banks[bank]!, toBankPubkey: bank });
    }
  }

  // Submit the initiator's own Tx, signed "lead".
  const mine = built.holderTxs.find((h) => h.holder === profile.pubkey);
  if (!mine) throw new Error("initiator is not a holder in this deal");
  const sig = holderSig(profile, mine.txHash, "lead");
  for (const bank of mine.banks) {
    await call(
      profile,
      "submit_tx",
      { tx: mine.tx, holder_signature: sig, docs: docsByBank[bank] ?? [] },
      { bankUrl: banks[bank]!, toBankPubkey: bank },
    );
  }

  return {
    deal: newUlid(),
    initiator: profile.pubkey,
    order,
    banks,
    holderTxs: built.holderTxs.map((h) => ({
      holder: h.holder,
      tx: h.tx,
      txHash: h.txHash,
      role: h.role,
      banks: h.banks,
    })),
    records,
    recordsByBank,
  };
}

/** Encode one signed deal token per follow holder — the OOB handoff that
 *  carries their unsigned Tx, the record bodies it references, and the
 *  banks to submit to. */
export function makeDealTokens(
  profile: Profile,
  state: DealState,
  expSeconds = 7 * 24 * 3600,
): Array<{ holder: string; token: string }> {
  const out: Array<{ holder: string; token: string }> = [];
  for (const h of state.holderTxs) {
    if (h.holder === state.initiator) continue;
    const token = signDealToken(
      {
        pubkey: profile.pubkey,
        deal: state.deal,
        tx: h.tx,
        records: h.tx.records.map((hash) => state.records[hash]).filter(Boolean) as RecordDoc[],
        banks: h.banks.map((b) => ({ pubkey: b, url: state.banks[b]! })),
        exp: Math.floor(Date.now() / 1000) + expSeconds,
      },
      profilePrivateKeyBytes(profile),
    );
    out.push({ holder: h.holder, token: encodeDealToken(token) });
  }
  return out;
}

/** Submit a holder's signed "follow" Tx to every bank owning its records.
 *  docsByBank maps bank pubkey → supporting docs to attach at that bank only.
 *  Account docs must be paired with the bank that issued their promise. */
export async function submitFollow(
  profile: Profile,
  tx: Tx,
  banks: Array<{ pubkey: string; url: string }>,
  docsByBank: Record<string, Array<Record<string, unknown>>> = {},
): Promise<void> {
  const sig = holderSig(profile, hashDoc(tx), "follow");
  for (const b of banks) {
    await call(
      profile,
      "submit_tx",
      { tx, holder_signature: sig, docs: docsByBank[b.pubkey] ?? [] },
      { bankUrl: b.url, toBankPubkey: b.pubkey },
    );
  }
}

/** Per-bank leg states for a deal. */
export async function fetchLegStates(
  profile: Profile,
  state: DealState,
): Promise<Array<{ bank: string; state: string }>> {
  const out: Array<{ bank: string; state: string }> = [];
  for (const bank of state.order) {
    const hashes = state.recordsByBank[bank] ?? [];
    let settled = 0;
    for (const hash of hashes) {
      const res = (await call(profile, "get_record_signatures", { record_hash: hash }, {
        bankUrl: state.banks[bank],
        toBankPubkey: bank,
      })) as { signatures: Array<Record<string, unknown>> };
      if (res.signatures.some((s) => s.action === "settle" && s.pubkey === bank)) settled++;
    }
    const stateName = settled === hashes.length ? "settled" : settled === 0 ? "pending" : "settling";
    out.push({ bank, state: stateName });
  }
  return out;
}

/**
 * Client relay — the fallback topology. Carry every signature each bank has
 * issued for its own records to every other bank (signatures hold their own
 * authority, so anyone may deliver them). Un-sticks a deal whose pushes were
 * lost.
 */
export async function relayAll(profile: Profile, state: DealState): Promise<void> {
  const sigsByBank: Record<string, Array<Record<string, unknown>>> = {};
  for (const bank of state.order) {
    const hashes = state.recordsByBank[bank] ?? [];
    const sigs: Array<Record<string, unknown>> = [];
    for (const hash of hashes) {
      const res = (await call(profile, "get_record_signatures", { record_hash: hash }, {
        bankUrl: state.banks[bank],
        toBankPubkey: bank,
      })) as { signatures: Array<Record<string, unknown>> };
      sigs.push(...res.signatures.filter((s) => typeof s.sig === "string"));
    }
    sigsByBank[bank] = sigs;
  }
  for (const from of state.order) {
    for (const to of state.order) {
      if (from === to || (sigsByBank[from]?.length ?? 0) === 0) continue;
      await call(
        profile,
        "notify_signatures",
        { signatures: sigsByBank[from] },
        { bankUrl: state.banks[to], toBankPubkey: to },
      );
    }
  }
}
