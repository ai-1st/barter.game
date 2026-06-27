import {
  getRecord,
  listActiveDeals,
  storePeerSettleSig,
  storeSignature,
} from '../db.ts';
import { validateSignature, verifyDoc } from '@barter.game/protocol';
import type { Bank } from '../types.ts';
import { RpcError } from '../error.ts';
import { advanceDeal } from '../advance.ts';

export async function notifySignatures(
  bank: Bank,
  params: Record<string, unknown>,
  _sender: string,
): Promise<unknown> {
  const sigsRaw = params.signatures;
  if (!Array.isArray(sigsRaw)) {
    throw new RpcError(-32602, 'signatures array required');
  }
  const stored: string[] = [];
  const touchedDeals = new Set<string>();
  let gotPeerSettle = false;
  for (const raw of sigsRaw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
    try {
      const sig = validateSignature(raw);
      if (!sig.sig || !verifyDoc(raw, sig.sig, sig.pubkey)) {
        continue;
      }
      const h = await storeSignature(bank, sig);
      stored.push(h);
      if (sig.hash) {
        const rec = await getRecord(bank, sig.hash);
        if (rec) {
          touchedDeals.add(rec.details.deal_id);
        } else if (sig.action === 'settle') {
          // Foreign lead-bank settle signature: store so follow banks can cite it.
          await storePeerSettleSig(bank, sig);
          gotPeerSettle = true;
        }
      }
    } catch {
      // skip invalid entries
    }
  }

  // If we received a foreign settle signature, it may unblock follow records in
  // any active deal where that signer is a lead bank. Advance all active deals.
  if (gotPeerSettle) {
    const active = await listActiveDeals(bank);
    for (const dealId of active) touchedDeals.add(dealId);
  }

  const advanced: string[] = [];
  for (const dealId of touchedDeals) {
    try {
      await advanceDeal(bank, dealId);
      advanced.push(dealId);
    } catch {
      // continue
    }
  }
  return { stored, advanced };
}
