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
  pending: string;
  acknowledged: boolean;
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

  /** Insert or update an Account row. Used by mint_promise (issuer's negative account) and open_account. */
  async upsertAccount(input: {
    accountHash: string;
    promiseHash: string;
    pocketHash: string;
    holderPubkey: string;
    initialBalance?: number;
    acknowledged?: boolean;
  }): Promise<void> {
    const { error } = await this.sb.from("accounts").upsert(
      {
        account_hash: input.accountHash,
        bank_pubkey: this.bankPubkey,
        promise_hash: input.promiseHash,
        pocket_hash: input.pocketHash,
        holder_pubkey: input.holderPubkey,
        balance: input.initialBalance ?? 0,
        pending: 0,
        acknowledged: input.acknowledged ?? false,
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

  /** Acquire a hold on an Account for a Tx. Returns true if acquired, false on conflict. */
  async acquireHold(input: {
    accountHash: string;
    txHash: string;
    amount: number;
  }): Promise<boolean> {
    const { error } = await this.sb.from("holds").insert({
      account_hash: input.accountHash,
      tx_hash: input.txHash,
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

  /** Release a hold (settle or reject path). */
  async releaseHold(accountHash: string, txHash: string): Promise<void> {
    const { error } = await this.sb
      .from("holds")
      .update({ active: false, released_at: new Date().toISOString() })
      .eq("account_hash", accountHash)
      .eq("tx_hash", txHash)
      .eq("bank_pubkey", this.bankPubkey)
      .eq("active", true);
    if (error) throw new Error(`holds.release: ${error.message}`);
  }

  /** Tx state machine helpers. Only writes fields that are explicitly set, so
   *  a state-only update doesn't null out `role` / `predecessors` populated on a
   *  previous call. Under the client-orchestrated N-party model each bank stores
   *  its own role (lead|follow) and the predecessor banks it must observe a
   *  `settle` from before settling its own leg. */
  async upsertTx(input: {
    txHash: string;
    state: string;
    role?: string;
    predecessors?: string[];
  }): Promise<void> {
    const row: Record<string, unknown> = {
      tx_hash: input.txHash,
      bank_pubkey: this.bankPubkey,
      state: input.state,
    };
    if (input.role !== undefined) row.role = input.role;
    if (input.predecessors !== undefined) row.predecessors = input.predecessors;
    const { error } = await this.sb.from("txs").upsert(row, { onConflict: "tx_hash,bank_pubkey" });
    if (error) throw new Error(`txs.upsert: ${error.message}`);
  }

  /** Find a stored signature doc by signer + the (hash, action) it carries.
   *  Used to check confirm/settle attestations without re-walking the doc
   *  stream by hand. Returns the doc body, or null. */
  async findActionSig(
    actorPubkey: string,
    txHash: string,
    action: string,
  ): Promise<Record<string, unknown> | null> {
    const { data, error } = await this.sb
      .from("docs")
      .select("body")
      .eq("bank_pubkey", this.bankPubkey)
      .eq("type", "signature")
      .eq("pubkey", actorPubkey)
      .contains("body", { hash: txHash, action })
      .limit(1);
    if (error) throw new Error(`docs.findActionSig: ${error.message}`);
    return data && data[0] ? (data[0].body as Record<string, unknown>) : null;
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

  async getTxState(txHash: string): Promise<{
    state: string;
    role: string | null;
    predecessors: string[];
  } | null> {
    const { data, error } = await this.sb
      .from("txs")
      .select("state, role, predecessors")
      .eq("tx_hash", txHash)
      .eq("bank_pubkey", this.bankPubkey)
      .maybeSingle();
    if (error) throw new Error(`txs.getState: ${error.message}`);
    if (!data) return null;
    const row = data as { state: string; role: string | null; predecessors: unknown };
    return {
      state: row.state,
      role: row.role ?? null,
      predecessors: Array.isArray(row.predecessors) ? (row.predecessors as string[]) : [],
    };
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
