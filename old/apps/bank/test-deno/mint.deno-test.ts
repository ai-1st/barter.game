// mint_voucher — mint IS the first record pair, settled immediately.
//
// Run: deno test --allow-read --allow-write apps/bank/test-deno/mint.deno-test.ts

import { hashDoc, newUlid } from "../../../packages/protocol/src/index.ts";
import { mintVoucher } from "../handlers/mint_voucher.ts";
import { assert, closeTestKv, ctx, eq, key, openTestKv, type Key } from "./helpers.ts";

function accountHash(holder: Key, name: string): string {
  return hashDoc({ type: "account", pubkey: holder.pub, ulid: newUlid(), name });
}

function accountDoc(holder: Key, voucherHash: string, account: string) {
  return { type: "account", holder: holder.pub, account, voucher: voucherHash };
}

function makeMintParams(bank: Key, issuer: Key, opts: { limit?: number; integer?: boolean; amount: number; sameAccount?: boolean }) {
  const voucher: Record<string, unknown> = {
    type: "voucher", pubkey: issuer.pub, ulid: newUlid(), bank: bank.pub, name: "1 logo",
  };
  if (opts.limit !== undefined) voucher.limit = opts.limit;
  if (opts.integer !== undefined) voucher.integer = opts.integer;
  const voucherHash = hashDoc(voucher);
  const p1 = accountHash(issuer, "issue");
  const p2 = opts.sameAccount ? p1 : accountHash(issuer, "holding");
  return {
    voucher,
    debit_account: accountDoc(issuer, voucherHash, p1),
    credit_account: accountDoc(issuer, voucherHash, p2),
    amount: opts.amount,
  };
}

Deno.test("mint creates the ± record pair and settles immediately", async () => {
  const tk = await openTestKv();
  try {
    const bank = key(), alice = key();
    const params = makeMintParams(bank, alice, { amount: 5 });
    const res = await mintVoucher(params, ctx(tk.kv, bank, alice.pub)) as {
      voucher_hash: string;
      debit_account_hash: string;
      credit_account_hash: string;
      records: Array<Record<string, unknown>>;
      debit_hash: string;
      credit_hash: string;
      settle_signatures: Array<Record<string, unknown>>;
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

    eq(res.settle_signatures.length, 2, "mint signs settle on both records");
    eq(res.settle_signatures[0].action, "settle", "settle action");
  } finally {
    await closeTestKv(tk);
  }
});

Deno.test("mint requires two distinct account hashes", async () => {
  const tk = await openTestKv();
  try {
    const bank = key(), alice = key();
    const params = makeMintParams(bank, alice, { amount: 1, sameAccount: true });
    let threw = false;
    try {
      await mintVoucher(params, ctx(tk.kv, bank, alice.pub));
    } catch (err) {
      threw = true;
      assert(String(err).includes("distinct"), `unexpected error: ${err}`);
    }
    assert(threw, "same-account mint must be rejected");
  } finally {
    await closeTestKv(tk);
  }
});

Deno.test("voucher.limit caps cumulative minting across mints", async () => {
  const tk = await openTestKv();
  try {
    const bank = key(), alice = key();
    const params = makeMintParams(bank, alice, { amount: 6, limit: 10 });
    await mintVoucher(params, ctx(tk.kv, bank, alice.pub));

    let threw = false;
    try {
      await mintVoucher(params, ctx(tk.kv, bank, alice.pub));
    } catch (err) {
      threw = true;
      assert(String(err).includes("limit"), `unexpected error: ${err}`);
    }
    assert(threw, "over-limit mint must be rejected");

    await mintVoucher({ ...params, amount: 4 }, ctx(tk.kv, bank, alice.pub));
    const issueHash = hashDoc(params.debit_account);
    const acct = await ctx(tk.kv, bank, alice.pub).db.getAccount(issueHash);
    eq(Number(acct?.balance), -10, "issue after top-up");
  } finally {
    await closeTestKv(tk);
  }
});

Deno.test("voucher.integer rejects fractional mint amounts", async () => {
  const tk = await openTestKv();
  try {
    const bank = key(), alice = key();
    const params = makeMintParams(bank, alice, { amount: 1.5, integer: true });
    let threw = false;
    try {
      await mintVoucher(params, ctx(tk.kv, bank, alice.pub));
    } catch (err) {
      threw = true;
      assert(String(err).includes("integer"), `unexpected error: ${err}`);
    }
    assert(threw, "fractional mint of an integer voucher must be rejected");
  } finally {
    await closeTestKv(tk);
  }
});

Deno.test("mint issues record-level settle signatures, no ready/hold", async () => {
  const tk = await openTestKv();
  try {
    const bank = key(), alice = key();
    const params = makeMintParams(bank, alice, { amount: 3 });
    const res = await mintVoucher(params, ctx(tk.kv, bank, alice.pub)) as {
      debit_hash: string;
      credit_hash: string;
      settle_signatures: Array<Record<string, unknown>>;
    };

    for (const hash of [res.debit_hash, res.credit_hash]) {
      const row = await ctx(tk.kv, bank, alice.pub).db.getRecord(hash);
      eq(row?.status, "settle", `record ${hash.slice(0, 8)} must be in settle prefix`);
    }

    const actions = res.settle_signatures.map((s) => s.action);
    eq(actions.filter((a) => a === "settle").length, 2, "two settle signatures");
    eq(actions.filter((a) => a === "ready" || a === "hold").length, 0, "no ready/hold signatures");
  } finally {
    await closeTestKv(tk);
  }
});

Deno.test("mint rejects a voucher issued for another bank", async () => {
  const tk = await openTestKv();
  try {
    const bank = key(), otherBank = key(), alice = key();
    const params = makeMintParams(otherBank, alice, { amount: 1 });
    let threw = false;
    try {
      await mintVoucher(params, ctx(tk.kv, bank, alice.pub));
    } catch {
      threw = true;
    }
    assert(threw, "voucher.bank mismatch must be rejected");
  } finally {
    await closeTestKv(tk);
  }
});
