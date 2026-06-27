import type { Base58PubKey } from '@barter.game/protocol';

export type Bank = {
  name: string;
  pubkey: Base58PubKey;
  privateKey: Uint8Array;
  kv: Deno.Kv;
  url: string;
  // True when url came from a BANK_<NAME>_URL env override and must not be
  // overwritten by request-host derivation.
  urlPinned?: boolean;
  // True once url has been resolved from an incoming request origin.
  urlResolved?: boolean;
};

export type RpcContext = {
  bank: Bank;
  senderPubkey: Base58PubKey;
};

export type JsonRpcError = {
  code: number;
  message: string;
  data?: unknown;
};
