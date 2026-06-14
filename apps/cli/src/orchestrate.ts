// Client-side orchestration of a direct-approval deal.
//
// The initiating user holds the whole deal and hands each bank only its own
// slice (PROTOCOL.md §2 Visibility). The client's job ends early: it creates
// the records on every bank (create_records), cross-subscribes the banks to
// each other's session signatures, and submits the holder Txs it has (its own,
// signed "lead"; others arrive via deal tokens and `barter accept`). From
// there the BANKS self-advance through hold and settle — there is no client
// hold/settle call. If a push gets lost, `relayAll` (barter nudge) carries
// the signatures by hand; they hold their own authority.
//
// Each bank groups its records under a per-bank `session` ULID supplied by
// the initiator. The user-facing `deal` ULID is for local state only; it is
// never passed to banks or shared across them.

import {
  buildDeal,
  hashDoc,
  newUlid,
  signDoc,
  signDealToken,
  encodeDealToken,
  type BuiltDeal,
  type DealSpec,
  type SignedDealToken,
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
  legs: Array<{ bank: string; role: "lead" | "follow"; predecessors: string[] }>;
  /** Per-bank session ULIDs supplied to create_records and used for subscriptions. */
  sessionsByBank: Record<string, string>;
  holderTxs: HolderTxState[];
  /** Record bodies returned by create_records, by ULID. */
  records: Record<string, Record<string, unknown>>;
};

/** The settle topology (roles, predecessors, order) depends only on the
 *  transfer graph — compute it before any bank call by building the deal
 *  with placeholder ULIDs. */
export function computeTopology(spec: DealSpec): {
  legs: BuiltDeal["legs"];
  order: string[];
} {
  let n = 0;
  const fake = () => ("0FAKE" + String(n++).padStart(21, "0")).slice(0, 26);
  const fakeUlids: Record<string, string[]> = {};
  for (const t of spec.transfers) {
    if (!fakeUlids[t.issuerBank]) fakeUlids[t.issuerBank] = [];
    fakeUlids[t.issuerBank].push(fake(), fake());
  }
  const built = buildDeal(spec, fakeUlids, { ulid: fake });
  return { legs: built.legs, order: built.order };
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

const rpcUrl = (bankUrl: string) => `${bankUrl.replace(/\/$/, "")}/rpc`;

/**
 * Wave 1, initiator side: create_records on every bank (attaching any
 * supporting docs), cross-subscribe the banks to each other, sign and
 * submit the initiator's own Tx as "lead". Returns the DealState to
 * persist; the remaining holders sign via deal tokens (`barter accept`).
 */
export async function createRecordsAndLead(
  profile: Profile,
  spec: DealSpec,
  banks: BankMap,
  docsByBank: Record<string, Array<Record<string, unknown>>> = {},
): Promise<DealState> {
  const topology = computeTopology(spec);
  for (const bank of topology.order) {
    if (!banks[bank]) throw new Error(`no URL configured for participating bank ${bank}`);
  }

  // Each bank gets its own opaque session ULID. It is supplied to
  // create_records and used for subscriptions / get_session / reject_session.
  const sessionsByBank: Record<string, string> = {};
  for (const leg of topology.legs) {
    sessionsByBank[leg.bank] = newUlid();
  }

  // Phase 0: create records at each bank. The bank assigns ULIDs and stores
  // this bank's slice of the topology alongside.
  const bankRecordUlids: Record<string, string[]> = {};
  const records: Record<string, Record<string, unknown>> = {};
  for (const leg of topology.legs) {
    const transfers = spec.transfers
      .filter((t) => t.issuerBank === leg.bank)
      .map((t) => ({ amount: t.amount, from_account: t.from.account, to_account: t.to.account }));
    const res = (await call(
      profile,
      "create_records",
      {
        session: sessionsByBank[leg.bank],
        role: leg.role,
        predecessors: leg.predecessors,
        banks: topology.order,
        transfers,
        docs: docsByBank[leg.bank] ?? [],
      },
      { bankUrl: banks[leg.bank], toBankPubkey: leg.bank },
    )) as { records: Array<Record<string, unknown>> };
    bankRecordUlids[leg.bank] = res.records.map((r) => r.ulid as string);
    for (const r of res.records) records[r.ulid as string] = r;
  }

  const built = buildDeal(spec, bankRecordUlids);

  // Cross-subscribe the banks to each other's session signatures, so they can
  // self-advance (the lead waits for peer holds; followers for predecessor
  // settles). For each ordered pair (thisBank, peerBank), thisBank watches its
  // own session and pushes to peerBank's URL. Client relay (`barter nudge`) is
  // the fallback topology.
  for (const bank of topology.order) {
    for (const peer of topology.order) {
      if (peer === bank) continue;
      const sub: Record<string, unknown> = {
        type: "subscription",
        pubkey: profile.pubkey,
        ulid: newUlid(),
        sessions: [sessionsByBank[bank]],
        url: rpcUrl(banks[peer]),
        to: peer,
      };
      await call(profile, "subscribe", { subscription: sub }, { bankUrl: banks[bank], toBankPubkey: bank });
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
      { tx: mine.tx, holder_sig: sig, docs: docsByBank[bank] ?? [] },
      { bankUrl: banks[bank], toBankPubkey: bank },
    );
  }

  return {
    deal: spec.deal,
    initiator: profile.pubkey,
    order: built.order,
    banks,
    legs: built.legs.map((l) => ({ bank: l.bank, role: l.role, predecessors: l.predecessors })),
    sessionsByBank,
    holderTxs: built.holderTxs.map((h) => ({
      holder: h.holder,
      tx: h.tx,
      txHash: h.txHash,
      role: h.role,
      banks: h.banks,
    })),
    records,
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
    const token: SignedDealToken = signDealToken(
      {
        pubkey: profile.pubkey,
        deal: state.deal,
        tx: h.tx,
        records: h.tx.records.map((u) => state.records[u]).filter(Boolean) as never,
        banks: h.banks.map((b) => ({ pubkey: b, url: state.banks[b], session: state.sessionsByBank[b] })),
        exp: Math.floor(Date.now() / 1000) + expSeconds,
      },
      profilePrivateKeyBytes(profile),
    );
    out.push({ holder: h.holder, token: encodeDealToken(token) });
  }
  return out;
}

/** Submit a holder's signed "follow" Tx to every bank owning its records. */
export async function submitFollow(
  profile: Profile,
  tx: Tx,
  banks: Array<{ pubkey: string; url: string }>,
  docs: Array<Record<string, unknown>> = [],
): Promise<void> {
  const sig = holderSig(profile, hashDoc(tx), "follow");
  for (const b of banks) {
    await call(profile, "submit_tx", { tx, holder_sig: sig, docs }, { bankUrl: b.url, toBankPubkey: b.pubkey });
  }
}

/** Per-bank leg states for a deal. */
export async function fetchLegStates(
  profile: Profile,
  state: DealState,
): Promise<Array<{ bank: string; state: string }>> {
  const out: Array<{ bank: string; state: string }> = [];
  for (const bank of state.order) {
    const session = state.sessionsByBank[bank];
    if (!session) throw new Error(`no session stored for bank ${bank}`);
    const res = (await call(profile, "get_session", { session }, {
      bankUrl: state.banks[bank],
      toBankPubkey: bank,
    })) as { state: string };
    out.push({ bank, state: res.state });
  }
  return out;
}

/**
 * Client relay — the fallback topology. Carry every signature each bank has
 * for its own session to every other bank (signatures hold their own
 * authority, so anyone may deliver them). Un-sticks a deal whose pushes were
 * lost.
 */
export async function relayAll(profile: Profile, state: DealState): Promise<void> {
  const sigsByBank: Record<string, Array<Record<string, unknown>>> = {};
  for (const bank of state.order) {
    const session = state.sessionsByBank[bank];
    if (!session) continue;
    const res = (await call(profile, "get_session", { session }, {
      bankUrl: state.banks[bank],
      toBankPubkey: bank,
    })) as { signatures: Array<Record<string, unknown>> };
    sigsByBank[bank] = res.signatures.filter((s) => typeof s.sig === "string");
  }
  for (const from of state.order) {
    for (const to of state.order) {
      if (from === to || sigsByBank[from].length === 0) continue;
      await call(
        profile,
        "notify_signatures",
        { signatures: sigsByBank[from] },
        { bankUrl: state.banks[to], toBankPubkey: to },
      );
    }
  }
}
