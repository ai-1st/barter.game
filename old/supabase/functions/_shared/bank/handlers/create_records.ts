// create_records — initiating client → a single participating bank.
//
// The bank is the sole creator of ledger records. The client sends the deal
// ULID (its grouping key), this bank's slice of the settle topology
// (role / predecessors / banks), the transfer specs, and optionally any
// supporting docs (Voucher copies, Account docs — accounts are implicit).
// The bank validates, assigns record ULIDs, creates the debit/credit pair
// with mandatory `pair` cross-references, stores the leg topology, and
// returns the record bodies.
//
// role/predecessors/banks are client-computed orchestration hints, not
// authority: a lying client can only fragment or stall its own deal. The
// money gates are the holder Tx signatures and per-record approvals checked
// at submit_tx, and the hold/settle preconditions in the advance engine.

import { newUlid } from "../../protocol/crypto.ts";
import { RpcError, RpcErrors, type Handler } from "../rpc.ts";
import { intakeDocs } from "./intake.ts";

type CreateRecordsParams = {
  deal: string;
  role: "lead" | "follow";
  predecessors: string[];
  banks: string[];
  transfers: Array<{
    amount: number;
    from_account: string;
    to_account: string;
  }>;
  docs?: unknown[];
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
  if (!Array.isArray(p.transfers) || p.transfers.length === 0) {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.transfers must be a non-empty array");
  }

  // Implicit accounts: store any presented Voucher/Account docs first so
  // brand-new accounts can be referenced by the transfers below.
  await intakeDocs(p.docs, ctx);

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
      throw new RpcError(RpcErrors.UNKNOWN_DOC, `from_account ${tr.from_account} not known to this bank (attach the Account doc)`);
    }
    const toAcct = await ctx.db.getAccount(tr.to_account);
    if (!toAcct) {
      throw new RpcError(RpcErrors.UNKNOWN_DOC, `to_account ${tr.to_account} not known to this bank (attach the Account doc)`);
    }
    if (fromAcct.voucher_hash !== toAcct.voucher_hash) {
      throw new RpcError(RpcErrors.VALIDATION, "a transfer moves one voucher: both accounts must hold the same voucher");
    }
    const voucherRow = await ctx.db.getDoc(fromAcct.voucher_hash);
    if (voucherRow && (voucherRow.body as { integer?: boolean }).integer === true && !Number.isInteger(tr.amount)) {
      throw new RpcError(RpcErrors.VALIDATION, "voucher.integer requires an integer amount");
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
      dealUlid: p.deal,
      body: debit,
    });
    await ctx.db.insertLedgerRecord({
      ulid: creditUlid,
      type: "credit",
      account: tr.to_account,
      amount: tr.amount,
      pairUlid: debitUlid,
      dealUlid: p.deal,
      body: credit,
    });

    created.push(debit);
    created.push(credit);
  }

  await ctx.db.upsertLeg({
    dealUlid: p.deal,
    state: "created",
    role: p.role,
    predecessors: p.predecessors,
    banks: p.banks,
  });

  return { deal: p.deal, records: created };
};
