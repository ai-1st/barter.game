// subscribe — any party → a bank.
//
// The initiating party sends Subscription docs to the banks in a deal; each
// bank uses them to fan out the Signature docs it creates (per-record
// approvals, holds, settles, rejects) to the subscription's url. The
// topology is the client's choice: cross-subscribe the banks to each other
// (bank-to-bank push), subscribe only yourself (client relay), or any mix.

import { hashDoc, validateSubscription } from "../../../packages/protocol/src/index.ts";
import { RpcError, RpcErrors, type Handler } from "../rpc.ts";

const DEFAULT_TTL_DAYS = 7;

type SubscribeParams = { subscription: Record<string, unknown> };

export const subscribe: Handler = async (params, ctx) => {
  const p = params as SubscribeParams;
  if (!p.subscription) {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.subscription required");
  }
  try {
    validateSubscription(p.subscription);
  } catch (err) {
    throw new RpcError(RpcErrors.VALIDATION, err instanceof Error ? err.message : "subscription invalid");
  }
  const sub = p.subscription as {
    pubkey: string;
    records?: string[];
    hashes?: string[];
    deals?: string[];
    url: string;
    to?: string;
    until?: string;
  };
  if (sub.pubkey !== ctx.senderPubkey) {
    throw new RpcError(RpcErrors.VALIDATION, "subscription.pubkey must equal the request sender (the creator)");
  }

  const subscriptionHash = hashDoc(p.subscription);
  await ctx.db.insertDoc({
    hash: subscriptionHash,
    type: "subscription",
    pubkey: sub.pubkey,
    body: p.subscription,
  });

  const watchKeys = [...(sub.records ?? []), ...(sub.hashes ?? []), ...(sub.deals ?? [])];
  const until = sub.until ??
    new Date(Date.now() + DEFAULT_TTL_DAYS * 24 * 3600 * 1000).toISOString().slice(0, 10);
  await ctx.db.insertSubscription({
    subscriptionHash,
    subscriberPubkey: sub.to ?? sub.pubkey, // delivery target behind url
    url: sub.url,
    until,
    watchKeys,
  });

  return { subscription_hash: subscriptionHash, watching: watchKeys.length, until };
};
