// Implicit doc intake — accounts come into existence when presented.
//
// There is no open_account call. Any mutating request may attach supporting
// docs (Voucher copies, Account docs) under params.docs; the bank stores
// what it is shown and creates account rows lazily. v0 openness: the bank
// accepts any docs linked to vouchers that reference this bank, from anyone
// — the sender need not be the doc's pubkey (counterparties carry each
// other's Account docs).
//
// Pocket docs are NEVER accepted: accounts reference pockets by opaque hash
// and pocket bodies stay on the holder's machine.

import { hashDoc, validateAccount, validateVoucher } from "../../../packages/protocol/src/index.ts";
import { RpcError, RpcErrors, type RpcContext } from "../rpc.ts";

export async function intakeDocs(
  docs: unknown,
  ctx: RpcContext,
): Promise<{ vouchers: string[]; accounts: string[] }> {
  if (docs === undefined) return { vouchers: [], accounts: [] };
  if (!Array.isArray(docs)) {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.docs must be an array if present");
  }

  const vouchers: Array<Record<string, unknown>> = [];
  const accounts: Array<Record<string, unknown>> = [];
  for (const d of docs) {
    const t = d === null || typeof d !== "object" ? undefined : (d as Record<string, unknown>).type;
    if (t === "voucher") vouchers.push(d as Record<string, unknown>);
    else if (t === "account") accounts.push(d as Record<string, unknown>);
    else if (t === "pocket") {
      throw new RpcError(RpcErrors.VALIDATION, "banks do not accept Pocket bodies — present the pocket hash only");
    } else {
      throw new RpcError(RpcErrors.INVALID_PARAMS, `docs[] may carry voucher or account docs, got ${String(t)}`);
    }
  }

  // Vouchers first, so accounts created in the same call can reference them.
  const voucherHashes: string[] = [];
  for (const voucher of vouchers) {
    try {
      validateVoucher(voucher);
    } catch (err) {
      throw new RpcError(RpcErrors.VALIDATION, err instanceof Error ? err.message : "voucher invalid");
    }
    if (voucher.bank !== ctx.bankPubkey) {
      throw new RpcError(RpcErrors.VALIDATION, "docs[] voucher does not reference this bank");
    }
    const hash = hashDoc(voucher);
    await ctx.db.insertDoc({
      hash,
      type: "voucher",
      pubkey: voucher.pubkey as string,
      body: voucher,
    });
    voucherHashes.push(hash);
  }

  const accountHashes: string[] = [];
  for (const account of accounts) {
    try {
      validateAccount(account);
    } catch (err) {
      throw new RpcError(RpcErrors.VALIDATION, err instanceof Error ? err.message : "account invalid");
    }
    const voucherHash = account.voucher as string;
    const voucherRow = await ctx.db.getDoc(voucherHash);
    if (!voucherRow || voucherRow.type !== "voucher") {
      throw new RpcError(
        RpcErrors.UNKNOWN_DOC,
        `account references voucher ${voucherHash} not known to this bank (attach the Voucher doc)`,
      );
    }
    if ((voucherRow.body as { bank?: string }).bank !== ctx.bankPubkey) {
      throw new RpcError(RpcErrors.VALIDATION, `voucher ${voucherHash} was not issued at this bank`);
    }
    const hash = hashDoc(account);
    await ctx.db.insertDoc({
      hash,
      type: "account",
      pubkey: account.holder as string,
      body: account,
    });
    await ctx.db.upsertAccount({
      accountHash: hash,
      voucherHash,
      pocketHash: account.pocket as string,
      holderPubkey: account.holder as string,
    });
    accountHashes.push(hash);
  }

  return { vouchers: voucherHashes, accounts: accountHashes };
}
