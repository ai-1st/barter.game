// Bank-side database layer backed by Deno KV.
//
// A single KV database stores all banks served by this process. Every key is
// prefixed by the bank pubkey so multiple banks can share one KV instance.
// Balances are stored as strings to avoid floating-point rounding. Atomic
// operations are used for concurrency-sensitive paths: replay claims, hold
// acquire/release, and balance settlement.
//
// v1 record model: records are content-addressed by hash and stored under a
// status prefix: records:draft:<hash>, records:ready:<hash>,
// records:hold:<hash>, records:settle:<hash>, records:reject:<hash>.
// Draft records do not affect balances. A status change copies the body to the
// new prefix and deletes the old prefix. Secondary indexes track records by
// pair ULID and by account hash.

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
  voucher_hash: string;
  pocket_hash: string;
  holder_pubkey: string;
  balance: string;
};

export type RecordStatus = "draft" | "ready" | "hold" | "settle" | "reject";

export type RecordRow = {
  hash: string;
  bank_pubkey: string;
  status: RecordStatus;
  type: "credit" | "debit";
  account: string;
  amount: string;
  pair_ulid: string;
  body: Record<string, unknown>;
};

export type HoldRow = {
  account_hash: string;
  tx_hash: string;
  record_hashes: string[];
  amount: string;
  active: boolean;
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
    voucherHash: string;
    pocketHash: string;
    holderPubkey: string;
  }): Promise<void> {
    const key = K(this.bankPubkey, "accounts", input.accountHash);
    const existing = await this.kv.get<AccountRow>(key);
    if (existing.value) return;
    await this.kv.set(key, {
      account_hash: input.accountHash,
      bank_pubkey: this.bankPubkey,
      voucher_hash: input.voucherHash,
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

  // ── records: bank-minted, content-addressed by hash ───────────────────

  /** Store a freshly minted record pair as drafts. Returns the hashes. */
  async insertRecordPair(input: {
    pairUlid: string;
    debit: Record<string, unknown>;
    credit: Record<string, unknown>;
  }): Promise<{ debitHash: string; creditHash: string }> {
    const debitHash = await this.insertRecord(input.debit, "draft", input.pairUlid);
    const creditHash = await this.insertRecord(input.credit, "draft", input.pairUlid);
    return { debitHash, creditHash };
  }

  /** Store a record body under a status prefix and index it by pair/account. */
  async insertRecord(
    body: Record<string, unknown>,
    status: RecordStatus,
    pairUlid?: string,
  ): Promise<string> {
    const { hashDoc } = await import("../../packages/protocol/src/index.ts");
    const hash = hashDoc(body);
    const row: RecordRow = {
      hash,
      bank_pubkey: this.bankPubkey,
      status,
      type: body.type as "credit" | "debit",
      account: body.account as string,
      amount: String(body.amount),
      pair_ulid: pairUlid ?? (body.pair as string),
      body,
    };
    await this.kv.atomic()
      .set(K(this.bankPubkey, "records", status, hash), row)
      .set(K(this.bankPubkey, "records_by_pair", row.pair_ulid, hash), { status })
      .set(K(this.bankPubkey, "records_by_account", row.account, hash), { status })
      .commit();
    return hash;
  }

  /** Move a record from one status prefix to another. No-op if already at target. */
  async moveRecord(
    hash: string,
    fromStatus: RecordStatus,
    toStatus: RecordStatus,
  ): Promise<void> {
    const fromKey = K(this.bankPubkey, "records", fromStatus, hash);
    const res = await this.kv.get<RecordRow>(fromKey);
    if (!res.value) return;
    const row = { ...res.value, status: toStatus, body: { ...res.value.body } };
    await this.kv.atomic()
      .check(res)
      .delete(fromKey)
      .set(K(this.bankPubkey, "records", toStatus, hash), row)
      .set(K(this.bankPubkey, "records_by_pair", row.pair_ulid, hash), { status: toStatus })
      .set(K(this.bankPubkey, "records_by_account", row.account, hash), { status: toStatus })
      .commit();
  }

  /** Look up a record across all status prefixes. */
  async getRecord(hash: string): Promise<RecordRow | null> {
    for (const status of ["draft", "ready", "hold", "settle", "reject"] as RecordStatus[]) {
      const res = await this.kv.get<RecordRow>(K(this.bankPubkey, "records", status, hash));
      if (res.value) return res.value;
    }
    return null;
  }

  /** Get the current status of a record, if known. */
  async getRecordStatus(hash: string): Promise<RecordStatus | null> {
    const row = await this.getRecord(hash);
    return row?.status ?? null;
  }

  /** All records of a pair, regardless of status. */
  async getRecordsByPair(pairUlid: string): Promise<RecordRow[]> {
    const prefix = K(this.bankPubkey, "records_by_pair", pairUlid);
    const out: RecordRow[] = [];
    for await (const entry of this.kv.list<{ status: RecordStatus }>({ prefix })) {
      const hash = String(entry.key.at(-1));
      const row = await this.getRecord(hash);
      if (row) out.push(row);
    }
    return out;
  }

  /** All records touching an account, regardless of status. */
  async getRecordsByAccount(accountHash: string): Promise<RecordRow[]> {
    const prefix = K(this.bankPubkey, "records_by_account", accountHash);
    const out: RecordRow[] = [];
    for await (const entry of this.kv.list<{ status: RecordStatus }>({ prefix })) {
      const hash = String(entry.key.at(-1));
      const row = await this.getRecord(hash);
      if (row) out.push(row);
    }
    return out;
  }

  /** Scan all records at a given status. */
  async listRecordsByStatus(status: RecordStatus): Promise<RecordRow[]> {
    const prefix = K(this.bankPubkey, "records", status);
    const out: RecordRow[] = [];
    for await (const entry of this.kv.list<RecordRow>({ prefix })) {
      out.push(entry.value);
    }
    return out;
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

  /** Acquire or extend a hold on an Account for a debit record. */
  async acquireHold(input: {
    accountHash: string;
    recordHash: string;
    txHash: string;
    amount: number;
  }): Promise<boolean> {
    const key = K(this.bankPubkey, "holds", input.accountHash);
    const res = await this.kv.get<HoldRow>(key);
    if (res.value?.active) {
      // Idempotent: same tx can accumulate multiple records.
      if (res.value.tx_hash === input.txHash) {
        if (!res.value.record_hashes.includes(input.recordHash)) {
          const newAmount = Number(res.value.amount) + input.amount;
          const row: HoldRow = {
            ...res.value,
            record_hashes: [...res.value.record_hashes, input.recordHash],
            amount: String(newAmount),
          };
          await this.kv.atomic().check(res).set(key, row).commit();
        }
        return true;
      }
      return false; // held by a different tx
    }
    const ok = await this.kv.atomic()
      .check(res)
      .set(key, {
        account_hash: input.accountHash,
        tx_hash: input.txHash,
        record_hashes: [input.recordHash],
        amount: String(input.amount),
        active: true,
      })
      .commit();
    return ok.ok;
  }

  /** Amount of the active hold on an account, or 0 if none. */
  async getActiveHoldAmount(accountHash: string): Promise<number> {
    const res = await this.kv.get<HoldRow>(K(this.bankPubkey, "holds", accountHash));
    return res.value?.active ? Number(res.value.amount) : 0;
  }

  /** Release the portion of a hold associated with a settled/rejected record. */
  async releaseHold(accountHash: string, recordHash: string): Promise<void> {
    const key = K(this.bankPubkey, "holds", accountHash);
    const res = await this.kv.get<HoldRow>(key);
    if (!res.value || !res.value.active) return;
    const remaining = res.value.record_hashes.filter((h) => h !== recordHash);
    if (remaining.length === 0) {
      await this.kv.atomic().check(res).set(key, { ...res.value, active: false }).commit();
      return;
    }
    // Recalculate amount from the remaining records' bodies.
    let amount = 0;
    for (const h of remaining) {
      const row = await this.getRecord(h);
      if (row && row.type === "debit") amount += Number(row.amount);
    }
    await this.kv.atomic()
      .check(res)
      .set(key, { ...res.value, record_hashes: remaining, amount: String(amount) })
      .commit();
  }

  /** Find a stored signature doc by signer + hash + action. */
  async findActionSig(
    actorPubkey: string,
    hash: string,
    action: string,
  ): Promise<Record<string, unknown> | null> {
    const prefix = K(this.bankPubkey, "docs");
    const entries = this.kv.list<DocRow>({ prefix });
    for await (const entry of entries) {
      const row = entry.value;
      if (row.type !== "signature") continue;
      const b = row.body;
      if (b.pubkey !== actorPubkey || b.action !== action) continue;
      if (b.hash !== hash) continue;
      return b;
    }
    return null;
  }

  /** All stored signature docs whose `hash` field equals the given hash. */
  async listSignaturesByHash(hash: string): Promise<Array<Record<string, unknown>>> {
    const prefix = K(this.bankPubkey, "docs");
    const entries = this.kv.list<DocRow>({ prefix });
    const out: Array<Record<string, unknown>> = [];
    for await (const entry of entries) {
      const row = entry.value;
      if (row.type !== "signature") continue;
      if (row.body.hash !== hash) continue;
      out.push(row.body);
    }
    return out;
  }

  /** All stored settle signatures from other banks (any hash, action settle). */
  async listSettleSigs(): Promise<Array<Record<string, unknown>>> {
    const prefix = K(this.bankPubkey, "docs");
    const entries = this.kv.list<DocRow>({ prefix });
    const out: Array<Record<string, unknown>> = [];
    for await (const entry of entries) {
      const row = entry.value;
      if (row.type !== "signature") continue;
      if (row.body.action !== "settle") continue;
      if (row.body.pubkey === this.bankPubkey) continue; // only peer settles
      out.push(row.body);
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

  /** Generate a fresh pair ULID. Convenience wrapper. */
  newPairUlid(): string {
    return newUlid();
  }

  // ── create_records idempotency ───────────────────────────────────────────

  async getCreateRequest(key: string): Promise<{ debit_hash: string; credit_hash: string } | null> {
    const res = await this.kv.get<{ debit_hash: string; credit_hash: string }>(
      K(this.bankPubkey, "create_requests", key),
    );
    return res.value;
  }

  async setCreateRequest(
    key: string,
    recordHashes: { debit_hash: string; credit_hash: string },
  ): Promise<void> {
    await this.kv.set(K(this.bankPubkey, "create_requests", key), recordHashes);
  }
}

/** Build a BankDB from an already-open Deno.Kv handle. */
export function bankDbFromKv(kv: Deno.Kv, bankPubkey: string): BankDB {
  return new BankDB(kv, bankPubkey);
}
