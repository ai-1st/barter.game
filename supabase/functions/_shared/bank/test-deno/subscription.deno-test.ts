// Subscription fan-out: banks push the signatures they create to watchers.
//
// Run: deno test --allow-read supabase/functions/_shared/bank/test-deno/subscription.deno-test.ts

import { hashDoc, newUlid, verifyDoc } from "../../protocol/crypto.ts";
import { mintPromise } from "../handlers/mint_promise.ts";
import { subscribe } from "../handlers/subscribe.ts";
import { assert, ctx, eq, installFetchRouter, key, Store, type Key } from "./_harness.ts";

function accountDoc(holder: Key, promiseHash: string, pocketName: string) {
  return {
    type: "account",
    pubkey: holder.pub,
    ulid: newUlid(),
    pocket: hashDoc({ type: "pocket", pubkey: holder.pub, ulid: newUlid(), name: pocketName }),
    promise: promiseHash,
  };
}

Deno.test("fan-out pushes bank-signed notify envelopes to watchers; expiry and failures are harmless", async () => {
  const store = new Store();
  const bank = key(), alice = key();
  const pushLog: Array<{ url: string; envelope: Record<string, unknown> }> = [];
  // No banks behind any URL: every push 404s — must never fail the handler.
  const restoreFetch = installFetchRouter(store, new Map(), pushLog);

  try {
    // Alice knows her promise hash before minting (content-addressed), so she
    // can subscribe to it up front.
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
      ctx(store, bank, alice.pub),
    );

    // An EXPIRED subscription on the same key must not be notified.
    const deadUrl = "https://dead.test/notify";
    await subscribe(
      {
        subscription: {
          type: "subscription", pubkey: alice.pub, ulid: newUlid(),
          hashes: [promiseHash], url: deadUrl, until: "2020-01-01",
        },
      },
      ctx(store, bank, alice.pub),
    );

    // Mint — the bank creates signatures; the promise attestation targets
    // the watched hash.
    const res = await mintPromise(
      {
        promise,
        debit_account: accountDoc(alice, promiseHash, "issue"),
        credit_account: accountDoc(alice, promiseHash, "holding"),
        amount: 1,
      },
      ctx(store, bank, alice.pub),
    ) as { promise_hash: string };
    eq(res.promise_hash, promiseHash, "mint succeeded despite failing pushes");

    const toAlice = pushLog.filter((p) => p.url === aliceUrl);
    eq(toAlice.length, 1, "one push to the live subscription");
    eq(pushLog.filter((p) => p.url === deadUrl).length, 0, "expired subscription not notified");

    // The push is a bank-signed notify_signatures envelope addressed to the
    // delivery target.
    const env = toAlice[0].envelope;
    eq(env.method, "notify_signatures", "envelope method");
    eq(env.pubkey, bank.pub, "envelope sender is the bank");
    eq(env.to, alice.pub, "envelope target is the subscriber");
    assert(verifyDoc(env, env.sig as string, bank.pub), "envelope must verify against the bank key");
    const sigs = (env.params as { signatures: Array<Record<string, unknown>> }).signatures;
    assert(
      sigs.some((s) => s.hash === promiseHash && s.action === "approve"),
      "pushed batch contains the promise attestation",
    );
  } finally {
    restoreFetch();
  }
});
