// Signed-RPC client used by every CLI command.
//
// Wraps fetch with the request-envelope construction defined in the design doc
// (Protocol section). Signs the envelope with the user's private key, posts
// to `<bank-url>/rpc`, parses the JSON-RPC 2.0 response, throws on error.

import {
  newUlid,
  signDoc,
} from "../../../packages/protocol/src/index.ts";

import type { Profile } from "./profile.ts";
import { profilePrivateKeyBytes } from "./profile.ts";

export class RpcError extends Error {
  constructor(public code: number, message: string, public data?: unknown) {
    super(message);
  }
}

/** Fetch the bank's pubkey from <bank-url>/barter-bank.json. Used to populate the `to` field. */
export async function fetchBankPubkey(bankUrl: string): Promise<string> {
  const url = `${bankUrl.replace(/\/$/, "")}/barter-bank.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
  const body = await res.json();
  if (typeof body.pubkey !== "string") {
    throw new Error(`bank ${bankUrl} barter-bank.json response missing pubkey`);
  }
  return body.pubkey;
}

export type CallOptions = {
  bankUrl?: string;
  toBankPubkey?: string;
};

/** Make a signed JSON-RPC call to the user's home bank. */
export async function call(
  profile: Profile,
  method: string,
  params: Record<string, unknown>,
  opts: CallOptions = {},
): Promise<unknown> {
  const bankUrl = opts.bankUrl ?? profile.defaultBankUrl;
  const toPubkey = opts.toBankPubkey ?? (await fetchBankPubkey(bankUrl));

  const envelope: Record<string, unknown> = {
    jsonrpc: "2.0",
    id: newUlid(),
    method,
    params,
    pubkey: profile.pubkey,
    to: toPubkey,
  };
  envelope.sig = signDoc(envelope, profilePrivateKeyBytes(profile));

  const res = await fetch(`${bankUrl.replace(/\/$/, "")}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });
  let body: { result?: unknown; error?: { code: number; message: string; data?: unknown } } = {};
  try {
    body = await res.json();
  } catch {
    throw new Error(`bank returned non-JSON (HTTP ${res.status})`);
  }
  if (body.error) {
    throw new RpcError(body.error.code, body.error.message, body.error.data);
  }
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${JSON.stringify(body)}`);
  }
  return body.result;
}
