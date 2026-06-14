# barter.game bank server

Deno Deploy entrypoint for one or more federated barter.game banks.

## Run locally

```bash
# Generate a keypair
bun run scripts/genkey.ts
# Copy BANK_PRIV_KEY value and export as BANK_ALICE_PRIV_KEY
export BANK_ALICE_PRIV_KEY=<base58-private-key>

# Start the server
deno run --allow-env --allow-net --allow-read --allow-write apps/bank/main.ts
```

The server is now at `http://localhost:8000`:

- `GET /` — health + list served banks
- `GET /alice/barter-bank.json` — discovery doc
- `POST /alice/rpc` — JSON-RPC endpoint
- `GET /alice/address/<pubkey>` — lookup Address doc
- `POST /alice/address` — store Address doc

## Run integration tests

```bash
bun run test:deno
```

## Deploy to Deno Deploy

1. Create a project at https://deno.com/deploy and link this GitHub repo.
2. Set the repository variable `DENO_DEPLOY_PROJECT` to the project name.
3. Set env vars `BANK_ALICE_PRIV_KEY`, `BANK_BOB_PRIV_KEY`, etc. in the Deno Deploy dashboard.
4. Push to `main`. `.github/workflows/deploy.yml` deploys automatically.

## Multi-bank on one project

A single Deno Deploy project can serve multiple banks at different paths. Each bank needs its own `BANK_<NAME>_PRIV_KEY` env var. For production federation, run one project per bank so each has an isolated key and KV namespace.
