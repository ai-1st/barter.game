import { publicKeyOf, base58Decode, type Base58PubKey } from '@barter.game/protocol';
import type { Bank } from './types.ts';

export type LoadedBank = {
  name: string;
  pubkey: Base58PubKey;
  privateKey: Uint8Array;
};

const BANK_ENV_RE = /^BANK_([A-Z0-9_]+)_PRIV_KEY$/;

export function loadBankKeys(): LoadedBank[] {
  const banks: LoadedBank[] = [];
  for (const [key, value] of Object.entries(Deno.env.toObject())) {
    const m = key.match(BANK_ENV_RE);
    if (!m || !value) continue;
    const name = m[1]!.toLowerCase().replace(/_/g, '-');
    try {
      const privateKey = base58Decode(value);
      if (privateKey.length !== 32) {
        console.error(`Bank ${name}: private key must decode to 32 bytes`);
        continue;
      }
      const { pubkeyBase58 } = publicKeyOf(privateKey);
      banks.push({ name, pubkey: pubkeyBase58, privateKey });
    } catch (e) {
      console.error(`Bank ${name}: failed to load key: ${e}`);
    }
  }
  return banks;
}

export function createBank(
  loaded: LoadedBank,
  kv: Deno.Kv,
  url: string,
): Bank {
  return { ...loaded, kv, url };
}
