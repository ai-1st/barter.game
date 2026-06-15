// create_records — initiating client → a single participating bank.
//
// The bank is the sole creator of records. The client sends:
//   { requests: [{ type: "transfer", amount, debit_account_hash, credit_account_hash }, ...],
//     docs?, record_subscriptions? }
// where account fields may be Account doc bodies (attached in params.docs) or
// hashes. The bank validates, assigns record ULIDs, creates each debit/credit
// pair with mandatory `pair` cross-references, stores the records as drafts,
// attaches optional `record_subscriptions` for fan-out, and returns the record
// bodies.
//
// Draft records do NOT affect balances. They are promoted to ready/hold/settle
// as the bank signs them.

import { hashAccount, hashDoc, newUlid } from "../../../packages/protocol/src/index.ts";
import { RpcError, RpcErrors, type Handler } from "../rpc.ts";
import { intakeDocs } from "./intake.ts";

type RecordSubscription = {
  record: string; // record hash
  url: string;
};

type TransferRequest = {
  type: "transfer";
  promise_hash: string;
  amount: number;
  debit_account_hash: string | Record<string, unknown>;
  credit_account_hash: string | Record<string, unknown>;
};

type CreateRecordsParams = {
  requests: TransferRequest[];
  docs?: unknown[];
  record_subscriptions?: RecordSubscription[];
};

export const createRecords: Handler = async (params, ctx) => {
  const p = params as CreateRecordsParams;
  if (!Array.isArray(p.requests) || p.requests.length === 0) {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.requests must be a non-empty array");
  }

  // Implicit accounts: store any presented Promise/Account docs first so
  // brand-new accounts can be referenced.
  await intakeDocs(p.docs, ctx);

  const records: Array<Record<string, unknown>> = [];
  const hashByBody = new Map<Record<string, unknown>, string>();
  let alreadyCreated = false;

  for (const req of p.requests) {
    if (!isObject(req) || req.type !== "transfer") {
      throw new RpcError(RpcErrors.INVALID_PARAMS, "each request must be a transfer");
    }
    const tr = req as TransferRequest;
    if (typeof tr.amount !== "number" || !Number.isFinite(tr.amount) || tr.amount <= 0) {
      throw new RpcError(RpcErrors.INVALID_PARAMS, "transfer.amount must be a positive finite number");
    }

    const debitAccountHash = await resolveAccountHash(tr.debit_account_hash, "debit_account_hash", ctx);
    const creditAccountHash = await resolveAccountHash(tr.credit_account_hash, "credit_account_hash", ctx);

    const fromAcct = await ctx.db.getAccount(debitAccountHash);
    if (!fromAcct) {
      throw new RpcError(RpcErrors.UNKNOWN_DOC, `debit_account ${debitAccountHash} not known to this bank (attach the Account doc)`);
    }
    const toAcct = await ctx.db.getAccount(creditAccountHash);
    if (!toAcct) {
      throw new RpcError(RpcErrors.UNKNOWN_DOC, `credit_account ${creditAccountHash} not known to this bank (attach the Account doc)`);
    }
    if (fromAcct.promise_hash !== toAcct.promise_hash) {
      throw new RpcError(RpcErrors.VALIDATION, "a transfer moves one promise: both accounts must hold the same promise");
    }
    if (typeof tr.promise_hash === "string" && fromAcct.promise_hash !== tr.promise_hash) {
      throw new RpcError(RpcErrors.VALIDATION, "accounts do not reference the requested promise_hash");
    }

    const promiseRow = await ctx.db.getDoc(fromAcct.promise_hash);
    if (promiseRow && (promiseRow.body as { integer?: boolean }).integer === true && !Number.isInteger(tr.amount)) {
      throw new RpcError(RpcErrors.VALIDATION, "promise.integer requires an integer amount");
    }

    // Idempotency: an identical request from the same sender must not mint a
    // duplicate record pair. The envelope replay window blocks exact replays;
    // this guards a fresh signed envelope with the same payload.
    const requestKey = hashDoc({ sender: ctx.senderPubkey, amount: tr.amount, debit: debitAccountHash, credit: creditAccountHash });
    const existing = await ctx.db.getCreateRequest(requestKey);
    if (existing) {
      const debitRow = await ctx.db.getRecord(existing.debit_hash);
      const creditRow = await ctx.db.getRecord(existing.credit_hash);
      if (debitRow && creditRow) {
        records.push(debitRow.body, creditRow.body);
        hashByBody.set(debitRow.body, existing.debit_hash);
        hashByBody.set(creditRow.body, existing.credit_hash);
        alreadyCreated = true;
        continue;
      }
    }

    const pairUlid = ctx.db.newPairUlid();
    const debitUlid = newUlid();
    const creditUlid = newUlid();
    const debit: Record<string, unknown> = {
      type: "debit",
      pubkey: ctx.bankPubkey,
      ulid: debitUlid,
      amount: tr.amount,
      account: debitAccountHash,
      pair: creditUlid,
    };
    const credit: Record<string, unknown> = {
      type: "credit",
      pubkey: ctx.bankPubkey,
      ulid: creditUlid,
      amount: tr.amount,
      account: creditAccountHash,
      pair: debitUlid,
    };

    const { debitHash, creditHash } = await ctx.db.insertRecordPair({ pairUlid, debit, credit });
    records.push(debit, credit);
    hashByBody.set(debit, debitHash);
    hashByBody.set(credit, creditHash);
    await ctx.db.setCreateRequest(requestKey, { debit_hash: debitHash, credit_hash: creditHash });
  }

  // Lightweight record_subscriptions are routing hints: watch the record hash.
  if (Array.isArray(p.record_subscriptions)) {
    for (const rs of p.record_subscriptions) {
      if (!isObject(rs) || typeof rs.record !== "string" || typeof rs.url !== "string") continue;
      const match = records.find((r) => hashByBody.get(r) === rs.record);
      if (!match) continue;
      const watchKey = rs.record;
      const { hashDoc } = await import("../../../packages/protocol/src/index.ts");
      const subHash = hashDoc({ type: "subscription", pubkey: ctx.bankPubkey, ulid: "01" + watchKey.slice(0, 24), hashes: [watchKey], url: rs.url });
      await ctx.db.insertSubscription({
        subscriptionHash: subHash,
        subscriberPubkey: ctx.senderPubkey,
        url: rs.url,
        watchKeys: [watchKey],
      });
    }
  }

  return { records, already_created: alreadyCreated || undefined };
};

async function resolveAccountHash(
  input: string | Record<string, unknown>,
  field: string,
  ctx: { db: { getAccount: (h: string) => Promise<{ account_hash: string } | null>; getDoc: (h: string) => Promise<{ type: string } | null> }; bankPubkey: string },
): Promise<string> {
  if (typeof input === "string") {
    return input;
  }
  if (!isObject(input)) {
    throw new RpcError(RpcErrors.INVALID_PARAMS, `params.${field} must be an account hash or Account body`);
  }
  const { validateAccount } = await import("../../../packages/protocol/src/index.ts") as { validateAccount: (d: unknown) => void };
  try {
    validateAccount(input);
  } catch (err) {
    throw new RpcError(RpcErrors.VALIDATION, err instanceof Error ? err.message : `${field} invalid`);
  }
  const h = hashAccount(input as never);
  const acct = await ctx.db.getAccount(h);
  if (!acct) {
    throw new RpcError(RpcErrors.UNKNOWN_DOC, `${field} account not known to this bank`);
  }
  return h;
}

function isObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}
