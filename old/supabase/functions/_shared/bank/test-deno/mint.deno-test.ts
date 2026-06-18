// mint_voucher — mint IS the first ledger record pair, settled immediately.
//
// Run: deno test --allow-read supabase/functions/_shared/bank/test-deno/mint.deno-test.ts

import { hashDoc, newUlid } from "../../protocol/crypto.ts";
import { mintVoucher } from "../handlers/mint_voucher.ts";
import { assert, ctx, eq, k, key, Store, type Key } from "./_harness.ts";

function accountHash(holder: Key, name: string): string {
  return hashDoc({ type: "account", pubkey: holder.pub, ulid: newUlid(), name });
}

function accountDoc(holder: Key, voucherHash: string, account: string) {
  return { type: "account", pubkey: holder.pub, ulid: newUlid(), account, voucher: voucherHash };
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
  const store = new Store();
  const bank = key(), alice = key();
  const params = makeMintParams(bank, alice, { amount: 5 });
  const res = await mintVoucher(params, ctx(store, bank, alice.pub)) as {
    voucher_hash: string;
    debit_account_hash: string;
    credit_account_hash: string;
    deal: string;
    records: Array<Record<string, unknown>>;
  };

  eq(Number(store.accounts.get(k(bank.pub, res.debit_account_hash))!.balance), -5, "issue account");
  eq(Number(store.accounts.get(k(bank.pub, res.credit_account_hash))!.balance), 5, "holding account");

  // The record pair carries mandatory mutual pair refs and no tx field.
  eq(res.records.length, 2, "record count");
  const [debit, credit] = res.records;
  eq(debit.pair, credit.ulid, "debit.pair");
  eq(credit.pair, debit.ulid, "credit.pair");
  assert(debit.tx === undefined && credit.tx === undefined, "records must not carry a tx back-reference");

  // The mint mini-deal is settled.
  eq(store.legs.get(k(bank.pub, res.deal))!.state, "settled", "mint leg state");
});

Deno.test("mint requires two distinct account hashes", async () => {
  const store = new Store();
  const bank = key(), alice = key();
  const params = makeMintParams(bank, alice, { amount: 1, sameAccount: true });
  let threw = false;
  try {
    await mintVoucher(params, ctx(store, bank, alice.pub));
  } catch (err) {
    threw = true;
    assert(String(err).includes("distinct"), `unexpected error: ${err}`);
  }
  assert(threw, "same-account mint must be rejected");
});

Deno.test("voucher.limit caps cumulative minting across mints", async () => {
  const store = new Store();
  const bank = key(), alice = key();
  const params = makeMintParams(bank, alice, { amount: 6, limit: 10 });
  await mintVoucher(params, ctx(store, bank, alice.pub));

  // Second mint of the SAME voucher into the same accounts: 6 + 6 > 10.
  let threw = false;
  try {
    await mintVoucher(params, ctx(store, bank, alice.pub));
  } catch (err) {
    threw = true;
    assert(String(err).includes("limit"), `unexpected error: ${err}`);
  }
  assert(threw, "over-limit mint must be rejected");

  // A top-up within the limit is fine: 6 + 4 = 10.
  await mintVoucher({ ...params, amount: 4 }, ctx(store, bank, alice.pub));
  const issueHash = hashDoc(params.debit_account);
  eq(Number(store.accounts.get(k(bank.pub, issueHash))!.balance), -10, "issue after top-up");
});

Deno.test("voucher.integer rejects fractional mint amounts", async () => {
  const store = new Store();
  const bank = key(), alice = key();
  const params = makeMintParams(bank, alice, { amount: 1.5, integer: true });
  let threw = false;
  try {
    await mintVoucher(params, ctx(store, bank, alice.pub));
  } catch (err) {
    threw = true;
    assert(String(err).includes("integer"), `unexpected error: ${err}`);
  }
  assert(threw, "fractional mint of an integer voucher must be rejected");
});

Deno.test("mint rejects a voucher issued for another bank", async () => {
  const store = new Store();
  const bank = key(), otherBank = key(), alice = key();
  const params = makeMintParams(otherBank, alice, { amount: 1 });
  let threw = false;
  try {
    await mintVoucher(params, ctx(store, bank, alice.pub));
  } catch {
    threw = true;
  }
  assert(threw, "voucher.bank mismatch must be rejected");
});
