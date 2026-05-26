#!/usr/bin/env bun
// Generate a fresh ed25519 keypair for a bank. Prints:
//   PRIV_KEY=<base58-32-bytes>
//   PUB_KEY=<base58-32-bytes>
//
// Use to bootstrap a new bank function:
//   bun run scripts/genkey.ts > /tmp/bank-alice.env
//   supabase secrets set --env-file /tmp/bank-alice.env
//   rm /tmp/bank-alice.env
//
// Never commit the resulting private key.

import { base58Encode, genKeyPair } from "../packages/protocol/src/index.ts";

const { privateKey, publicKey } = genKeyPair();
process.stdout.write(`BANK_PRIV_KEY=${base58Encode(privateKey)}\n`);
process.stdout.write(`BANK_PUB_KEY=${base58Encode(publicKey)}\n`);
