---
title: For Self-Hosters
---

## Run your own bank in 10 minutes

A barter.game bank is just an HTTP server that holds an ed25519 key and enforces a few invariants. The reference implementation runs on Deno Deploy using Deno KV, but you can port it to any stack that meets the protocol contract.

## The Deno Deploy path (reference implementation)

This is the fastest way to get a live bank. It uses the same code that runs the demo.

### Prerequisites

- [Bun](https://bun.sh) installed (for local tooling and key generation)
- A [Deno Deploy](https://deno.com/deploy) account
- A GitHub repository for the project

### Steps

```bash
# 1. Clone the repo and install
git clone https://github.com/ai-1st/barter.game.git && cd barter.game
bun install

# 2. Generate a bank private key
bun run scripts/genkey.ts | sed 's/^BANK_PRIV_KEY/BANK_ALICE_PRIV_KEY/' > /tmp/key.env
#    The file contains one line: BANK_ALICE_PRIV_KEY=<base58>

# 3. Create a Deno Deploy project and link the repo
#    - Go to https://deno.com/deploy
#    - Create a project; note its name
#    - Connect the GitHub repository

# 4. Configure GitHub variables and secrets
#    - Repository variable: DENO_DEPLOY_PROJECT = <your-project-name>
#    - Repository secret:   BANK_ALICE_PRIV_KEY = <the key from /tmp/key.env>
#    Add BANK_BOB_PRIV_KEY, BANK_CAROL_PRIV_KEY, etc. to serve more banks from the same project.

# 5. Push to main
#    .github/workflows/deploy.yml deploys apps/bank/main.ts automatically.

# 6. Verify it's live
curl https://<your-project>.deno.dev/alice/barter-bank.json
```

You now have a bank. Tell your friends about it. They run `barter init` against your URL and you're a tiny central bank in a federation of exactly however many people you've invited.

## The "bring your own server" path

Don't want Deno Deploy? No problem. You need four things:

### 1. An HTTP server

Any language, any framework. You just need to handle:
- `POST /<name>/rpc` — the JSON-RPC envelope
- `GET /<name>/barter-bank.json` — bank identity discovery
- `GET /<name>/address/<pubkey>` and `POST /<name>/address` — address directory (optional but recommended)

### 2. An ed25519 keypair

Generate it however you like. The private key stays on the server. The pubkey is your bank's identity.

### 3. Storage that enforces two invariants

- **Sum-to-zero:** For any Promise, the sum of all account balances equals zero (or the limit).
- **One active hold per account:** No two in-flight transactions can lock the same debit account simultaneously.

Deno KV with atomic check-and-set is one way. Postgres with a partial unique index is another. SQLite with application-level locking works for smaller deployments. An in-memory store with mutexes works for demos.

### 4. The protocol handlers

Implement the methods in `PROTOCOL.md` §7. The reference handlers in `apps/bank/handlers/` are a working example you can read and adapt.

## Security checklist

- [ ] **Pin your bank's pubkey everywhere.** Clients should store `{pubkey, url}` and reject `barter-bank.json` responses that diverge.
- [ ] **Backup your private key.** Lose it and every Promise issued by your bank becomes orphaned.
- [ ] **Rate-limit RPC endpoints.** Even cheap verification adds up.
- [ ] **Don't expose your database directly.** The Deno Deploy process / server is the trust boundary.
- [ ] **Monitor the sum invariant.** Alert if it ever drifts.

## Federation

Your bank does not need permission from anyone to join the network. There is no central registry in v1. Clients discover you by:

1. Hardcoding your URL+pubkey in their config.
2. Receiving an invite string from one of your users.
3. Checking `/<name>/barter-bank.json` and comparing against a pinned pubkey.

In v1.5 we may add a federated directory. For now, word of mouth is the discovery mechanism — which is exactly right for the trust model.

## Read more

- [Protocol contract →](https://github.com/ai-1st/barter.game/blob/main/PROTOCOL.md)
- [Implementation details →](https://github.com/ai-1st/barter.game/blob/main/IMPLEMENTATION.md)
- [Database schema →](https://github.com/ai-1st/barter.game/blob/main/SCHEMA.md)
- [Developer guide →](../for-developers)
