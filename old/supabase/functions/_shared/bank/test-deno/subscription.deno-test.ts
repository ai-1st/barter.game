// Subscription fan-out: banks push the signatures they create to watchers.
//
// Run: deno test --allow-read supabase/functions/_shared/bank/test-deno/subscription.deno-test.ts

import { hashDoc, newUlid, verifyDoc } from "../../protocol/crypto.ts";
import { mintVoucher } from "../handlers/mint_voucher.ts";
import { subscribe } from "../handlers/subscribe.ts";
import { assert, ctx, eq, installFetchRouter, key, Store, type Key } from "./_harness.ts";

function accountDoc(holder: Key, voucherHash: string, pocketName: string) {
  return {
    type: "account",
    pubkey: holder.pub,
    ulid: newUlid(),
    pocket: hashDoc({ type: "pocket", pubkey: holder.pub, ulid: newUlid(), name: pocketName }),
    voucher: voucherHash,
  };
}

Deno.test("fan-out pushes bank-signed notify envelopes to watchers; expiry and failures are harmless", async () => {
  const store = new Store();
  const bank = key(), alice = key();
  const pushLog: Array<{ url: string; envelope: Record<string, unknown> }> = [];
  // No banks behind any URL: every push 404s — must never fail the handler.
  const restoreFetch = installFetchRouter(store, new Map(), pushLog);

  try {
    // Alice knows her voucher hash before minting (content-addressed), so she
    // can subscribe to it up front.
    const voucher: Record<string, unknown> = {
      type: "voucher", pubkey: alice.pub, ulid: newUlid(), bank: bank.pub, name: "1 logo",
    };
    const voucherHash = hashDoc(voucher);
    const aliceUrl = "https://alice-client.test/notify";
    await subscribe(
      {
        subscription: {
          type: "subscription", pubkey: alice.pub, ulid: newUlid(),
          hashes: [voucherHash], url: aliceUrl,
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
          hashes: [voucherHash], url: deadUrl, until: "2020-01-01",
        },
      },
      ctx(store, bank, alice.pub),
    );

    // Mint — the bank creates signatures; the voucher attestation targets
    // the watched hash.
    const res = await mintVoucher(
      {
        voucher,
        debit_account: accountDoc(alice, voucherHash, "issue"),
        credit_account: accountDoc(alice, voucherHash, "holding"),
        amount: 1,
      },
      ctx(store, bank, alice.pub),
    ) as { voucher_hash: string };
    eq(res.voucher_hash, voucherHash, "mint succeeded despite failing pushes");

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
      sigs.some((s) => s.hash === voucherHash && s.action === "approve"),
      "pushed batch contains the voucher attestation",
    );
  } finally {
    restoreFetch();
  }
});
