// Bank-side database layer backed by Deno KV.
//
// A single KV database stores all banks served by this process. Every key is
// prefixed by the bank pubkey so multiple banks can share one KV instance.
// Balances are stored as strings to avoid floating-point rounding. Atomic
// operations are used for concurrency-sensitive paths: replay claims, hold
// acquire/release, and balance settlement.

import { newUlid } from "../../packages/protocol/src/crypto.ts";

export type DocRow = {
  hash: string;
  bank_pubkey: string;
  type: string;
  pubkey: string;
  body: Record<string, unknown>;
};

export type AccountRow = {
  account_hash: string;
  bank_pubkey: string;
  promise_hash: string;
  pocket_hash: string;
  holder_pubkey: string;
  balance: string;
};

export type LedgerRecordRow = {
  ulid: string;
  bank_pubkey: string;
  type: string;
  account: string;
  amount: string;
  pair_ulid: string;
  deal_ulid: string;
  tx_ulid: string | null;
  body: Record<string, unknown>;
};

export type LegRow = {
  state: string;
  role: string | null;
  predecessors: string[];
  banks: string[];
};

export type SubscriptionRow = {
  subscription_hash: string;
  bank_pubkey: string;
  subscriber_pubkey: string;
  url: string;
  until: string | null;
  active: boolean;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const REPLAY_WINDOW_MS = 7 * DAY_MS;

/** Key helpers — every key is scoped by bank pubkey. */
function K(bankPubkey: string, ...parts: unknown[]): Deno.KvKey {
  return [bankPubkey, ...parts] as Deno.KvKey;
}

export class BankDB {
  constructor(private kv: Deno.Kv, private bankPubkey: string) {}

  /** Store a signed doc by hash. Idempotent: re-inserting same hash is a no-op. */
  async insertDoc(input: {
    hash: string;
    type: string;
    pubkey: string;
    body: Record<string, unknown>;
  }): Promise<void> {
    const key = K(this.bankPubkey, "docs", input.hash);
    const existing = await this.kv.get<DocRow>(key);
    if (existing.value) return;
    await this.kv.set(key, {
      hash: input.hash,
      bank_pubkey: this.bankPubkey,
      type: input.type,
      pubkey: input.pubkey,
      body: input.body,
    });
  }

  async getDoc(hash: string): Promise<DocRow | null> {
    const res = await this.kv.get<DocRow>(K(this.bankPubkey, "docs", hash));
    return res.value;
  }

  /** Insert an Account row if absent. Balance always starts at 0. */
  async upsertAccount(input: {
    accountHash: string;
    promiseHash: string;
    pocketHash: string;
    holderPubkey: string;
  }): Promise<void> {
    const key = K(this.bankPubkey, "accounts", input.accountHash);
    const existing = await this.kv.get<AccountRow>(key);
    if (existing.value) return;
    await this.kv.set(key, {
      account_hash: input.accountHash,
      bank_pubkey: this.bankPubkey,
      promise_hash: input.promiseHash,
      pocket_hash: input.pocketHash,
      holder_pubkey: input.holderPubkey,
      balance: "0",
    });
  }

  async getAccount(accountHash: string): Promise<AccountRow | null> {
    const res = await this.kv.get<AccountRow>(K(this.bankPubkey, "accounts", accountHash));
    return res.value;
  }

  /** Look up all accounts owned by a holder at this bank. */
  async listAccountsByHolder(holderPubkey: string): Promise<AccountRow[]> {
    const prefix = K(this.bankPubkey, "accounts");
    const entries = this.kv.list<AccountRow>({ prefix });
    const out: AccountRow[] = [];
    for await (const entry of entries) {
      if (entry.value.holder_pubkey === holderPubkey) out.push(entry.value);
    }
    return out;
  }

  /** Look up multiple docs by hash. Returns a hash → body map. */
  async getDocsByHashes(hashes: string[]): Promise<Record<string, Record<string, unknown>>> {
    if (hashes.length === 0) return {};
    const keys = hashes.map((h) => K(this.bankPubkey, "docs", h));
    const entries = await this.kv.getMany<DocRow[]>(keys);
    const out: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < hashes.length; i++) {
      const row = entries[i].value;
      if (row) out[hashes[i]!] = row.body;
    }
    return out;
  }

  // ── ledger_records: bank-minted, ULID-identified ───────────────────────────

  async insertLedgerRecord(input: {
    ulid: string;
    type: "credit" | "debit";
    account: string;
    amount: number;
    pairUlid: string;
    dealUlid: string;
    body: Record<string, unknown>;
  }): Promise<void> {
    const row: LedgerRecordRow = {
      ulid: input.ulid,
      bank_pubkey: this.bankPubkey,
      type: input.type,
      account: input.account,
      amount: String(input.amount),
      pair_ulid: input.pairUlid,
      deal_ulid: input.dealUlid,
      tx_ulid: null,
      body: input.body,
    };
    await this.kv.atomic()
      .set(K(this.bankPubkey, "ledger_records", input.ulid), row)
      .set(K(this.bankPubkey, "ledger_records_by_deal", input.dealUlid, input.ulid), row)
      .commit();
  }

  /** All records of a deal at this bank, sorted by ULID. */
  async getLedgerRecordsByDeal(dealUlid: string): Promise<LedgerRecordRow[]> {
    const prefix = K(this.bankPubkey, "ledger_records_by_deal", dealUlid);
    const entries = this.kv.list<LedgerRecordRow>({ prefix });
    const out: LedgerRecordRow[] = [];
    for await (const entry of entries) out.push(entry.value);
    out.sort((a, b) => a.ulid.localeCompare(b.ulid));
    return out;
  }

  async getLedgerRecord(ulid: string): Promise<LedgerRecordRow | null> {
    const res = await this.kv.get<LedgerRecordRow>(K(this.bankPubkey, "ledger_records", ulid));
    return res.value;
  }

  /** Look up multiple ledger records by ULID. Returns a ulid → body map. */
  async getLedgerRecordsByUlids(ulids: string[]): Promise<Record<string, Record<string, unknown>>> {
    if (ulids.length === 0) return {};
    const keys = ulids.map((u) => K(this.bankPubkey, "ledger_records", u));
    const entries = await this.kv.getMany<LedgerRecordRow[]>(keys);
    const out: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < ulids.length; i++) {
      const row = entries[i].value;
      if (row) out[ulids[i]!] = row.body;
    }
    return out;
  }

  /** Bind ledger records to a Tx by setting their tx_ulid. */
  async bindRecordsToTx(ulids: string[], txUlid: string): Promise<void> {
    for (const ulid of ulids) {
      const key = K(this.bankPubkey, "ledger_records", ulid);
      const res = await this.kv.get<LedgerRecordRow>(key);
      if (!res.value) continue;
      const row = { ...res.value, tx_ulid: txUlid };
      const dealKey = K(this.bankPubkey, "ledger_records_by_deal", row.deal_ulid, ulid);
      await this.kv.atomic()
        .set(key, row)
        .set(dealKey, row)
        .commit();
    }
  }

  /**
   * Apply a balance delta to an Account row atomically. Used by settle.
   * Returns the new balance as a string.
   */
  async applyBalanceDelta(accountHash: string, delta: number): Promise<string> {
    const key = K(this.bankPubkey, "accounts", accountHash);
    const res = await this.kv.get<AccountRow>(key);
    if (!res.value) throw new Error(`account ${accountHash} not found`);
    const newBalance = Number(res.value.balance) + delta;
    const row: AccountRow = { ...res.value, balance: String(newBalance) };
    const ok = await this.kv.atomic()
      .check(res)
      .set(key, row)
      .commit();
    if (!ok.ok) {
      // Retry once on conflict.
      return this.applyBalanceDelta(accountHash, delta);
    }
    return row.balance;
  }

  /** Acquire a hold on an Account for a deal. Returns true if acquired, false on conflict. */
  async acquireHold(input: {
    accountHash: string;
    dealUlid: string;
    amount: number;
  }): Promise<boolean> {
    const key = K(this.bankPubkey, "holds", input.accountHash);
    const res = await this.kv.get<{ deal_ulid: string; amount: number; active: boolean }>(key);
    if (res.value?.active) {
      // Idempotent re-hold for the same deal.
      return res.value.deal_ulid === input.dealUlid;
    }
    const ok = await this.kv.atomic()
      .check(res)
      .set(key, { deal_ulid: input.dealUlid, amount: input.amount, active: true })
      .commit();
    return ok.ok;
  }

  /** Amount of the active hold on an account, or 0 if none. */
  async getActiveHoldAmount(accountHash: string): Promise<number> {
    const res = await this.kv.get<{ deal_ulid: string; amount: number; active: boolean }>(
      K(this.bankPubkey, "holds", accountHash),
    );
    return res.value?.active ? res.value.amount : 0;
  }

  /** Release a single hold (settle or reject path). */
  async releaseHold(accountHash: string, dealUlid: string): Promise<void> {
    const key = K(this.bankPubkey, "holds", accountHash);
    const res = await this.kv.get<{ deal_ulid: string; amount: number; active: boolean }>(key);
    if (!res.value || !res.value.active || res.value.deal_ulid !== dealUlid) return;
    await this.kv.atomic()
      .check(res)
      .set(key, { ...res.value, active: false })
      .commit();
  }

  /** Release every active hold this bank placed for a deal (reject path). */
  async releaseHoldsByDeal(dealUlid: string): Promise<void> {
    const prefix = K(this.bankPubkey, "holds");
    const entries = this.kv.list<{ deal_ulid: string; active: boolean }>({ prefix });
    for await (const entry of entries) {
      if (entry.value.deal_ulid === dealUlid && entry.value.active) {
        await this.kv.set(entry.key, { ...entry.value, active: false });
      }
    }
  }

  /** Leg state machine helpers, keyed (deal_ulid, bank). */
  async upsertLeg(input: {
    dealUlid: string;
    state: string;
    role?: string;
    predecessors?: string[];
    banks?: string[];
  }): Promise<void> {
    const key = K(this.bankPubkey, "legs", input.dealUlid);
    const res = await this.kv.get<LegRow>(key);
    const prev = res.value;
    const row: LegRow = {
      state: input.state,
      role: input.role !== undefined ? input.role : (prev?.role ?? null),
      predecessors: input.predecessors !== undefined ? input.predecessors : (prev?.predecessors ?? []),
      banks: input.banks !== undefined ? input.banks : (prev?.banks ?? []),
    };
    await this.kv.set(key, row);
  }

  async getLegState(dealUlid: string): Promise<LegRow | null> {
    const res = await this.kv.get<LegRow>(K(this.bankPubkey, "legs", dealUlid));
    return res.value;
  }

  /** Find a stored signature doc by signer + (target, action). */
  async findActionSig(
    actorPubkey: string,
    target: { hash?: string; record?: string; deal?: string },
    action: string,
  ): Promise<Record<string, unknown> | null> {
    const prefix = K(this.bankPubkey, "docs");
    const entries = this.kv.list<DocRow>({ prefix });
    for await (const entry of entries) {
      const row = entry.value;
      if (row.type !== "signature") continue;
      const b = row.body;
      if (b.pubkey !== actorPubkey || b.action !== action) continue;
      if (target.hash !== undefined && b.hash !== target.hash) continue;
      if (target.record !== undefined && b.record !== target.record) continue;
      if (target.deal !== undefined && b.deal !== target.deal) continue;
      return b;
    }
    return null;
  }

  /** All stored signature docs anchored to one target. */
  async listSignaturesByTarget(
    target: { hash?: string; record?: string; deal?: string },
  ): Promise<Array<Record<string, unknown>>> {
    const prefix = K(this.bankPubkey, "docs");
    const entries = this.kv.list<DocRow>({ prefix });
    const out: Array<Record<string, unknown>> = [];
    for await (const entry of entries) {
      const row = entry.value;
      if (row.type !== "signature") continue;
      const b = row.body;
      if (target.hash !== undefined && b.hash !== target.hash) continue;
      if (target.record !== undefined && b.record !== target.record) continue;
      if (target.deal !== undefined && b.deal !== target.deal) continue;
      out.push(b);
    }
    return out;
  }

  // ── subscriptions: signature fan-out targets ────────────────────────────

  async insertSubscription(input: {
    subscriptionHash: string;
    subscriberPubkey: string;
    url: string;
    until?: string;
    watchKeys: string[];
  }): Promise<void> {
    const subKey = K(this.bankPubkey, "subscriptions", input.subscriptionHash);
    const existing = await this.kv.get<SubscriptionRow>(subKey);
    if (!existing.value) {
      await this.kv.set(subKey, {
        subscription_hash: input.subscriptionHash,
        bank_pubkey: this.bankPubkey,
        subscriber_pubkey: input.subscriberPubkey,
        url: input.url,
        until: input.until ?? null,
        active: true,
      });
    }
    for (const watchKey of input.watchKeys) {
      await this.kv.set(
        K(this.bankPubkey, "subscription_watches", watchKey, input.subscriptionHash),
        true,
      );
    }
  }

  /** Active, unexpired subscriptions watching any of the given keys. */
  async findSubscriptionsByWatchKeys(keys: string[]): Promise<SubscriptionRow[]> {
    if (keys.length === 0) return [];
    const subs = new Map<string, SubscriptionRow>();
    for (const key of keys) {
      const prefix = K(this.bankPubkey, "subscription_watches", key);
      const entries = this.kv.list<boolean>({ prefix });
      for await (const entry of entries) {
        const subHash = String(entry.key.at(-1));
        if (subs.has(subHash)) continue;
        const subRes = await this.kv.get<SubscriptionRow>(K(this.bankPubkey, "subscriptions", subHash));
        const sub = subRes.value;
        if (!sub || !sub.active) continue;
        if (sub.until && new Date(sub.until).getTime() <= Date.now()) continue;
        subs.set(subHash, sub);
      }
    }
    return [...subs.values()];
  }

  /** Record (or refresh) a peer bank URL we just heard from. */
  async rememberPeer(peerPubkey: string, peerUrl: string): Promise<void> {
    await this.kv.set(K(this.bankPubkey, "peers", peerPubkey), {
      peer_url: peerUrl,
      last_seen: new Date().toISOString(),
    });
  }

  async lookupPeerUrl(peerPubkey: string): Promise<string | null> {
    const res = await this.kv.get<{ peer_url: string }>(K(this.bankPubkey, "peers", peerPubkey));
    return res.value?.peer_url ?? null;
  }

  /**
   * Replay-window check + insert. Returns false if the (sender, id, to) tuple
   * was already seen. Uses an atomic check-and-set and prunes entries older
   * than REPLAY_WINDOW_MS.
   */
  async claimUlid(
    senderPubkey: string,
    id: string,
    toPubkey: string,
  ): Promise<boolean> {
    const key = K(this.bankPubkey, "replay", senderPubkey, id, toPubkey);
    const res = await this.kv.get<{ created_at: number }>(key);
    if (res.value) return false;
    const ok = await this.kv.atomic()
      .check(res)
      .set(key, { created_at: Date.now() })
      .commit();
    if (!ok.ok) return false;
    // Best-effort prune of stale entries in the background.
    this.pruneReplayWindow(senderPubkey).catch(() => undefined);
    return true;
  }

  private async pruneReplayWindow(senderPubkey: string): Promise<void> {
    const cutoff = Date.now() - REPLAY_WINDOW_MS;
    const prefix = K(this.bankPubkey, "replay", senderPubkey);
    const entries = this.kv.list<{ created_at: number }>({ prefix });
    for await (const entry of entries) {
      if (entry.value.created_at < cutoff) {
        await this.kv.delete(entry.key);
      }
    }
  }
}

/** Build a BankDB from an already-open Deno.Kv handle. */
export function bankDbFromKv(kv: Deno.Kv, bankPubkey: string): BankDB {
  return new BankDB(kv, bankPubkey);
}
