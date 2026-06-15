// In-memory integration test for the direct-approval N-party flow.
//
// Drives the real bank handlers (mint_promise → create_records → submit_tx,
// with banks self-advancing through hold and settle) across FOUR simulated
// banks, exercising the branching/merging deal:
//
//   A → C   B → C   C → D   D → A   D → B
//
// Run: deno test --allow-read --allow-write apps/bank/test-deno/nparty.deno-test.ts

import { hashDoc, newUlid, signDoc } from "../../../packages/protocol/src/index.ts";
import { buildDeal, type TransferSpec } from "../../../packages/protocol/src/deal.ts";
import { mintPromise } from "../handlers/mint_promise.ts";
import { createRecords } from "../handlers/create_records.ts";
import { submitTx } from "../handlers/submit_tx.ts";
import { subscribe } from "../handlers/subscribe.ts";
import { assert, bankUrl, closeTestKv, ctx, eq, installFetchRouter, key, openTestKv, type Key } from "./helpers.ts";

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
  const promiseHash = hashDoc(promise);
  const issue = accountDoc(issuer, promiseHash, "issue");
  const holding = accountDoc(issuer, promiseHash, "holding");
  const res = await mintPromise(
    { promise, debit_account: issue.body, credit_account: holding.body, amount },
    ctx(store.kv, bank, issuer.pub),
  ) as { promise_hash: string; debit_account_hash: string; credit_account_hash: string };
  return { promiseHash: res.promise_hash, issue: res.debit_account_hash, holding: res.credit_account_hash };
}

Deno.test("N-party deal: banks self-advance to settled, balances sum to zero", async () => {
  const tk = await openTestKv();
  try {
    const A = key(), B = key(), C = key(), D = key();
    const bA = key(), bB = key(), bC = key(), bD = key();
    const bankByPub = new Map([[bA.pub, bA], [bB.pub, bB], [bC.pub, bC], [bD.pub, bD]]);
    const nameByPub = new Map([[bA.pub, "bankA"], [bB.pub, "bankB"], [bC.pub, "bankC"], [bD.pub, "bankD"]]);
    const banksByUrl = new Map([...bankByPub].map(([pub, bk]) => [bankUrl(nameByPub.get(pub)!), bk]));
    const restoreFetch = installFetchRouter(tk.kv, banksByUrl);

    try {
      const coinA = await mint(tk, bA, A, "A-coin", 1);
      const coinB = await mint(tk, bB, B, "B-coin", 1);
      const coinC = await mint(tk, bC, C, "C-coin", 2);
      const coinD = await mint(tk, bD, D, "D-coin", 2);

      const accC_A = accountDoc(C, coinA.promiseHash, "main");
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

      const spec = { initiator: A.pub, transfers };
      const order = [bA.pub, bB.pub, bC.pub, bD.pub];

      const recordsByBank: Record<string, Array<Record<string, unknown>>> = {};
      for (const bankPub of order) {
        const btransfers = transfers.filter((t) => t.issuerBank === bankPub);
        const requests = btransfers.map((t) => ({
          type: "transfer" as const,
          promise_hash: t.promise,
          amount: t.amount,
          debit_account_hash: t.from.account,
          credit_account_hash: t.to.account,
        }));
        const res = await createRecords(
          { requests, docs: docsByBank.get(bankPub)! },
          ctx(tk.kv, bankByPub.get(bankPub)!, A.pub),
        ) as { records: Array<Record<string, unknown>> };
        recordsByBank[bankPub] = res.records;
      }

      const built = buildDeal(
        spec,
        { [bA.pub]: recordsByBank[bA.pub] as never, [bB.pub]: recordsByBank[bB.pub] as never, [bC.pub]: recordsByBank[bC.pub] as never, [bD.pub]: recordsByBank[bD.pub] as never },
      );

      const allRecordHashes = new Set<string>();
      for (const recs of Object.values(recordsByBank)) {
        for (const r of recs) allRecordHashes.add(hashDoc(r));
      }

      // Cross-subscribe every bank to every record hash so signatures fan out
      // across the whole graph. In production the coordinator would choose a
      // sparser topology.
      for (const bankPub of order) {
        for (const peerPub of order) {
          if (peerPub === bankPub) continue;
          const sub: Record<string, unknown> = {
            type: "subscription",
            pubkey: A.pub,
            ulid: newUlid(),
            hashes: [...allRecordHashes],
            url: bankUrl(nameByPub.get(peerPub)!),
            to: peerPub,
          };
          await subscribe({ subscription: sub }, ctx(tk.kv, bankByPub.get(bankPub)!, A.pub));
        }
      }

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
            { tx: plan.tx, holder_signature: holderSig },
            ctx(tk.kv, bankByPub.get(bankPub)!, A.pub),
          );
        }
      }

      // Every record at every bank should be settled.
      for (const bankPub of order) {
        for (const r of recordsByBank[bankPub]) {
          const hash = hashDoc(r);
          const row = await ctx(tk.kv, bankByPub.get(bankPub)!, A.pub).db.getRecord(hash);
          eq(row?.status, "settle", `record ${hash.slice(0, 8)} at ${nameByPub.get(bankPub)} must be settled`);
        }
      }

      const bal = async (bank: Key, acct: string) => Number((await ctx(tk.kv, bank, A.pub).db.getAccount(acct))?.balance);
      eq(await bal(bA, coinA.issue), -1, "A's A-coin issue");
      eq(await bal(bA, coinA.holding), 0, "A's A-coin holding");
      eq(await bal(bA, accC_A.hash), 1, "C's A-coin");
      eq(await bal(bB, coinB.issue), -1, "B's B-coin issue");
      eq(await bal(bB, coinB.holding), 0, "B's B-coin holding");
      eq(await bal(bB, accC_B.hash), 1, "C's B-coin");
      eq(await bal(bC, coinC.issue), -2, "C's C-coin issue");
      eq(await bal(bC, coinC.holding), 0, "C's C-coin holding");
      eq(await bal(bC, accD_C.hash), 2, "D's C-coin");
      eq(await bal(bD, coinD.issue), -2, "D's D-coin issue");
      eq(await bal(bD, coinD.holding), 0, "D's D-coin holding");
      eq(await bal(bD, accA_D.hash), 1, "A's D-coin");
      eq(await bal(bD, accB_D.hash), 1, "B's D-coin");

      eq(await bal(bA, coinA.issue) + await bal(bA, coinA.holding) + await bal(bA, accC_A.hash), 0, "A-coin sum");
      eq(await bal(bB, coinB.issue) + await bal(bB, coinB.holding) + await bal(bB, accC_B.hash), 0, "B-coin sum");
      eq(await bal(bC, coinC.issue) + await bal(bC, coinC.holding) + await bal(bC, accD_C.hash), 0, "C-coin sum");
      eq(await bal(bD, coinD.issue) + await bal(bD, coinD.holding) + await bal(bD, accA_D.hash) + await bal(bD, accB_D.hash), 0, "D-coin sum");

      const holds = [] as Array<{ active: boolean }>;
      for (const bankPub of order) {
        for await (const entry of tk.kv.list<{ active: boolean }>({ prefix: [bankPub, "holds"] })) holds.push(entry.value);
      }
      for (const h of holds) assert(!h.active, "a hold was left active after settle");
    } finally {
      restoreFetch();
    }
  } finally {
    await closeTestKv(tk);
  }
});
