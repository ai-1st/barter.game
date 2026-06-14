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

export type RecordRow = {
  ulid: string;
  bank_pubkey: string;
  type: string;
  account: string;
  amount: string;
  pair_ulid: string;
  session: string;
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

  // ── records: bank-minted, ULID-identified ───────────────────────────

  async insertRecord(input: {
    ulid: string;
    type: "credit" | "debit";
    account: string;
    amount: number;
    pairUlid: string;
    session: string;
    body: Record<string, unknown>;
  }): Promise<void> {
    const row: RecordRow = {
      ulid: input.ulid,
      bank_pubkey: this.bankPubkey,
      type: input.type,
      account: input.account,
      amount: String(input.amount),
      pair_ulid: input.pairUlid,
      session: input.session,
      tx_ulid: null,
      body: input.body,
    };
    await this.kv.atomic()
      .set(K(this.bankPubkey, "records", input.ulid), row)
      .set(K(this.bankPubkey, "records_by_session", input.session, input.ulid), row)
      .commit();
  }

  /** All records of a session at this bank, sorted by ULID. */
  async getRecordsBySession(session: string): Promise<RecordRow[]> {
    const prefix = K(this.bankPubkey, "records_by_session", session);
    const entries = this.kv.list<RecordRow>({ prefix });
    const out: RecordRow[] = [];
    for await (const entry of entries) out.push(entry.value);
    out.sort((a, b) => a.ulid.localeCompare(b.ulid));
    return out;
  }

  async getRecord(ulid: string): Promise<RecordRow | null> {
    const res = await this.kv.get<RecordRow>(K(this.bankPubkey, "records", ulid));
    return res.value;
  }

  /** Look up multiple records by ULID. Returns a ulid → body map. */
  async getRecordsByUlids(ulids: string[]): Promise<Record<string, Record<string, unknown>>> {
    if (ulids.length === 0) return {};
    const keys = ulids.map((u) => K(this.bankPubkey, "records", u));
    const entries = await this.kv.getMany<RecordRow[]>(keys);
    const out: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < ulids.length; i++) {
      const row = entries[i].value;
      if (row) out[ulids[i]!] = row.body;
    }
    return out;
  }

  /** Bind records to a Tx by setting their tx_ulid. */
  async bindRecordsToTx(ulids: string[], txUlid: string): Promise<void> {
    for (const ulid of ulids) {
      const key = K(this.bankPubkey, "records", ulid);
      const res = await this.kv.get<RecordRow>(key);
      if (!res.value) continue;
      const row = { ...res.value, tx_ulid: txUlid };
      const sessionKey = K(this.bankPubkey, "records_by_session", row.session, ulid);
      await this.kv.atomic()
        .set(key, row)
        .set(sessionKey, row)
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

  /** Acquire a hold on an Account for a session. Returns true if acquired, false on conflict. */
  async acquireHold(input: {
    accountHash: string;
    session: string;
    amount: number;
  }): Promise<boolean> {
    const key = K(this.bankPubkey, "holds", input.accountHash);
    const res = await this.kv.get<{ session: string; amount: number; active: boolean }>(key);
    if (res.value?.active) {
      // Idempotent re-hold for the same session.
      return res.value.session === input.session;
    }
    const ok = await this.kv.atomic()
      .check(res)
      .set(key, { session: input.session, amount: input.amount, active: true })
      .commit();
    return ok.ok;
  }

  /** Amount of the active hold on an account, or 0 if none. */
  async getActiveHoldAmount(accountHash: string): Promise<number> {
    const res = await this.kv.get<{ session: string; amount: number; active: boolean }>(
      K(this.bankPubkey, "holds", accountHash),
    );
    return res.value?.active ? res.value.amount : 0;
  }

  /** Release a single hold (settle or reject path). */
  async releaseHold(accountHash: string, session: string): Promise<void> {
    const key = K(this.bankPubkey, "holds", accountHash);
    const res = await this.kv.get<{ session: string; amount: number; active: boolean }>(key);
    if (!res.value || !res.value.active || res.value.session !== session) return;
    await this.kv.atomic()
      .check(res)
      .set(key, { ...res.value, active: false })
      .commit();
  }

  /** Release every active hold this bank placed for a session (reject path). */
  async releaseHoldsBySession(session: string): Promise<void> {
    const prefix = K(this.bankPubkey, "holds");
    const entries = this.kv.list<{ session: string; active: boolean }>({ prefix });
    for await (const entry of entries) {
      if (entry.value.session === session && entry.value.active) {
        await this.kv.set(entry.key, { ...entry.value, active: false });
      }
    }
  }

  /** Leg state machine helpers, keyed by per-bank session ULID. */
  async upsertLeg(input: {
    session: string;
    state: string;
    role?: string;
    predecessors?: string[];
    banks?: string[];
  }): Promise<void> {
    const key = K(this.bankPubkey, "legs", input.session);
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

  async getLegState(session: string): Promise<LegRow | null> {
    const res = await this.kv.get<LegRow>(K(this.bankPubkey, "legs", session));
    return res.value;
  }

  /** All local leg sessions that are not in a terminal state. */
  async listPendingSessions(): Promise<string[]> {
    const prefix = K(this.bankPubkey, "legs");
    const out: string[] = [];
    for await (const entry of this.kv.list<LegRow>({ prefix })) {
      if (entry.value.state !== "settled" && entry.value.state !== "rejected") {
        out.push(String(entry.key.at(-1)));
      }
    }
    return out;
  }

  /** Find a stored signature doc by signer + (target, action). */
  async findActionSig(
    actorPubkey: string,
    target: { hash?: string; record?: string; session?: string },
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
      if (target.session !== undefined && b.session !== target.session) continue;
      return b;
    }
    return null;
  }

  /** All stored signature docs anchored to one target. */
  async listSignaturesByTarget(
    target: { hash?: string; record?: string; session?: string },
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
      if (target.session !== undefined && b.session !== target.session) continue;
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
