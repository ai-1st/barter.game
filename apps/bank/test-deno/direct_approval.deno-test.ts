// The bilateral walkthrough: Alice and Bob swap vouchers across two banks.
//
// Run: deno test --allow-read --allow-write apps/bank/test-deno/direct_approval.deno-test.ts

import { hashDoc, newUlid, signDoc } from "../../../packages/protocol/src/index.ts";
import { buildDeal, type TransferSpec } from "../../../packages/protocol/src/deal.ts";
import { mintVoucher } from "../handlers/mint_voucher.ts";
import { createRecords } from "../handlers/create_records.ts";
import { submitTx } from "../handlers/submit_tx.ts";
import { getRecordSignatures } from "../handlers/get_record_signatures.ts";
import { notifySignatures } from "../handlers/notify_signatures.ts";
import { assert, closeTestKv, ctx, eq, key, openTestKv, type Key } from "./helpers.ts";

function accountDoc(holder: Key, voucherHash: string, pocketName: string) {
  const body: Record<string, unknown> = {
    type: "account",
    holder: holder.pub,
    pocket: hashDoc({ type: "pocket", pubkey: holder.pub, ulid: newUlid(), name: pocketName }),
    voucher: voucherHash,
  };
  return { body, hash: hashDoc(body) };
}

async function mint(store: { kv: Deno.Kv }, bank: Key, issuer: Key, name: string, amount: number) {
  const voucher: Record<string, unknown> = {
    type: "voucher", pubkey: issuer.pub, ulid: newUlid(), bank: bank.pub, name,
  };
  const issue = accountDoc(issuer, hashDoc(voucher), "issue");
  const holding = accountDoc(issuer, hashDoc(voucher), "holding");
  const res = await mintVoucher(
    { voucher, debit_account: issue.body, credit_account: holding.body, amount },
    ctx(store.kv, bank, issuer.pub),
  ) as { voucher_hash: string; debit_account_hash: string; credit_account_hash: string };
  return { voucherHash: res.voucher_hash, issue: res.debit_account_hash, holding: res.credit_account_hash };
}

function holderSig(holder: Key, txHash: string, action: "lead" | "follow") {
  const sig: Record<string, unknown> = {
    type: "signature", pubkey: holder.pub, ulid: newUlid(), hash: txHash, action,
  };
  sig.sig = signDoc(sig, holder.priv);
  return sig;
}

/** Fetch every signature this bank has issued on a record. */
async function recordSigs(store: { kv: Deno.Kv }, bank: Key, recordHash: string, sender: Key) {
  const view = await getRecordSignatures({ record_hash: recordHash }, ctx(store.kv, bank, sender.pub)) as {
    signatures: Array<Record<string, unknown>>;
  };
  return view.signatures;
}

Deno.test("bilateral walkthrough: direct approval settles both banks", async () => {
  const tk = await openTestKv();
  try {
    const alice = key(), bob = key();
    const bA = key(), bB = key();

    const logo = await mint(tk, bA, alice, "1 logo", 1);
    const hour = await mint(tk, bB, bob, "1 hour", 1);

    const bobLogo = accountDoc(bob, logo.voucherHash, "main");
    const aliceHour = accountDoc(alice, hour.voucherHash, "main");

    const transfers: TransferSpec[] = [
      { voucher: logo.voucherHash, issuerBank: bA.pub, amount: 1, from: { holder: alice.pub, account: logo.holding }, to: { holder: bob.pub, account: bobLogo.hash } },
      { voucher: hour.voucherHash, issuerBank: bB.pub, amount: 1, from: { holder: bob.pub, account: hour.holding }, to: { holder: alice.pub, account: aliceHour.hash } },
    ];

    const resA = await createRecords(
      {
        requests: [{ type: "transfer", voucher_hash: logo.voucherHash, amount: 1, debit_account_hash: logo.holding, credit_account_hash: bobLogo.hash }],
        docs: [bobLogo.body],
      },
      ctx(tk.kv, bA, alice.pub),
    ) as { records: Array<Record<string, unknown>> };
    const resB = await createRecords(
      {
        requests: [{ type: "transfer", voucher_hash: hour.voucherHash, amount: 1, debit_account_hash: hour.holding, credit_account_hash: aliceHour.hash }],
        docs: [aliceHour.body],
      },
      ctx(tk.kv, bB, alice.pub),
    ) as { records: Array<Record<string, unknown>> };

    const recordsA = resA.records;
    const recordsB = resB.records;
    for (const r of [...recordsA, ...recordsB]) {
      assert(typeof r.pair === "string", "record.pair must be set by the bank");
    }

    const built = buildDeal(
      { initiator: alice.pub, transfers },
      { [bA.pub]: recordsA as never, [bB.pub]: recordsB as never },
    );
    const aTx = built.holderTxs.find((h) => h.holder === alice.pub)!;
    const bTx = built.holderTxs.find((h) => h.holder === bob.pub)!;
    eq(aTx.role, "lead", "ATx role");
    eq(bTx.role, "follow", "BTx role");

    for (const bank of [bA, bB]) {
      await submitTx({ tx: aTx.tx, holder_signature: holderSig(alice, aTx.txHash, "lead") }, ctx(tk.kv, bank, alice.pub));
    }

    for (const bank of [bA, bB]) {
      await submitTx({ tx: bTx.tx, holder_signature: holderSig(bob, bTx.txHash, "follow") }, ctx(tk.kv, bank, alice.pub));
    }

    // Both banks should have settled the records.
    // Alice's Tx carries her debit (transfer 0) then her credit (transfer 1).
    // Bob's Tx carries his credit (transfer 0) then his debit (transfer 1).
    const aliceDebitHash = aTx.tx.records[0];
    const aliceCreditHash = aTx.tx.records[1];
    const bobCreditHash = bTx.tx.records[0];
    const bobDebitHash = bTx.tx.records[1];

    for (const [bank, hash] of [[bA, aliceDebitHash], [bA, bobCreditHash], [bB, bobDebitHash], [bB, aliceCreditHash]] as [Key, string][]) {
      const sigs = await recordSigs(tk, bank, hash, alice);
      assert(sigs.some((s) => s.action === "settle" && s.pubkey === bank.pub), `bank ${bank.pub.slice(0, 8)} must settle record ${hash.slice(0, 8)}`);
    }

    const bal = async (bank: Key, acct: string) => Number((await ctx(tk.kv, bank, alice.pub).db.getAccount(acct))?.balance);
    eq(await bal(bA, logo.issue), -1, "Alice issue logo");
    eq(await bal(bA, logo.holding), 0, "Alice holding logo");
    eq(await bal(bA, bobLogo.hash), 1, "Bob logo");
    eq(await bal(bB, hour.issue), -1, "Bob issue hour");
    eq(await bal(bB, hour.holding), 0, "Bob holding hour");
    eq(await bal(bB, aliceHour.hash), 1, "Alice hour");

    const holds = [] as Array<{ active: boolean }>;
    for (const bank of [bA, bB]) {
      for await (const entry of tk.kv.list<{ active: boolean }>({ prefix: [bank.pub, "holds"] })) holds.push(entry.value);
    }
    for (const h of holds) assert(!h.active, "all holds released");
  } finally {
    await closeTestKv(tk);
  }
});

Deno.test("insufficient non-issuer balance draws a per-record reject", async () => {
  const tk = await openTestKv();
  try {
    const alice = key(), bob = key();
    const bB = key();

    const hour = await mint(tk, bB, bob, "1 hour", 1);
    const aliceHour = accountDoc(alice, hour.voucherHash, "main");

    const r1 = await createRecords(
      {
        requests: [{ type: "transfer", voucher_hash: hour.voucherHash, amount: 1, debit_account_hash: hour.holding, credit_account_hash: aliceHour.hash }],
        docs: [aliceHour.body],
      },
      ctx(tk.kv, bB, bob.pub),
    ) as { records: Array<Record<string, unknown>> };
    const built1 = buildDeal(
      { initiator: bob.pub, transfers: [
        { voucher: hour.voucherHash, issuerBank: bB.pub, amount: 1, from: { holder: bob.pub, account: hour.holding }, to: { holder: alice.pub, account: aliceHour.hash } },
      ] },
      { [bB.pub]: r1.records as never },
    );
    for (const plan of built1.holderTxs) {
      const u = plan.holder === bob.pub ? bob : alice;
      await submitTx({ tx: plan.tx, holder_signature: holderSig(u, plan.txHash, plan.role) }, ctx(tk.kv, bB, bob.pub));
    }
    eq(Number((await ctx(tk.kv, bB, bob.pub).db.getAccount(aliceHour.hash))?.balance), 1, "Alice holds 1 hour");

    const r2 = await createRecords(
      {
        requests: [{ type: "transfer", voucher_hash: hour.voucherHash, amount: 2, debit_account_hash: aliceHour.hash, credit_account_hash: hour.holding }],
      },
      ctx(tk.kv, bB, alice.pub),
    ) as { records: Array<Record<string, unknown>> };
    const built2 = buildDeal(
      { initiator: alice.pub, transfers: [
        { voucher: hour.voucherHash, issuerBank: bB.pub, amount: 2, from: { holder: alice.pub, account: aliceHour.hash }, to: { holder: bob.pub, account: hour.holding } },
      ] },
      { [bB.pub]: r2.records as never },
    );
    const alicePlan = built2.holderTxs.find((h) => h.holder === alice.pub)!;
    const res = await submitTx(
      { tx: alicePlan.tx, holder_signature: holderSig(alice, alicePlan.txHash, "lead") },
      ctx(tk.kv, bB, alice.pub),
    ) as { record_sigs: Array<Record<string, unknown>> };

    const rejectSig = res.record_sigs.find((s) => s.action === "reject");
    assert(rejectSig !== undefined, "over-balance debit must draw a reject signature");
    assert(String(rejectSig!.reason).includes("insufficient"), "reject carries a reason");

    eq(Number((await ctx(tk.kv, bB, alice.pub).db.getAccount(aliceHour.hash))?.balance), 1, "balances untouched");
  } finally {
    await closeTestKv(tk);
  }
});
