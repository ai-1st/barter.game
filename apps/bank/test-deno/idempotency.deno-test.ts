// Idempotency tests for bank request handlers.
//
// The envelope replay window blocks exact replays, but a fresh signed envelope
// with identical content must not create duplicate records or duplicate mints.

import { hashDoc, newUlid } from "../../../packages/protocol/src/index.ts";
import { createRecords } from "../handlers/create_records.ts";
import { mintPromise } from "../handlers/mint_promise.ts";
import { assert, closeTestKv, ctx, eq, key, openTestKv, type Key } from "./helpers.ts";

function pocketHash(holder: Key, name: string): string {
  return hashDoc({ type: "pocket", pubkey: holder.pub, ulid: newUlid(), name });
}

function accountDoc(holder: Key, promiseHash: string, pocket: string) {
  return { type: "account", holder: holder.pub, pocket, promise: promiseHash };
}

function makeMintParams(bank: Key, issuer: Key, amount: number) {
  const promise: Record<string, unknown> = {
    type: "promise", pubkey: issuer.pub, ulid: newUlid(), bank: bank.pub, name: "1 logo",
  };
  const promiseHash = hashDoc(promise);
  return {
    promise,
    debit_account: accountDoc(issuer, promiseHash, pocketHash(issuer, "issue")),
    credit_account: accountDoc(issuer, promiseHash, pocketHash(issuer, "holding")),
    amount,
  };
}

Deno.test("create_records is idempotent for the same request", async () => {
  const tk = await openTestKv();
  try {
    const bank = key(), alice = key(), bob = key();
    const minted = await mintPromise(makeMintParams(bank, alice, 1), ctx(tk.kv, bank, alice.pub)) as {
      promise_hash: string;
      debit_account_hash: string;
      credit_account_hash: string;
    };

    const bobAccount = accountDoc(bob, minted.promise_hash, pocketHash(bob, "main"));
    const bobAccountHash = hashDoc(bobAccount);
    const params = {
      requests: [{
        type: "transfer" as const,
        promise_hash: minted.promise_hash,
        amount: 1,
        debit_account_hash: minted.credit_account_hash,
        credit_account_hash: bobAccountHash,
      }],
      docs: [bobAccount],
    };

    const first = await createRecords(params, ctx(tk.kv, bank, alice.pub)) as {
      records: Array<Record<string, unknown>>;
      already_created?: boolean;
    };
    eq(first.already_created, undefined, "first call creates records");
    eq(first.records.length, 2, "first call returns record pair");

    // Simulate a replay with a fresh signed envelope: different requestId, same content.
    const second = await createRecords(params, ctx(tk.kv, bank, alice.pub)) as {
      records: Array<Record<string, unknown>>;
      already_created?: boolean;
    };
    eq(second.already_created, true, "second call is flagged idempotent");
    eq(second.records.length, 2, "second call returns same record count");

    // No duplicate records were created.
    const rows = await ctx(tk.kv, bank, alice.pub).db.getRecordsByAccount(minted.credit_account_hash);
    eq(rows.filter((r) => r.status === "draft").length, 1, "only one draft debit record for the account");
  } finally {
    await closeTestKv(tk);
  }
});
