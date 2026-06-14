// mint_promise — mint IS the first ledger record pair, settled immediately.
//
// Run: deno test --allow-read --allow-write apps/bank/test-deno/mint.deno-test.ts

import { hashDoc, newUlid } from "../../../packages/protocol/src/index.ts";
import { mintPromise } from "../handlers/mint_promise.ts";
import { assert, closeTestKv, ctx, eq, key, openTestKv, type Key } from "./helpers.ts";

function pocketHash(holder: Key, name: string): string {
  return hashDoc({ type: "pocket", pubkey: holder.pub, ulid: newUlid(), name });
}

function accountDoc(holder: Key, promiseHash: string, pocket: string) {
  return { type: "account", holder: holder.pub, pocket, promise: promiseHash };
}

function makeMintParams(bank: Key, issuer: Key, opts: { limit?: number; integer?: boolean; amount: number; samePocket?: boolean }) {
  const promise: Record<string, unknown> = {
    type: "promise", pubkey: issuer.pub, ulid: newUlid(), bank: bank.pub, name: "1 logo",
  };
  if (opts.limit !== undefined) promise.limit = opts.limit;
  if (opts.integer !== undefined) promise.integer = opts.integer;
  const promiseHash = hashDoc(promise);
  const p1 = pocketHash(issuer, "issue");
  const p2 = opts.samePocket ? p1 : pocketHash(issuer, "holding");
  return {
    promise,
    debit_account: accountDoc(issuer, promiseHash, p1),
    credit_account: accountDoc(issuer, promiseHash, p2),
    amount: opts.amount,
  };
}

Deno.test("mint creates the ± record pair and settles immediately", async () => {
  const tk = await openTestKv();
  try {
    const bank = key(), alice = key();
    const params = makeMintParams(bank, alice, { amount: 5 });
    const res = await mintPromise(params, ctx(tk.kv, bank, alice.pub)) as {
      promise_hash: string;
      debit_account_hash: string;
      credit_account_hash: string;
      deal: string;
      records: Array<Record<string, unknown>>;
    };

    const debitBal = (await ctx(tk.kv, bank, alice.pub).db.getAccount(res.debit_account_hash))?.balance;
    const creditBal = (await ctx(tk.kv, bank, alice.pub).db.getAccount(res.credit_account_hash))?.balance;
    eq(Number(debitBal), -5, "issue account");
    eq(Number(creditBal), 5, "holding account");

    eq(res.records.length, 2, "record count");
    const [debit, credit] = res.records;
    eq(debit.pair, credit.ulid, "debit.pair");
    eq(credit.pair, debit.ulid, "credit.pair");
    assert(debit.tx === undefined && credit.tx === undefined, "records must not carry a tx back-reference");

    const leg = await ctx(tk.kv, bank, alice.pub).db.getLegState(res.deal);
    eq(leg?.state, "settled", "mint leg state");
  } finally {
    await closeTestKv(tk);
  }
});

Deno.test("mint requires two distinct pocket hashes", async () => {
  const tk = await openTestKv();
  try {
    const bank = key(), alice = key();
    const params = makeMintParams(bank, alice, { amount: 1, samePocket: true });
    let threw = false;
    try {
      await mintPromise(params, ctx(tk.kv, bank, alice.pub));
    } catch (err) {
      threw = true;
      assert(String(err).includes("distinct"), `unexpected error: ${err}`);
    }
    assert(threw, "same-pocket mint must be rejected");
  } finally {
    await closeTestKv(tk);
  }
});

Deno.test("promise.limit caps cumulative minting across mints", async () => {
  const tk = await openTestKv();
  try {
    const bank = key(), alice = key();
    const params = makeMintParams(bank, alice, { amount: 6, limit: 10 });
    await mintPromise(params, ctx(tk.kv, bank, alice.pub));

    let threw = false;
    try {
      await mintPromise(params, ctx(tk.kv, bank, alice.pub));
    } catch (err) {
      threw = true;
      assert(String(err).includes("limit"), `unexpected error: ${err}`);
    }
    assert(threw, "over-limit mint must be rejected");

    await mintPromise({ ...params, amount: 4 }, ctx(tk.kv, bank, alice.pub));
    const issueHash = hashDoc(params.debit_account);
    const acct = await ctx(tk.kv, bank, alice.pub).db.getAccount(issueHash);
    eq(Number(acct?.balance), -10, "issue after top-up");
  } finally {
    await closeTestKv(tk);
  }
});

Deno.test("promise.integer rejects fractional mint amounts", async () => {
  const tk = await openTestKv();
  try {
    const bank = key(), alice = key();
    const params = makeMintParams(bank, alice, { amount: 1.5, integer: true });
    let threw = false;
    try {
      await mintPromise(params, ctx(tk.kv, bank, alice.pub));
    } catch (err) {
      threw = true;
      assert(String(err).includes("integer"), `unexpected error: ${err}`);
    }
    assert(threw, "fractional mint of an integer promise must be rejected");
  } finally {
    await closeTestKv(tk);
  }
});

Deno.test("mint rejects a promise issued for another bank", async () => {
  const tk = await openTestKv();
  try {
    const bank = key(), otherBank = key(), alice = key();
    const params = makeMintParams(otherBank, alice, { amount: 1 });
    let threw = false;
    try {
      await mintPromise(params, ctx(tk.kv, bank, alice.pub));
    } catch {
      threw = true;
    }
    assert(threw, "promise.bank mismatch must be rejected");
  } finally {
    await closeTestKv(tk);
  }
});
