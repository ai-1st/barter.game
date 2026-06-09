// In-memory integration test for the client-orchestrated N-party flow.
//
// Drives the real bank handlers (create_records → propose_leg → hold_leg →
// confirm_receipt → settle_leg) across FOUR simulated banks, with an in-memory
// BankDB, exercising the exact branching/merging deal from PROTOCOL.md §2:
//
//   A → C   B → C   C → D   D → A   D → B      leads: {bank-A, bank-B}
//
// No HTTP, no Postgres — handlers are pure (params, ctx) functions, so we feed
// them a fake ctx whose `db` is the in-memory store. This verifies the protocol
// logic (slicing, holds, the confirm gate, and the settle cascade with seen
// proofs) that we cannot run against live Supabase from here.
//
// Run: deno test --allow-read supabase/functions/_shared/bank/test-deno/nparty.deno-test.ts

import { genKeyPair, hashDoc, newUlid, signDoc } from "../../protocol/crypto.ts";
import { buildDeal, type TransferSpec } from "../../protocol/deal.ts";
import { createRecords } from "../handlers/create_records.ts";
import { proposeLeg } from "../handlers/propose_leg.ts";
import { holdLeg } from "../handlers/hold_leg.ts";
import { confirmReceipt } from "../handlers/confirm_receipt.ts";
import { settleLeg } from "../handlers/settle_leg.ts";

// ── tiny asserts (no std import → no network) ───────────────────────────────
function eq(actual: unknown, expected: unknown, msg: string) {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}
function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// ── in-memory, per-bank-scoped DB (mirrors the real multi-tenant BankDB) ─────
type Hold = { txHash: string; active: boolean; amount: number };
class Store {
  docs = new Map<string, { hash: string; type: string; pubkey: string; body: Record<string, unknown> }>();
  accounts = new Map<string, { promise: string; pocket: string; holder: string; balance: number }>();
  txs = new Map<string, { state: string; role: string | null; predecessors: string[] }>();
  holds = new Map<string, Hold>();
  ledgerRecords = new Map<string, { type: string; account: string; amount: number; pairUlid: string | null; txUlid: string | null; body: Record<string, unknown> }>();
}
const k = (bank: string, x: string) => `${bank}|${x}`;

class InMemoryBankDB {
  constructor(private store: Store, private bankPubkey: string) {}
  insertDoc(input: { hash: string; type: string; pubkey: string; body: Record<string, unknown> }) {
    const key = k(this.bankPubkey, input.hash);
    if (!this.store.docs.has(key)) this.store.docs.set(key, input);
    return Promise.resolve();
  }
  getDoc(hash: string) {
    const d = this.store.docs.get(k(this.bankPubkey, hash));
    return Promise.resolve(d ? { ...d, bank_pubkey: this.bankPubkey, created_at: "" } : null);
  }
  getDocsByHashes(hashes: string[]) {
    const out: Record<string, Record<string, unknown>> = {};
    for (const h of hashes) {
      const d = this.store.docs.get(k(this.bankPubkey, h));
      if (d) out[h] = d.body;
    }
    return Promise.resolve(out);
  }
  getAccount(accountHash: string) {
    const a = this.store.accounts.get(k(this.bankPubkey, accountHash));
    if (!a) return Promise.resolve(null);
    return Promise.resolve({
      account_hash: accountHash,
      bank_pubkey: this.bankPubkey,
      promise_hash: a.promise,
      pocket_hash: a.pocket,
      holder_pubkey: a.holder,
      balance: String(a.balance),
      pending: "0",
      acknowledged: true,
    });
  }
  upsertAccount(input: { accountHash: string; promiseHash: string; pocketHash: string; holderPubkey: string; initialBalance?: number }) {
    this.store.accounts.set(k(this.bankPubkey, input.accountHash), {
      promise: input.promiseHash,
      pocket: input.pocketHash,
      holder: input.holderPubkey,
      balance: input.initialBalance ?? 0,
    });
    return Promise.resolve();
  }
  applyBalanceDelta(accountHash: string, delta: number) {
    const a = this.store.accounts.get(k(this.bankPubkey, accountHash));
    if (!a) throw new Error(`account ${accountHash} not found`);
    a.balance += delta;
    return Promise.resolve(String(a.balance));
  }
  acquireHold(input: { accountHash: string; txHash: string; amount: number }) {
    const key = k(this.bankPubkey, input.accountHash);
    const existing = this.store.holds.get(key);
    if (existing && existing.active) return Promise.resolve(false);
    this.store.holds.set(key, { txHash: input.txHash, active: true, amount: input.amount });
    return Promise.resolve(true);
  }
  releaseHold(accountHash: string, txHash: string) {
    const key = k(this.bankPubkey, accountHash);
    const h = this.store.holds.get(key);
    if (h && h.txHash === txHash) h.active = false;
    return Promise.resolve();
  }
  upsertTx(input: { txHash: string; state: string; role?: string; predecessors?: string[] }) {
    const key = k(this.bankPubkey, input.txHash);
    const prev = this.store.txs.get(key) ?? { state: "", role: null, predecessors: [] };
    this.store.txs.set(key, {
      state: input.state,
      role: input.role !== undefined ? input.role : prev.role,
      predecessors: input.predecessors !== undefined ? input.predecessors : prev.predecessors,
    });
    return Promise.resolve();
  }
  getTxState(txHash: string) {
    return Promise.resolve(this.store.txs.get(k(this.bankPubkey, txHash)) ?? null);
  }
  findActionSig(actorPubkey: string, txHash: string, action: string) {
    for (const [mapKey, d] of this.store.docs) {
      if (!mapKey.startsWith(`${this.bankPubkey}|`)) continue;
      const b = d.body as Record<string, unknown>;
      if (d.type === "signature" && b.pubkey === actorPubkey && b.hash === txHash && b.action === action) {
        return Promise.resolve(b);
      }
    }
    return Promise.resolve(null);
  }
  // ledger_records
  insertLedgerRecord(input: { ulid: string; type: "credit" | "debit"; account: string; amount: number; pairUlid?: string; body: Record<string, unknown> }) {
    this.store.ledgerRecords.set(k(this.bankPubkey, input.ulid), {
      type: input.type,
      account: input.account,
      amount: input.amount,
      pairUlid: input.pairUlid ?? null,
      txUlid: null,
      body: input.body,
    });
    return Promise.resolve();
  }
  getLedgerRecord(ulid: string) {
    const r = this.store.ledgerRecords.get(k(this.bankPubkey, ulid));
    if (!r) return Promise.resolve(null);
    return Promise.resolve({
      ulid,
      bank_pubkey: this.bankPubkey,
      type: r.type,
      account: r.account,
      amount: String(r.amount),
      pair_ulid: r.pairUlid,
      tx_ulid: r.txUlid,
      body: r.body,
      created_at: "",
    });
  }
  getLedgerRecordsByUlids(ulids: string[]) {
    const out: Record<string, Record<string, unknown>> = {};
    for (const u of ulids) {
      const r = this.store.ledgerRecords.get(k(this.bankPubkey, u));
      if (r) out[u] = r.body;
    }
    return Promise.resolve(out);
  }
  bindRecordsToTx(ulids: string[], txUlid: string) {
    for (const u of ulids) {
      const r = this.store.ledgerRecords.get(k(this.bankPubkey, u));
      if (r) r.txUlid = txUlid;
    }
    return Promise.resolve();
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────
type Key = { priv: Uint8Array; pub: string };
const key = (): Key => {
  const g = genKeyPair();
  return { priv: g.privateKey, pub: g.pubkeyBase58 };
};

function ctx(store: Store, bank: Key, sender: string) {
  return {
    db: new InMemoryBankDB(store, bank.pub) as unknown as import("../db.ts").BankDB,
    bankPubkey: bank.pub,
    bankPrivateKey: bank.priv,
    senderPubkey: sender,
    requestId: newUlid(),
  };
}

function seedPromise(store: Store, bank: Key, issuer: Key, name: string): string {
  const promise = { type: "promise", pubkey: issuer.pub, ulid: newUlid(), bank: bank.pub, name };
  const promiseHash = hashDoc(promise);
  new InMemoryBankDB(store, bank.pub).insertDoc({ hash: promiseHash, type: "promise", pubkey: issuer.pub, body: promise });
  return promiseHash;
}
function seedAccount(store: Store, bank: Key, holder: Key, promiseHash: string, balance: number): string {
  const account = { type: "account", pubkey: holder.pub, ulid: newUlid(), pocket: "pkt-" + holder.pub.slice(0, 6), promise: promiseHash };
  const accountHash = hashDoc(account);
  new InMemoryBankDB(store, bank.pub).upsertAccount({
    accountHash, promiseHash, pocketHash: account.pocket, holderPubkey: holder.pub, initialBalance: balance,
  });
  return accountHash;
}

Deno.test("N-party branching/merging deal settles and balances sum to zero", async () => {
  const store = new Store();
  const A = key(), B = key(), C = key(), D = key();                 // users
  const bA = key(), bB = key(), bC = key(), bD = key();             // banks
  const bankByPub = new Map([[bA.pub, bA], [bB.pub, bB], [bC.pub, bC], [bD.pub, bD]]);

  // Each user issues their own coin at their own bank.
  const coinA = seedPromise(store, bA, A, "A-coin");
  const coinB = seedPromise(store, bB, B, "B-coin");
  const coinC = seedPromise(store, bC, C, "C-coin");
  const coinD = seedPromise(store, bD, D, "D-coin");

  // Issuer accounts (balance 0) + receiver accounts (opened in advance).
  const accA_A = seedAccount(store, bA, A, coinA, 0);   // A's own A-coin
  const accC_A = seedAccount(store, bA, C, coinA, 0);   // C receives A-coin
  const accB_B = seedAccount(store, bB, B, coinB, 0);
  const accC_B = seedAccount(store, bB, C, coinB, 0);
  const accC_C = seedAccount(store, bC, C, coinC, 0);
  const accD_C = seedAccount(store, bC, D, coinC, 0);
  const accD_D = seedAccount(store, bD, D, coinD, 0);
  const accA_D = seedAccount(store, bD, A, coinD, 0);
  const accB_D = seedAccount(store, bD, B, coinD, 0);

  const transfers: TransferSpec[] = [
    { promise: coinA, issuerBank: bA.pub, amount: 1, from: { holder: A.pub, account: accA_A }, to: { holder: C.pub, account: accC_A } },
    { promise: coinB, issuerBank: bB.pub, amount: 1, from: { holder: B.pub, account: accB_B }, to: { holder: C.pub, account: accC_B } },
    { promise: coinC, issuerBank: bC.pub, amount: 2, from: { holder: C.pub, account: accC_C }, to: { holder: D.pub, account: accD_C } },
    { promise: coinD, issuerBank: bD.pub, amount: 1, from: { holder: D.pub, account: accD_D }, to: { holder: A.pub, account: accA_D } },
    { promise: coinD, issuerBank: bD.pub, amount: 1, from: { holder: D.pub, account: accD_D }, to: { holder: B.pub, account: accB_D } },
  ];

  // Phase 0: create_records on every bank with its own transfers.
  const bankRecordUlids: Record<string, string[]> = {};
  const bankTransfers = new Map<string, Array<{ amount: number; from_account: string; to_account: string }>>();
  for (const t of transfers) {
    if (!bankTransfers.has(t.issuerBank)) bankTransfers.set(t.issuerBank, []);
    bankTransfers.get(t.issuerBank)!.push({ amount: t.amount, from_account: t.from.account, to_account: t.to.account });
  }
  for (const [bankPub, btransfers] of bankTransfers) {
    const bank = bankByPub.get(bankPub)!;
    const res = await createRecords(
      { transfers: btransfers },
      ctx(store, bank, A.pub),
    ) as { records: Array<Record<string, unknown>> };
    bankRecordUlids[bankPub] = res.records.map((r) => r.ulid as string);
  }

  const deal = buildDeal({ proposer: A.pub, leadBanks: [bA.pub, bB.pub], transfers }, bankRecordUlids);
  const txHash = deal.txHash;

  // proposer signs approve over the Tx hash.
  const proposerApprove: Record<string, unknown> = { type: "signature", pubkey: A.pub, ulid: newUlid(), hash: txHash, action: "approve" };
  proposerApprove.sig = signDoc(proposerApprove, A.priv);

  // 1) propose_leg on every bank with its own record ULIDs.
  for (const leg of deal.legs) {
    const bank = bankByPub.get(leg.bank)!;
    const res = await proposeLeg(
      { tx: deal.tx, record_ulids: leg.recordUlids, proposer_approve: proposerApprove, role: leg.role, predecessors: leg.predecessors },
      ctx(store, bank, A.pub),
    ) as { owned_records: number };
    assert(res.owned_records === leg.recordUlids.length, `propose_leg owned mismatch for ${leg.bank}`);
  }

  // 2) hold_leg on every bank.
  for (const leg of deal.legs) {
    await holdLeg({ tx_hash: txHash }, ctx(store, bankByPub.get(leg.bank)!, A.pub));
  }

  // 3) confirms: each holder signs once; client delivers to every bank they touch.
  const users = new Map([[A.pub, A], [B.pub, B], [C.pub, C], [D.pub, D]]);
  for (const [holderPub, banks] of Object.entries(deal.confirmsByHolder)) {
    const u = users.get(holderPub)!;
    const confirm: Record<string, unknown> = { type: "signature", pubkey: u.pub, ulid: newUlid(), hash: txHash, action: "settle" };
    confirm.sig = signDoc(confirm, u.priv);
    for (const bankPub of banks) {
      await confirmReceipt({ tx_hash: txHash, user_confirm: confirm }, ctx(store, bankByPub.get(bankPub)!, u.pub));
    }
  }

  // A follower cannot settle before its predecessors (no upstream proof).
  let threw = false;
  try {
    await settleLeg({ tx_hash: txHash, upstream_settles: [] }, ctx(store, bC, A.pub));
  } catch {
    threw = true;
  }
  assert(threw, "bank-C settled with no upstream settle — risk model violated");

  // 4) settle cascade in topological order; client relays each settle downstream.
  const settles = new Map<string, Record<string, unknown>>();
  for (const bankPub of deal.order) {
    const leg = deal.legs.find((l) => l.bank === bankPub)!;
    const upstream = leg.predecessors.map((p) => settles.get(p)!);
    const res = await settleLeg(
      { tx_hash: txHash, upstream_settles: upstream },
      ctx(store, bankByPub.get(bankPub)!, A.pub),
    ) as { settle: Record<string, unknown>; state: string };
    eq(res.state, "settled", `settle_leg state for ${bankPub}`);
    settles.set(bankPub, res.settle);
  }

  // seen-chain: bank-C cites both leads; bank-D cites bank-C.
  const cSeen = (settles.get(bC.pub)!.seen as string[]) ?? [];
  eq(cSeen.length, 2, "bank-C settle.seen length");
  assert(cSeen.includes(hashDoc(settles.get(bA.pub)!)) && cSeen.includes(hashDoc(settles.get(bB.pub)!)), "bank-C must cite both leads");
  const dSeen = (settles.get(bD.pub)!.seen as string[]) ?? [];
  eq(dSeen.length, 1, "bank-D settle.seen length");
  assert(dSeen.includes(hashDoc(settles.get(bC.pub)!)), "bank-D must cite bank-C");

  // final balances
  const bal = (bank: Key, acct: string) => Number(store.accounts.get(k(bank.pub, acct))!.balance);
  eq(bal(bA, accA_A), -1, "A's A-coin");
  eq(bal(bA, accC_A), 1, "C's A-coin");
  eq(bal(bB, accB_B), -1, "B's B-coin");
  eq(bal(bB, accC_B), 1, "C's B-coin");
  eq(bal(bC, accC_C), -2, "C's C-coin");
  eq(bal(bC, accD_C), 2, "D's C-coin");
  eq(bal(bD, accD_D), -2, "D's D-coin");
  eq(bal(bD, accA_D), 1, "A's D-coin");
  eq(bal(bD, accB_D), 1, "B's D-coin");

  // sum invariant per promise = 0
  eq(bal(bA, accA_A) + bal(bA, accC_A), 0, "A-coin sum");
  eq(bal(bB, accB_B) + bal(bB, accC_B), 0, "B-coin sum");
  eq(bal(bC, accC_C) + bal(bC, accD_C), 0, "C-coin sum");
  eq(bal(bD, accD_D) + bal(bD, accA_D) + bal(bD, accB_D), 0, "D-coin sum");

  // all holds released
  for (const h of store.holds.values()) assert(!h.active, "a hold was left active after settle");
});
