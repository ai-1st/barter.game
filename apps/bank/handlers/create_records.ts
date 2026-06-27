import {
  addOrderUsage,
  getAccount,
  getOffer,
  getOrder,
  getRecord,
  getVoucher,
  storeRecord,
} from '../db.ts';
import {
  hashDoc,
  newUlid,
  signDoc,
  verifyDoc,
  type Order,
  type BankRecord,
  type RecordDetails,
} from '@barter.game/protocol';
import type { Bank } from '../types.ts';
import { RpcError } from '../error.ts';

export async function createRecords(
  bank: Bank,
  params: Record<string, unknown>,
  _sender: string,
): Promise<unknown> {
  const offer1Raw = params.offer1;
  const offer2Raw = params.offer2;
  const dealId = params.deal_id;
  if (
    !offer1Raw ||
    typeof offer1Raw !== 'object' ||
    Array.isArray(offer1Raw) ||
    !offer2Raw ||
    typeof offer2Raw !== 'object' ||
    Array.isArray(offer2Raw) ||
    typeof dealId !== 'string'
  ) {
    throw new RpcError(-32602, 'offer1, offer2, deal_id required');
  }

  const o1 = parseOfferRef(offer1Raw as Record<string, unknown>);
  const o2 = parseOfferRef(offer2Raw as Record<string, unknown>);

  // Resolve each authorization reference to its underlying Order. The hash may
  // be an Order hash (canonical — the holder submits the same Order to every
  // bank its sides touch, so it resolves identically everywhere) or an Offer
  // hash (a per-bank derivation; only resolvable at its issuing bank).
  // Cross-bank matchmakers MUST pass Order hashes; same-bank flows may pass
  // either. The matchmaker discovers the Order hash from a published Offer's
  // `order` field.
  const a1 = await resolveAuth(bank, o1.hash);
  const a2 = await resolveAuth(bank, o2.hash);
  const order1 = a1.order;
  const order2 = a2.order;

  // Determine the local side and amount for each order (the side whose voucher
  // this bank issues). Both orders must contribute a side for this bank's
  // voucher — one gives (debit), one receives (credit).
  const local1 = localSide(order1, o1, bank.pubkey);
  const local2 = localSide(order2, o2, bank.pubkey);

  if (!local1 || !local2) {
    throw new RpcError(-32000, 'order does not reference this bank voucher');
  }

  if (local1.voucher !== local2.voucher) {
    throw new RpcError(-32000, 'local sides must be for the same voucher');
  }
  if (local1.amount !== local2.amount) {
    throw new RpcError(-32000, 'local amounts must match');
  }
  const amount = local1.amount;
  if (amount <= 0) {
    throw new RpcError(-32000, 'amount must be positive');
  }

  // Validate min/max constraints on each side.
  if (amount < local1.min || amount > local1.max) {
    throw new RpcError(-32000, 'amount outside order1 local min/max');
  }
  if (amount < local2.min || amount > local2.max) {
    throw new RpcError(-32000, 'amount outside order2 local min/max');
  }

  // Determine which order is debit vs credit for the local voucher. Records
  // reference the canonical Order hash so every bank resolves the same doc.
  const debitOrderRef = local1.side === 'debit' ? order1 : order2;
  const debitOrderHash = local1.side === 'debit' ? a1.orderHash : a2.orderHash;
  const creditOrderRef = local1.side === 'credit' ? order1 : order2;
  const creditOrderHash = local1.side === 'credit' ? a1.orderHash : a2.orderHash;

  if (!debitOrderRef.debit || !creditOrderRef.credit) {
    throw new RpcError(-32000, 'debit/credit side missing');
  }

  const voucher = await getVoucher(bank, local1.voucher);
  if (!voucher) throw new RpcError(-32005, 'voucher unknown');

  if (voucher.integer && !Number.isInteger(amount)) {
    throw new RpcError(-32000, 'integer voucher requires integer amount');
  }

  // Voucher.limit check against total issued.
  if (voucher.limit !== undefined) {
    const existing = await totalIssuedForVoucher(bank, local1.voucher);
    if (existing + amount > voucher.limit) {
      throw new RpcError(-32000, 'voucher limit exceeded');
    }
  }

  // Order cumulative limits.
  await checkOrderLimit(bank, debitOrderRef, 'debit', amount);
  await checkOrderLimit(bank, creditOrderRef, 'credit', amount);

  const pair = newUlid();

  const debitDetails: RecordDetails = {
    pair,
    deal_id: dealId,
    holder: debitOrderRef.pubkey,
    account: debitOrderRef.debit.account,
  };
  const creditDetails: RecordDetails = {
    pair,
    deal_id: dealId,
    holder: creditOrderRef.pubkey,
    account: creditOrderRef.credit.account,
  };

  const debitRecord: BankRecord = {
    type: 'debit',
    pubkey: bank.pubkey,
    ulid: newUlid(),
    amount,
    order: debitOrderHash,
    details: hashDoc(debitDetails),
    sig: '',
  };
  debitRecord.sig = signDoc(debitRecord, bank.privateKey);

  const creditRecord: BankRecord = {
    type: 'credit',
    pubkey: bank.pubkey,
    ulid: newUlid(),
    amount,
    order: creditOrderHash,
    details: hashDoc(creditDetails),
    sig: '',
  };
  creditRecord.sig = signDoc(creditRecord, bank.privateKey);

  await storeRecord(bank, debitRecord, debitDetails);
  await storeRecord(bank, creditRecord, creditDetails);

  await addOrderUsage(bank, hashDoc(debitOrderRef), amount, 0);
  await addOrderUsage(bank, hashDoc(creditOrderRef), 0, amount);

  return { records: [debitRecord, creditRecord] };
}

function parseOfferRef(o: Record<string, unknown>): {
  hash: string;
  debit_amount: number;
  credit_amount: number;
} {
  if (
    typeof o.hash !== 'string' ||
    typeof o.debit_amount !== 'number' ||
    typeof o.credit_amount !== 'number'
  ) {
    throw new RpcError(-32602, 'offer ref must have hash, debit_amount, credit_amount');
  }
  return {
    hash: o.hash,
    debit_amount: o.debit_amount,
    credit_amount: o.credit_amount,
  };
}

// Resolve an authorization reference (Order hash or Offer hash) to its
// underlying holder Order. Order hashes are canonical across banks; Offer
// hashes are bank-local derivations that point at the same Order.
async function resolveAuth(
  bank: Bank,
  hash: string,
): Promise<{ order: Order; orderHash: string }> {
  const order = await getOrder(bank, hash);
  if (order) {
    if (!order.sig || !verifyDoc(order, order.sig, order.pubkey)) {
      throw new RpcError(-32001, 'order signature invalid');
    }
    return { order, orderHash: hash };
  }
  const offer = await getOffer(bank, hash);
  if (offer) {
    if (!offer.sig || !verifyDoc(offer, offer.sig, bank.pubkey)) {
      throw new RpcError(-32001, 'offer signature invalid');
    }
    const underlying = await getOrder(bank, offer.order);
    if (!underlying) throw new RpcError(-32005, 'underlying order not found');
    return { order: underlying, orderHash: offer.order };
  }
  throw new RpcError(-32005, 'order or offer unknown');
}

function localSide(
  order: Order,
  ref: { debit_amount: number; credit_amount: number },
  bankPubkey: string,
): { side: 'debit' | 'credit'; voucher: string; amount: number; min: number; max: number } | null {
  if (order.debit && order.debit.bank === bankPubkey) {
    return {
      side: 'debit',
      voucher: order.debit.voucher,
      amount: ref.debit_amount,
      min: order.debit.min,
      max: order.debit.max,
    };
  }
  if (order.credit && order.credit.bank === bankPubkey) {
    return {
      side: 'credit',
      voucher: order.credit.voucher,
      amount: ref.credit_amount,
      min: order.credit.min,
      max: order.credit.max,
    };
  }
  return null;
}

async function totalIssuedForVoucher(
  bank: Bank,
  voucherHash: string,
): Promise<number> {
  const { listRecordsByVoucher } = await import('../db.ts');
  return (await listRecordsByVoucher(bank, voucherHash)).reduce(
    (sum, r) => sum + r.doc.amount,
    0,
  );
}

async function checkOrderLimit(
  bank: Bank,
  order: Order,
  side: 'debit' | 'credit',
  amount: number,
): Promise<void> {
  const usage = await import('../db.ts').then((m) => m.getOrderUsage(bank, hashDoc(order)));
  const limit = side === 'debit' ? order.debit_order_limit : order.credit_order_limit;
  const used = side === 'debit' ? usage.debit : usage.credit;
  if (limit !== undefined && used + amount > limit) {
    throw new RpcError(-32000, 'order limit exceeded');
  }
}
