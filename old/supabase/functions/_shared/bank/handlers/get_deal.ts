// get_deal — read-only view of a deal at this bank.
//
// Returns the leg state, this bank's record bodies, and every signature
// anchored to the deal or its records. Used by:
//   - a follow party verifying a deal token against the bank before signing
//   - clients watching deal progress (poll instead of / besides push)
//   - a relaying client collecting signatures to carry to another bank

import { RpcError, RpcErrors, type Handler } from "../rpc.ts";

type GetDealParams = { deal: string };

export const getDeal: Handler = async (params, ctx) => {
  const p = params as GetDealParams;
  if (typeof p.deal !== "string") {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.deal required");
  }

  const leg = await ctx.db.getLegState(p.deal);
  if (!leg) {
    throw new RpcError(RpcErrors.UNKNOWN_DOC, `deal ${p.deal} not known to this bank`);
  }

  const recordRows = await ctx.db.getLedgerRecordsByDeal(p.deal);
  const records = recordRows.map((r) => r.body);

  const signatures: Array<Record<string, unknown>> = [];
  const seen = new Set<string>();
  const collect = (sigs: Array<Record<string, unknown>>) => {
    for (const s of sigs) {
      const key = JSON.stringify(s);
      if (!seen.has(key)) {
        seen.add(key);
        signatures.push(s);
      }
    }
  };
  collect(await ctx.db.listSignaturesByTarget({ deal: p.deal }));
  for (const r of recordRows) {
    collect(await ctx.db.listSignaturesByTarget({ record: r.ulid }));
  }

  return {
    deal: p.deal,
    state: leg.state,
    role: leg.role,
    predecessors: leg.predecessors,
    banks: leg.banks,
    records,
    signatures,
  };
};
