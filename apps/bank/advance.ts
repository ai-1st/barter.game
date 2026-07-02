import {
  getAccount,
  getAccountBalance,
  getAddress,
  getMandate,
  getOffer,
  getOrder,
  getRecord,
  getSignaturesForRecord,
  listPeerSettleSigs,
  listRecordsByDeal,
  releaseHold,
  storeSignature,
  updateAccountBalance,
  type RecordRow,
} from './db.ts';
import {
  hashDoc,
  newUlid,
  signDoc,
  type Base58PubKey,
  type Base58SHA256,
  type Order,
  type BankRecord,
  type Signature,
} from '@barter.game/protocol';
import { bankRpcCall } from './peer.ts';
import type { Bank } from './types.ts';

const EPS = 1e-9;

type RecordState = {
  hash: Base58SHA256;
  row: RecordRow;
  mandated: boolean;
  ready: boolean;
  held: boolean;
  settled: boolean;
  rejected: boolean;
  readySig: Signature | null;
  holdSig: Signature | null;
  settleSig: Signature | null;
  rejectSig: Signature | null;
};

export async function advanceDeal(bank: Bank, dealId: string): Promise<void> {
  const records = await listRecordsByDeal(bank, dealId);
  if (records.length === 0) return;

  const states: RecordState[] = [];
  for (const row of records) {
    const h = hashDoc(row.doc);
    const sigs = await getSignaturesForRecord(bank, h);
    states.push({
      hash: h,
      row,
      // A record is mandated when a Mandate exists for its (deal, order),
      // lists this record, and was signed by the coordinator sealed into the
      // record. Only mandated records may advance.
      mandated: await isMandated(bank, dealId, row, h),
      ready: sigs.some((s) => s.action === 'ready'),
      held: sigs.some((s) => s.action === 'hold'),
      settled: sigs.some((s) => s.action === 'settle'),
      rejected: sigs.some((s) => s.action === 'reject'),
      readySig: sigs.find((s) => s.action === 'ready') ?? null,
      holdSig: sigs.find((s) => s.action === 'hold') ?? null,
      settleSig: sigs.find((s) => s.action === 'settle') ?? null,
      rejectSig: sigs.find((s) => s.action === 'reject') ?? null,
    });
  }

  if (!states.some((s) => s.mandated)) return; // still awaiting coordinator clearance

  if (states.some((s) => s.rejected)) return;

  // Resolve underlying orders.
  const resolved = await Promise.all(
    states.map((s) => resolveOrderForRecord(bank, s.row.doc)),
  );

  // Determine the lead bank set for this deal from the orders.
  const leadBanks = new Set<Base58PubKey>();
  for (let i = 0; i < states.length; i++) {
    const lb = await determineLeadBank(bank, states[i]!.row, resolved[i]!);
    if (lb) leadBanks.add(lb);
  }

  // 1. Ready
  for (let i = 0; i < states.length; i++) {
    const st = states[i]!;
    if (st.ready || st.held || st.settled || !st.mandated) continue;
    const ok = await readyCheck(bank, st.row, resolved[i]!);
    if (ok) {
      await signAndStore(bank, st.hash, 'ready');
      st.ready = true;
    }
  }

  // 2. Hold — only when EVERY owned record of the deal is ready (README §2.0:
  // "A bank holds its own records in a deal when all of its records are
  // `ready`"). Holding or settling a subset would let one half of a
  // debit/credit pair apply without the other, breaking the sum invariant.
  const allReady = states.every((s) => s.ready || s.settled);
  if (!allReady) return;

  const notHeld = states.filter((s) => !s.held && !s.settled);
  if (notHeld.length > 0) {
    const holdOk = await acquireHoldsForDeal(bank, dealId, notHeld);
    if (holdOk) {
      for (const st of notHeld) {
        const sig = await signAndStore(bank, st.hash, 'hold');
        st.held = true;
        st.holdSig = sig;
      }
    }
  }

  // 3. Settle — pair each held record with ITS resolved order (indexes into
  // `states`/`resolved` stay aligned via zip; a filtered array must not be
  // indexed against the unfiltered `resolved`).
  const heldPairs = states
    .map((st, i) => ({ st, order: resolved[i]! }))
    .filter(({ st }) => st.held && !st.settled);
  if (heldPairs.length === 0) return;

  const ownLeadStates = heldPairs.filter(({ order }) => order.lead).map(({ st }) => st);
  const ownFollowStates = heldPairs.filter(({ order }) => !order.lead).map(({ st }) => st);

  // Settle this bank's lead records first.
  const thisBankSettleSigs: Signature[] = [];
  for (const st of ownLeadStates) {
    const sig = await settleRecord(bank, st);
    if (sig) thisBankSettleSigs.push(sig);
  }

  // Collect upstream settle signatures from every lead bank.
  const leadBankSigs = new Map<Base58PubKey, Signature[]>();
  if (thisBankSettleSigs.length > 0) {
    leadBankSigs.set(bank.pubkey, thisBankSettleSigs);
  }

  let canSettleFollow = true;
  for (const leadBank of leadBanks) {
    if (leadBank === bank.pubkey) continue;
    const peerSigs = await listPeerSettleSigs(bank, leadBank);
    if (peerSigs.length === 0) {
      canSettleFollow = false;
      break;
    }
    leadBankSigs.set(leadBank, [peerSigs[0]!]);
  }

  if (canSettleFollow) {
    const seen = [...leadBankSigs.values()].flat().map((s) => hashDoc(s));
    for (const st of ownFollowStates) {
      await settleRecord(bank, st, seen);
    }
  }

  // Fan out this bank's settle signatures to peer banks that need them.
  if (thisBankSettleSigs.length > 0) {
    await fanOutSettleSigs(bank, dealId, thisBankSettleSigs, resolved, states);
  }
}

export async function advanceRecord(
  bank: Bank,
  recordHash: Base58SHA256,
): Promise<void> {
  const rec = await getRecord(bank, recordHash);
  if (!rec) return;
  await advanceDeal(bank, rec.details.deal_id);
}

async function isMandated(
  bank: Bank,
  dealId: string,
  row: RecordRow,
  hash: Base58SHA256,
): Promise<boolean> {
  const mandate = await getMandate(bank, dealId, row.doc.order);
  if (!mandate) return false;
  if (mandate.coordinator !== row.details.coordinator) return false;
  return mandate.records.includes(hash);
}

async function resolveOrderForRecord(
  bank: Bank,
  record: BankRecord,
): Promise<Order> {
  const doc = await getOrder(bank, record.order);
  if (doc) return doc;
  const offer = await getOffer(bank, record.order);
  if (offer) {
    const order = await getOrder(bank, offer.order);
    if (order) return order;
  }
  throw new Error('order/offer not found');
}

async function determineLeadBank(
  bank: Bank,
  record: RecordRow,
  order: Order,
): Promise<Base58PubKey | null> {
  if (order.lead) return bank.pubkey;
  // Follow: the lead bank is the bank on the opposite side of this transfer.
  if (record.doc.type === 'debit' && order.credit) {
    return order.credit.bank;
  }
  if (record.doc.type === 'credit' && order.debit) {
    return order.debit.bank;
  }
  // One-sided at this bank (e.g. invoice lead by the paying cheque side).
  return bank.pubkey;
}

async function readyCheck(
  bank: Bank,
  row: RecordRow,
  order: Order,
): Promise<boolean> {
  const account = await getAccount(bank, row.details.account);
  if (!account) return false;

  // Verify order side matches record type & account.
  if (row.doc.type === 'debit') {
    if (!order.debit) return false;
    if (order.debit.account !== row.details.account) return false;
  } else {
    if (!order.credit) return false;
    if (order.credit.account !== row.details.account) return false;
  }

  const amount = row.doc.amount;
  if (amount < (row.doc.type === 'debit' ? order.debit!.min : order.credit!.min)) return false;
  if (amount > (row.doc.type === 'debit' ? order.debit!.max : order.credit!.max)) return false;

  // Free balance check for debits (non-issuers may not overdraw).
  if (row.doc.type === 'debit') {
    const voucher = await import('./db.ts').then((m) =>
      m.getVoucher(bank, order.debit!.voucher),
    );
    const isIssuer = voucher ? voucher.pubkey === row.details.holder : false;
    const bal = await getAccountBalance(bank, row.details.account);
    if (!bal) return false;
    const free = bal.current - bal.pending;
    if (!isIssuer && free < amount) return false;
    if (isIssuer && voucher?.limit !== undefined) {
      const issued = await totalIssuedForVoucher(bank, order.debit!.voucher);
      if (issued + amount > voucher.limit) return false;
    }
    if (order.debit_account_limit !== undefined) {
      if (!isIssuer && bal.current - amount < order.debit_account_limit) return false;
    }
  }

  // Credit account ceiling check.
  if (row.doc.type === 'credit' && order.credit_account_limit !== undefined) {
    const bal = await getAccountBalance(bank, row.details.account);
    if (!bal) return false;
    if (bal.current + amount > order.credit_account_limit) return false;
  }

  // Aggregate rate check for two-sided orders when both sides are local.
  const rateOk = await aggregateRateCheck(bank, row.details.deal_id, order);
  if (!rateOk) return false;

  return true;
}

async function aggregateRateCheck(
  bank: Bank,
  dealId: string,
  order: Order,
): Promise<boolean> {
  if (!order.debit || !order.credit) return true; // one-sided: no rate gate
  const records = await listRecordsByDeal(bank, dealId);
  let debitAmount = 0;
  let creditAmount = 0;
  for (const r of records) {
    const ord = await resolveOrderForRecord(bank, r.doc);
    if (hashDoc(ord) !== hashDoc(order)) continue;
    if (r.doc.type === 'debit') debitAmount += r.doc.amount;
    if (r.doc.type === 'credit') creditAmount += r.doc.amount;
  }
  if (creditAmount === 0) return true; // cannot check yet
  return debitAmount / creditAmount <= order.rate + EPS;
}

async function acquireHoldsForDeal(
  bank: Bank,
  dealId: string,
  states: RecordState[],
): Promise<boolean> {
  const { acquireHold } = await import('./db.ts');
  const byAccount = new Map<Base58SHA256, number>();
  for (const st of states) {
    if (st.row.doc.type !== 'debit') continue;
    const sum = byAccount.get(st.row.details.account) ?? 0;
    byAccount.set(st.row.details.account, sum + st.row.doc.amount);
  }
  for (const [account, amount] of byAccount) {
    const ok = await acquireHold(bank, account, dealId, amount);
    if (!ok) return false;
  }
  return true;
}

async function settleRecord(
  bank: Bank,
  st: RecordState,
  seen?: Base58SHA256[],
): Promise<Signature | null> {
  if (st.settled) return st.settleSig;
  const delta = st.row.doc.type === 'credit' ? st.row.doc.amount : -st.row.doc.amount;
  await updateAccountBalance(bank, st.row.details.account, delta);
  await releaseHold(bank, st.row.details.account, st.row.details.deal_id);
  const sig = await signAndStore(bank, st.hash, 'settle', seen);
  st.settled = true;
  st.settleSig = sig;
  return sig;
}

async function signAndStore(
  bank: Bank,
  targetHash: Base58SHA256,
  action: Signature['action'],
  seen?: Base58SHA256[],
): Promise<Signature> {
  const sig: Signature = {
    type: 'signature',
    pubkey: bank.pubkey,
    ulid: newUlid(),
    hash: targetHash,
    action,
    seen,
    sig: '',
  };
  sig.sig = signDoc(sig, bank.privateKey);
  await storeSignature(bank, sig);
  return sig;
}

async function fanOutSettleSigs(
  bank: Bank,
  dealId: string,
  settleSigs: Signature[],
  resolved: Order[],
  states: RecordState[],
): Promise<void> {
  // Find follow banks: counter-side banks of our lead records.
  const followBanks = new Set<Base58PubKey>();
  for (let i = 0; i < states.length; i++) {
    const st = states[i]!;
    if (!resolved[i]!.lead) continue;
    const order = resolved[i]!;
    const counterBank =
      st.row.doc.type === 'debit'
        ? order.credit?.bank
        : order.debit?.bank;
    if (counterBank && counterBank !== bank.pubkey) {
      followBanks.add(counterBank);
    }
  }
  if (followBanks.size === 0) return;

  for (const target of followBanks) {
    const addr = await getAddress(bank, target);
    if (!addr) continue;
    try {
      await bankRpcCall(bank, addr.url, target, 'notify_signatures', {
        signatures: settleSigs,
      });
    } catch {
      // Fire-and-forget; client relay is the recovery path.
    }
  }
}

async function totalIssuedForVoucher(
  bank: Bank,
  voucherHash: string,
): Promise<number> {
  const { listRecordsByVoucher } = await import('./db.ts');
  return (await listRecordsByVoucher(bank, voucherHash)).reduce(
    (sum, r) => sum + r.doc.amount,
    0,
  );
}
