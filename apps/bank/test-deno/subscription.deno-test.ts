// Subscription fan-out: banks push the signatures they create to watchers.
//
// Run: deno test --allow-read --allow-write apps/bank/test-deno/subscription.deno-test.ts

import { hashDoc, newUlid, verifyDoc } from "../../../packages/protocol/src/index.ts";
import { mintPromise } from "../handlers/mint_promise.ts";
import { subscribe } from "../handlers/subscribe.ts";
import { assert, closeTestKv, ctx, eq, installFetchRouter, key, openTestKv, type Key } from "./helpers.ts";

function accountDoc(holder: Key, promiseHash: string, pocketName: string) {
  return {
    type: "account",
    holder: holder.pub,
    pocket: hashDoc({ type: "pocket", pubkey: holder.pub, ulid: newUlid(), name: pocketName }),
    promise: promiseHash,
  };
}

Deno.test("fan-out pushes bank-signed notify envelopes to watchers; expiry and failures are harmless", async () => {
  const tk = await openTestKv();
  try {
    const bank = key(), alice = key();
    const pushLog: Array<{ url: string; envelope: Record<string, unknown> }> = [];
    const restoreFetch = installFetchRouter(tk.kv, new Map(), pushLog);

    try {
      const promise: Record<string, unknown> = {
        type: "promise", pubkey: alice.pub, ulid: newUlid(), bank: bank.pub, name: "1 logo",
      };
      const promiseHash = hashDoc(promise);
      const aliceUrl = "https://alice-client.test/notify";
      await subscribe(
        {
          subscription: {
            type: "subscription", pubkey: alice.pub, ulid: newUlid(),
            hashes: [promiseHash], url: aliceUrl,
          },
        },
        ctx(tk.kv, bank, alice.pub),
      );

      const deadUrl = "https://dead.test/notify";
      await subscribe(
        {
          subscription: {
            type: "subscription", pubkey: alice.pub, ulid: newUlid(),
            hashes: [promiseHash], url: deadUrl, until: "2020-01-01",
          },
        },
        ctx(tk.kv, bank, alice.pub),
      );

      const res = await mintPromise(
        {
          promise,
          debit_account: accountDoc(alice, promiseHash, "issue"),
          credit_account: accountDoc(alice, promiseHash, "holding"),
          amount: 1,
        },
        ctx(tk.kv, bank, alice.pub),
      ) as { promise_hash: string };
      eq(res.promise_hash, promiseHash, "mint succeeded despite failing pushes");

      const toAlice = pushLog.filter((p) => p.url === aliceUrl);
      eq(toAlice.length, 1, "one push to the live subscription");
      eq(pushLog.filter((p) => p.url === deadUrl).length, 0, "expired subscription not notified");

      const env = toAlice[0].envelope;
      eq(env.method, "notify_signatures", "envelope method");
      eq(env.pubkey, bank.pub, "envelope sender is the bank");
      eq(env.to, alice.pub, "envelope target is the subscriber");
      assert(verifyDoc(env, env.sig as string, bank.pub), "envelope must verify against the bank key");
      const sigs = (env.params as { signatures: Array<Record<string, unknown>> }).signatures;
      assert(
        sigs.some((s) => s.hash === promiseHash && s.action === "ack"),
        "pushed batch contains the promise ack attestation",
      );
    } finally {
      restoreFetch();
    }
  } finally {
    await closeTestKv(tk);
  }
});
