# Deno Deploy operations for barter.game

Skill for managing the `apps/bank/` server on new Deno Deploy (console.deno.com).

## Scope

- Create / update a Deno Deploy application for the barter.game bank server.
- Provision and assign Deno KV databases.
- Generate and rotate bank private keys.
- Set environment variables and deploy.
- Read logs and troubleshoot common failures.

## CLI basics

New Deno Deploy is driven by the `deno deploy` subcommand (not the old `deployctl`).

```bash
# Authenticate (opens browser if no DENO_DEPLOY_TOKEN)
deno deploy --help

# Or use a token from the org dashboard
export DENO_DEPLOY_TOKEN=ddo_...
```

> `deno deploy login` does not exist. Authentication is via browser flow or `DENO_DEPLOY_TOKEN` / `--token`.

## Create the app

The bank server lives in `apps/bank/main.ts` and imports `packages/protocol/` via relative paths, so deploy from the repo root.

If the app does not exist yet, the first deploy will create it automatically:

```bash
cd /Users/xo/barter.game
deno deploy \
  --org ai-1st \
  --app barter-game-banks \
  --prod \
  --no-wait
```

For a GitHub-connected app with autodeploy, use the Deno Deploy dashboard or CLI's Git source flags (`--source github --owner ai-1st --repo barter.game --entrypoint apps/bank/main.ts --runtime-mode dynamic --region global`).

## Provision and assign KV

`apps/bank/main.ts` calls `await Deno.openKv()`. On new Deno Deploy this requires a provisioned `denokv` database assigned to the app.

```bash
# Create the database
deno deploy database provision --org ai-1st --kind denokv barter-game-banks-kv

# Attach it to the app
deno deploy database assign --org ai-1st --app barter-game-banks barter-game-banks-kv
```

Assignment can take a few seconds; if the first deploy after assignment fails, wait and redeploy.

## Generate bank private keys

The server reads any number of `BANK_<NAME>_PRIV_KEY` environment variables.

```bash
# One key
cd /Users/xo/barter.game
bun run scripts/genkey.ts

# Multiple keys for the demo banks
tmpenv=$(mktemp)
for name in ALICE BOB CAROL DAVE; do
  key=$(bun run scripts/genkey.ts 2>/dev/null | grep '^BANK_PRIV_KEY=' | cut -d= -f2)
  echo "BANK_${name}_PRIV_KEY=${key}" >> "$tmpenv"
done
cat "$tmpenv"   # only in a secure session; never commit this file
```

Never commit keys. Load them into Deno Deploy and delete the temp file.

## Set environment variables

### One at a time

```bash
deno deploy env add \
  --org ai-1st --app barter-game-banks \
  BANK_ALICE_PRIV_KEY <base58-private-key>
```

### From a `.env` file

```bash
deno deploy env load --org ai-1st --app barter-game-banks ./bank-keys.env
```

To overwrite existing values, add `--replace`:

```bash
deno deploy env load --org ai-1st --app barter-game-banks --replace ./bank-keys.env
```

List current vars:

```bash
deno deploy env list --org ai-1st --app barter-game-banks
```

## Deploy

```bash
cd /Users/xo/barter.game
deno deploy \
  --org ai-1st \
  --app barter-game-banks \
  --prod \
  --no-wait
```

- Omit `--prod` for a preview deployment.
- Add `--no-wait` to return immediately without waiting for the build.
- The deploy uploads the working directory; `node_modules`, `old`, `website`, and `apps/cli` are harmless but can be ignored if desired.

## Verify the deployment

The app exposes:

- `GET /` — health + list of served banks
- `GET /<name>/barter-bank.json` — discovery doc
- `POST /<name>/rpc` — JSON-RPC endpoint

For this app the canonical URL is:

```bash
curl https://barter-game-banks.ai-1st.deno.net/
curl https://barter-game-banks.ai-1st.deno.net/alice/barter-bank.json
```

## Logs and troubleshooting

Stream runtime logs:

```bash
deno deploy logs --org ai-1st --app barter-game-banks
```

If a revision fails and the CLI only says "Please view the revision in the dashboard", open the build URL it printed (e.g. `https://console.deno.com/ai-1st/barter-game-banks/builds/<id>`) and read the build/runtime log.

Common failures:

| Symptom | Cause | Fix |
|---|---|---|
| `revision failed` right after create | KV database not provisioned / assigned | Run `database provision` + `assign`, then redeploy |
| App boots then crashes on `Deno.openKv()` | KV assignment not active yet | Wait a few seconds and redeploy |
| `The requested app was not found` | App hasn't been created | Run `deno deploy create` first |
| `Missing required option --runtime-mode` | `--runtime-mode` omitted | Use `--runtime-mode dynamic` |
| `Missing required option --source` | `--source github --owner --repo` omitted | Add GitHub source flags |
| `Missing required option --region` | `--region` omitted | Add `--region global` |
| `barter-bank.json` returns `bank-not-found` | `BANK_<NAME>_PRIV_KEY` env vars not set | Generate keys and `deno deploy env load` them, then redeploy |
| Build fails when importing protocol/crypto | New Deno Deploy doesn't resolve `npm:` specifiers | Map bare specifiers to `https://esm.sh/...` in `deno.json` |

## Import maps for Deno Deploy

New Deno Deploy (console.deno.com) currently does **not** resolve `npm:` specifiers. The project keeps the protocol library's source imports as bare specifiers (e.g. `@noble/ed25519`) and resolves them differently per runtime:

- **Bun**: uses `node_modules` via `packages/protocol/package.json`.
- **Deno / Deno Deploy**: uses `deno.json` import map pointing to `https://esm.sh/...` URLs.

Current `deno.json` mappings (check `deno.json` for the live versions):

```json
{
  "imports": {
    "@noble/ed25519": "https://esm.sh/@noble/ed25519@3.1.0",
    "@noble/hashes/sha2.js": "https://esm.sh/@noble/hashes@2.2.0/sha2.js",
    "@scure/base": "https://esm.sh/@scure/base@2.2.0",
    "ulid": "https://esm.sh/ulid@2.3.0"
  }
}
```

After changing import URLs, run the full test matrix before deploying:

```bash
bun run test:all
```

## Rotating keys

1. Generate new keys.
2. Load them with `deno deploy env load` (this overwrites existing values of the same name).
3. Redeploy.

## GitHub autodeploy

For autodeploy on merge, the project uses `.github/workflows/deploy.yml`. New Deno Deploy may use a different action or native Git integration. If switching, replace the workflow with the new Deno Deploy GitHub action and store bank keys as repository secrets or Deno Deploy env vars.

## Security reminders

- Bank private keys live only in Deno Deploy env vars and local temp files.
- Never print keys in logs or commit them.
- Rotate keys if they are ever exposed.
