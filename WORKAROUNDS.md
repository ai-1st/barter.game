# barter.game Web UI Implementation — Workarounds & Known Blockers

This file documents contradictions and blockers found while implementing the backend and frontend against `docs/ui/claude-ui.md` and the `protocol/` contract, and the workarounds chosen so the project can move forward.

## Source-of-truth documents

- UI spec: `docs/ui/claude-ui.md`
- Protocol contract: `protocol/README.md`, `protocol/base.md`, `protocol/bank-schema.md`, `protocol/bank-rpc.md`

---

## 1. The legacy `old/` implementation did not comply with the protocol contract — now removed

### Resolution

The archived implementation under `old/` (the Supabase/Postgres bank, the `@barter.game/protocol` reference library, and the CLI) predated the protocol rework in `protocol/`: it used `submit_tx`/`Tx` instead of `submit_docs`/`Order`, had no `Confirm` gate, carried `account`/`pair` on records instead of `details`/`deal_id`/`order`, exposed a `mint` method, and shipped two conflicting `Account` types.

A new backend was built from scratch in `apps/bank/` implementing the `protocol/` contract directly, and the shared primitives now live in `packages/protocol/`. The `old/` tree has since been **removed from the repository** (it was reference-only and no longer needed), which also eliminates the duplicate `@barter.game/protocol` workspace package described in §7. The crypto/canonical helpers were re-implemented in `packages/protocol/src/index.ts` against the RFC 8785 / JCS requirement in `protocol/base.md §2` (verified by golden-vector tests under both Bun and Deno).

---

## 2. Full Argon2id-in-browser key encryption is deferred

### Blocker

`docs/ui/claude-ui.md §4` and `§10.1` mandate Argon2id (`m=64 MiB, t=3, p=1`) with XChaCha20-Poly1305 for the encrypted keystore, plus a PBKDF2 fallback. Shipping a WASM Argon2id build inside the SPA, with strict CSP/SRI, adds significant build complexity and bundle size.

### Workaround

The first working version uses **PBKDF2-HMAC-SHA-256 + AES-GCM via Web Crypto** for the keystore blob. This satisfies the hard invariant that the plaintext private key and password never leave the browser, while keeping the frontend a plain HTML/JS app with no WASM build step. Argon2id is listed as a future upgrade in `docs/ui/claude-ui.md §12` and the spec explicitly allows PBKDF2 as a fallback (`docs/ui/claude-ui.md §4`, `docs/ui/kimi-ui.md §2.2`).

---

## 3. Multi-bank lead/follow settlement is complex and error-prone

### Blocker

Implementing a fully correct cross-bank advance engine (lead/follow `hold`/`settle` cascade, `Signature.seen` predecessor proofs, subscription fan-out, relay recovery) from scratch in one pass is a large correctness-critical task.

### Workaround

The implementation prioritizes **same-bank Invoice/Cheque settlement first** (a single bank self-advances `ready → hold → settle`). Cross-bank swaps are implemented on top of the same primitives with the bank acting as matchmaker via `/ui/propose_deal`; the advance engine handles the lead/follow logic. The UI exposes a manual "Relay" button for signature recovery. This matches the protocol's own fallback story (`protocol/bank-rpc.md §4 step 7`).

---

## 4. The UI spec describes many screens; not all are built in the first pass

### Blocker

`docs/ui/claude-ui.md §8` enumerates dozens of screens (Dashboard, Wallet, Activity, Vouchers, Orders, Invoices, Cheques, Discover, Network, Settings, Deal flow, etc.). Building every screen to full spec is beyond a single implementation pass.

### Workaround

The first frontend implements the minimal end-to-end flow: **Register / Unlock → Create Voucher → Create Invoice/Cheque → Discover → Accept / Pay → Deal status**. Other screens exist as stub routes or are omitted. The custom backend API is shaped so the missing screens can be added later without protocol changes.

---

## 5. Deno Deploy deployment may require project setup that cannot be automated from here

### Blocker

Deno Deploy requires a project, GitHub linking, and env vars (`BANK_<NAME>_PRIV_KEY`) configured in the dashboard. The repo already has `.github/workflows/deploy.yml` and `deno.json` with deploy metadata, but actually creating the project and setting secrets requires owner access to the Deno Deploy dashboard/GitHub repo.

### Workaround

The backend is built to run on Deno Deploy (`Deno.serve`, `Deno.openKv()`, env-var bank keys). If dashboard setup is not possible during this task, the backend is started locally with `deno run --allow-env --allow-net --unstable-kv apps/bank/main.ts` so it can be verified end-to-end. Deployment instructions are recorded in `README.md`.

---

## 6. `base64url` encoding in Barter Link fragments uses built-in browser APIs

### Blocker

`docs/ui/claude-ui.md §5` requires DEFLATE + base64url for inline Barter Link payloads. A fully self-contained implementation would bundle a deflate library.

### Workaround

Reference-mode Barter Links are used for QR/link sharing (short URL resolved by the bank). Inline mode is implemented using the browser's native `CompressionStream`/`DecompressionStream` where available, with a fallback to reference mode. This preserves the "same link, two readers" architecture for the common case.

---

## 7. Corrupted protocol import specifier + workspace name collision (RESOLVED)

### Contradiction

Every file in `apps/bank/` imported the shared protocol package as `from '.game/protocol'` (e.g. [`apps/bank/main.ts:5`](apps/bank/main.ts), [`apps/bank/env.ts:1`](apps/bank/env.ts)) — a corrupted specifier (the `@barter` prefix was stripped) that resolves to nothing under Deno. `deno check apps/bank/main.ts` failed with `TS2307: Import ".game/protocol" not a dependency` on all 19 import sites.

Separately, **two workspace packages are both named `@barter.game/protocol`**: the new [`packages/protocol/package.json`](packages/protocol/package.json) and the legacy `old/packages/protocol/package.json` (since removed). `bun.lock` resolved the name to `old/packages/protocol`, and `node_modules/@barter.game/protocol` symlinks to the legacy (non-compliant) package — so even a *correct* bare import would have pulled the wrong code.

### Workaround

- Repaired the 19 specifiers to `@barter.game/protocol`.
- Added a Deno import map in [`deno.json`](deno.json) pinning `@barter.game/protocol` → `./packages/protocol/src/index.ts` (the new, compliant package) and the npm deps it needs, bypassing the ambiguous `node_modules` symlink.

The duplicate package name has since been eliminated: the `old/` tree (including `old/packages/protocol`) was removed from the repo and dropped from `package.json` `workspaces`, so `@barter.game/protocol` now resolves unambiguously to `packages/protocol` (confirmed in `bun.lock`). The Deno import map remains the source of truth for the bank server.

---

## 8. `apps/web/app.js` syntax error broke the entire SPA (RESOLVED)

### Blocker

[`apps/web/app.js`](apps/web/app.js) had an unbalanced `${card('Offers', …` interpolation in `renderDiscover` (the `card(` call was never closed before the `}`). This is a hard parse error, so the ES module never loaded and **nothing rendered** — the `#app` div stayed empty in the browser. `node --check apps/web/app.js` reported `missing ) after argument list` at the offending line.

### Workaround

Added the missing `)`. `node --check` now passes and the SPA renders (verified end-to-end in a browser: welcome → register with in-browser key encryption → dashboard → create & sign voucher).

---

## 9. `/ui/config` was behind auth, breaking SPA bootstrap (RESOLVED)

### Contradiction

The SPA fetches `GET /:bank/ui/config` during bootstrap — **before any user is unlocked** — to learn the bank's pubkey/url ([`apps/web/app.js` `fetchConfig`](apps/web/app.js)). But the route was defined *after* the `requireAuth` gate in [`apps/bank/ui.ts`](apps/bank/ui.ts), so it returned `-32001 missing X-Barter-Auth` and the app rendered `Failed to load bank config`.

### Workaround

Moved `/config` into `handlePublicUiRoute` (no auth required); it returns only public bank info, identical to `/barter-bank.json`.

---

## 10. Deno Deploy blocks isolate self-fetch (508) — co-located banks couldn't transact (RESOLVED)

### Blocker

The matchmaker (`/ui/propose_deal`) and the advance engine reach participating banks over HTTP via [`apps/bank/peer.ts`](apps/bank/peer.ts) `fetchDiscovery` / `bankRpcCall`. On Deno Deploy, all four banks (`alice`, `bob`, `carol`, `dave`) run in **one deployment**, so these are self-requests. Deno Deploy **hard-blocks an isolate from fetching its own deployment URL**, returning:

```
508 Loop Detected — Loop detected: the deployment is fetching itself.
```

(Confirmed empirically with a temporary self-fetch probe.) The result was `-32013 pinning mismatch` on `propose_deal`, and any cross-bank hop would have failed the same way. This works fine locally (localhost self-fetch is allowed), so it only surfaces on deployment.

### Workaround

Added an in-process dispatch path ([`apps/bank/local.ts`](apps/bank/local.ts) registry + branches in [`apps/bank/peer.ts`](apps/bank/peer.ts)): when a target bank's pubkey is served by this same process, `bankRpcCall` invokes the registry handler directly and `fetchDiscovery` answers from memory instead of issuing an HTTP request. Genuine cross-deployment banks still use HTTP. Same-bank settlement now completes end-to-end on the live deployment.

---

## 11. Bank canonical URL hardcoded to `localhost` (RESOLVED)

### Contradiction

[`base.md §5.1`](protocol/base.md) / [`bank-rpc.md §3`](protocol/bank-rpc.md): the `url` in `barter-bank.json` "MUST be a prefix of the URL from which `barter-bank.json` was fetched." But [`apps/bank/main.ts`](apps/bank/main.ts) fell back to `http://localhost:8000/<name>` whenever `BANK_<NAME>_URL` was unset, so the deployed bank advertised a localhost URL and signed its Address doc with it — breaking the prefix rule and cross-bank discovery.

### Workaround

`main.ts` now derives the bank URL from the incoming request origin on first contact (`resolveBankUrl`) and re-signs the Address doc to match, unless `BANK_<NAME>_URL` pins it explicitly. Deployed `barter-bank.json` now reports the real origin (e.g. `https://barter-game-banks.ai-1st.deno.net/alice`).

---

## 12. Cross-bank deals could not resolve the foreign Offer (RESOLVED)

### Resolution (chosen by the protocol author)

Reference **Orders, not Offers**, in `create_records`. An Order is one holder-signed doc with a single canonical hash, and [`bank-schema.md §1.4`](protocol/bank-schema.md) already requires the holder to submit that *same* Order to every bank its sides touch — so the Order hash resolves identically at every participating bank, where a per-bank Offer hash cannot. Offers remain the discovery surface; the matchmaker reads the canonical Order hash from a published Offer's `order` field. This is exactly what [`bank-schema.md §1.5`](protocol/bank-schema.md) ("a Record's `order` MAY reference either an `order` hash or an `offer` hash") and [`bank-rpc.md §2.2`](protocol/bank-rpc.md) ("Both Offers resolve to stored Orders, **or the bank already has the Orders**") permit.

Implemented:

- [`create_records.ts`](apps/bank/handlers/create_records.ts) — `resolveAuth()` resolves each reference hash as an **Order** hash (holder-signed, verified against `order.pubkey`) or, failing that, an **Offer** hash (bank-signed) pointing at the underlying Order. Matching and min/max now run off the Order's sides, and Records are written with `Record.order = <canonical Order hash>`. Same-bank flows that pass Offer hashes still work via the Offer fallback; the advance engine's [`resolveOrderForRecord`](apps/bank/advance.ts) already resolves either.
- [`apps/web/app.js`](apps/web/app.js) `acceptOffer` and `/discover` rendering now pass Order hashes (the discovered offer's `order` field) to `propose_deal`.

**Verified:** [`apps/bank/e2e-crossbank.ts`](apps/bank/e2e-crossbank.ts) — a bilateral VX@alice ⇄ VY@bob swap — settles both legs and produces correct balances (issuer −10 / counterparty +10 on each voucher, sum invariant zero per voucher) **both locally and on production** (`https://barter-game-banks.ai-1st.deno.net`). The lead/follow cascade runs across the two co-located banks in-process (see §10).

A spec clarification is still worth making: [`bank-rpc.md §2.2`](protocol/bank-rpc.md)'s phrase "At least one of them was issued by this bank" describes the Offer framing; under the Order-keyed model the invariant is "both Orders contribute a side for this bank's voucher," which `create_records` enforces directly.

<details><summary>Original contradiction (for the record)</summary>

A bilateral cross-bank swap (two vouchers issued at two different banks) could not complete with the original code. The chain of facts:

1. [`bank-rpc.md §2.2`](protocol/bank-rpc.md): "The matchmaker passes the **same** `offer1` and `offer2` to every participating bank," and each bank verifies "Both Offers are valid and bank-signed. At least one of them was issued by this bank; the other may be foreign."
2. [`create_records.ts:47-50`](apps/bank/handlers/create_records.ts) enforces this literally: it calls `getOffer(bank, hash)` for **both** offer hashes and throws `-32005 one or both offers unknown` if either is missing from this bank's store.
3. But Offers are **per-bank derivations**: each bank signs its own Offer doc for a given Order ([`bank-schema.md §1.5`](protocol/bank-schema.md), [`submit_docs.ts:155`](apps/bank/handlers/submit_docs.ts)), so bank A's Offer and bank B's Offer for the *same* Order have **different hashes**. The "foreign" offer hash a matchmaker passes is therefore unknown to the other bank.
4. There is **no path to share a foreign Offer doc**: [`submit_docs.ts`](apps/bank/handlers/submit_docs.ts) routes only `voucher | account | order | address | signature` (no `offer` case), and `handleProposeDeal` in [`apps/bank/ui.ts`](apps/bank/ui.ts) shares **Address** docs across banks but never **Offer** docs. The orchestration recipe in [`bank-rpc.md §4`](protocol/bank-rpc.md) likewise has no "share Offers" step, even though step 4's `create_records` requires them.

**Original reproduction:** the cross-bank swap failed at `propose_deal` with `-32005 one or both offers unknown`, because each bank only held its own derived Offer (different hash) and there was no path to share the foreign one ([`submit_docs.ts`](apps/bank/handlers/submit_docs.ts) had no `offer` route; `propose_deal` shared only Address docs).

</details>

---

## Deployment status (updates §5)

§5 above is **resolved**: the bank is deployed to Deno Deploy (EA) at **`https://barter-game-banks.ai-1st.deno.net`** under org `ai-1st`, app `barter-game-banks`, entrypoint `apps/bank/main.ts`. Four banks (`alice`/`bob`/`carol`/`dave`) are configured via `BANK_<NAME>_PRIV_KEY` env vars already present in the app. Production was verified end-to-end (registration, voucher, invoice/cheque, settle; balances obey the sum invariant). CI ([`.github/workflows/deploy.yml`](.github/workflows/deploy.yml)) was switched from the legacy `old/apps/bank/main.ts` deployctl path to `deno deploy --prod` and **now needs a `DENO_DEPLOY_TOKEN` repo secret**.

---

## Notes for future resolution

- Optionally update [`bank-rpc.md §2.2`](protocol/bank-rpc.md) wording so the `create_records` inputs are described as Order-or-Offer references (the Order-keyed model from §12), and add a note that the matchmaker reads the Order hash from a discovered Offer's `order` field.
- Restore/expand the full screen inventory once the backend is protocol-complete.
- Upgrade keystore encryption to Argon2id + XChaCha20-Poly1305 when a WASM build pipeline is added.
- Add automated golden-vector tests matching `protocol/base.md §2` cross-runtime parity.
