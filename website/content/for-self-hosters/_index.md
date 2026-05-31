---
title: For Self-Hosters
---

## Run your own bank in 10 minutes

A barter.game bank is just an HTTP server that holds an ed25519 key and enforces a few invariants. You can run one on Supabase, a VPS, Cloudflare Workers, or a Raspberry Pi in your closet.

## The Supabase path (reference implementation)

This is the fastest way to get a live bank. It uses the same code that runs the demo.

### Prerequisites

- [Bun](https://bun.sh) installed
- [Supabase CLI](https://supabase.com/docs/guides/cli) installed and logged in
- A Supabase project (free tier works)

### Steps

```bash
# 1. Clone the repo and install
git clone https://github.com/ai-1st/barter.game.git && cd barter.game
bun install

# 2. Link your Supabase project
supabase link --project-ref <your-project-ref>

# 3. Apply the database schema
supabase db push

# 4. Generate a bank private key
bun run scripts/genkey.ts | sed 's/^BANK_PRIV_KEY/BANK_ALICE_PRIV_KEY/' > /tmp/key.env
supabase secrets set --env-file /tmp/key.env
rm /tmp/key.env

# 5. Deploy the protocol code and the bank function
bun run scripts/sync-protocol.ts
supabase functions deploy bank-alice --no-verify-jwt

# 6. Verify it's live
curl https://<your-ref>.supabase.co/functions/v1/bank-alice/
```

You now have a bank. Tell your friends about it. They run `barter init` against your URL and you're a tiny central bank in a federation of exactly however many people you've invited.

## The "bring your own server" path

Don't want Supabase? No problem. You need four things:

### 1. An HTTP server

Any language, any framework. You just need to handle:
- `POST /rpc` — the JSON-RPC envelope
- `GET /.well-known/barter-bank.json` — bank identity discovery

### 2. An ed25519 keypair

Generate it however you like. The private key stays on the server. The pubkey is your bank's identity.

### 3. Storage that enforces two invariants

- **Sum-to-zero:** For any Promise, the sum of all account balances equals zero (or the limit).
- **One active hold per account:** No two in-flight transactions can lock the same debit account simultaneously.

Postgres with a partial unique index is one way. SQLite with application-level locking is another. An in-memory store with mutexes works for demos.

### 4. The protocol handlers

Implement the methods in `PROTOCOL.md` §7. The reference handlers in `supabase/functions/_shared/bank/handlers/` are a working example you can read and adapt.

## Security checklist

- [ ] **Pin your bank's pubkey everywhere.** Clients should store `{pubkey, url}` and reject `.well-known` responses that diverge.
- [ ] **Backup your private key.** Lose it and every Promise issued by your bank becomes orphaned.
- [ ] **Rate-limit RPC endpoints.** Even cheap verification adds up.
- [ ] **Don't expose your database directly.** The Edge Function / server is the trust boundary.
- [ ] **Monitor the sum invariant.** Alert if it ever drifts.

## Federation

Your bank does not need permission from anyone to join the network. There is no central registry in v1. Clients discover you by:

1. Hardcoding your URL+pubkey in their config.
2. Receiving an invite string from one of your users.
3. Checking `.well-known/barter-bank.json` and comparing against a pinned pubkey.

In v1.5 we may add a federated directory. For now, word of mouth is the discovery mechanism — which is exactly right for the trust model.

## Read more

- [Protocol contract →](https://github.com/ai-1st/barter.game/blob/main/PROTOCOL.md)
- [Implementation details →](https://github.com/ai-1st/barter.game/blob/main/IMPLEMENTATION.md)
- [Database schema →](https://github.com/ai-1st/barter.game/blob/main/SCHEMA.md)
- [Developer guide →](../for-developers)
