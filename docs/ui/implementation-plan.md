# barter.game Web UI — Step-by-Step Implementation Plan

> Derived from `docs/ui/claude-ui.md`. Each phase is designed to be **small enough to code and test in one sitting**, but **meaningful enough to ship or demo on its own**. Every phase ends with **validation steps** — automated tests, curl/CLI checks, and manual UI verification.

---

## Phase 0 — Groundwork & Audit

**Goal:** confirm what already exists, pick the app location, and set up the build/test skeleton.

### 0.1 Audit existing protocol code
- Read `protocol/README.md`, `protocol/base.md`, `protocol/bank-schema.md`, `protocol/bank-rpc.md`.
- Inspect `old/packages/protocol/src/` for reusable canonical JSON, crypto, and schema utilities.
- Decide whether the new UI reuses `old/packages/protocol` or starts a fresh `packages/protocol` under the root.

**Validation:**
- `bun run typecheck` passes on the protocol package you will depend on.
- A one-line test prints a base58 ed25519 pubkey from a random seed under Bun and Deno.

### 0.2 Choose workspace location
- Either `apps/web/` (separate web app) or extend `apps/bank/` with `/ui/*` routes.
- The spec assumes the bank serves the SPA from its own origin, so `apps/bank/` plus a bundled `apps/web/` is the natural split.

**Validation:**
- `package.json` workspace entries exist and `bun install` succeeds.
- `bun run build` produces a static SPA bundle and the bank server can serve it.

### 0.3 Tooling skeleton
- TypeScript strict, ES modules, `.ts` imports.
- Test runner: `bun:test` for unit tests; Deno tests for cross-runtime parity where required.
- End-to-end: Playwright or Puppeteer for in-browser crypto + UI flows.
- Static server for local SPA dev (e.g. Vite or a small Deno/Bun file server).

**Validation:**
- `bun test` runs an empty test suite successfully.
- A CI-like command (`bun run typecheck && bun test`) passes.

### 0.4 Module boundaries
Create empty module directories/files:
```
apps/web/src/
  protocol/      # thin re-export of canonical crypto/signing
  crypto/        # keystore KDF/AEAD + memory hygiene
  auth/          # X-Barter-Auth signed-request auth
  rpc/           # protocol envelope signing + standard RPC calls
  uiapi/         # custom /ui/* API client
  barterlink/    # Barter Link builders + extractors + verifiers
  state/         # in-memory session, auto-lock, account switching
  components/    # reusable UI components
  screens/       # route-level screens
  router/        # SPA router + deep-link dispatch
```

**Validation:**
- `bun run typecheck` passes with empty modules exporting `void` placeholders.

---

## Phase 1 — Protocol Primitives

**Goal:** canonical JSON, hashing, base58, and ed25519 signing work in the browser and under test.

### 1.1 Canonical JSON (JCS/RFC 8785)
- Reuse or port the canonicalizer from the protocol package.
- Expose `canonicalJSON(value: unknown): string` and `hashDoc(doc): Uint8Array`.

**Validation:**
- Golden-vector tests pass: input object → expected canonical bytes → expected SHA-256 → expected base58 hash.
- Cross-runtime: same test runs under Bun and Deno with identical output.

### 1.2 ed25519 signing
- Use `@noble/ed25519` to sign `SHA-256(canonical(doc minus sig))`.
- Functions: `generateSeed()`, `getPublicKey(seed)`, `signDoc(doc, seed)`, `verifyDoc(doc, pubkey)`.

**Validation:**
- Round-trip: sign a `Voucher` doc, verify with derived pubkey, tamper one field → verify fails.
- Base58 encoding/decoding round-trips for pubkeys, hashes, and signatures.

### 1.3 Protocol envelope builder
- Build `{jsonrpc, id, method, params, pubkey, to, sig}` envelopes per `base.md §4`.

**Validation:**
- A signed `submit_docs` envelope verifies against the signer pubkey and bound bank `to`.

---

## Phase 2 — Client-Side Keystore Crypto

**Goal:** browser-only encryption/decryption of the ed25519 seed, plus recovery kit support.

### 2.1 KDF implementations
- Argon2id via `hash-wasm` WASM bundle (vendored under `apps/web/public/`).
- PBKDF2-HMAC-SHA-256 fallback using `crypto.subtle`.
- Expose `deriveKEK(password, salt, kdfParams): Promise<Uint8Array>`.

**Validation:**
- Argon2id with `m=65536, t=3, p=1, dkLen=32` derives a known test vector from a known password/salt.
- PBKDF2 with `600000` iterations matches a `crypto.subtle` reference vector.

### 2.2 AEAD encrypt/decrypt
- XChaCha20-Poly1305 via `@noble/ciphers` (or AES-256-GCM fallback).
- AAD = `"barter.game/v1|keystore|" + pubkey`.
- `encryptSeed(seed, password) => KeystoreBlob`; `decryptSeed(blob, password) => seed`.

**Validation:**
- Encrypt a seed, decrypt with correct password → original seed.
- Wrong password → AEAD tag failure, not silent corruption.
- Swapping AAD/pubkey → decryption fails.

### 2.3 Memory hygiene helpers
- Zero-fill password/KEK buffers after use (`Buffer` not allowed; use `Uint8Array.fill(0)`).
- Wrap the in-memory seed in a closure/`CryptoKey` and expose a `withSigner(callback)` pattern.

**Validation:**
- Unit test asserts that password/KEK arrays are zeroed after encrypt/decrypt.
- Linter rule forbids `Buffer` and `process.env` in `apps/web/src/crypto/`.

### 2.4 Recovery kit
- `.barterkey` file = JSON keystore blob + `pubkey` + metadata.
- BIP39 mnemonic encoding/decoding of the raw 32-byte seed (entropy ↔ words).

**Validation:**
- Seed → mnemonic → seed round-trip.
- `.barterkey` JSON import produces the same seed with the same password.

---

## Phase 3 — Signed-Request Authentication

**Goal:** every per-user custom call proves possession of the private key without sending it.

### 3.1 Build `X-Barter-Auth` (client)
- Authdoc: `{pubkey, method, path, id, ts, body_sha256}`.
- Header value: `<base64url(canonical(authdoc minus sig))>.<base58 sig>`.
- `id` is a ULID; `ts` is ms timestamp; `body_sha256` is base58 SHA-256 of raw body (omitted for empty GET).

**Validation:**
- Sign a sample `POST /ui/trusted` request; verify the authdoc signature server-side with a test harness.

### 3.2 Server middleware: parse and verify
- Middleware for the bank server extracts `X-Barter-Auth`, parses `authdoc`, verifies ed25519 signature, checks `body_sha256`, and binds `pubkey` to request context.

**Validation:**
- Valid header → `ctx.pubkey` set.
- Tampered body → `-32600`/`body_sha256 mismatch`.
- Wrong signature → `-32001`.

### 3.3 Replay & skew protection
- Maintain sliding replay window on `(pubkey, id)`.
- Reject `ts` outside ±120 s → `-32006`.
- Duplicate id → `-32002`.

**Validation:**
- Replaying the same header twice returns `-32002`.
- A header with `ts` 5 minutes ago returns `-32006`.

### 3.4 Optional challenge endpoint
- `GET /ui/challenge` returns `{nonce, exp}`; client may use `nonce` as `authdoc.id`; server marks unspent.

**Validation:**
- Using a spent/expired nonce returns an auth error.

---

## Phase 4 — Identity & Keystore API

**Goal:** registration, login, and password rotation work end-to-end.

### 4.1 `GET /ui/handle/:handle`
- Returns `{handle, available, pubkey?}`.
- Validates handle `[a-z0-9_-]{3,32}`.

**Validation:**
- `curl /ui/handle/alice` for a taken handle returns the bound pubkey.
- `curl /ui/handle/bob` for a free handle returns `available:true`.
- `curl /ui/handle/BAD` returns `-32600`.

### 4.2 `POST /ui/register`
- Body: `{handle, pubkey, proof, keystore}`.
- `proof` = signature over `sha256(canonical({handle, pubkey, keystore_sha256}))`.
- Store handle uniqueness + one-pubkey-per-handle.

**Validation:**
- Register a new keypair; verify handle lookup returns the pubkey.
- Re-register same handle → `-32008`.
- Invalid proof → `-32001`.

### 4.3 `GET /ui/keystore/:handle`
- Rate-limited: 5/handle/min, 30/IP/min.
- Returns `{handle, pubkey, keystore}`.

**Validation:**
- Fetch 6 times quickly for the same handle → 6th returns `-32010` with `retry_after`.
- Unknown handle returns `-32005`.

### 4.4 `PUT /ui/keystore`
- Signed-request auth; body is new keystore blob.
- Server verifies signer == bound pubkey.

**Validation:**
- Rotate password (re-encrypt + upload); old password fails, new password unlocks.
- Upload with wrong signer → `-32001`/`-32007`.

### 4.5 Client API wrapper (no UI yet)
- Functions: `register(handle, password)`, `unlock(handle, password)`, `rotatePassword(oldPw, newPw)`.

**Validation:**
- End-to-end script: register → unlock → sign a doc → rotate → unlock with new password.

---

## Phase 5 — Per-User State API

**Goal:** trusted issuers, contacts, known banks, catalog, drafts, prefs stored per pubkey.

### 5.1 `GET /ui/state` / `PUT /ui/state`
- Full blob read/replace with `rev` optimistic concurrency.
- Sub-resource writes bump `rev`.

**Validation:**
- `PUT` with stale `rev` → `-32011`.
- Concurrent sub-resource writes increment `rev` correctly.

### 5.2 `/ui/trusted` CRUD
- `POST /ui/trusted {pubkey}` idempotent add.
- `DELETE /ui/trusted/:pubkey`.

**Validation:**
- Add, list, delete; malformed pubkey → `-32012`.

### 5.3 `/ui/contacts` CRUD
- Same pattern with `{pubkey, handle?, note?}`.

### 5.4 `/ui/banks` CRUD
- `{pubkey, url}`; server validates URL shape only.

### 5.5 `/ui/catalog`, `/ui/drafts`, `/ui/prefs`
- Bulk catalog replace; drafts with `id`, `kind`, `body`; prefs with `theme`, `default_bank`, `encrypt_state`.

**Validation (all 5.x):**
- Each endpoint returns updated array/`rev`.
- All require `X-Barter-Auth`; unauthenticated → `-32001`.
- `GET /ui/state` reflects all sub-resource mutations.

---

## Phase 6 — Aggregation / Read Helpers

**Goal:** the UI can show portfolio, history, and orders without fanning out from the browser.

### 6.1 `GET /ui/portfolio`
- Accepts `reads[]` of pre-signed `list_accounts` envelopes per bank.
- Calls each issuer bank, then `get_account_balance` per account.
- Returns `{as_of, holdings[], unreachable[]}`.

**Validation:**
- With one local issuer bank, portfolio shows correct `current`/`pending`.
- Simulated unreachable bank returns entry in `unreachable[]` and HTTP 200.

### 6.2 `GET /ui/history`
- Assemble timeline from `get_record_signatures` for records touching the user.
- Query params: `account`, `since`, `limit`, `cursor`.

**Validation:**
- After a settled deal, history contains both sides with state `settled`.
- Cursor pagination returns consistent pages.

### 6.3 `GET /ui/orders`
- Returns user Orders annotated with derived Offer hashes and `state` (`open`/`matched`/`settled`/`expired`).

**Validation:**
- Submit an Order → `/ui/orders` lists it as `open`.
- After match → state updates to `matched`/`settled`.

### 6.4 `GET /ui/feed`
- Convenience home-activity endpoint over `/ui/history`.

**Validation:**
- Returns the N most recent events.

---

## Phase 7 — Discovery, Relay, Resolution

**Goal:** cross-bank operations from the browser without opening CORS on every peer.

### 7.1 `POST /ui/discover`
- Fan-out to known banks’ `list_offers(voucher_hash, intention)`.
- Cache per `(bank, voucher, intention)` TTL ≈ 15 s.
- Return merged `offers[]`, `polled[]`, `unreachable[]`.

**Validation:**
- Publish an Offer on bank A; discover from bank B (with A in known banks) finds it.
- Rapid repeated calls within 15 s hit cache.

### 7.2 `POST /ui/relay`
- Outer signed-request auth; inner envelope is a standard JSON-RPC request already signed by user.
- Pin target `bank_url` against `barter-bank.json` before forwarding.

**Validation:**
- Relay a `submit_docs` envelope to another local bank; response passes through.
- Pinning mismatch → `-32013`.
- Destination unreachable → `-32014`.

### 7.3 `POST /ui/relay_signatures`
- Pull `get_record_signatures` from `from` bank, push `notify_signatures` to `to` bank.

**Validation:**
- After deliberately dropping a signature push, calling relay_signatures advances the stuck deal.

### 7.4 `GET /ui/resolve/:pubkey`
- Look up `Address` doc / `barter-bank.json` for a pubkey.

**Validation:**
- Resolve a bank pubkey → returns `{pubkey, url, verified:true/false}`.
- Unknown pubkey → `-32005`.

---

## Phase 8 — Matchmaker Trigger

**Goal:** one-click deal execution via bank-as-matchmaker.

### 8.1 `POST /ui/propose_deal`
- Input: `{deal_id, offer1, offer2, banks?, lead_bank?}`.
- Bank shares Address docs, calls `create_records` per bank, signs and submits per-bank `Confirm`.

**Validation:**
- Single-bank invoice+cheque deal: propose → records created → advance engine settles.
- Cross-bank swap: both banks settle with correct lead/follow `seen` chain.
- Lock conflict → `-32003` with account detail.

### 8.2 `GET /ui/deal/:deal_id`
- Poll deal progress across participating banks.

**Validation:**
- After `propose_deal`, polling returns `state` progression `confirming → created → approved → held → settled`.

---

## Phase 9 — Barter Link Library

**Goal:** encode and decode dual-purpose landing-page + signed-doc URLs.

### 9.1 URL builders
- `buildIssuerLink(pubkey, bankUrl, mode?)`
- `buildInvoiceLink(orderOrOffer, bankUrl, mode?)`
- `buildChequeLink(...)`
- `buildOfferLink(...)`
- `buildInviteLink(...)`

**Validation:**
- Each builder emits a valid `URL` whose origin matches `bankUrl` and path matches §3.4.

### 9.2 Inline fragment encoding
- Payload = `{v:1, docs:[...]}`.
- Encode: JCS → raw DEFLATE → base64url → `#b=<payload>`.
- Decode: reverse.

**Validation:**
- Round-trip a signed `Order`; reconstructed doc verifies.
- Fragment never sent to server: capture network tab, assert no `#` in requests.

### 9.3 Signed summary (`#s=`)
- Encode a compact signed summary for hybrid Offer links.

**Validation:**
- Hybrid link: verify `#s` offline, then fetch reference `.json`, full doc set verifies.

### 9.4 Extraction precedence
Implement client extractor that tries in order:
1. `#b` fragment
2. `Accept: application/barter+json` / `.json` / `?format=json`
3. `<script id="barter-payload">`
4. `<link rel="alternate">`
5. `barter:*` meta reconstruction

**Validation:**
- Serve a reference HTML page; extractor recovers docs from each source independently.

### 9.5 Signature verification & pinning
- Verify each doc’s `sig` over JCS-minus-sig.
- Fetch `<bank-url>/barter-bank.json` and compare `pubkey`; fail closed.

**Validation:**
- Valid link → verification succeeds, pinned bank accepted.
- Tampered doc → hard error.
- Bank pubkey mismatch → hard error.

### 9.6 Expiry handling
- Honor `expires`/`exp`; expired links render non-actionable.

**Validation:**
- Link with past `exp` verifies signature but is marked expired and blocks action CTAs.

---

## Phase 10 — Landing Routes (Server)

**Goal:** the bank serves human landing pages with embedded machine metadata.

### 10.1 `GET /i/:pubkey`
- HTML: issuer profile landing.
- JSON (`Accept: application/barter+json`, `.json`, `?format=json`): `{kind:"profile", docs:[...]}`.

### 10.2 `GET /v/:token`
- Resolve token via `get_invoice(hash)`; render invoice landing.

### 10.3 `GET /q/:token`
- Resolve via `get_cheque(hash)`.

### 10.4 `GET /o/:hash`
- Resolve Offer by hash.

### 10.5 `GET /x/:token`
- Mirror `barter://` invite or `barterdeal:` token.

### 10.6 Embedded metadata
Every landing HTML `<head>` includes:
- `<link rel="alternate" type="application/barter+json" href="...json">`
- `<script type="application/barter+json" id="barter-payload">` (for reference/hybrid)
- `<meta name="barter:type">`, `barter:pubkey`, `barter:bank`, `barter:sig`, `barter:expires`, `barter:version`
- OpenGraph/Twitter Card tags

### 10.7 App-link association files
- `/.well-known/apple-app-site-association`
- `/.well-known/assetlinks.json`

**Validation (all 10.x):**
- `curl -H 'Accept: application/barter+json' /i/<pubkey>` returns JSON docs.
- `curl /i/<pubkey>.json` returns identical JSON.
- `curl -H 'Accept: text/html' /i/<pubkey>` returns HTML with all required tags.
- The Barter Link extractor from Phase 9 succeeds against each landing route.

---

## Phase 11 — SPA Auth Shell

**Goal:** the user can create, connect, unlock, and lock an identity in the browser.

### 11.1 Welcome / landing screen
- Show bank name, pubkey, protocol version from `/barter-bank.json`.
- Buttons: Register, Connect.

**Validation:**
- Manual: open `/`, see bank info, navigate to Register and Connect.

### 11.2 Register screen
- Handle input (live availability check), password + confirm, strength meter, KDF disclosure, no-recovery acknowledgement.
- Keygen in browser → encrypt → `POST /ui/register`.
- Recovery kit modal: download `.barterkey` + show BIP39 mnemonic.

**Validation:**
- Register a new user; verify `/ui/handle/:handle` returns the new pubkey.
- Wrong acknowledgement checked blocks submit.
- Kit file can be imported on `/connect`.

### 11.3 Connect screen
- Toggle: import private key / restore from kit.
- Private key: base58 seed or mnemonic → derive pubkey → encrypt under new password → register.
- Kit: file picker + password.
- Ephemeral mode: generate/import without server backup.

**Validation:**
- Import the seed from a kit; derive same pubkey.
- Ephemeral key signs a doc but is not stored server-side.

### 11.4 Unlock screen
- Fetch blob by handle → decrypt with password → hold seed in memory.
- “Forgot password?” links to static explainer, not reset.

**Validation:**
- Correct password → unlocked, can sign a doc.
- Wrong password → generic error, no server “is this right?” round-trip.

### 11.5 Auto-lock & session state
- Wipe seed on: tab close, `visibilitychange` hidden beyond timeout, idle timer (default 15 min).
- Preserve draft across lock using `sessionStorage` (draft only, never keys).

**Validation:**
- Leave tab hidden for configured timeout → on return, `/unlock` required.
- Refresh tab → `/unlock` required.

### 11.6 Account switcher
- Dropdown lists stored handles; switching moves to `/unlock` for target key.

**Validation:**
- Register two handles; switch between them; each requires its own password.

---

## Phase 12 — Core SPA Screens

**Goal:** all management screens render and mutate state correctly.

### 12.1 Home / Dashboard
- Portfolio summary, recent activity, attention strip, quick actions.
- Calls `/ui/feed`, `list_accounts`, `get_account_balance`.

### 12.2 Wallet + Account detail
- Group balances by Voucher across banks.
- Per-voucher detail: Voucher body, accounts, records, Orders.

### 12.3 Activity + record drawer
- Filterable list; drawer shows record body + signature timeline + settle cascade.
- Manual refresh and pull-to-refresh.

### 12.4 My Vouchers (list/create/detail)
- Create Voucher form → `submit_docs`.
- Detail shows immutable Voucher + supersede action.

### 12.5 Orders (list/create/detail)
- Unified Swap/Invoice/Cheque form.
- Cross-bank fan-out via `/ui/relay` or `/ui/submit_order`.
- Detail shows cancel/drain guidance.

### 12.6 Invoices (list/create/detail/QR)
- Credit-only Order form.
- Detail includes Share modal with Barter Link + QR.

### 12.7 Cheques (list/create/detail/QR)
- Debit-only Order form; bearer warning.

### 12.8 Discover / Marketplace
- Poll known banks; filter by voucher/intention; trusted-only toggle.
- Offer cards with Accept button.

### 12.9 Network
- Trusted issuers, contacts, known banks.
- Known banks: fetch `barter-bank.json`, confirm/pin pubkey.

### 12.10 Settings
- Security: auto-lock timeout, change password, export kit, lock now.
- Banks shortcut.
- About: bank info + v1 constraints.

**Validation (all 12.x):**
- Each screen loads without errors and calls documented endpoints.
- Create Voucher/Order/Invoice/Cheque flows produce stored docs verifiable via `get_voucher`/`get_invoice`/`get_cheque`.
- Playwright E2E covers: register → create voucher → create order → view wallet.

---

## Phase 13 — Deal Flow UI

**Goal:** accept an offer and watch ready/hold/settle.

### 13.1 Review terms
- Show give/get, rate, min/max, lead/follow, counterparty bank, trust check.
- Hard block on tampered/expired; warn on unknown bank/untrusted issuer.

### 13.2 Sign matching Order
- Build user’s matching Order, sign in browser, fan out via `submit_docs` (local + `/ui/relay`).
- Show per-bank progress.

### 13.3 Deal stepper
- Poll `GET /ui/deal/:deal_id` or `get_record_signatures` every 2–3 s.
- Render states: created → approved → held → settled, with lead/follow cascade.

### 13.4 Manual relay / nudge
- Button pulls signatures from one bank and pushes to another via `/ui/relay_signatures`.

### 13.5 Reject / abort
- Surface `reject` Signature and reason; release holds automatically.

**Validation:**
- E2E: two users accept each other’s cross-bank Offers → stepper reaches settled on both sides.
- E2E: stuck follow bank → manual nudge advances it.

---

## Phase 14 — QR / Share Modals

**Goal:** every shareable entity produces a Barter Link and QR.

### 14.1 Issuer profile QR
- From dashboard/network: `/i/<pubkey>`.

### 14.2 Invoice QR
- From invoice detail: `/v/<token>`.

### 14.3 Cheque QR
- From cheque detail: `/q/<token>`.

### 14.4 Offer QR
- From order detail or discover: `/o/<hash>`.

### 14.5 Invite / deal QR
- Build `barter://` invite or `barterdeal:` token, mirror at `/x/<token>`.

### 14.6 Reference vs inline mode
- Toggle in share modal; inline warns if payload too large.
- Download PNG, copy link, OS share sheet.

**Validation:**
- Generated QR decodes to a URL matching the spec path.
- Scan simulation (fetch `.json` or extract fragment) recovers verifiable docs.

---

## Phase 15 — Landing Page Journeys

**Goal:** camera-browser and barter-webapp paths work for profile/invoice/cheque/invite.

### 15.1 Issuer profile → register & trust
- Anonymous view shows profile + “Register & trust” CTA.
- Registering adds issuer to trusted + bank to known banks + imports vouchers.

### 15.2 Invoice → register & pay
- Anonymous view shows read-only invoice + “Register to pay”.
- Logged-in view opens prefilled PAY deal flow.

### 15.3 Cheque → register & claim
- Same as invoice but debit side / CLAIM.

### 15.4 Webapp extraction path
- When opened in barter-aware context, extract docs, skip landing chrome, open action sheet.

### 15.5 Security gating UI
- Tampered link: hard error, no CTAs.
- Expired link: non-actionable state.
- Unknown bank: explicit add + pin confirmation.

**Validation:**
- Playwright: scan issuer QR as anonymous → register → trusted list contains issuer.
- Playwright: scan invoice QR as logged-in user → pay → record settles.
- Unit: tampered fragment triggers hard block before any `fetch` to `/rpc`.

---

## Phase 16 — Integration & E2E

**Goal:** whole system works for the two worked examples in the spec.

### 16.1 Example A — cross-bank sell Order
- Alice creates Avoucher, places sell Order for Bvoucher.
- Bob places opposite Offer.
- Matchmaker pairs, lead/follow settles.
- Verify balances and history on both sides.

### 16.2 Example B — pay an invoice from scanned Barter Link
- Alice creates invoice for Bvoucher.
- Bob scans link, builds cheque-side Order, signs, matchmaker settles.
- Verify Alice credit and Bob debit.

### 16.3 Polling & caching
- Assert polling pauses on `document.hidden`.
- Assert `/ui/discover` cache hits within TTL.

### 16.4 Error & toast model
- Trigger each mapped RPC error code and confirm user-facing message.

### 16.5 Deep-link routing
- Each Barter Link route, logged-out and logged-in, lands on the correct screen.

**Validation:**
- Full Playwright suite passes.
- Deno integration tests for bank backend pass.

---

## Phase 17 — Security Hardening

**Goal:** the implementation preserves the spec’s security guarantees.

### 17.1 CSP headers
- Serve strict CSP on all UI pages:
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self' https://<known-bank-origins>; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`.

### 17.2 Subresource Integrity
- Vendor Argon2id WASM + JS bundle with SRI hashes.

### 17.3 Rate limit verification
- Confirm `/ui/keystore/:handle` limits (5/handle/min, 30/IP/min).

### 17.4 Telemetry scrubbing
- Confirm password/key inputs are never logged or sent to error reporter.

### 17.5 Final threat-model review
- Re-read §10 of the spec and verify each mitigation is present.
- Document any accepted residual risks.

**Validation:**
- Security headers test: every `/ui/*` and landing route returns expected CSP.
- Network audit: no request body contains plaintext seed or password during register/unlock/sign flows.
- Manual code review checklist against §10.

---

## Validation Methodology

| Layer | Tool | When to run |
|---|---|---|
| Unit tests (crypto, auth, link encoding) | `bun test` | Every phase |
| Cross-runtime parity | `deno test` in protocol/crypto tests | Phases 1, 2, 16 |
| Backend integration | `deno test` against local bank server | Phases 4–8, 10 |
| End-to-end flows | Playwright | Phases 11–16 |
| Security audit | manual + header/requests tests | Phase 17 |

### Definition of done for each phase
1. All new code is typed (`strict: true`) and lint-clean.
2. Phase-specific tests pass.
3. No regression in earlier phases (`bun run test:all` or equivalent passes).
4. A short `PHASE.md` note is added to the phase directory summarizing what changed and how to demo it (optional but recommended).

---

## Suggested Order of Attack

1. **Week 1:** Phases 0–3 (tooling, protocol, keystore crypto, auth).
2. **Week 2:** Phases 4–8 (backend API: identity, state, aggregation, relay, matchmaker).
3. **Week 3:** Phases 9–10 (Barter Link library + server landing routes).
4. **Week 4:** Phases 11–13 (SPA auth shell, core screens, deal flow).
5. **Week 5:** Phases 14–16 (QR, landing journeys, integration E2E).
6. **Week 6:** Phase 17 (security hardening + audit).

This plan intentionally leaves the visual polish of screens until after the protocol, crypto, and backend guarantees are solid — because the spec’s invariants are load-bearing.
