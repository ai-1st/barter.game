// Peer-bank HTTP client. Used by lead bank to call follow bank.
// Signs every request as THIS bank (using bankPrivateKey), so the peer can
// verify the envelope.

import { newUlid, signDoc } from "../protocol/crypto.ts";

export type PeerCallArgs = {
  bankUrl: string;
  bankPubkey: string;       // sender bank's pubkey (the one calling)
  bankPrivateKey: Uint8Array;
  peerPubkey: string;       // recipient bank's pubkey
  method: string;
  params: Record<string, unknown>;
};

export type PeerResult = { result?: unknown; error?: { code: number; message: string; data?: unknown } };

export async function callPeer(args: PeerCallArgs): Promise<PeerResult> {
  const envelope: Record<string, unknown> = {
    jsonrpc: "2.0",
    id: newUlid(),
    method: args.method,
    params: args.params,
    pubkey: args.bankPubkey,
    to: args.peerPubkey,
  };
  envelope.sig = signDoc(envelope, args.bankPrivateKey);

  const res = await fetch(`${args.bankUrl.replace(/\/$/, "")}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(envelope),
  });
  try {
    return (await res.json()) as PeerResult;
  } catch {
    return { error: { code: -32603, message: `peer non-JSON response HTTP ${res.status}` } };
  }
}

/** Resolve a peer's pubkey from its discovery endpoint. */
export async function resolvePeerPubkey(bankUrl: string): Promise<string> {
  const url = `${bankUrl.replace(/\/$/, "")}/barter-bank.json`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url}: HTTP ${res.status}`);
  const body = await res.json();
  if (typeof body.pubkey !== "string") {
    throw new Error(`peer ${bankUrl} barter-bank.json missing pubkey`);
  }
  return body.pubkey;
}
