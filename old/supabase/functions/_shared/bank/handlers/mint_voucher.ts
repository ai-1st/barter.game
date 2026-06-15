// mint_voucher — issuer → issuing bank.
//
// Minting IS the first ledger record pair. The issuer presents:
//   - the Voucher doc (signed request envelope claims authorship)
//   - two Account docs on two DISTINCT Pocket hashes: the issue account
//     (goes negative) and the holding account (goes positive)
//   - the amount to mint
//
// The bank stores the docs, creates the debit/credit pair under a fresh
// deal ULID, and settles immediately — a mint has a single signer and a
// single bank, so the signed envelope is the issuer's authorization and
// there is zero counterparty risk. No special mint balance logic: the same
// mechanism that moves value in trades creates it here.
//
// There is no open_account call; these two Account rows come into existence
// right here. Pocket bodies never reach the bank — only the hashes inside
// the Account docs.

import { hashDoc, newUlid, signDoc } from "../../protocol/crypto.ts";
import { validateAccount, validateVoucher } from "../../protocol/schemas.ts";
import { RpcError, RpcErrors, type Handler } from "../rpc.ts";
import { fanoutSignatures } from "../subscriptions.ts";

type MintVoucherParams = {
  voucher: Record<string, unknown>;
  debit_account: Record<string, unknown>;   // issue account — goes negative
  credit_account: Record<string, unknown>;  // holding account — goes positive
  amount: number;
};

export const mintVoucher: Handler = async (params, ctx) => {
  const p = params as MintVoucherParams;
  for (const f of ["voucher", "debit_account", "credit_account"] as const) {
    if (!p[f]) throw new RpcError(RpcErrors.INVALID_PARAMS, `params.${f} required`);
  }
  if (typeof p.amount !== "number" || !Number.isFinite(p.amount) || p.amount <= 0) {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.amount must be a positive finite number");
  }

  try {
    validateVoucher(p.voucher);
    validateAccount(p.debit_account);
    validateAccount(p.credit_account);
  } catch (err) {
    throw new RpcError(RpcErrors.VALIDATION, err instanceof Error ? err.message : "doc validation failed");
  }

  const voucher = p.voucher;
  if (voucher.bank !== ctx.bankPubkey) {
    throw new RpcError(RpcErrors.VALIDATION, `voucher.bank must equal this bank's pubkey (${ctx.bankPubkey})`);
  }
  if (voucher.pubkey !== ctx.senderPubkey) {
    throw new RpcError(RpcErrors.VALIDATION, "voucher.pubkey must equal the request sender (issuer issues their own vouchers)");
  }
  const voucherHash = hashDoc(voucher);

  for (const [label, acct] of [["debit_account", p.debit_account], ["credit_account", p.credit_account]] as const) {
    if (acct.pubkey !== ctx.senderPubkey) {
      throw new RpcError(RpcErrors.VALIDATION, `${label}.pubkey must equal the request sender`);
    }
    if (acct.voucher !== voucherHash) {
      throw new RpcError(RpcErrors.VALIDATION, `${label}.voucher must reference the minted voucher`);
    }
  }
  if (p.debit_account.pocket === p.credit_account.pocket) {
    throw new RpcError(RpcErrors.VALIDATION, "the two accounts must use two distinct Pocket hashes");
  }

  if (voucher.integer === true && !Number.isInteger(p.amount)) {
    throw new RpcError(RpcErrors.VALIDATION, "voucher.integer requires an integer amount");
  }

  const debitAccountHash = hashDoc(p.debit_account);
  const creditAccountHash = hashDoc(p.credit_account);

  // Limit: total issuance lives on the issue account as a negative balance.
  if (typeof voucher.limit === "number") {
    const existing = await ctx.db.getAccount(debitAccountHash);
    const alreadyMinted = existing ? -Number(existing.balance) : 0;
    if (alreadyMinted + p.amount > voucher.limit) {
      throw new RpcError(
        RpcErrors.VALIDATION,
        `mint of ${p.amount} would exceed voucher.limit ${voucher.limit} (already minted ${alreadyMinted})`,
      );
    }
  }

  // Persist docs + implicit accounts. Hash-keyed upserts are idempotent.
  await ctx.db.insertDoc({ hash: voucherHash, type: "voucher", pubkey: ctx.senderPubkey, body: voucher });
  for (const [hash, acct] of [[debitAccountHash, p.debit_account], [creditAccountHash, p.credit_account]] as const) {
    await ctx.db.insertDoc({ hash, type: "account", pubkey: ctx.senderPubkey, body: acct });
    await ctx.db.upsertAccount({
      accountHash: hash,
      voucherHash,
      pocketHash: acct.pocket as string,
      holderPubkey: ctx.senderPubkey,
    });
  }

  // The mint record pair — a self-contained mini-deal.
  const deal = newUlid();
  const debitUlid = newUlid();
  const creditUlid = newUlid();
  const debit: Record<string, unknown> = {
    type: "debit",
    pubkey: ctx.bankPubkey,
    ulid: debitUlid,
    amount: p.amount,
    account: debitAccountHash,
    pair: creditUlid,
  };
  const credit: Record<string, unknown> = {
    type: "credit",
    pubkey: ctx.bankPubkey,
    ulid: creditUlid,
    amount: p.amount,
    account: creditAccountHash,
    pair: debitUlid,
  };
  await ctx.db.insertLedgerRecord({
    ulid: debitUlid, type: "debit", account: debitAccountHash, amount: p.amount,
    pairUlid: creditUlid, dealUlid: deal, body: debit,
  });
  await ctx.db.insertLedgerRecord({
    ulid: creditUlid, type: "credit", account: creditAccountHash, amount: p.amount,
    pairUlid: debitUlid, dealUlid: deal, body: credit,
  });

  // Settle immediately: apply ±amount, sign the artifacts.
  await ctx.db.applyBalanceDelta(debitAccountHash, -p.amount);
  await ctx.db.applyBalanceDelta(creditAccountHash, +p.amount);

  const signatures: Array<Record<string, unknown>> = [];
  const sign = async (body: Record<string, unknown>) => {
    body.sig = signDoc(body, ctx.bankPrivateKey);
    await ctx.db.insertDoc({ hash: hashDoc(body), type: "signature", pubkey: ctx.bankPubkey, body });
    signatures.push(body);
    return body;
  };

  // Per-record approvals, the mint-deal settle, and the voucher attestation.
  for (const ulid of [debitUlid, creditUlid]) {
    await sign({ type: "signature", pubkey: ctx.bankPubkey, ulid: newUlid(), record: ulid, action: "approve" });
  }
  const settle = await sign({ type: "signature", pubkey: ctx.bankPubkey, ulid: newUlid(), deal, action: "settle" });
  const attestation = await sign({ type: "signature", pubkey: ctx.bankPubkey, ulid: newUlid(), hash: voucherHash, action: "approve" });

  await ctx.db.upsertLeg({ dealUlid: deal, state: "settled", role: "lead", predecessors: [], banks: [ctx.bankPubkey] });
  await fanoutSignatures(ctx, signatures);

  return {
    voucher_hash: voucherHash,
    debit_account_hash: debitAccountHash,
    credit_account_hash: creditAccountHash,
    deal,
    records: [debit, credit],
    settle,
    bank_attestation: attestation,
  };
};
