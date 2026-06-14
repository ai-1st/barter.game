// Shared in-memory harness for handler-level integration tests.
//
// No HTTP, no Postgres — handlers are pure (params, ctx) functions, so we
// feed them a fake ctx whose `db` is an in-memory store mirroring the real
// multi-tenant BankDB surface. Bank-to-bank push is simulated by stubbing
// global fetch: subscription URLs are `https://<bank-name>.test/rpc`, and
// the stub routes a notify_signatures envelope straight into the target
// bank's handler — so the self-advance cascade runs exactly as in
// production, minus the network.

import { genKeyPair, newUlid } from "../../protocol/crypto.ts";
import { notifySignatures } from "../handlers/notify_signatures.ts";
import type { BankDB } from "../db.ts";

// ── tiny asserts (no std import → no network) ───────────────────────────────
export function eq(actual: unknown, expected: unknown, msg: string) {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}
export function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// ── in-memory, per-bank-scoped DB ───────────────────────────────────────────
type Hold = { dealUlid: string; active: boolean; amount: number };
type LedgerRec = {
  type: string; account: string; amount: number;
  pairUlid: string; dealUlid: string; txUlid: string | null;
  body: Record<string, unknown>;
};

export class Store {
  docs = new Map<string, { hash: string; type: string; pubkey: string; body: Record<string, unknown> }>();
  accounts = new Map<string, { promise: string; pocket: string; holder: string; balance: number }>();
  legs = new Map<string, { state: string; role: string | null; predecessors: string[]; banks: string[] }>();
  holds = new Map<string, Hold>(); // key: bank|account
  ledgerRecords = new Map<string, LedgerRec>();
  subscriptions = new Map<string, { subscriber: string; url: string; until: string | null; active: boolean }>();
  watches = new Map<string, Set<string>>(); // key: bank|watchKey → subscription hashes
}
export const k = (bank: string, x: string) => `${bank}|${x}`;

export class InMemoryBankDB {
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
    });
  }
  listAccountsByHolder(holderPubkey: string) {
    const out: Array<Record<string, unknown>> = [];
    for (const [mapKey, a] of this.store.accounts) {
      if (!mapKey.startsWith(`${this.bankPubkey}|`)) continue;
      if (a.holder !== holderPubkey) continue;
      out.push({
        account_hash: mapKey.slice(this.bankPubkey.length + 1),
        bank_pubkey: this.bankPubkey,
        promise_hash: a.promise,
        pocket_hash: a.pocket,
        holder_pubkey: a.holder,
        balance: String(a.balance),
      });
    }
    return Promise.resolve(out);
  }
  upsertAccount(input: { accountHash: string; promiseHash: string; pocketHash: string; holderPubkey: string }) {
    const key = k(this.bankPubkey, input.accountHash);
    if (!this.store.accounts.has(key)) {
      this.store.accounts.set(key, {
        promise: input.promiseHash,
        pocket: input.pocketHash,
        holder: input.holderPubkey,
        balance: 0,
      });
    }
    return Promise.resolve();
  }
  applyBalanceDelta(accountHash: string, delta: number) {
    const a = this.store.accounts.get(k(this.bankPubkey, accountHash));
    if (!a) throw new Error(`account ${accountHash} not found`);
    a.balance += delta;
    return Promise.resolve(String(a.balance));
  }
  acquireHold(input: { accountHash: string; dealUlid: string; amount: number }) {
    const key = k(this.bankPubkey, input.accountHash);
    const existing = this.store.holds.get(key);
    if (existing && existing.active) {
      return Promise.resolve(existing.dealUlid === input.dealUlid); // idempotent re-hold
    }
    this.store.holds.set(key, { dealUlid: input.dealUlid, active: true, amount: input.amount });
    return Promise.resolve(true);
  }
  getActiveHoldAmount(accountHash: string) {
    const h = this.store.holds.get(k(this.bankPubkey, accountHash));
    return Promise.resolve(h && h.active ? h.amount : 0);
  }
  releaseHold(accountHash: string, dealUlid: string) {
    const h = this.store.holds.get(k(this.bankPubkey, accountHash));
    if (h && h.dealUlid === dealUlid) h.active = false;
    return Promise.resolve();
  }
  releaseHoldsByDeal(dealUlid: string) {
    for (const [mapKey, h] of this.store.holds) {
      if (mapKey.startsWith(`${this.bankPubkey}|`) && h.dealUlid === dealUlid) h.active = false;
    }
    return Promise.resolve();
  }
  upsertLeg(input: { dealUlid: string; state: string; role?: string; predecessors?: string[]; banks?: string[] }) {
    const key = k(this.bankPubkey, input.dealUlid);
    const prev = this.store.legs.get(key) ?? { state: "", role: null, predecessors: [], banks: [] };
    this.store.legs.set(key, {
      state: input.state,
      role: input.role !== undefined ? input.role : prev.role,
      predecessors: input.predecessors !== undefined ? input.predecessors : prev.predecessors,
      banks: input.banks !== undefined ? input.banks : prev.banks,
    });
    return Promise.resolve();
  }
  getLegState(dealUlid: string) {
    const leg = this.store.legs.get(k(this.bankPubkey, dealUlid));
    return Promise.resolve(leg ? { ...leg } : null);
  }
  findActionSig(actorPubkey: string, target: { hash?: string; record?: string; deal?: string }, action: string) {
    for (const [mapKey, d] of this.store.docs) {
      if (!mapKey.startsWith(`${this.bankPubkey}|`)) continue;
      if (d.type !== "signature") continue;
      const b = d.body as Record<string, unknown>;
      if (b.pubkey !== actorPubkey || b.action !== action) continue;
      if (target.hash !== undefined && b.hash !== target.hash) continue;
      if (target.record !== undefined && b.record !== target.record) continue;
      if (target.deal !== undefined && b.deal !== target.deal) continue;
      return Promise.resolve(b);
    }
    return Promise.resolve(null);
  }
  listSignaturesByTarget(target: { hash?: string; record?: string; deal?: string }) {
    const out: Array<Record<string, unknown>> = [];
    for (const [mapKey, d] of this.store.docs) {
      if (!mapKey.startsWith(`${this.bankPubkey}|`)) continue;
      if (d.type !== "signature") continue;
      const b = d.body as Record<string, unknown>;
      if (target.hash !== undefined && b.hash !== target.hash) continue;
      if (target.record !== undefined && b.record !== target.record) continue;
      if (target.deal !== undefined && b.deal !== target.deal) continue;
      out.push(b);
    }
    return Promise.resolve(out);
  }
  // ledger_records
  insertLedgerRecord(input: { ulid: string; type: "credit" | "debit"; account: string; amount: number; pairUlid: string; dealUlid: string; body: Record<string, unknown> }) {
    this.store.ledgerRecords.set(k(this.bankPubkey, input.ulid), {
      type: input.type,
      account: input.account,
      amount: input.amount,
      pairUlid: input.pairUlid,
      dealUlid: input.dealUlid,
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
      deal_ulid: r.dealUlid,
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
  getLedgerRecordsByDeal(dealUlid: string) {
    const out: Array<Record<string, unknown>> = [];
    for (const [mapKey, r] of this.store.ledgerRecords) {
      if (!mapKey.startsWith(`${this.bankPubkey}|`)) continue;
      if (r.dealUlid !== dealUlid) continue;
      out.push({
        ulid: mapKey.slice(this.bankPubkey.length + 1),
        bank_pubkey: this.bankPubkey,
        type: r.type,
        account: r.account,
        amount: String(r.amount),
        pair_ulid: r.pairUlid,
        deal_ulid: r.dealUlid,
        tx_ulid: r.txUlid,
        body: r.body,
        created_at: "",
      });
    }
    out.sort((a, b) => String(a.ulid).localeCompare(String(b.ulid)));
    return Promise.resolve(out);
  }
  bindRecordsToTx(ulids: string[], txUlid: string) {
    for (const u of ulids) {
      const r = this.store.ledgerRecords.get(k(this.bankPubkey, u));
      if (r) r.txUlid = txUlid;
    }
    return Promise.resolve();
  }
  // subscriptions
  insertSubscription(input: { subscriptionHash: string; subscriberPubkey: string; url: string; until?: string; watchKeys: string[] }) {
    this.store.subscriptions.set(k(this.bankPubkey, input.subscriptionHash), {
      subscriber: input.subscriberPubkey,
      url: input.url,
      until: input.until ?? null,
      active: true,
    });
    for (const w of input.watchKeys) {
      const key = k(this.bankPubkey, w);
      if (!this.store.watches.has(key)) this.store.watches.set(key, new Set());
      this.store.watches.get(key)!.add(input.subscriptionHash);
    }
    return Promise.resolve();
  }
  findSubscriptionsByWatchKeys(keys: string[]) {
    const hashes = new Set<string>();
    for (const w of keys) {
      for (const h of this.store.watches.get(k(this.bankPubkey, w)) ?? []) hashes.add(h);
    }
    const now = Date.now();
    const out: Array<Record<string, unknown>> = [];
    for (const h of hashes) {
      const s = this.store.subscriptions.get(k(this.bankPubkey, h));
      if (!s || !s.active) continue;
      if (s.until && new Date(s.until).getTime() <= now) continue;
      out.push({
        subscription_hash: h,
        bank_pubkey: this.bankPubkey,
        subscriber_pubkey: s.subscriber,
        url: s.url,
        until: s.until,
        active: s.active,
      });
    }
    return Promise.resolve(out);
  }
}

// ── ctx + key helpers ───────────────────────────────────────────────────────
export type Key = { priv: Uint8Array; pub: string };
export const key = (): Key => {
  const g = genKeyPair();
  return { priv: g.privateKey, pub: g.pubkeyBase58 };
};

export function ctx(store: Store, bank: Key, sender: string) {
  return {
    db: new InMemoryBankDB(store, bank.pub) as unknown as BankDB,
    bankPubkey: bank.pub,
    bankPrivateKey: bank.priv,
    senderPubkey: sender,
    requestId: newUlid(),
  };
}

// ── fetch stub: routes notify envelopes into target banks ───────────────────
//
// install with `using` semantics: const restore = installFetchRouter(...);
// try { ... } finally { restore(); }
export function installFetchRouter(
  store: Store,
  banksByUrl: Map<string, Key>,
  pushLog?: Array<{ url: string; envelope: Record<string, unknown> }>,
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: URL | Request | string, init?: RequestInit) => {
    const url = String(input);
    const envelope = JSON.parse(String(init?.body)) as Record<string, unknown>;
    pushLog?.push({ url, envelope });
    const bank = banksByUrl.get(url);
    if (!bank) return new Response("no such bank", { status: 404 });
    // Route into the bank's notify handler as in production (sender = pushing bank).
    await notifySignatures(
      envelope.params as Record<string, unknown>,
      ctx(store, bank, envelope.pubkey as string),
    );
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: envelope.id, result: {} }), { status: 200 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

export const bankUrl = (name: string) => `https://${name}.test/rpc`;
