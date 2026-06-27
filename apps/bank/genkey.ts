import { base58Encode, genKeyPair } from '@barter.game/protocol';
const { privateKey, publicKey } = genKeyPair();
console.log('BANK_ALICE_PRIV_KEY=' + base58Encode(privateKey));
console.log('BANK_ALICE_PUB_KEY=' + base58Encode(publicKey));
