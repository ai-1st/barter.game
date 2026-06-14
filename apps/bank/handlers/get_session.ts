// get_session — read-only view of a session at this bank.
//
// Returns the leg state, this bank's record bodies, and every signature
// anchored to the session or its records. Used by:
//   - a follow party verifying a deal token against the bank before signing
//   - clients watching session progress (poll instead of / besides push)
//   - a relaying client collecting signatures to carry to another bank

import { RpcError, RpcErrors, type Handler } from "../rpc.ts";

type GetSessionParams = { session: string };

export const getSession: Handler = async (params, ctx) => {
  const p = params as GetSessionParams;
  if (typeof p.session !== "string") {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.session required");
  }

  const leg = await ctx.db.getLegState(p.session);
  if (!leg) {
    throw new RpcError(RpcErrors.UNKNOWN_DOC, `session ${p.session} not known to this bank`);
  }

  const recordRows = await ctx.db.getRecordsBySession(p.session);
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
  collect(await ctx.db.listSignaturesByTarget({ session: p.session }));
  for (const r of recordRows) {
    collect(await ctx.db.listSignaturesByTarget({ record: r.ulid }));
  }

  return {
    session: p.session,
    state: leg.state,
    role: leg.role,
    predecessors: leg.predecessors,
    banks: leg.banks,
    records,
    signatures,
  };
};
