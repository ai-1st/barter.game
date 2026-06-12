// In-memory integration test for the direct-approval N-party flow.
//
// Drives the real bank handlers (mint_promise → create_records → submit_tx,
// with banks self-advancing through hold and settle via subscription
// fan-out) across FOUR simulated banks, exercising the exact
// branching/merging deal from PROTOCOL.md §2:
//
//   A → C   B → C   C → D   D → A   D → B      leads: {bank-A, bank-B}
//
// Everyone's balance starts from a real mint (mint = the first ledger
// record pair: issue account negative, holding account positive). The
// initiator cross-subscribes the banks to each other, each holder submits
// their own signed Tx, and the banks cascade to settled on their own — the
// test never calls a hold or settle method, because none exists.
//
// Run: deno test --allow-read supabase/functions/_shared/bank/test-deno/nparty.deno-test.ts

import { hashDoc, newUlid, signDoc } from "../../protocol/crypto.ts";
import { buildDeal, type TransferSpec } from "../../protocol/deal.ts";
import { mintPromise } from "../handlers/mint_promise.ts";
import { createRecords } from "../handlers/create_records.ts";
import { submitTx } from "../handlers/submit_tx.ts";
import { subscribe } from "../handlers/subscribe.ts";
import {
  assert,
  bankUrl,
  ctx,
  eq,
  installFetchRouter,
  k,
  key,
  Store,
  type Key,
} from "./_harness.ts";

function accountDoc(holder: Key, promiseHash: string, pocketName: string) {
  const body: Record<string, unknown> = {
    type: "account",
    pubkey: holder.pub,
    ulid: newUlid(),
    pocket: hashDoc({ type: "pocket", pubkey: holder.pub, ulid: newUlid(), name: pocketName }),
    promise: promiseHash,
  };
  return { body, hash: hashDoc(body) };
}

async function mint(store: Store, bank: Key, issuer: Key, name: string, amount: number) {
  const promise: Record<string, unknown> = {
    type: "promise", pubkey: issuer.pub, ulid: newUlid(), bank: bank.pub, name,
  };
  const promiseHash = hashDoc(promise);
  const issue = accountDoc(issuer, promiseHash, "issue");
  const holding = accountDoc(issuer, promiseHash, "holding");
  const res = await mintPromise(
    { promise, debit_account: issue.body, credit_account: holding.body, amount },
    ctx(store, bank, issuer.pub),
  ) as { promise_hash: string; debit_account_hash: string; credit_account_hash: string };
  return { promiseHash: res.promise_hash, issue: res.debit_account_hash, holding: res.credit_account_hash };
}

Deno.test("N-party deal: banks self-advance to settled, balances sum to zero", async () => {
  const store = new Store();
  const A = key(), B = key(), C = key(), D = key();                 // users
  const bA = key(), bB = key(), bC = key(), bD = key();             // banks
  const bankByPub = new Map([[bA.pub, bA], [bB.pub, bB], [bC.pub, bC], [bD.pub, bD]]);
  const nameByPub = new Map([[bA.pub, "bankA"], [bB.pub, "bankB"], [bC.pub, "bankC"], [bD.pub, "bankD"]]);
  const banksByUrl = new Map([...bankByPub].map(([pub, bk]) => [bankUrl(nameByPub.get(pub)!), bk]));
  const restoreFetch = installFetchRouter(store, banksByUrl);

  try {
    // Everyone mints their own coin — mint IS the first record pair.
    const coinA = await mint(store, bA, A, "A-coin", 1);
    const coinB = await mint(store, bB, B, "B-coin", 1);
    const coinC = await mint(store, bC, C, "C-coin", 2);
    const coinD = await mint(store, bD, D, "D-coin", 2);

    // Receiver accounts exist only as client-side docs; they reach each bank
    // implicitly via create_records docs[].
    const accC_A = accountDoc(C, coinA.promiseHash, "main"); // C receives A-coin at bankA
    const accC_B = accountDoc(C, coinB.promiseHash, "main");
    const accD_C = accountDoc(D, coinC.promiseHash, "main");
    const accA_D = accountDoc(A, coinD.promiseHash, "main");
    const accB_D = accountDoc(B, coinD.promiseHash, "main");

    const transfers: TransferSpec[] = [
      { promise: coinA.promiseHash, issuerBank: bA.pub, amount: 1, from: { holder: A.pub, account: coinA.holding }, to: { holder: C.pub, account: accC_A.hash } },
      { promise: coinB.promiseHash, issuerBank: bB.pub, amount: 1, from: { holder: B.pub, account: coinB.holding }, to: { holder: C.pub, account: accC_B.hash } },
      { promise: coinC.promiseHash, issuerBank: bC.pub, amount: 2, from: { holder: C.pub, account: coinC.holding }, to: { holder: D.pub, account: accD_C.hash } },
      { promise: coinD.promiseHash, issuerBank: bD.pub, amount: 1, from: { holder: D.pub, account: coinD.holding }, to: { holder: A.pub, account: accA_D.hash } },
      { promise: coinD.promiseHash, issuerBank: bD.pub, amount: 1, from: { holder: D.pub, account: coinD.holding }, to: { holder: B.pub, account: accB_D.hash } },
    ];
    const docsByBank = new Map<string, Array<Record<string, unknown>>>([
      [bA.pub, [accC_A.body]],
      [bB.pub, [accC_B.body]],
      [bC.pub, [accD_C.body]],
      [bD.pub, [accA_D.body, accB_D.body]],
    ]);

    // Build the deal client-side first (we need legs/order before create_records,
    // but record ULIDs only after) — so: compute topology from a dry spec, then
    // create records per bank, then build the full deal.
    const deal = newUlid();
    const spec = { deal, initiator: A.pub, leadBanks: [bA.pub, bB.pub], transfers };

    // Phase 0: create_records on every bank with its own transfers + docs.
    const order = [bA.pub, bB.pub, bC.pub, bD.pub];
    const preds: Record<string, string[]> = {
      [bA.pub]: [], [bB.pub]: [], [bC.pub]: [bA.pub, bB.pub], [bD.pub]: [bC.pub],
    };
    const bankRecordUlids: Record<string, string[]> = {};
    for (const bankPub of order) {
      const btransfers = transfers
        .filter((t) => t.issuerBank === bankPub)
        .map((t) => ({ amount: t.amount, from_account: t.from.account, to_account: t.to.account }));
      const res = await createRecords(
        {
          deal,
          role: preds[bankPub].length === 0 ? "lead" : "follow",
          predecessors: preds[bankPub],
          banks: order,
          transfers: btransfers,
          docs: docsByBank.get(bankPub)!,
        },
        ctx(store, bankByPub.get(bankPub)!, A.pub),
      ) as { records: Array<Record<string, unknown>> };
      bankRecordUlids[bankPub] = res.records.map((r) => r.ulid as string);
    }

    const built = buildDeal(spec, bankRecordUlids);
    // Cross-check: client-computed legs match what we told the banks.
    for (const leg of built.legs) {
      eq(JSON.stringify(leg.predecessors.slice().sort()), JSON.stringify(preds[leg.bank].slice().sort()), `predecessors for ${leg.bank}`);
    }

    // Subscriptions: the initiator cross-subscribes the banks to each other.
    for (const bankPub of order) {
      for (const peerPub of order) {
        if (peerPub === bankPub) continue;
        const sub: Record<string, unknown> = {
          type: "subscription",
          pubkey: A.pub,
          ulid: newUlid(),
          deals: [deal],
          url: bankUrl(nameByPub.get(peerPub)!),
          to: peerPub,
        };
        await subscribe({ subscription: sub }, ctx(store, bankByPub.get(bankPub)!, A.pub));
      }
    }

    // Wave 1 — direct approval: each holder signs THEIR OWN Tx and submits
    // it (here the initiator relays everyone's). Banks do the rest.
    const users = new Map([[A.pub, A], [B.pub, B], [C.pub, C], [D.pub, D]]);
    for (const plan of built.holderTxs) {
      const holder = users.get(plan.holder)!;
      const holderSig: Record<string, unknown> = {
        type: "signature",
        pubkey: holder.pub,
        ulid: newUlid(),
        hash: plan.txHash,
        action: plan.role,
      };
      holderSig.sig = signDoc(holderSig, holder.priv);
      for (const bankPub of plan.banks) {
        await submitTx(
          { tx: plan.tx, holder_sig: holderSig },
          ctx(store, bankByPub.get(bankPub)!, A.pub), // initiator relays — sender ≠ holder is fine
        );
      }
    }

    // No client hold/settle calls — the banks must have cascaded on their own.
    for (const bankPub of order) {
      const leg = store.legs.get(k(bankPub, deal))!;
      eq(leg.state, "settled", `leg state at ${nameByPub.get(bankPub)}`);
    }

    // seen-chain: bank-C cites both leads' settles; bank-D cites bank-C's.
    const settleOf = (bank: Key) => {
      for (const [mapKey, d] of store.docs) {
        if (!mapKey.startsWith(`${bank.pub}|`)) continue;
        const b = d.body as Record<string, unknown>;
        if (d.type === "signature" && b.pubkey === bank.pub && b.action === "settle" && b.deal === deal) return b;
      }
      throw new Error(`no settle by ${nameByPub.get(bank.pub)}`);
    };
    const cSeen = (settleOf(bC).seen as string[]) ?? [];
    eq(cSeen.length, 2, "bank-C settle.seen length");
    assert(cSeen.includes(hashDoc(settleOf(bA))) && cSeen.includes(hashDoc(settleOf(bB))), "bank-C must cite both leads");
    const dSeen = (settleOf(bD).seen as string[]) ?? [];
    eq(dSeen.length, 1, "bank-D settle.seen length");
    assert(dSeen.includes(hashDoc(settleOf(bC))), "bank-D must cite bank-C");

    // Final balances: issue accounts stay negative, holdings drained, receivers paid.
    const bal = (bank: Key, acct: string) => Number(store.accounts.get(k(bank.pub, acct))!.balance);
    eq(bal(bA, coinA.issue), -1, "A's A-coin issue");
    eq(bal(bA, coinA.holding), 0, "A's A-coin holding");
    eq(bal(bA, accC_A.hash), 1, "C's A-coin");
    eq(bal(bB, coinB.issue), -1, "B's B-coin issue");
    eq(bal(bB, coinB.holding), 0, "B's B-coin holding");
    eq(bal(bB, accC_B.hash), 1, "C's B-coin");
    eq(bal(bC, coinC.issue), -2, "C's C-coin issue");
    eq(bal(bC, coinC.holding), 0, "C's C-coin holding");
    eq(bal(bC, accD_C.hash), 2, "D's C-coin");
    eq(bal(bD, coinD.issue), -2, "D's D-coin issue");
    eq(bal(bD, coinD.holding), 0, "D's D-coin holding");
    eq(bal(bD, accA_D.hash), 1, "A's D-coin");
    eq(bal(bD, accB_D.hash), 1, "B's D-coin");

    // sum invariant per promise = 0
    eq(bal(bA, coinA.issue) + bal(bA, coinA.holding) + bal(bA, accC_A.hash), 0, "A-coin sum");
    eq(bal(bB, coinB.issue) + bal(bB, coinB.holding) + bal(bB, accC_B.hash), 0, "B-coin sum");
    eq(bal(bC, coinC.issue) + bal(bC, coinC.holding) + bal(bC, accD_C.hash), 0, "C-coin sum");
    eq(bal(bD, coinD.issue) + bal(bD, coinD.holding) + bal(bD, accA_D.hash) + bal(bD, accB_D.hash), 0, "D-coin sum");

    // all holds released
    for (const h of store.holds.values()) assert(!h.active, "a hold was left active after settle");
  } finally {
    restoreFetch();
  }
});
