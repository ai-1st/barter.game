// JSON-RPC 2.0 envelope wrapper for the Deno Deploy bank server.
//
// All RPC requests are POSTs to /:name/rpc with a signed envelope:
//
//   { "jsonrpc": "2.0", "id": "<ulid>", "method": "...", "params": {...},
//     "pubkey": "<sender>", "to": "<recipient-bank>", "sig": "<sig>" }
//
// This module validates the envelope shape, verifies the ed25519 signature,
// validates `to` matches the named bank's pubkey, claims the ULID in the
// replay window, and dispatches to the registered handler for `method`.

import { verifyDoc } from "../../packages/protocol/src/index.ts";
import type { BankDB } from "./db.ts";

export type RpcContext = {
  db: BankDB;
  bankPubkey: string;
  bankPrivateKey: Uint8Array;
  senderPubkey: string;
  requestId: string;
};

export type Handler = (
  params: Record<string, unknown>,
  ctx: RpcContext,
) => Promise<unknown>;

export type Registry = Record<string, Handler>;

/** Error codes matching PROTOCOL.md §6.2. */
export const RpcErrors = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  VALIDATION: -32000,
  SIG_INVALID: -32001,
  REPLAY: -32002,
  LOCK_CONFLICT: -32003,
  TIMEOUT: -32004,
  UNKNOWN_DOC: -32005,
} as const;

export class RpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message);
  }
}

type Envelope = {
  jsonrpc: "2.0";
  id: string;
  method: string;
  params: Record<string, unknown>;
  pubkey: string;
  to: string;
  sig: string;
};

function isObject(x: unknown): x is Record<string, unknown> {
  return x !== null && typeof x === "object" && !Array.isArray(x);
}

function validateEnvelope(body: unknown): Envelope {
  if (!isObject(body)) throw new RpcError(RpcErrors.INVALID_REQUEST, "body not an object");
  for (const f of ["jsonrpc", "id", "method", "pubkey", "to", "sig"]) {
    if (typeof body[f] !== "string" || (body[f] as string).length === 0) {
      throw new RpcError(RpcErrors.INVALID_REQUEST, `envelope.${f} must be a non-empty string`);
    }
  }
  if (body.jsonrpc !== "2.0") {
    throw new RpcError(RpcErrors.INVALID_REQUEST, `jsonrpc must be "2.0"`);
  }
  if (!isObject(body.params)) {
    throw new RpcError(RpcErrors.INVALID_REQUEST, "envelope.params must be an object");
  }
  return body as unknown as Envelope;
}

function jsonRpcSuccess(id: string, result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }, null, 2), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function jsonRpcError(id: string | null, err: RpcError, status = 200): Response {
  return new Response(
    JSON.stringify(
      {
        jsonrpc: "2.0",
        id,
        error: { code: err.code, message: err.message, data: err.data },
      },
      null,
      2,
    ),
    {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    },
  );
}

/** Top-level RPC handler. Wire it from main.ts. */
export async function handleRpc(
  req: Request,
  ctx: { bankPubkey: string; bankPrivateKey: Uint8Array; db: BankDB; registry: Registry },
): Promise<Response> {
  let bodyText: string;
  try {
    bodyText = await req.text();
  } catch (err) {
    return jsonRpcError(null, new RpcError(RpcErrors.PARSE_ERROR, "could not read body"), 400);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch {
    return jsonRpcError(null, new RpcError(RpcErrors.PARSE_ERROR, "invalid JSON"), 400);
  }

  let env: Envelope;
  try {
    env = validateEnvelope(parsed);
  } catch (err) {
    if (err instanceof RpcError) return jsonRpcError(null, err, 400);
    throw err;
  }

  // Bind to recipient (this bank). Prevents cross-bank replay.
  if (env.to !== ctx.bankPubkey) {
    return jsonRpcError(env.id, new RpcError(RpcErrors.SIG_INVALID, "envelope.to does not match this bank"), 400);
  }

  // Verify the signature over the envelope (minus sig).
  if (!verifyDoc(env, env.sig, env.pubkey)) {
    return jsonRpcError(env.id, new RpcError(RpcErrors.SIG_INVALID, "signature verification failed"), 400);
  }

  // Claim the ULID atomically.
  const fresh = await ctx.db.claimUlid(env.pubkey, env.id, env.to);
  if (!fresh) {
    return jsonRpcError(
      env.id,
      new RpcError(RpcErrors.REPLAY, `replay: id ${env.id} already seen from ${env.pubkey}`),
      400,
    );
  }

  const handler = ctx.registry[env.method];
  if (!handler) {
    return jsonRpcError(
      env.id,
      new RpcError(RpcErrors.METHOD_NOT_FOUND, `method not found: ${env.method}`),
      404,
    );
  }

  try {
    const result = await handler(env.params, {
      db: ctx.db,
      bankPubkey: ctx.bankPubkey,
      bankPrivateKey: ctx.bankPrivateKey,
      senderPubkey: env.pubkey,
      requestId: env.id,
    });
    return jsonRpcSuccess(env.id, result);
  } catch (err) {
    if (err instanceof RpcError) return jsonRpcError(env.id, err, 200);
    const msg = err instanceof Error ? err.message : String(err);
    return jsonRpcError(env.id, new RpcError(RpcErrors.INTERNAL, msg), 500);
  }
}
