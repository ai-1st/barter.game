// The bilateral walkthrough (SETTLEMENT_WALKTHROUGH.md), client-relay
// topology: no subscriptions at all. The deal stalls exactly where the
// protocol says it must (a lead bank will not settle without the peer's
// hold; a follow bank will not settle without the predecessor's settle),
// and the client un-sticks it by relaying signatures via get_deal →
// notify_signatures. Also covers the reject path: a non-issuer debit
// exceeding the balance draws a per-record reject and the leg never
// approves.
//
// Run: deno test --allow-read supabase/functions/_shared/bank/test-deno/direct_approval.deno-test.ts

import { hashDoc, newUlid, signDoc } from "../../protocol/crypto.ts";
import { buildDeal, type TransferSpec } from "../../protocol/deal.ts";
import { mintVoucher } from "../handlers/mint_voucher.ts";
import { createRecords } from "../handlers/create_records.ts";
import { submitTx } from "../handlers/submit_tx.ts";
import { notifySignatures } from "../handlers/notify_signatures.ts";
import { getDeal } from "../handlers/get_deal.ts";
import { rejectDeal } from "../handlers/reject_deal.ts";
import { assert, ctx, eq, k, key, Store, type Key } from "./_harness.ts";

function accountDoc(holder: Key, voucherHash: string, accountName: string) {
  const body: Record<string, unknown> = {
    type: "account",
    pubkey: holder.pub,
    ulid: newUlid(),
    account: hashDoc({ type: "account", pubkey: holder.pub, ulid: newUlid(), name: accountName }),
    voucher: voucherHash,
  };
  return { body, hash: hashDoc(body) };
}

async function mint(store: Store, bank: Key, issuer: Key, name: string, amount: number) {
  const voucher: Record<string, unknown> = {
    type: "voucher", pubkey: issuer.pub, ulid: newUlid(), bank: bank.pub, name,
  };
  const issue = accountDoc(issuer, hashDoc(voucher), "issue");
  const holding = accountDoc(issuer, hashDoc(voucher), "holding");
  const res = await mintVoucher(
    { voucher, debit_account: issue.body, credit_account: holding.body, amount },
    ctx(store, bank, issuer.pub),
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

/** Client relay: carry every signature one bank has to another bank. */
async function relay(store: Store, from: Key, to: Key, deal: string, sender: Key) {
  const view = await getDeal({ deal }, ctx(store, from, sender.pub)) as {
    signatures: Array<Record<string, unknown>>;
  };
  await notifySignatures({ signatures: view.signatures }, ctx(store, to, sender.pub));
}

Deno.test("bilateral walkthrough: direct approval + client relay settles both legs", async () => {
  const store = new Store();
  const alice = key(), bob = key();
  const bA = key(), bB = key(); // Abank, Bbank

  // Minting: two accounts per voucher, one negative one positive.
  const logo = await mint(store, bA, alice, "1 logo", 1);
  const hour = await mint(store, bB, bob, "1 hour", 1);

  // Implicit counterparty accounts, presented with create_records.
  const bobLogo = accountDoc(bob, logo.voucherHash, "main");     // Bob receives logo at Abank
  const aliceHour = accountDoc(alice, hour.voucherHash, "main"); // Alice receives hour at Bbank

  const deal = newUlid();
  const transfers: TransferSpec[] = [
    { voucher: logo.voucherHash, issuerBank: bA.pub, amount: 1, from: { holder: alice.pub, account: logo.holding }, to: { holder: bob.pub, account: bobLogo.hash } },
    { voucher: hour.voucherHash, issuerBank: bB.pub, amount: 1, from: { holder: bob.pub, account: hour.holding }, to: { holder: alice.pub, account: aliceHour.hash } },
  ];

  // Alice contacts each bank to create the record pairs.
  const banks = [bA.pub, bB.pub];
  const resA = await createRecords(
    { deal, role: "lead", predecessors: [], banks, transfers: [{ amount: 1, from_account: logo.holding, to_account: bobLogo.hash }], docs: [bobLogo.body] },
    ctx(store, bA, alice.pub),
  ) as { records: Array<Record<string, unknown>> };
  const resB = await createRecords(
    { deal, role: "follow", predecessors: [bA.pub], banks, transfers: [{ amount: 1, from_account: hour.holding, to_account: aliceHour.hash }], docs: [aliceHour.body] },
    ctx(store, bB, alice.pub),
  ) as { records: Array<Record<string, unknown>> };

  // Records carry mandatory pair refs set by the bank.
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

  // Alice signs ATx as lead and presents it to Abank and Bbank.
  for (const bank of [bA, bB]) {
    await submitTx({ tx: aTx.tx, holder_sig: holderSig(alice, aTx.txHash, "lead") }, ctx(store, bank, alice.pub));
  }
  // Neither leg can be approved yet — Bob hasn't authorized his records.
  eq(store.legs.get(k(bA.pub, deal))!.state, "created", "Abank leg before BTx");

  // Bob signs BTx as follow and presents it to both banks (relayed by Alice).
  for (const bank of [bA, bB]) {
    await submitTx({ tx: bTx.tx, holder_sig: holderSig(bob, bTx.txHash, "follow") }, ctx(store, bank, alice.pub));
  }

  // Both banks approved + held on their own. Without fan-out or relay:
  // the lead won't settle (no peer hold seen), the follow won't settle
  // (no predecessor settle seen) — the stall IS the safety property.
  eq(store.legs.get(k(bA.pub, deal))!.state, "held", "Abank stalls at held without relay");
  eq(store.legs.get(k(bB.pub, deal))!.state, "held", "Bbank stalls at held without relay");

  // Client relays Bbank's signatures (incl. its hold) to Abank → lead settles.
  await relay(store, bB, bA, deal, alice);
  eq(store.legs.get(k(bA.pub, deal))!.state, "settled", "Abank settles after seeing Bbank hold");

  // Client relays Abank's signatures (incl. its settle) to Bbank → follow settles.
  await relay(store, bA, bB, deal, alice);
  eq(store.legs.get(k(bB.pub, deal))!.state, "settled", "Bbank settles after Abank settle");

  // Bbank's settle cites Abank's settle in seen — the proof chain.
  const view = await getDeal({ deal }, ctx(store, bB, alice.pub)) as { signatures: Array<Record<string, unknown>> };
  const bSettle = view.signatures.find((s) => s.action === "settle" && s.pubkey === bB.pub)!;
  const aSettle = view.signatures.find((s) => s.action === "settle" && s.pubkey === bA.pub)!;
  assert(((bSettle.seen as string[]) ?? []).includes(hashDoc(aSettle)), "Bbank settle must cite Abank settle");

  // The walkthrough's final balance grid.
  const bal = (bank: Key, acct: string) => Number(store.accounts.get(k(bank.pub, acct))!.balance);
  eq(bal(bA, logo.issue), -1, "Alice issue logo");
  eq(bal(bA, logo.holding), 0, "Alice holding logo");
  eq(bal(bA, bobLogo.hash), 1, "Bob logo");
  eq(bal(bB, hour.issue), -1, "Bob issue hour");
  eq(bal(bB, hour.holding), 0, "Bob holding hour");
  eq(bal(bB, aliceHour.hash), 1, "Alice hour");
  for (const h of store.holds.values()) assert(!h.active, "all holds released");
});

Deno.test("insufficient non-issuer balance draws a per-record reject; reject_deal unwinds", async () => {
  const store = new Store();
  const alice = key(), bob = key();
  const bB = key();

  // Bob mints 1 hour; Alice ends up holding 1 via a settled mini-deal.
  const hour = await mint(store, bB, bob, "1 hour", 1);
  const aliceHour = accountDoc(alice, hour.voucherHash, "main");

  // Simple single-bank transfer Bob → Alice of 1 hour, both sign, settles.
  const deal1 = newUlid();
  const r1 = await createRecords(
    { deal: deal1, role: "lead", predecessors: [], banks: [bB.pub], transfers: [{ amount: 1, from_account: hour.holding, to_account: aliceHour.hash }], docs: [aliceHour.body] },
    ctx(store, bB, bob.pub),
  ) as { records: Array<Record<string, unknown>> };
  const built1 = buildDeal(
    { deal: deal1, initiator: bob.pub, leadBanks: [bB.pub], transfers: [
      { voucher: hour.voucherHash, issuerBank: bB.pub, amount: 1, from: { holder: bob.pub, account: hour.holding }, to: { holder: alice.pub, account: aliceHour.hash } },
    ] },
    { [bB.pub]: r1.records.map((r) => r.ulid as string) },
  );
  for (const plan of built1.holderTxs) {
    const u = plan.holder === bob.pub ? bob : alice;
    await submitTx({ tx: plan.tx, holder_sig: holderSig(u, plan.txHash, plan.role) }, ctx(store, bB, bob.pub));
  }
  eq(store.legs.get(k(bB.pub, deal1))!.state, "settled", "single-bank deal settles by itself");
  eq(Number(store.accounts.get(k(bB.pub, aliceHour.hash))!.balance), 1, "Alice holds 1 hour");

  // Now Alice (non-issuer, balance 1) tries to give Bob 2 hours.
  const deal2 = newUlid();
  const r2 = await createRecords(
    { deal: deal2, role: "lead", predecessors: [], banks: [bB.pub], transfers: [{ amount: 2, from_account: aliceHour.hash, to_account: hour.holding }] },
    ctx(store, bB, alice.pub),
  ) as { records: Array<Record<string, unknown>> };
  const built2 = buildDeal(
    { deal: deal2, initiator: alice.pub, leadBanks: [bB.pub], transfers: [
      { voucher: hour.voucherHash, issuerBank: bB.pub, amount: 2, from: { holder: alice.pub, account: aliceHour.hash }, to: { holder: bob.pub, account: hour.holding } },
    ] },
    { [bB.pub]: r2.records.map((r) => r.ulid as string) },
  );
  const alicePlan = built2.holderTxs.find((h) => h.holder === alice.pub)!;
  const res = await submitTx(
    { tx: alicePlan.tx, holder_sig: holderSig(alice, alicePlan.txHash, "lead") },
    ctx(store, bB, alice.pub),
  ) as { record_sigs: Array<Record<string, unknown>>; leg_state: string };

  const rejectSig = res.record_sigs.find((s) => s.action === "reject");
  assert(rejectSig !== undefined, "over-balance debit must draw a reject signature");
  assert(String(rejectSig!.reason).includes("insufficient"), "reject carries a reason");
  eq(res.leg_state, "created", "leg never approves with a rejected record");

  // Unwind. No holds were ever taken; the leg just dies.
  const rej = await rejectDeal({ deal: deal2, reason: "abandoning" }, ctx(store, bB, alice.pub)) as { state: string };
  eq(rej.state, "rejected", "reject_deal marks the leg rejected");
  eq(Number(store.accounts.get(k(bB.pub, aliceHour.hash))!.balance), 1, "balances untouched");
});
