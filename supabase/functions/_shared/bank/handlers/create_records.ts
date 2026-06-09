// create_records — client (a user) → a single participating bank.
//
// The bank is the sole creator of ledger records. The client sends transfer
// specs (amount + from/to accounts); the bank validates the accounts, assigns
// ULIDs, creates the debit/credit pair with `pair` cross-references, stores
// them in ledger_records, and returns the record bodies to the client.
//
// This is Phase 0 of the deal flow. After collecting records from every
// participating bank, the client assembles the Tx and proceeds to propose_leg.

import { newUlid } from "../../protocol/crypto.ts";
import { RpcError, RpcErrors, type Handler } from "../rpc.ts";

type CreateRecordsParams = {
  transfers: Array<{
    amount: number;
    from_account: string;
    to_account: string;
  }>;
};

export const createRecords: Handler = async (params, ctx) => {
  const p = params as CreateRecordsParams;
  if (!Array.isArray(p.transfers) || p.transfers.length === 0) {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.transfers must be a non-empty array");
  }

  const created: Array<Record<string, unknown>> = [];

  for (const tr of p.transfers) {
    if (typeof tr.amount !== "number" || !Number.isFinite(tr.amount) || tr.amount <= 0) {
      throw new RpcError(RpcErrors.INVALID_PARAMS, "transfer.amount must be a positive finite number");
    }
    if (typeof tr.from_account !== "string" || tr.from_account.length === 0) {
      throw new RpcError(RpcErrors.INVALID_PARAMS, "transfer.from_account required");
    }
    if (typeof tr.to_account !== "string" || tr.to_account.length === 0) {
      throw new RpcError(RpcErrors.INVALID_PARAMS, "transfer.to_account required");
    }

    const fromAcct = await ctx.db.getAccount(tr.from_account);
    if (!fromAcct) {
      throw new RpcError(RpcErrors.UNKNOWN_DOC, `from_account ${tr.from_account} not known to this bank`);
    }
    const toAcct = await ctx.db.getAccount(tr.to_account);
    if (!toAcct) {
      throw new RpcError(RpcErrors.UNKNOWN_DOC, `to_account ${tr.to_account} not known to this bank`);
    }

    const debitUlid = newUlid();
    const creditUlid = newUlid();

    const debit: Record<string, unknown> = {
      type: "debit",
      pubkey: ctx.bankPubkey,
      ulid: debitUlid,
      amount: tr.amount,
      account: tr.from_account,
      pair: creditUlid,
    };
    const credit: Record<string, unknown> = {
      type: "credit",
      pubkey: ctx.bankPubkey,
      ulid: creditUlid,
      amount: tr.amount,
      account: tr.to_account,
      pair: debitUlid,
    };

    await ctx.db.insertLedgerRecord({
      ulid: debitUlid,
      type: "debit",
      account: tr.from_account,
      amount: tr.amount,
      pairUlid: creditUlid,
      body: debit,
    });
    await ctx.db.insertLedgerRecord({
      ulid: creditUlid,
      type: "credit",
      account: tr.to_account,
      amount: tr.amount,
      pairUlid: debitUlid,
      body: credit,
    });

    created.push(debit);
    created.push(credit);
  }

  return { records: created };
};
