// Generate a fresh ed25519 keypair for a bank using the new protocol module.
import { base58Encode, genKeyPair } from '../apps/bank/protocol.ts';

const { privateKey, publicKey } = genKeyPair();
console.log(`BANK_PRIV_KEY=${base58Encode(privateKey)}`);
console.log(`BANK_PUB_KEY=${base58Encode(publicKey)}`);
