import { getConfirm, getRecord, listRecordsByDeal, storeConfirm } from '../db.ts';
import { hashDoc, validateConfirm, verifyDoc } from '@barter.game/protocol';
import type { Bank } from '../types.ts';
import { RpcError } from '../error.ts';
import { advanceDeal } from '../advance.ts';

export async function submitConfirm(
  bank: Bank,
  params: Record<string, unknown>,
  _sender: string,
): Promise<unknown> {
  const raw = params.confirm;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new RpcError(-32602, 'confirm doc required');
  }
  const confirm = validateConfirm(raw);
  if (confirm.bank !== bank.pubkey) {
    throw new RpcError(-32000, 'confirm bank mismatch');
  }
  if (!confirm.sig || !verifyDoc(raw, confirm.sig, confirm.pubkey)) {
    throw new RpcError(-32001, 'invalid confirm signature');
  }

  // Verify every record this bank created for the deal is listed.
  const existing = await getConfirm(bank, confirm.deal_id);
  if (existing) {
    return { confirmed: true, deal_id: confirm.deal_id, records: confirm.records };
  }

  for (const h of confirm.records) {
    const rec = await getRecord(bank, h);
    if (!rec) {
      throw new RpcError(-32005, `unknown record ${h}`);
    }
    if (rec.details.deal_id !== confirm.deal_id) {
      throw new RpcError(-32000, `record ${h} not in deal ${confirm.deal_id}`);
    }
  }
  const dealRecords = await listRecordsByDeal(bank, confirm.deal_id);
  for (const r of dealRecords) {
    const h = hashDoc(r.doc);
    if (!confirm.records.includes(h)) {
      throw new RpcError(-32000, `missing record ${h} in confirm`);
    }
  }

  await storeConfirm(bank, confirm);
  await advanceDeal(bank, confirm.deal_id);

  return { confirmed: true, deal_id: confirm.deal_id, records: confirm.records };
}
