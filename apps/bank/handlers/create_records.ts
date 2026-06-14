// create_records — initiating client → a single participating bank.
//
// The bank is the sole creator of ledger records. The client sends the deal
// ULID (its grouping key), this bank's slice of the settle topology
// (role / predecessors / banks), the record requests, and optionally any
// supporting docs (Promise copies, Account docs — accounts are implicit).
// The bank validates, assigns record ULIDs, creates the debit/credit pair
// with mandatory `pair` cross-references, stores the leg topology, attaches
// optional `record_subscriptions` for fan-out, and returns the record bodies.
//
// A request is either:
//   - { type: "transfer", promise_hash, amount, debit_account_hash, credit_account_hash }
//   - { type: "offer_match", offer_hash, amount, account_hash }
//
// role/predecessors/banks are client-computed orchestration hints, not
// authority: a lying client can only fragment or stall its own deal. The
// money gates are the holder Tx signatures and per-record ready/hold/settle
// checked at submit_tx and in the advance engine.

import { newUlid } from "../../../packages/protocol/src/index.ts";
import { RpcError, RpcErrors, type Handler } from "../rpc.ts";
import { intakeDocs } from "./intake.ts";

type TransferRequest = {
  type: "transfer";
  promise_hash: string;
  amount: number;
  debit_account_hash: string;
  credit_account_hash: string;
};

type OfferMatchRequest = {
  type: "offer_match";
  offer_hash: string;
  amount: number;
  account_hash: string;
};

type CreateRecordsParams = {
  deal: string;
  role: "lead" | "follow";
  predecessors: string[];
  banks: string[];
  requests: Array<TransferRequest | OfferMatchRequest>;
  docs?: unknown[];
  record_subscriptions?: Array<{ record: string; url: string }>;
};

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export const createRecords: Handler = async (params, ctx) => {
  const p = params as CreateRecordsParams;
  if (typeof p.deal !== "string" || !ULID_RE.test(p.deal)) {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.deal must be a ULID");
  }
  if (p.role !== "lead" && p.role !== "follow") {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.role must be 'lead' or 'follow'");
  }
  for (const [name, list] of [["predecessors", p.predecessors], ["banks", p.banks]] as const) {
    if (!Array.isArray(list) || list.some((b) => typeof b !== "string" || b.length === 0)) {
      throw new RpcError(RpcErrors.INVALID_PARAMS, `params.${name} must be an array of bank pubkeys`);
    }
  }
  if (!p.banks.includes(ctx.bankPubkey)) {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.banks must include this bank");
  }
  if (!Array.isArray(p.requests) || p.requests.length === 0) {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.requests must be a non-empty array");
  }

  // Implicit accounts: store any presented Promise/Account docs first so
  // brand-new accounts can be referenced by the requests below.
  await intakeDocs(p.docs, ctx);

  const created: Array<Record<string, unknown>> = [];

  for (const req of p.requests) {
    if (!isObject(req) || req.type !== "transfer" && req.type !== "offer_match") {
      throw new RpcError(RpcErrors.INVALID_PARAMS, "each request must have type 'transfer' or 'offer_match'");
    }

    if (req.type === "transfer") {
      const tr = req as TransferRequest;
      if (typeof tr.amount !== "number" || !Number.isFinite(tr.amount) || tr.amount <= 0) {
        throw new RpcError(RpcErrors.INVALID_PARAMS, "transfer.amount must be a positive finite number");
      }
      if (typeof tr.debit_account_hash !== "string" || tr.debit_account_hash.length === 0) {
        throw new RpcError(RpcErrors.INVALID_PARAMS, "transfer.debit_account_hash required");
      }
      if (typeof tr.credit_account_hash !== "string" || tr.credit_account_hash.length === 0) {
        throw new RpcError(RpcErrors.INVALID_PARAMS, "transfer.credit_account_hash required");
      }
      if (typeof tr.promise_hash !== "string" || tr.promise_hash.length === 0) {
        throw new RpcError(RpcErrors.INVALID_PARAMS, "transfer.promise_hash required");
      }

      const fromAcct = await ctx.db.getAccount(tr.debit_account_hash);
      if (!fromAcct) {
        throw new RpcError(RpcErrors.UNKNOWN_DOC, `debit_account_hash ${tr.debit_account_hash} not known to this bank (attach the Account doc)`);
      }
      const toAcct = await ctx.db.getAccount(tr.credit_account_hash);
      if (!toAcct) {
        throw new RpcError(RpcErrors.UNKNOWN_DOC, `credit_account_hash ${tr.credit_account_hash} not known to this bank (attach the Account doc)`);
      }
      if (fromAcct.promise_hash !== toAcct.promise_hash) {
        throw new RpcError(RpcErrors.VALIDATION, "a transfer moves one promise: both accounts must hold the same promise");
      }
      if (fromAcct.promise_hash !== tr.promise_hash) {
        throw new RpcError(RpcErrors.VALIDATION, "accounts do not reference the requested promise_hash");
      }
      const promiseRow = await ctx.db.getDoc(fromAcct.promise_hash);
      if (promiseRow && (promiseRow.body as { integer?: boolean }).integer === true && !Number.isInteger(tr.amount)) {
        throw new RpcError(RpcErrors.VALIDATION, "promise.integer requires an integer amount");
      }

      created.push(...await mintRecordPair(ctx.bankPubkey, ctx.db, p.deal, tr.debit_account_hash, tr.credit_account_hash, tr.amount));
    } else {
      // offer_match
      const om = req as OfferMatchRequest;
      if (typeof om.offer_hash !== "string" || typeof om.account_hash !== "string" || typeof om.amount !== "number" || !Number.isFinite(om.amount) || om.amount <= 0) {
        throw new RpcError(RpcErrors.INVALID_PARAMS, "offer_match requires offer_hash, account_hash, and a positive amount");
      }
      const offerRow = await ctx.db.getDoc(om.offer_hash);
      if (!offerRow || offerRow.type !== "offer") {
        throw new RpcError(RpcErrors.UNKNOWN_DOC, `offer ${om.offer_hash} not found`);
      }
      const offer = offerRow.body as Record<string, unknown>;
      const orderRow = await ctx.db.getDoc(offer.order as string);
      if (!orderRow || orderRow.type !== "order") {
        throw new RpcError(RpcErrors.UNKNOWN_DOC, `offer ${om.offer_hash} references unknown order ${String(offer.order)}`);
      }
      const order = orderRow.body as Record<string, unknown>;

      // Determine which side the provided account is on.
      const providedAcct = await ctx.db.getAccount(om.account_hash);
      if (!providedAcct) {
        throw new RpcError(RpcErrors.UNKNOWN_DOC, `account ${om.account_hash} not known to this bank`);
      }

      const debitOffer = offer.debit as Record<string, unknown> | undefined;
      const creditOffer = offer.credit as Record<string, unknown> | undefined;

      let debitAccountHash: string;
      let creditAccountHash: string;
      let amount: number;

      if (debitOffer && creditOffer) {
        // Two-sided offer: the provided account must match one side's promise.
        if (providedAcct.promise_hash === debitOffer.promise) {
          // Matchmaker is giving the debit promise; order holder receives credit.
          debitAccountHash = om.account_hash;
          creditAccountHash = order.credit as string;
          const rate = Number(offer.rate);
          amount = om.amount; // debit amount
          const creditAmount = amount / rate;
          if (!Number.isFinite(creditAmount) || creditAmount <= 0) {
            throw new RpcError(RpcErrors.VALIDATION, "offer_match amount yields invalid credit amount");
          }
          // Validate against offer terms.
          const min = Number(debitOffer.min);
          const max = Number(debitOffer.max);
          if (amount < min || amount > max) {
            throw new RpcError(RpcErrors.VALIDATION, `offer_match amount ${amount} outside debit offer range [${min}, ${max}]`);
          }
        } else if (providedAcct.promise_hash === creditOffer.promise) {
          // Matchmaker is receiving credit; order holder gives debit.
          debitAccountHash = order.debit as string;
          creditAccountHash = om.account_hash;
          const rate = Number(offer.rate);
          amount = om.amount * rate; // debit amount from order holder
          if (!Number.isFinite(amount) || amount <= 0) {
            throw new RpcError(RpcErrors.VALIDATION, "offer_match amount yields invalid debit amount");
          }
          const min = Number(creditOffer.min);
          const max = Number(creditOffer.max);
          if (om.amount < min || om.amount > max) {
            throw new RpcError(RpcErrors.VALIDATION, `offer_match amount ${om.amount} outside credit offer range [${min}, ${max}]`);
          }
        } else {
          throw new RpcError(RpcErrors.VALIDATION, "provided account does not match either side of the offer");
        }
      } else if (debitOffer && !creditOffer) {
        // Cheque offer: order holder unconditionally debits; matchmaker credits.
        debitAccountHash = order.debit as string;
        creditAccountHash = om.account_hash;
        amount = om.amount;
        const min = Number(debitOffer.min);
        const max = Number(debitOffer.max);
        if (amount < min || amount > max) {
          throw new RpcError(RpcErrors.VALIDATION, `offer_match amount ${amount} outside offer range [${min}, ${max}]`);
        }
      } else if (!debitOffer && creditOffer) {
        // Invoice offer: matchmaker debits; order holder unconditionally credits.
        debitAccountHash = om.account_hash;
        creditAccountHash = order.credit as string;
        amount = om.amount;
        const min = Number(creditOffer.min);
        const max = Number(creditOffer.max);
        if (amount < min || amount > max) {
          throw new RpcError(RpcErrors.VALIDATION, `offer_match amount ${amount} outside offer range [${min}, ${max}]`);
        }
      } else {
        throw new RpcError(RpcErrors.VALIDATION, "offer has neither debit nor credit side");
      }

      created.push(...await mintRecordPair(ctx.bankPubkey, ctx.db, p.deal, debitAccountHash, creditAccountHash, amount));
    }
  }

  await ctx.db.upsertLeg({
    dealUlid: p.deal,
    state: "created",
    role: p.role,
    predecessors: p.predecessors,
    banks: p.banks,
  });

  // Turn lightweight record_subscriptions into persistent Subscription docs.
  if (Array.isArray(p.record_subscriptions)) {
    for (const rs of p.record_subscriptions) {
      if (!isObject(rs) || typeof rs.record !== "string" || typeof rs.url !== "string") continue;
      const sub: Record<string, unknown> = {
        type: "subscription",
        pubkey: ctx.senderPubkey,
        ulid: newUlid(),
        records: [rs.record],
        url: rs.url,
        to: ctx.senderPubkey,
      };
      // Import dynamically to avoid circular dependency.
      const { subscribe } = await import("./subscribe.ts");
      await subscribe({ subscription: sub }, ctx);
    }
  }

  return { deal: p.deal, records: created };
};

async function mintRecordPair(
  bankPubkey: string,
  db: { insertLedgerRecord: (input: { ulid: string; type: "credit" | "debit"; account: string; amount: number; pairUlid: string; dealUlid: string; body: Record<string, unknown> }) => Promise<void> },
  dealUlid: string,
  debitAccountHash: string,
  creditAccountHash: string,
  amount: number,
): Promise<Array<Record<string, unknown>>> {
  const debitUlid = newUlid();
  const creditUlid = newUlid();
  const debit: Record<string, unknown> = {
    type: "debit",
    pubkey: bankPubkey,
    ulid: debitUlid,
    amount,
    account: debitAccountHash,
    pair: creditUlid,
  };
  const credit: Record<string, unknown> = {
    type: "credit",
    pubkey: bankPubkey,
    ulid: creditUlid,
    amount,
    account: creditAccountHash,
    pair: debitUlid,
  };
  await db.insertLedgerRecord({
    ulid: debitUlid,
    type: "debit",
    account: debitAccountHash,
    amount,
    pairUlid: creditUlid,
    dealUlid,
    body: debit,
  });
  await db.insertLedgerRecord({
    ulid: creditUlid,
    type: "credit",
    account: creditAccountHash,
    amount,
    pairUlid: debitUlid,
    dealUlid,
    body: credit,
  });
  return [debit, credit];
}

function isObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}
