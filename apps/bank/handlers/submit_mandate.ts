import { getMandate, getRecord, storeMandate } from '../db.ts';
import { validateMandate, verifyDoc } from '@barter.game/protocol';
import type { Bank } from '../types.ts';
import { RpcError } from '../error.ts';
import { advanceDeal } from '../advance.ts';

// submit_mandate validates and executes one per-(deal, order) Mandate — the
// coordinator's unit of work. The coordinator passes the signed Mandate (the
// record bodies it lists were already stored by create_records, so they are
// verified by hash). The coordinator binding (details.coordinator ==
// mandate.pubkey) means only the coordinator that created the records can
// advance them, so knowing a deal_id is not enough.
export async function submitMandate(
  bank: Bank,
  params: Record<string, unknown>,
  _sender: string,
): Promise<unknown> {
  const raw = params.mandate;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RpcError(-32602, 'mandate doc required');
  }
  const mandate = validateMandate(raw);
  if (mandate.bank !== bank.pubkey) {
    throw new RpcError(-32000, 'mandate bank mismatch');
  }
  if (!mandate.sig || !verifyDoc(raw, mandate.sig, mandate.pubkey)) {
    throw new RpcError(-32001, 'invalid mandate signature');
  }

  // Reject a duplicate Mandate for the same (deal, order); idempotent reply.
  const existing = await getMandate(bank, mandate.deal_id, mandate.order);
  if (existing) {
    return {
      mandated: true,
      deal_id: mandate.deal_id,
      order: mandate.order,
      records: mandate.records,
    };
  }

  // Every listed record must be one this bank created for this deal, authorized
  // by mandate.order, and sealed with this coordinator.
  for (const h of mandate.records) {
    const rec = await getRecord(bank, h);
    if (!rec) throw new RpcError(-32005, `unknown record ${h}`);
    if (rec.details.deal_id !== mandate.deal_id) {
      throw new RpcError(-32000, `record ${h} not in deal ${mandate.deal_id}`);
    }
    if (rec.details.coordinator !== mandate.pubkey) {
      throw new RpcError(-32001, `record ${h} not bound to this coordinator`);
    }
    if (rec.doc.order !== mandate.order) {
      throw new RpcError(-32000, `record ${h} not authorized by order ${mandate.order}`);
    }
  }

  await storeMandate(bank, mandate);
  await advanceDeal(bank, mandate.deal_id);

  return {
    mandated: true,
    deal_id: mandate.deal_id,
    order: mandate.order,
    records: mandate.records,
  };
}
