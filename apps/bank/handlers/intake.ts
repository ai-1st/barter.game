// Implicit doc intake — accounts come into existence when presented.
//
// There is no open_account call. Any mutating request may attach supporting
// docs (Promise copies, Account docs) under params.docs; the bank stores
// what it is shown and creates account rows lazily. v0 openness: the bank
// accepts any docs linked to promises that reference this bank, from anyone
// — the sender need not be the doc's pubkey (counterparties carry each
// other's Account docs).
//
// Pocket docs are NEVER accepted: accounts reference pockets by opaque hash
// and pocket bodies stay on the holder's machine.

import { hashDoc, validateAccount, validatePromise } from "../../../packages/protocol/src/index.ts";
import { RpcError, RpcErrors, type RpcContext } from "../rpc.ts";

export async function intakeDocs(
  docs: unknown,
  ctx: RpcContext,
): Promise<{ promises: string[]; accounts: string[] }> {
  if (docs === undefined) return { promises: [], accounts: [] };
  if (!Array.isArray(docs)) {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.docs must be an array if present");
  }

  const promises: Array<Record<string, unknown>> = [];
  const accounts: Array<Record<string, unknown>> = [];
  for (const d of docs) {
    const t = d === null || typeof d !== "object" ? undefined : (d as Record<string, unknown>).type;
    if (t === "promise") promises.push(d as Record<string, unknown>);
    else if (t === "account") accounts.push(d as Record<string, unknown>);
    else if (t === "pocket") {
      throw new RpcError(RpcErrors.VALIDATION, "banks do not accept Pocket bodies — present the pocket hash only");
    } else {
      throw new RpcError(RpcErrors.INVALID_PARAMS, `docs[] may carry promise or account docs, got ${String(t)}`);
    }
  }

  // Promises first, so accounts created in the same call can reference them.
  const promiseHashes: string[] = [];
  for (const promise of promises) {
    try {
      validatePromise(promise);
    } catch (err) {
      throw new RpcError(RpcErrors.VALIDATION, err instanceof Error ? err.message : "promise invalid");
    }
    if (promise.bank !== ctx.bankPubkey) {
      throw new RpcError(RpcErrors.VALIDATION, "docs[] promise does not reference this bank");
    }
    const hash = hashDoc(promise);
    await ctx.db.insertDoc({
      hash,
      type: "promise",
      pubkey: promise.pubkey as string,
      body: promise,
    });
    promiseHashes.push(hash);
  }

  const accountHashes: string[] = [];
  for (const account of accounts) {
    try {
      validateAccount(account);
    } catch (err) {
      throw new RpcError(RpcErrors.VALIDATION, err instanceof Error ? err.message : "account invalid");
    }
    const promiseHash = account.promise as string;
    const promiseRow = await ctx.db.getDoc(promiseHash);
    if (!promiseRow || promiseRow.type !== "promise") {
      throw new RpcError(
        RpcErrors.UNKNOWN_DOC,
        `account references promise ${promiseHash} not known to this bank (attach the Promise doc)`,
      );
    }
    if ((promiseRow.body as { bank?: string }).bank !== ctx.bankPubkey) {
      throw new RpcError(RpcErrors.VALIDATION, `promise ${promiseHash} was not issued at this bank`);
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
      promiseHash,
      pocketHash: account.pocket as string,
      holderPubkey: account.holder as string,
    });
    accountHashes.push(hash);
  }

  return { promises: promiseHashes, accounts: accountHashes };
}
