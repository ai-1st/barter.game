// Subscription fan-out: banks push the signatures they create to watchers.
//
// Run: deno test --allow-read --allow-write apps/bank/test-deno/subscription.deno-test.ts

import { hashDoc, newUlid, signDoc, verifyDoc } from "../../../packages/protocol/src/index.ts";
import { mintVoucher } from "../handlers/mint_voucher.ts";
import { createRecords } from "../handlers/create_records.ts";
import { submitTx } from "../handlers/submit_tx.ts";
import { subscribe } from "../handlers/subscribe.ts";
import { assert, closeTestKv, ctx, eq, installFetchRouter, key, openTestKv, type Key } from "./helpers.ts";

function accountDoc(holder: Key, voucherHash: string, pocketName: string) {
  return {
    type: "account",
    holder: holder.pub,
    pocket: hashDoc({ type: "pocket", pubkey: holder.pub, ulid: newUlid(), name: pocketName }),
    voucher: voucherHash,
  };
}

Deno.test("fan-out pushes bank-signed notify envelopes to watchers; expiry and failures are harmless", async () => {
  const tk = await openTestKv();
  try {
    const bank = key(), alice = key(), bob = key();
    const pushLog: Array<{ url: string; envelope: Record<string, unknown> }> = [];
    const restoreFetch = installFetchRouter(tk.kv, new Map(), pushLog);

    try {
      const voucher: Record<string, unknown> = {
        type: "voucher", pubkey: alice.pub, ulid: newUlid(), bank: bank.pub, name: "1 logo",
      };
      const voucherHash = hashDoc(voucher);

      const issue = accountDoc(alice, voucherHash, "issue");
      const holding = accountDoc(alice, voucherHash, "holding");
      const bobAccount = accountDoc(bob, voucherHash, "main");
      await mintVoucher(
        { voucher, debit_account: issue, credit_account: holding, amount: 1 },
        ctx(tk.kv, bank, alice.pub),
      );

      const createRes = await createRecords(
        {
          requests: [{ type: "transfer", voucher_hash: voucherHash, amount: 1, debit_account_hash: hashDoc(holding), credit_account_hash: hashDoc(bobAccount) }],
          docs: [bobAccount],
        },
        ctx(tk.kv, bank, alice.pub),
      ) as { records: Array<Record<string, unknown>> };
      const recordHash = hashDoc(createRes.records[0]);

      const aliceUrl = "https://alice-client.test/notify";
      await subscribe(
        {
          subscription: {
            type: "subscription", pubkey: alice.pub, ulid: newUlid(),
            hashes: [recordHash], url: aliceUrl,
          },
        },
        ctx(tk.kv, bank, alice.pub),
      );

      const deadUrl = "https://dead.test/notify";
      await subscribe(
        {
          subscription: {
            type: "subscription", pubkey: alice.pub, ulid: newUlid(),
            hashes: [recordHash], url: deadUrl, until: "2020-01-01",
          },
        },
        ctx(tk.kv, bank, alice.pub),
      );

      const tx: Record<string, unknown> = {
        type: "tx", pubkey: alice.pub, ulid: newUlid(), records: [recordHash],
      };
      const txHash = hashDoc(tx);
      const holderSig: Record<string, unknown> = {
        type: "signature", pubkey: alice.pub, ulid: newUlid(), hash: txHash, action: "lead",
      };
      holderSig.sig = signDoc(holderSig, alice.priv);

      await submitTx({ tx, holder_signature: holderSig }, ctx(tk.kv, bank, alice.pub));

      const toAlice = pushLog.filter((p) => p.url === aliceUrl);
      eq(toAlice.length >= 1, true, "at least one push to the live subscription");
      eq(pushLog.filter((p) => p.url === deadUrl).length, 0, "expired subscription not notified");

      const env = toAlice[0].envelope;
      eq(env.method, "notify_signatures", "envelope method");
      eq(env.pubkey, bank.pub, "envelope sender is the bank");
      eq(env.to, alice.pub, "envelope target is the subscriber");
      assert(verifyDoc(env, env.sig as string, bank.pub), "envelope must verify against the bank key");
      const sigs = (env.params as { signatures: Array<Record<string, unknown>> }).signatures;
      assert(
        sigs.some((s) => s.hash === recordHash && (s.action === "ready" || s.action === "settle")),
        "pushed batch contains a signature on the watched record",
      );
    } finally {
      restoreFetch();
    }
  } finally {
    await closeTestKv(tk);
  }
});
