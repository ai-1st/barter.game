// get_record_signatures — read-only view of signatures on a record hash.
//
// Record hashes act as access keys: anyone with the hash can poll the bank
// for signatures issued on it. This is the recovery path when push
// subscriptions fail, and how clients watch the progress of a deal.

import { RpcError, RpcErrors, type Handler } from "../rpc.ts";

type GetRecordSignaturesParams = { record_hash: string };

export const getRecordSignatures: Handler = async (params, ctx) => {
  const p = params as GetRecordSignaturesParams;
  if (typeof p.record_hash !== "string" || p.record_hash.length === 0) {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.record_hash required");
  }

  const row = await ctx.db.getRecord(p.record_hash);
  if (!row) {
    throw new RpcError(RpcErrors.UNKNOWN_DOC, `record ${p.record_hash} not known to this bank`);
  }

  const signatures = await ctx.db.listSignaturesByHash(p.record_hash);

  return {
    record_hash: p.record_hash,
    record: row.body,
    signatures,
  };
};
