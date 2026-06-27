import { storeSubscription } from '../db.ts';
import { validateSubscription, verifyDoc } from '@barter.game/protocol';
import type { Bank } from '../types.ts';
import { RpcError } from '../error.ts';

export async function subscribe(
  bank: Bank,
  params: Record<string, unknown>,
  sender: string,
): Promise<unknown> {
  const sub = params.subscription;
  if (!sub || typeof sub !== 'object' || Array.isArray(sub)) {
    throw new RpcError(-32602, 'subscription doc required');
  }
  const doc = validateSubscription(sub);
  if (doc.pubkey !== sender) {
    throw new RpcError(-32001, 'subscription pubkey must match sender');
  }
  if (!doc.sig || !verifyDoc(doc, doc.sig, doc.pubkey)) {
    throw new RpcError(-32001, 'invalid subscription signature');
  }
  const hash = await storeSubscription(bank, doc);
  return { stored: hash };
}
