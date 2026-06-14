// The bilateral walkthrough, client-relay topology: no subscriptions at all.
// The deal stalls exactly where the protocol says it must, and the client
// un-sticks it by relaying signatures via get_deal → notify_signatures.
//
// Run: deno test --allow-read --allow-write apps/bank/test-deno/direct_approval.deno-test.ts

import { hashDoc, newUlid, signDoc } from "../../../packages/protocol/src/index.ts";
import { buildDeal, type TransferSpec } from "../../../packages/protocol/src/deal.ts";
import { mintPromise } from "../handlers/mint_promise.ts";
import { createRecords } from "../handlers/create_records.ts";
import { submitTx } from "../handlers/submit_tx.ts";
import { notifySignatures } from "../handlers/notify_signatures.ts";
import { getDeal } from "../handlers/get_deal.ts";
import { rejectDeal } from "../handlers/reject_deal.ts";
import { assert, closeTestKv, ctx, eq, key, openTestKv, type Key } from "./helpers.ts";

function accountDoc(holder: Key, promiseHash: string, pocketName: string) {
  const body: Record<string, unknown> = {
    type: "account",
    holder: holder.pub,
    pocket: hashDoc({ type: "pocket", pubkey: holder.pub, ulid: newUlid(), name: pocketName }),
    promise: promiseHash,
  };
  return { body, hash: hashDoc(body) };
}

async function mint(store: { kv: Deno.Kv }, bank: Key, issuer: Key, name: string, amount: number) {
  const promise: Record<string, unknown> = {
    type: "promise", pubkey: issuer.pub, ulid: newUlid(), bank: bank.pub, name,
  };
  const issue = accountDoc(issuer, hashDoc(promise), "issue");
  const holding = accountDoc(issuer, hashDoc(promise), "holding");
  const res = await mintPromise(
    { promise, debit_account: issue.body, credit_account: holding.body, amount },
    ctx(store.kv, bank, issuer.pub),
  ) as { promise_hash: string; debit_account_hash: string; credit_account_hash: string };
  return { promiseHash: res.promise_hash, issue: res.debit_account_hash, holding: res.credit_account_hash };
}

function holderSig(holder: Key, txHash: string, action: "lead" | "follow") {
  const sig: Record<string, unknown> = {
    type: "signature", pubkey: holder.pub, ulid: newUlid(), hash: txHash, action,
  };
  sig.sig = signDoc(sig, holder.priv);
  return sig;
}

/** Client relay: carry every signature one bank has to another bank. */
async function relay(store: { kv: Deno.Kv }, from: Key, to: Key, deal: string, sender: Key) {
  const view = await getDeal({ deal }, ctx(store.kv, from, sender.pub)) as {
    signatures: Array<Record<string, unknown>>;
  };
  await notifySignatures({ signatures: view.signatures }, ctx(store.kv, to, sender.pub));
}

Deno.test("bilateral walkthrough: direct approval + client relay settles both legs", async () => {
  const tk = await openTestKv();
  try {
    const alice = key(), bob = key();
    const bA = key(), bB = key();

    const logo = await mint(tk, bA, alice, "1 logo", 1);
    const hour = await mint(tk, bB, bob, "1 hour", 1);

    const bobLogo = accountDoc(bob, logo.promiseHash, "main");
    const aliceHour = accountDoc(alice, hour.promiseHash, "main");

    const deal = newUlid();
    const transfers: TransferSpec[] = [
      { promise: logo.promiseHash, issuerBank: bA.pub, amount: 1, from: { holder: alice.pub, account: logo.holding }, to: { holder: bob.pub, account: bobLogo.hash } },
      { promise: hour.promiseHash, issuerBank: bB.pub, amount: 1, from: { holder: bob.pub, account: hour.holding }, to: { holder: alice.pub, account: aliceHour.hash } },
    ];

    const banks = [bA.pub, bB.pub];
    const resA = await createRecords(
      {
        deal,
        role: "lead",
        predecessors: [],
        banks,
        requests: [{ type: "transfer", promise_hash: logo.promiseHash, amount: 1, debit_account_hash: logo.holding, credit_account_hash: bobLogo.hash }],
        docs: [bobLogo.body],
      },
      ctx(tk.kv, bA, alice.pub),
    ) as { records: Array<Record<string, unknown>> };
    const resB = await createRecords(
      {
        deal,
        role: "follow",
        predecessors: [bA.pub],
        banks,
        requests: [{ type: "transfer", promise_hash: hour.promiseHash, amount: 1, debit_account_hash: hour.holding, credit_account_hash: aliceHour.hash }],
        docs: [aliceHour.body],
      },
      ctx(tk.kv, bB, alice.pub),
    ) as { records: Array<Record<string, unknown>> };

    for (const r of [...resA.records, ...resB.records]) {
      assert(typeof r.pair === "string", "record.pair must be set by the bank");
    }

    const built = buildDeal(
      { deal, initiator: alice.pub, leadBanks: [bA.pub], transfers },
      { [bA.pub]: resA.records.map((r) => r.ulid as string), [bB.pub]: resB.records.map((r) => r.ulid as string) },
    );
    const aTx = built.holderTxs.find((h) => h.holder === alice.pub)!;
    const bTx = built.holderTxs.find((h) => h.holder === bob.pub)!;
    eq(aTx.role, "lead", "ATx role");
    eq(bTx.role, "follow", "BTx role");

    for (const bank of [bA, bB]) {
      await submitTx({ tx: aTx.tx, holder_signature: holderSig(alice, aTx.txHash, "lead") }, ctx(tk.kv, bank, alice.pub));
    }

    const legBeforeB = await ctx(tk.kv, bA, alice.pub).db.getLegState(deal);
    eq(legBeforeB?.state, "created", "Abank leg before BTx");

    for (const bank of [bA, bB]) {
      await submitTx({ tx: bTx.tx, holder_signature: holderSig(bob, bTx.txHash, "follow") }, ctx(tk.kv, bank, alice.pub));
    }

    const legAHeld = await ctx(tk.kv, bA, alice.pub).db.getLegState(deal);
    const legBHeld = await ctx(tk.kv, bB, alice.pub).db.getLegState(deal);
    eq(legAHeld?.state, "held", "Abank stalls at held without relay");
    eq(legBHeld?.state, "held", "Bbank stalls at held without relay");

    await relay(tk, bB, bA, deal, alice);
    const legASettled = await ctx(tk.kv, bA, alice.pub).db.getLegState(deal);
    eq(legASettled?.state, "settled", "Abank settles after seeing Bbank hold");

    await relay(tk, bA, bB, deal, alice);
    const legBSettled = await ctx(tk.kv, bB, alice.pub).db.getLegState(deal);
    eq(legBSettled?.state, "settled", "Bbank settles after Abank settle");

    const view = await getDeal({ deal }, ctx(tk.kv, bB, alice.pub)) as { signatures: Array<Record<string, unknown>> };
    const bSettle = view.signatures.find((s) => s.action === "settle" && s.pubkey === bB.pub)!;
    const aSettle = view.signatures.find((s) => s.action === "settle" && s.pubkey === bA.pub)!;
    assert(((bSettle.seen as string[]) ?? []).includes(hashDoc(aSettle)), "Bbank settle must cite Abank settle");

    const bal = async (bank: Key, acct: string) => Number((await ctx(tk.kv, bank, alice.pub).db.getAccount(acct))?.balance);
    eq(await bal(bA, logo.issue), -1, "Alice issue logo");
    eq(await bal(bA, logo.holding), 0, "Alice holding logo");
    eq(await bal(bA, bobLogo.hash), 1, "Bob logo");
    eq(await bal(bB, hour.issue), -1, "Bob issue hour");
    eq(await bal(bB, hour.holding), 0, "Bob holding hour");
    eq(await bal(bB, aliceHour.hash), 1, "Alice hour");

    const holds = [] as Array<{ active: boolean }>;
    const prefix = [bA.pub, "holds"] as Deno.KvKey;
    for await (const entry of tk.kv.list<{ active: boolean }>({ prefix })) holds.push(entry.value);
    const prefixB = [bB.pub, "holds"] as Deno.KvKey;
    for await (const entry of tk.kv.list<{ active: boolean }>({ prefix: prefixB })) holds.push(entry.value);
    for (const h of holds) assert(!h.active, "all holds released");
  } finally {
    await closeTestKv(tk);
  }
});

Deno.test("insufficient non-issuer balance draws a per-record reject; reject_deal unwinds", async () => {
  const tk = await openTestKv();
  try {
    const alice = key(), bob = key();
    const bB = key();

    const hour = await mint(tk, bB, bob, "1 hour", 1);
    const aliceHour = accountDoc(alice, hour.promiseHash, "main");

    const deal1 = newUlid();
    const r1 = await createRecords(
      {
        deal: deal1,
        role: "lead",
        predecessors: [],
        banks: [bB.pub],
        requests: [{ type: "transfer", promise_hash: hour.promiseHash, amount: 1, debit_account_hash: hour.holding, credit_account_hash: aliceHour.hash }],
        docs: [aliceHour.body],
      },
      ctx(tk.kv, bB, bob.pub),
    ) as { records: Array<Record<string, unknown>> };
    const built1 = buildDeal(
      { deal: deal1, initiator: bob.pub, leadBanks: [bB.pub], transfers: [
        { promise: hour.promiseHash, issuerBank: bB.pub, amount: 1, from: { holder: bob.pub, account: hour.holding }, to: { holder: alice.pub, account: aliceHour.hash } },
      ] },
      { [bB.pub]: r1.records.map((r) => r.ulid as string) },
    );
    for (const plan of built1.holderTxs) {
      const u = plan.holder === bob.pub ? bob : alice;
      await submitTx({ tx: plan.tx, holder_signature: holderSig(u, plan.txHash, plan.role) }, ctx(tk.kv, bB, bob.pub));
    }
    const leg1 = await ctx(tk.kv, bB, bob.pub).db.getLegState(deal1);
    eq(leg1?.state, "settled", "single-bank deal settles by itself");
    eq(Number((await ctx(tk.kv, bB, bob.pub).db.getAccount(aliceHour.hash))?.balance), 1, "Alice holds 1 hour");

    const deal2 = newUlid();
    const r2 = await createRecords(
      {
        deal: deal2,
        role: "lead",
        predecessors: [],
        banks: [bB.pub],
        requests: [{ type: "transfer", promise_hash: hour.promiseHash, amount: 2, debit_account_hash: aliceHour.hash, credit_account_hash: hour.holding }],
      },
      ctx(tk.kv, bB, alice.pub),
    ) as { records: Array<Record<string, unknown>> };
    const built2 = buildDeal(
      { deal: deal2, initiator: alice.pub, leadBanks: [bB.pub], transfers: [
        { promise: hour.promiseHash, issuerBank: bB.pub, amount: 2, from: { holder: alice.pub, account: aliceHour.hash }, to: { holder: bob.pub, account: hour.holding } },
      ] },
      { [bB.pub]: r2.records.map((r) => r.ulid as string) },
    );
    const alicePlan = built2.holderTxs.find((h) => h.holder === alice.pub)!;
    const res = await submitTx(
      { tx: alicePlan.tx, holder_signature: holderSig(alice, alicePlan.txHash, "lead") },
      ctx(tk.kv, bB, alice.pub),
    ) as { record_sigs: Array<Record<string, unknown>>; leg_state: string };

    const rejectSig = res.record_sigs.find((s) => s.action === "reject");
    assert(rejectSig !== undefined, "over-balance debit must draw a reject signature");
    assert(String(rejectSig!.reason).includes("insufficient"), "reject carries a reason");
    eq(res.leg_state, "created", "leg never approves with a rejected record");

    const rej = await rejectDeal({ deal: deal2, reason: "abandoning" }, ctx(tk.kv, bB, alice.pub)) as { state: string };
    eq(rej.state, "rejected", "reject_deal marks the leg rejected");
    eq(Number((await ctx(tk.kv, bB, alice.pub).db.getAccount(aliceHour.hash))?.balance), 1, "balances untouched");
  } finally {
    await closeTestKv(tk);
  }
});
