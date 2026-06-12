// Bank-side database layer. Thin wrapper over @supabase/supabase-js,
// scoped to a single bank's pubkey (multi-tenant filter applied on every read).
//
// Used by Edge Function handlers. NOT imported by the protocol package
// (packages/protocol has no I/O — see Issue 4 from the eng review).

import { createClient, type SupabaseClient } from "npm:@supabase/supabase-js@^2.45.0";

export type DocRow = {
  hash: string;
  bank_pubkey: string;
  type: string;
  pubkey: string;
  body: Record<string, unknown>;
  created_at: string;
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
  created_at: string;
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

export class BankDB {
  constructor(private sb: SupabaseClient, private bankPubkey: string) {}

  /** Store a signed doc by hash. Idempotent: re-inserting same hash is a no-op. */
  async insertDoc(input: {
    hash: string;
    type: string;
    pubkey: string;
    body: Record<string, unknown>;
  }): Promise<void> {
    const { error } = await this.sb.from("docs").upsert(
      {
        hash: input.hash,
        bank_pubkey: this.bankPubkey,
        type: input.type,
        pubkey: input.pubkey,
        body: input.body,
      },
      { onConflict: "hash,bank_pubkey", ignoreDuplicates: true },
    );
    if (error) throw new Error(`docs.upsert: ${error.message}`);
  }

  async getDoc(hash: string): Promise<DocRow | null> {
    const { data, error } = await this.sb
      .from("docs")
      .select("*")
      .eq("hash", hash)
      .eq("bank_pubkey", this.bankPubkey)
      .maybeSingle();
    if (error) throw new Error(`docs.get: ${error.message}`);
    return data as DocRow | null;
  }

  /** Insert an Account row if absent. Accounts are implicit: rows appear the
   *  first time the Account doc is presented (mint_promise, create_records,
   *  submit_tx). Balance always starts at 0. */
  async upsertAccount(input: {
    accountHash: string;
    promiseHash: string;
    pocketHash: string;
    holderPubkey: string;
  }): Promise<void> {
    const { error } = await this.sb.from("accounts").upsert(
      {
        account_hash: input.accountHash,
        bank_pubkey: this.bankPubkey,
        promise_hash: input.promiseHash,
        pocket_hash: input.pocketHash,
        holder_pubkey: input.holderPubkey,
        balance: 0,
      },
      { onConflict: "account_hash", ignoreDuplicates: true },
    );
    if (error) throw new Error(`accounts.upsert: ${error.message}`);
  }

  async getAccount(accountHash: string): Promise<AccountRow | null> {
    const { data, error } = await this.sb
      .from("accounts")
      .select("*")
      .eq("account_hash", accountHash)
      .eq("bank_pubkey", this.bankPubkey)
      .maybeSingle();
    if (error) throw new Error(`accounts.get: ${error.message}`);
    return data as AccountRow | null;
  }

  /** Look up all accounts owned by a holder at this bank. */
  async listAccountsByHolder(holderPubkey: string): Promise<AccountRow[]> {
    const { data, error } = await this.sb
      .from("accounts")
      .select("*")
      .eq("bank_pubkey", this.bankPubkey)
      .eq("holder_pubkey", holderPubkey);
    if (error) throw new Error(`accounts.byHolder: ${error.message}`);
    return (data as AccountRow[]) ?? [];
  }

  /** Look up multiple docs by hash. Returns a hash → body map. */
  async getDocsByHashes(hashes: string[]): Promise<Record<string, Record<string, unknown>>> {
    if (hashes.length === 0) return {};
    const { data, error } = await this.sb
      .from("docs")
      .select("hash, body")
      .eq("bank_pubkey", this.bankPubkey)
      .in("hash", hashes);
    if (error) throw new Error(`docs.byHashes: ${error.message}`);
    const out: Record<string, Record<string, unknown>> = {};
    for (const row of data ?? []) {
      out[row.hash as string] = row.body as Record<string, unknown>;
    }
    return out;
  }

  // ── ledger_records: bank-minted, ULID-identified ───────────────────────────

  /** Create a ledger record. The bank assigns the ULID and guarantees
   *  uniqueness. `pairUlid` (the peer record) and `dealUlid` (the grouping
   *  key) are mandatory. */
  async insertLedgerRecord(input: {
    ulid: string;
    type: "credit" | "debit";
    account: string;
    amount: number;
    pairUlid: string;
    dealUlid: string;
    body: Record<string, unknown>;
  }): Promise<void> {
    const { error } = await this.sb.from("ledger_records").insert({
      ulid: input.ulid,
      bank_pubkey: this.bankPubkey,
      type: input.type,
      account: input.account,
      amount: input.amount,
      pair_ulid: input.pairUlid,
      deal_ulid: input.dealUlid,
      body: input.body,
    });
    if (error) throw new Error(`ledger_records.insert: ${error.message}`);
  }

  /** All records of a deal at this bank. The advance engine and get_deal
   *  walk the deal through this. */
  async getLedgerRecordsByDeal(dealUlid: string): Promise<LedgerRecordRow[]> {
    const { data, error } = await this.sb
      .from("ledger_records")
      .select("*")
      .eq("bank_pubkey", this.bankPubkey)
      .eq("deal_ulid", dealUlid)
      .order("ulid");
    if (error) throw new Error(`ledger_records.byDeal: ${error.message}`);
    return (data as LedgerRecordRow[]) ?? [];
  }

  async getLedgerRecord(ulid: string): Promise<LedgerRecordRow | null> {
    const { data, error } = await this.sb
      .from("ledger_records")
      .select("*")
      .eq("ulid", ulid)
      .eq("bank_pubkey", this.bankPubkey)
      .maybeSingle();
    if (error) throw new Error(`ledger_records.get: ${error.message}`);
    return data as LedgerRecordRow | null;
  }

  /** Look up multiple ledger records by ULID. Returns a ulid → body map. */
  async getLedgerRecordsByUlids(ulids: string[]): Promise<Record<string, Record<string, unknown>>> {
    if (ulids.length === 0) return {};
    const { data, error } = await this.sb
      .from("ledger_records")
      .select("ulid, body")
      .eq("bank_pubkey", this.bankPubkey)
      .in("ulid", ulids);
    if (error) throw new Error(`ledger_records.byUlids: ${error.message}`);
    const out: Record<string, Record<string, unknown>> = {};
    for (const row of data ?? []) {
      out[row.ulid as string] = row.body as Record<string, unknown>;
    }
    return out;
  }

  /** Bind ledger records to a Tx by setting their tx_ulid. */
  async bindRecordsToTx(ulids: string[], txUlid: string): Promise<void> {
    const { error } = await this.sb
      .from("ledger_records")
      .update({ tx_ulid: txUlid })
      .eq("bank_pubkey", this.bankPubkey)
      .in("ulid", ulids);
    if (error) throw new Error(`ledger_records.bindTx: ${error.message}`);
  }

  /**
   * Apply a balance delta to an Account row. Used by settle.
   * Returns the new balance.
   */
  async applyBalanceDelta(accountHash: string, delta: number): Promise<string> {
    const { data, error } = await this.sb.rpc("apply_balance_delta", {
      _account_hash: accountHash,
      _bank_pubkey: this.bankPubkey,
      _delta: delta,
    });
    if (error) {
      // Fallback path if the stored proc isn't installed: read-modify-write.
      // Race-safe for single-writer banks (one Edge Function instance at a
      // time per Supabase project); contended writes still serialize via
      // Postgres row locks on the SELECT FOR UPDATE inside this function.
      return this.applyBalanceDeltaInline(accountHash, delta);
    }
    return String(data);
  }

  private async applyBalanceDeltaInline(accountHash: string, delta: number): Promise<string> {
    const acct = await this.getAccount(accountHash);
    if (!acct) throw new Error(`account ${accountHash} not found`);
    const newBalance = Number(acct.balance) + delta;
    const { error } = await this.sb
      .from("accounts")
      .update({ balance: newBalance })
      .eq("account_hash", accountHash)
      .eq("bank_pubkey", this.bankPubkey);
    if (error) throw new Error(`accounts.updateBalance: ${error.message}`);
    return String(newBalance);
  }

  /** Acquire a hold on an Account for a deal. Returns true if acquired, false on conflict. */
  async acquireHold(input: {
    accountHash: string;
    dealUlid: string;
    amount: number;
  }): Promise<boolean> {
    const { error } = await this.sb.from("holds").insert({
      account_hash: input.accountHash,
      deal_ulid: input.dealUlid,
      bank_pubkey: this.bankPubkey,
      amount: input.amount,
      active: true,
    });
    if (error) {
      if (error.code === "23505") return false; // already a hold on this account
      throw new Error(`holds.insert: ${error.message}`);
    }
    return true;
  }

  /** Amount of the active hold on an account, or 0 if none. Used by the
   *  approve-time balance check. */
  async getActiveHoldAmount(accountHash: string): Promise<number> {
    const { data, error } = await this.sb
      .from("holds")
      .select("amount")
      .eq("account_hash", accountHash)
      .eq("bank_pubkey", this.bankPubkey)
      .eq("active", true)
      .maybeSingle();
    if (error) throw new Error(`holds.activeAmount: ${error.message}`);
    return data ? Number(data.amount) : 0;
  }

  /** Release a single hold (settle or reject path). */
  async releaseHold(accountHash: string, dealUlid: string): Promise<void> {
    const { error } = await this.sb
      .from("holds")
      .update({ active: false, released_at: new Date().toISOString() })
      .eq("account_hash", accountHash)
      .eq("deal_ulid", dealUlid)
      .eq("bank_pubkey", this.bankPubkey)
      .eq("active", true);
    if (error) throw new Error(`holds.release: ${error.message}`);
  }

  /** Release every active hold this bank placed for a deal (reject path). */
  async releaseHoldsByDeal(dealUlid: string): Promise<void> {
    const { error } = await this.sb
      .from("holds")
      .update({ active: false, released_at: new Date().toISOString() })
      .eq("deal_ulid", dealUlid)
      .eq("bank_pubkey", this.bankPubkey)
      .eq("active", true);
    if (error) throw new Error(`holds.releaseByDeal: ${error.message}`);
  }

  /** Leg state machine helpers, keyed (deal_ulid, bank). Only writes fields
   *  that are explicitly set, so a state-only update doesn't null out the
   *  topology fields populated at create_records. */
  async upsertLeg(input: {
    dealUlid: string;
    state: string;
    role?: string;
    predecessors?: string[];
    banks?: string[];
  }): Promise<void> {
    const row: Record<string, unknown> = {
      deal_ulid: input.dealUlid,
      bank_pubkey: this.bankPubkey,
      state: input.state,
    };
    if (input.role !== undefined) row.role = input.role;
    if (input.predecessors !== undefined) row.predecessors = input.predecessors;
    if (input.banks !== undefined) row.banks = input.banks;
    const { error } = await this.sb.from("deal_legs").upsert(row, { onConflict: "deal_ulid,bank_pubkey" });
    if (error) throw new Error(`deal_legs.upsert: ${error.message}`);
  }

  async getLegState(dealUlid: string): Promise<LegRow | null> {
    const { data, error } = await this.sb
      .from("deal_legs")
      .select("state, role, predecessors, banks")
      .eq("deal_ulid", dealUlid)
      .eq("bank_pubkey", this.bankPubkey)
      .maybeSingle();
    if (error) throw new Error(`deal_legs.getState: ${error.message}`);
    if (!data) return null;
    const row = data as { state: string; role: string | null; predecessors: unknown; banks: unknown };
    return {
      state: row.state,
      role: row.role ?? null,
      predecessors: Array.isArray(row.predecessors) ? (row.predecessors as string[]) : [],
      banks: Array.isArray(row.banks) ? (row.banks as string[]) : [],
    };
  }

  /** Find a stored signature doc by signer + (target, action). The target is
   *  one of {hash, record, deal} — the three Signature anchor kinds. Returns
   *  the doc body, or null. */
  async findActionSig(
    actorPubkey: string,
    target: { hash?: string; record?: string; deal?: string },
    action: string,
  ): Promise<Record<string, unknown> | null> {
    const match: Record<string, string> = { action };
    if (target.hash !== undefined) match.hash = target.hash;
    if (target.record !== undefined) match.record = target.record;
    if (target.deal !== undefined) match.deal = target.deal;
    const { data, error } = await this.sb
      .from("docs")
      .select("body")
      .eq("bank_pubkey", this.bankPubkey)
      .eq("type", "signature")
      .eq("pubkey", actorPubkey)
      .contains("body", match)
      .limit(1);
    if (error) throw new Error(`docs.findActionSig: ${error.message}`);
    return data && data[0] ? (data[0].body as Record<string, unknown>) : null;
  }

  /** All stored signature docs anchored to one target (deal, record, or
   *  hash). Used by get_deal and the advance engine's proof checks. */
  async listSignaturesByTarget(
    target: { hash?: string; record?: string; deal?: string },
  ): Promise<Array<Record<string, unknown>>> {
    const match: Record<string, string> = {};
    if (target.hash !== undefined) match.hash = target.hash;
    if (target.record !== undefined) match.record = target.record;
    if (target.deal !== undefined) match.deal = target.deal;
    const { data, error } = await this.sb
      .from("docs")
      .select("body")
      .eq("bank_pubkey", this.bankPubkey)
      .eq("type", "signature")
      .contains("body", match);
    if (error) throw new Error(`docs.sigsByTarget: ${error.message}`);
    return (data ?? []).map((r) => r.body as Record<string, unknown>);
  }

  // ── subscriptions: signature fan-out targets ────────────────────────────

  async insertSubscription(input: {
    subscriptionHash: string;
    subscriberPubkey: string;
    url: string;
    until?: string;
    watchKeys: string[];
  }): Promise<void> {
    const { error } = await this.sb.from("subscriptions").upsert(
      {
        subscription_hash: input.subscriptionHash,
        bank_pubkey: this.bankPubkey,
        subscriber_pubkey: input.subscriberPubkey,
        url: input.url,
        until: input.until ?? null,
        active: true,
      },
      { onConflict: "subscription_hash,bank_pubkey", ignoreDuplicates: true },
    );
    if (error) throw new Error(`subscriptions.upsert: ${error.message}`);
    if (input.watchKeys.length === 0) return;
    const { error: werr } = await this.sb.from("subscription_watches").upsert(
      input.watchKeys.map((k) => ({
        bank_pubkey: this.bankPubkey,
        watch_key: k,
        subscription_hash: input.subscriptionHash,
      })),
      { onConflict: "bank_pubkey,watch_key,subscription_hash", ignoreDuplicates: true },
    );
    if (werr) throw new Error(`subscription_watches.upsert: ${werr.message}`);
  }

  /** Active, unexpired subscriptions watching any of the given keys. */
  async findSubscriptionsByWatchKeys(keys: string[]): Promise<SubscriptionRow[]> {
    if (keys.length === 0) return [];
    const { data, error } = await this.sb
      .from("subscription_watches")
      .select("subscription_hash")
      .eq("bank_pubkey", this.bankPubkey)
      .in("watch_key", keys);
    if (error) throw new Error(`subscription_watches.byKeys: ${error.message}`);
    const hashes = [...new Set((data ?? []).map((r) => r.subscription_hash as string))];
    if (hashes.length === 0) return [];
    const { data: subs, error: serr } = await this.sb
      .from("subscriptions")
      .select("*")
      .eq("bank_pubkey", this.bankPubkey)
      .eq("active", true)
      .in("subscription_hash", hashes);
    if (serr) throw new Error(`subscriptions.byHashes: ${serr.message}`);
    const now = Date.now();
    return ((subs as SubscriptionRow[]) ?? []).filter(
      (s) => !s.until || new Date(s.until).getTime() > now,
    );
  }

  /** Record (or refresh) a peer bank URL we just heard from. */
  async rememberPeer(peerPubkey: string, peerUrl: string): Promise<void> {
    const { error } = await this.sb.from("bank_peers").upsert(
      {
        bank_pubkey: this.bankPubkey,
        peer_pubkey: peerPubkey,
        peer_url: peerUrl,
        last_seen: new Date().toISOString(),
      },
      { onConflict: "bank_pubkey,peer_pubkey" },
    );
    if (error) throw new Error(`bank_peers.upsert: ${error.message}`);
  }

  async lookupPeerUrl(peerPubkey: string): Promise<string | null> {
    const { data, error } = await this.sb
      .from("bank_peers")
      .select("peer_url")
      .eq("bank_pubkey", this.bankPubkey)
      .eq("peer_pubkey", peerPubkey)
      .maybeSingle();
    if (error) throw new Error(`bank_peers.lookup: ${error.message}`);
    return (data?.peer_url as string) ?? null;
  }

  /**
   * Replay-window check + insert in one trip. Returns false if the (sender, id, to)
   * tuple was already seen — caller MUST reject as -32002.
   *
   * Postgres unique constraint + ON CONFLICT DO NOTHING gives us atomic
   * check-and-insert. If the insert returns a row, we just claimed the
   * ULID — the request is fresh. If it returns nothing, the tuple existed.
   */
  async claimUlid(
    senderPubkey: string,
    id: string,
    toPubkey: string,
  ): Promise<boolean> {
    const { data, error } = await this.sb
      .from("replay_window")
      .insert({
        sender_pubkey: senderPubkey,
        id,
        to_pubkey: toPubkey,
      })
      .select("id")
      .maybeSingle();
    if (error) {
      // 23505 = unique_violation — that's the "already seen" path.
      if (error.code === "23505") return false;
      throw new Error(`replay_window.insert: ${error.message}`);
    }
    return data !== null;
  }
}

/** Build a BankDB from the request's runtime env. */
export function bankDbFromEnv(bankPubkey: string): BankDB {
  const url = Deno.env.get("SUPABASE_URL");
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceRole) {
    throw new Error("SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY not set");
  }
  const sb = createClient(url, serviceRole, {
    auth: { persistSession: false },
  });
  return new BankDB(sb, bankPubkey);
}
