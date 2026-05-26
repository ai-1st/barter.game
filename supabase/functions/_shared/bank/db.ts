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
