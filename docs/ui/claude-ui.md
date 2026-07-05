# barter.game — Web UI Specification

> **Status:** v1 design spec for the bank-served web UI (the v1.5 "Web UI" track in [`TODOS.md`](./TODOS.md)).
> **Layer:** everything in this document is the **custom layer** sanctioned by [`protocol/base.md`](./protocol/base.md) §6. It MUST NOT alter any standard document schema (`Voucher`, `Account`, `Order`, `Offer`, `Confirm`, `Record`, `Signature`, `Subscription`, `Address`) or the semantics of any standard RPC method (`submit_docs`, `submit_confirm`, `create_records`, `subscribe`, `notify_signatures`, `get_address`, …). A client that speaks only the standard protocol ignores this entire document and still interoperates.
> **Companion docs:** the invariant contract in [`protocol/`](./protocol/README.md); interaction traces in [`scenarios/`](./scenarios/).

This spec describes a browser app (HTML + JS) that a bank serves so non-technical humans can hold an ed25519 key, sign standard docs, and trade — without a CLI. It covers every screen, action element, navigation path, and behavior; the new backend endpoints the UI needs; the encrypted key-custody model; and the **Barter Link** — one URL that is simultaneously a human landing page and a carrier for signed protocol documents.

## Contents

1. **Overview** — what this is and the one-paragraph architecture
2. **Goals & Non-Goals** — the requirements this UI meets, and what it deliberately omits
3. **Vocabulary & Data-Model Glossary** — canonical terms, the record lifecycle, the Barter Link route namespace, the custom endpoint index
4. **Identity, Key Custody & Authentication** — encrypted-keystore-on-server, browser-only decryption, "forget password = lose account"
5. **The Barter Link** — the dual-purpose landing-page + signed-document carrier format
6. **QR Codes & Landing-Page Journeys** — issuer-profile announce/trust funnel, invoice & cheque scans
7. **Bank UI Backend API** — every custom `/ui/*` endpoint and the public landing routes
8. **Screens, Navigation & Behavior** — the full screen inventory, route table, and global behaviors
9. **Core Object Flows** — how each action maps onto standard docs and RPC calls, with worked examples
10. **Security Summary** — the consolidated guarantees and threat posture
11. **Polling, Cadence & Caching** — the single source of truth for refresh/poll/cache constants
12. **Future Work** — what is explicitly out of scope for this version
- **Appendix A** — custom error-code registry (`-32006..-32099`)

---

## 1. Overview

barter.game is a federated mutual-credit ledger: every user and every bank is an ed25519 keypair; users issue **Vouchers** ("1 logo", "1 hour of consulting") and trade them through **Banks** that settle signed double-entry **Records** atomically. The protocol is transport-agnostic and, in v1, CLI-driven. This document specifies the **web client** that makes the same protocol usable from a phone browser.

The architecture in one paragraph: **a bank serves a single-page app (SPA) from its own origin under `/ui/`.** The SPA holds the user's ed25519 private key *in browser memory only* — the key is generated or decrypted client-side and used to sign standard docs locally; the server never sees it. The bank stores the private key as an opaque, password-encrypted **keystore blob** (a blind-custodian backup) and adds a small set of **custom `/ui/*` endpoints** for things the protocol has no concept of: the encrypted keystore, per-user app state (the **trusted issuers** list, **known banks**, contacts, drafts), cross-bank read aggregation, discovery polling, a signed-envelope relay, and an optional bank-operated matchmaker. The bank also serves **Barter Links** — HTTPS URLs that render a human landing page *and* expose the underlying signed docs to a barter webapp via embedded metadata and content negotiation. Money-moving artifacts (`Order`, `Offer`, `Confirm`, `Record`, `Signature`) are produced and signed exactly as the protocol defines them; the custom layer only stores public-derived state or forwards already-signed artifacts, so the bank is never trusted to forge authority.

Three properties hold throughout, and the rest of the spec is mostly their consequences:

- **The plaintext private key never leaves the browser** (§4, §10). The server is a blind custodian of ciphertext.
- **Every link self-validates before it is acted on** (§5, §6, §10). The bank serving a page is not a trust anchor; the receiver verifies signatures and pins the bank pubkey, failing closed on divergence.
- **The custom layer is removable.** Delete every `/ui/*` route and Barter Link and a fully conformant v1 bank remains.

---

## 2. Goals & Non-Goals

### Goals

1. **Bank-served web UI.** HTML + JS, served by the bank from its own origin; no separate hosting, no native install required.
2. **Bring-your-own-key or create-one.** Connect with an existing keypair (paste / mnemonic / file) **or** generate a fresh keypair in the browser.
3. **Encrypted server-side key custody.** The private key is stored on the server only as ciphertext; it is decrypted **only in the browser** and the plaintext key (and the password) are **never** sent over the network. Forgetting the password permanently loses the key and its account — by design, consistent with v1 "lose key ⇒ lose account."
4. **Issue and trade.** Create **Vouchers** and **Orders**, and maintain a per-user list of **trusted issuers** (custom UI state; the protocol has no trust concept).
5. **Issuer-profile QR → registration & trust funnel.** A user generates a QR for their **issuer profile**; opened in a normal browser it shows a landing page that invites the viewer to register and immediately adds the original user to the new user's trusted issuers. This is the primary friend-announcement and new-user-onboarding mechanism.
6. **Invoice / cheque QR.** A user generates a QR for an **Invoice** or a **Cheque**; a browser scan lands on a specialized page, while a barter webapp extracts the signed docs from the page metadata or metadata links.
7. **One link, two readers.** The same URL works as a human landing page **and** as a carrier for signed documents (the **Barter Link**, §5).
8. **Visibility & discovery.** Check balances, transaction history, and current orders, and **poll known banks** for orders on the user's vouchers to discover interesting exchange requests.

### Non-Goals (this version)

- **Direct messaging** between users and **voucher blogs** are out of scope; they are reserved as future work (§12) and the issuer-profile landing leaves room for them.
- **No protocol changes.** No new doc types, no new standard RPC semantics. Everything new is custom-layer.
- **No key recovery or key rotation beyond the user's own recovery kit.** There is no server-side password reset or operator override (v1 forever-keys; §4, §12).
- **No new trust, reputation, or dispute machinery.** Trust remains social; the "trusted issuers" list is a private convenience, never a signed artifact.

### Hard invariants the implementation MUST preserve

- Never alter a standard schema or RPC; standard-only clients keep working.
- The plaintext private key and the decryption password never cross the network.
- The bank serving a Barter Link is not a trust anchor: verify signatures and pin the bank pubkey before acting; fail closed.

---

## 3. Vocabulary & Data-Model Glossary

This section fixes the canonical terms used everywhere below. Protocol terms keep their meaning from [`protocol/`](./protocol/README.md); custom terms are introduced here once.

### 3.1 Identity, handle, account

| Term | Owned by | Scope | Meaning | Appears in any signed doc? |
|---|---|---|---|---|
| **pubkey** (base58 ed25519) | protocol | global, content-addressed | the actual identity; the `pubkey` field of every `BaseDoc` | **yes** |
| **handle** | this UI (custom) | unique **per bank** | a human label and the **keystore lookup key** at one bank | **no** — never canonicalized, signed, or shared off its bank |
| **account** | protocol (`Account` doc) | per voucher, per holder | a holder's named bucket for one Voucher; signed by the holder, stored by the issuing bank; `name` is private | the `Account` doc is signed; its `name` is private |

The handle is **not** an identity and carries **no** trust. The UI always surfaces the pubkey (truncated, copyable) alongside a handle so users verify the key, not the name. Where no handle exists (ephemeral / no-server-backup sessions) the display label falls back to the truncated pubkey.

### 3.2 Custom UI-state terms

| Term | What it is |
|---|---|
| **trusted issuers** | a per-user list of **issuer pubkeys** the user has chosen to trust. Custom UI state (§7.3); never a signed doc. This is the list the issuer-profile QR funnel adds to. |
| **known banks** | a per-user list of **pinned `{pubkey, url}` banks** the user trades with / polls. Pinning is the v1 security model (`base.md` §5.2). |
| **contacts** | a local address book mapping pubkeys → labels. |
| **keystore blob** | the opaque, password-encrypted ed25519 private seed plus its KDF parameters, stored server-side (§4). Also called the keystore record. |
| **recovery kit** | the one-time, user-downloaded backup offered at key creation: a `.barterkey` encrypted file and/or a 24-word BIP39 mnemonic. The **only** recovery path (§4). |
| **Barter Link** | one HTTPS URL that is both a human landing page and a signed-document carrier (§5). Proper noun, always capitalized. |
| **barter webapp** | a barter-aware client (this SPA, or a future installed app) that extracts signed docs from a Barter Link rather than rendering its landing page. |
| **advance engine** | the bank's self-driving loop that issues `ready` → `hold` → `settle` Signatures as preconditions are met (`bank-rpc.md` §2). |

### 3.3 Record lifecycle — states vs. signature actions

A common source of confusion: **`ready`, `hold`, `settle`, `reject` are Signature *actions* a bank issues; they are not record states.** Per `bank-schema.md` §2 a Record moves through exactly five states, and the actions drive the transitions:

| Record **state** | Reached when | Driven by action |
|---|---|---|
| `created` | the matchmaker minted the debit/credit pair (`create_records`) | — |
| `approved` | a valid `Order` is bound **and** the per-bank `Confirm` arrived **and** the record is `ready` | bank issues **`ready`** on the record |
| `held` | the debit account is locked (lead, or after the lead's `hold` is verified) | bank issues **`hold`** |
| `settled` | the delta is applied and the hold released | bank issues **`settle`** (followers cite predecessors in `Signature.seen`) |
| `rejected` | any precondition fails from any pre-settled state | bank issues **`reject`** |

The UI renders **states** as the canonical status chips (`created` / `approved` / `held` / `settled` / `rejected`) and treats the four **actions** as the underlying events it observes via `get_record_signatures`. It never presents `ready`/`settling`/`confirming` as record states; `confirming` is at most a **custom UI-only** sub-label meaning "records created, awaiting `Confirm` + bound Orders," i.e. still protocol-state `created`.

### 3.4 Barter Link route namespace (single source of truth)

All public Barter Link routes are rooted at the bank UI origin with short, lowercase, single-letter paths (§5 owns the full format). These are **server landing routes**, distinct from the SPA's own client-router paths (§8).

| Kind | Route | Carries (signed docs) | Server resolves via |
|---|---|---|---|
| **Issuer profile** | `/i/<pubkey>` | issuer's `Voucher`s + `Address` pointer | `get_voucher`, `list_vouchers`, `get_address` |
| **Invoice** (credit-only `Order`) | `/v/<token>` | invoice `Order` (+ author `Account` docs) | `get_invoice(hash)` |
| **Cheque** (debit-only `Order`) | `/q/<token>` | cheque `Order` (+ author `Account` docs) | `get_cheque(hash)` |
| **Offer** | `/o/<offer-hash>` | a bank-signed `Offer` | `list_offers` / direct lookup |
| **Invite / deal** | `/x/<token>` | a `barter://` invite or `barterdeal:` token | self-contained; bank mirrors |

Each route also serves its machine representation via `Accept: application/barter+json`, a `.json` sibling, or `?format=json` (§5).

### 3.5 Custom endpoint index

Every custom route lives under `/ui/` (JSON API + SPA shell) except the public Barter Link landing routes above. Full shapes, auth, and errors are in §7; this is the map.

| Group | Endpoints |
|---|---|
| **Auth & keystore** | `GET /ui/handle/:handle` · `POST /ui/register` · `GET /ui/keystore/:handle` · `PUT /ui/keystore` · `GET /ui/challenge` |
| **Per-user state** | `GET/PUT /ui/state` · `POST /ui/trusted` · `DELETE /ui/trusted/:pubkey` · `GET/POST/DELETE /ui/contacts[/:pubkey]` · `GET/POST/DELETE /ui/banks[/:pubkey]` · `GET/PUT /ui/catalog` · `GET/PUT/DELETE /ui/drafts[/:id]` · `GET/PUT /ui/prefs` |
| **Aggregation / reads** | `GET /ui/portfolio` · `GET /ui/history` · `GET /ui/orders` · `GET /ui/feed` (Home activity convenience over `/ui/history`) |
| **Discovery** | `POST /ui/discover` |
| **Relay / resolve** | `POST /ui/relay` (forward a client-signed envelope) · `POST /ui/relay_signatures` (pull `get_record_signatures` → push `notify_signatures`; the "Nudge") · `GET /ui/resolve/:pubkey` |
| **Matchmaker** | `POST /ui/propose_deal` · `GET /ui/deal/:deal_id` · `POST /ui/submit_order` (optional cross-bank Order fan-out helper) |
| **SPA + landing** | `GET /ui/`, `/ui/app/*` · `GET /i/:pubkey`, `/v/:token`, `/q/:token`, `/o/:hash`, `/x/:token` |

**Auth model:** every per-user mutating call and private read uses the single **signed-request** scheme (`X-Barter-Auth`, §7.2) — the unlocked browser signs the request with the user's ed25519 key; the plaintext key never crosses the network. Public reads (`/ui/handle`, `/ui/keystore`, `/ui/resolve`, landing routes) need no auth; `/ui/keystore` is rate-limited.

---

## 4. Identity, Key Custody & Authentication

This section is part of the **custom layer** defined by `protocol/base.md` §6. Everything here is operator/UX-specific scaffolding around the standard protocol: it MUST NOT alter any standard document schema (`Voucher`, `Account`, `Order`, `Offer`, `Confirm`, `Record`, `Signature`, `Subscription`, `Address`) or the semantics of any standard RPC method (`submit_docs`, `submit_confirm`, `create_records`, `subscribe`, `notify_signatures`, `get_address`, …). A client that speaks only the standard protocol — never touching this keystore — still interoperates fully. The keystore exists purely so a human can use a *browser* (which has no safe long-term secret storage) to hold an ed25519 key and sign standard docs.

### Recap: what "identity" is

Per `protocol/base.md`, a party's identity **is** its ed25519 public key, rendered as a **base58** string. There is no DID, no username-as-identity, no account-open call. The same pubkey is the `pubkey` field of every `BaseDoc` the user signs (`Order`, `Account`, `Voucher`, holder `Signature`s) and the issuer field of any `Voucher` they mint.

The UI adds exactly **one** purely-local convenience on top: an optional human **handle**.

| Concept | Owned by | Scope | Purpose | In any signed doc? |
|---|---|---|---|---|
| **pubkey** (base58 ed25519) | protocol | global, content-addressed | the actual identity | **yes** — `pubkey` field everywhere |
| **handle** (e.g. `alice`) | this custom layer | unique *per bank* | keystore lookup + friendly display | **no** — never canonicalized, never signed, never leaves the bank it was registered on |

The handle is a lookup key for the encrypted blob and a label for the Screens section. It is **not** an identity and carries **no** trust. Two banks may host different users under the handle `alice`; they are unrelated. When the UI shows a handle it MUST also surface the pubkey (truncated, copyable) so users verify the key, not the name — consistent with the protocol's "pubkey is pinned everywhere" rule. Where a handle is absent (ephemeral / "use without server backup" sessions), the UI falls back to the truncated pubkey as the display label.

### Server-side encrypted keystore model

The bank stores, per registered identity, an **opaque ciphertext blob plus the parameters needed to derive the key that decrypts it** — and nothing else secret. The server is a *blind* custodian: it can enumerate pubkeys, handles, and ciphertext, but it can never recover a private key without the user's password, which it never receives.

**Stored keystore record** (logical shape; the wire/storage shape and endpoint are owned by the Bank UI Backend API section — these are custom keys, NOT a protocol doc and NOT stored under the protocol `docs` keyspace):

```json
{
  "handle": "alice",
  "pubkey": "7vQ4kF2mNqZr8sP1xY3aB9cD6eGhJkLmNpQrStUvWxYz",
  "ciphertext": "kZ3y...base64url...Qe9w",
  "nonce": "9mB1c4D7e0F3g6H9i2J5k8L1",
  "kdf": {
    "name": "argon2id",
    "salt": "Xa7Bc9De1Fg3Hi5Jk7Lm9No1Pq3Rs5Tu7Vw9Xy1Zb3=",
    "params": { "m": 65536, "t": 3, "p": 1, "v": 19, "dkLen": 32 }
  },
  "aead": "xchacha20poly1305",
  "kit_issued": true,
  "created_at": "2026-06-20T12:00:00Z",
  "updated_at": "2026-06-20T12:00:00Z"
}
```

Field notes:
- `ciphertext` — AEAD-encrypted **32-byte ed25519 private seed** (the seed, not the expanded 64-byte secret key; `@noble/ed25519` derives the public key and signs from the seed). Encoded base64url.
- `nonce` — AEAD nonce. 24 bytes for XChaCha20-Poly1305, 12 bytes for AES-256-GCM. **Random per encryption**, never reused with the same key.
- `kdf.salt` — 16-byte random salt, base64. New salt on every password set/change.
- `kdf.params` — exact KDF cost (see below). Stored so any future client can reproduce the derivation even if defaults change.
- `aead` — names the AEAD so the algorithm is self-describing; the client never guesses.
- `kit_issued` — UI hint only (whether a recovery kit was downloaded at creation); not security-bearing.

The server treats `ciphertext`, `nonce`, and `kdf` as **opaque**. It does not parse, validate, or decrypt them. It binds the record to `pubkey` (the real identity) and indexes it by `handle` (the lookup key). The server MUST enforce: `handle` unique per bank; and on any write, that the writer proves control of `pubkey` (see *Session & request signing*), so nobody can overwrite someone else's blob.

#### Client-side crypto pipeline (normative)

All of this runs in the browser, in first-party JS only. Reference libs: `@noble/ed25519`, `@noble/hashes`, `@scure/base`, `ulid`, plus an Argon2id WASM build (e.g. `hash-wasm`).

**Encrypt (registration / password change):**

1. `seed` ← 32 random bytes (new key) *or* the user's imported seed (connect-existing).
2. `salt` ← 16 random bytes; `nonce` ← 24 random bytes (XChaCha20) / 12 (GCM).
3. `KEK` ← `Argon2id(password, salt, m=65536 KiB, t=3, p=1, dkLen=32)` → 256-bit key-encryption-key.
4. `ciphertext = AEAD_encrypt(key=KEK, nonce, plaintext=seed, aad="barter.game/v1|keystore|" + pubkey)`. Binding the pubkey as AAD means a blob can't be silently swapped between identities.
5. `pubkey` ← base58 of `ed25519.getPublicKey(seed)`.
6. Zero the `password` and `KEK` buffers; upload `{handle, pubkey, ciphertext, nonce, kdf:{name,salt,params}, aead}`.

**Decrypt (login / unlock):**

1. Fetch blob by `handle` (or by `pubkey`) from the bank.
2. Re-derive `KEK` with the **stored** `kdf.params` + `salt` and the typed password.
3. `seed = AEAD_decrypt(KEK, nonce, ciphertext, aad)`. AEAD auth-tag failure ⇒ wrong password (or tampered blob) — show the irreversibility-aware error, never a server round-trip "is this right?".
4. Hold `seed` (and derived signing key) **in memory only**. Zero `password`/`KEK`.

**KDF choice and parameters.**

- **Primary: Argon2id (WASM).** Memory-hard, the modern standard for password-derived keys; resists GPU/ASIC brute force of the offline blob. Concrete defaults: `m = 65536` (64 MiB), `t = 3` iterations, `p = 1`, `v = 0x13` (Argon2 v1.3), `dkLen = 32`. These target well under ~1 s on a typical 2020s phone while costing an attacker ~64 MiB per guess. The UI MAY bump `m`/`t` on capable desktops and records whatever it used in `kdf.params`, so login always reproduces the exact derivation.
- **Fallback: PBKDF2-HMAC-SHA-256**, `iterations = 600000`, `dkLen = 32`. Used only when the Argon2id WASM module fails to load/instantiate (locked-down CSP edge cases, ancient WebView, WASM disabled). It is weaker against custom hardware but available in `crypto.subtle` everywhere with zero extra payload. The `kdf.name` (`"argon2id"` vs `"pbkdf2-sha256"`) makes each blob self-describing, so a blob created with one is always decryptable later regardless of current default. The UI SHOULD warn when it had to fall back and offer to re-encrypt with Argon2id once available.

**Storage hygiene.** The plaintext `seed`/signing key live in a JS closure (or a non-extractable `CryptoKey` where the algorithm allows). **Never** `localStorage`/`sessionStorage`/IndexedDB in plaintext, never a cookie. Optionally, a short-lived **session-unlock token** (random, server-issued, opaque) may be kept in `sessionStorage` to authorize *custom* backend calls for the tab's lifetime — it authorizes nothing cryptographic and can decrypt nothing; losing it just forces a re-unlock.

**Auto-lock.** The in-memory key is wiped on: tab close / `pagehide`; `visibilitychange` to hidden beyond a grace period; and an idle timer (default **15 min** no interaction). After auto-lock the user must re-enter the password to re-derive (the ciphertext is still cached locally, so no network is needed to re-unlock). Signing flows that are mid-flight prompt for unlock rather than failing silently.

### Account-entry flows

All flows converge on the same end state: an ed25519 `seed` held in memory, ready to sign standard docs (`Order`, `Voucher`, `Account`, holder `Signature`). The detailed screens are owned by the Screens & Navigation section; here is the identity/custody contract for each.

#### A. Create new keypair (default funnel)

1. Generate `seed` in-browser (`crypto.getRandomValues`, 32 bytes).
2. User picks a **handle** (checked unique per bank, live) and a **password** (strength meter; min 10 chars enforced client-side).
3. Run the encrypt pipeline; upload the keystore record. The user is now an identity; their first `Account`/`Voucher`/`Order` is created later on demand (no protocol "open account").
4. **Offer the recovery kit immediately** (see below). This is the only moment a plaintext-recoverable copy is ever presented.

#### B. Connect existing keypair

Accepts any of: a **base58 private key/seed** paste; a **BIP39-style mnemonic** (24 words → 32-byte seed via the standard BIP39 seed derivation, taking the first 32 bytes as the ed25519 seed; the exact mnemonic scheme is fixed and shown in the Recovery-kit subsection); or an **uploaded key file** (`.barterkey`, the same JSON as a recovery kit). After import the UI derives the pubkey and shows it for the user to verify against what they expect.

Then the user chooses custody:
- **Back up here (recommended):** set a password, encrypt, and upload — so the *same handle + password* logs in on any device against this bank. Identical pipeline to flow A.
- **Ephemeral / in-memory only ("use without server backup"):** key stays in the tab, never uploaded. On close it's gone; the user must re-import next time. No handle is registered (display label = truncated pubkey). Good for shared/kiosk machines or maximal-paranoia users. The UI persistently flags this session as *not backed up*.

#### C. Use without server backup

A first-class variant of B: generate or import a key and never upload anything. The user is fully functional (can sign and submit standard docs) but the bank stores **no** ciphertext for them. The UI makes the trade-off explicit: no cross-device login, and if the tab is lost before they export a kit, the key is gone — i.e. the account is gone (v1: lose key ⇒ lose account).

### "Forgot password = lose account"

Because the server is a blind custodian, **there is no password reset and no server-side recovery — by design**, and this is consistent with the protocol's v1 stance of *no key recovery, no key rotation* (`protocol/README.md` trust model).

**UX requirements:**
- At **creation/password-set**, a blocking modal states plainly: *"We never see your password and cannot reset it. If you forget it, this account and everything signed with it are permanently lost. There is no recovery except the kit below."* The user must check an acknowledgement to proceed.
- On the **login screen**, a "Forgot password?" link does **not** offer reset. It explains the above and points to the recovery kit (if they kept one) or to creating a new identity.
- A wrong password is detected **locally** (AEAD tag failure). The UI never tells the server "this was the right/wrong password," so the server cannot even count attempts against the secret — though the *custom* backend MAY rate-limit blob *fetches* per handle/IP to slow online enumeration (see Threat model).

**The optional one-time recovery kit** — offered once, at creation (flow A) and on opt-in backup (flow B):
- **Form:** a downloadable `recovery-kit.barterkey` JSON (the same self-describing encrypted blob as the keystore record, so it can be re-imported as a key file) **and/or** a **24-word BIP39 mnemonic** that reconstructs the raw seed. The mnemonic is the human-friendly, paper-safe form; the file is the click-to-restore form.
- The mnemonic encodes the **seed itself** (entropy → words via BIP39), so it recovers the key with **no password**. The UI warns that the mnemonic is therefore plaintext-equivalent and must be stored offline. The `.barterkey` file, by contrast, is password-encrypted and safe to store in cloud/disk.
- The kit is shown **once**, never re-fetchable from the server (the server doesn't have the mnemonic and can't reissue it). The UI strongly nudges the user to save it before continuing and records `kit_issued` for a later "you have no backup" nag.
- **This kit is the only recovery path.** No server reset, no operator override, no email link.

### The "never sent over network" guarantee

This is a *hard* property, and the design makes it auditable:

- **All crypto is first-party client JS/WASM.** Key generation, KDF, AEAD, and ed25519 signing happen in the browser. The only things that ever leave are: **ciphertext + KDF params + public values** (pubkey, handle, nonce, salt) and **finished signed docs/signatures**. The raw `seed`, the `password`, and the derived `KEK` never touch `fetch`/`XHR`/`WebSocket`/`sendBeacon`.
- **Strict CSP** on every UI page, served by the bank, e.g.:
  `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self' https://<known-bank-origins>; img-src 'self' data:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'`.
  `'wasm-unsafe-eval'` is the *only* eval-class allowance, needed for the Argon2id WASM; no `unsafe-inline`, no remote script origins.
- **No third-party scripts, no CDN, no analytics SDKs** on any page that can hold a key or password. Crypto libs are vendored and served from the bank origin (Subresource Integrity on every `<script>`). This shrinks the supply-chain surface to "the bank's own bundle," which is itself pinned/auditable.
- **Password & key inputs are excluded from all telemetry.** Inputs are `autocomplete="new-password"`/`current-password`, never logged, never in error reports; any client error reporter must scrub form values and key material by allowlist, not blocklist.
- **URL fragments (`#…`) carry inline secret payloads and never reach the server** — browsers do not send the fragment in HTTP requests. The Barter Link format and QR & Landing Journeys sections use the `#` fragment for inline signed-doc payloads precisely so the bank serving the landing page never receives them; the same rule means any future inline key/seed transport (e.g. an in-page "import via link") would live in the fragment, client-read only.
- **Auditability:** because the bundle is first-party and CSP forbids remote code, a reviewer can confirm "no key exfiltration" by reading one bundle and the CSP header, and can verify in DevTools' Network tab that no request body ever contains the seed/password. We document the expected `connect-src` allowlist so deviation is visible.

### Session & request signing for custom backend calls

Standard protocol RPCs are already signed envelopes (`{jsonrpc,id,method,params,pubkey,to,sig}`, `protocol/base.md`). The **custom** backend (keystore I/O, trusted-issuer list, poll preferences, QR/landing metadata) needs the same "prove you are this pubkey" property without inventing a new identity. The **canonical scheme is the per-request signed-request (`X-Barter-Auth`) defined in §7.2** — there is no server-side password; auth is pure signature, so the SPA reuses one signer code path and the plaintext key never crosses the network.

- **Per-request signing is the rule.** Every per-user mutating call and private read (keystore put, trusted-issuer list, drafts, prefs, aggregation/discovery/relay) carries an `X-Barter-Auth` header: an ed25519 signature, by the unlocked key, over a compact authdoc that binds `method`, `path`, a fresh ULID `id` (claimed in the same replay window as `/rpc`), a `ts` (±120 s skew), and `body_sha256`. This gives custom calls the same replay protection and signature semantics as protocol RPCs (`-32001` sig invalid, `-32002` replay; custom failures in `-32006..-32099`). Full shape: §7.2.
- **Optional login nonce.** Stricter deployments MAY have the client first fetch a one-time nonce from `GET /ui/challenge` and place it in `authdoc.id`; the bank verifies it was issued and unspent. The `ts`/replay-window default is sufficient without it.
- **Optional, non-cryptographic session token.** A deployment MAY additionally hand the browser an opaque, short-TTL session token (held in `sessionStorage`) purely to avoid re-signing trivial reads. It is a UX optimization only: it authorizes nothing cryptographic, can decrypt nothing, and losing it just forces a re-unlock. It is **not** required and never substitutes for the per-request signature on a mutating call.
- **Endpoints are named here, shaped in §7.** keystore put/get, handle-availability, the optional `GET /ui/challenge`, trusted-issuer list, and bank-poll preferences are **named only** above; their exact request/response shapes, URLs, and error bodies are owned by the **Bank UI Backend API** section (§7). Their on-screen flows belong to **Screens & Navigation** (§8).

### Threat model

| Threat | What the attacker gets / does | Mitigation in this design | Residual risk |
|---|---|---|---|
| **Server compromise** (DB dump / malicious read access) | Sees only `ciphertext`, `nonce`, `salt`, `kdf`, `pubkey`, `handle`, and public ledger/Offer state — never plaintext keys or passwords | Blind-custodian model: private seed is AEAD-encrypted under an Argon2id-derived KEK the server never holds; pubkey bound as AAD | Must still brute-force each blob individually against a 64 MiB Argon2id wall (see offline brute force) |
| **XSS / supply-chain** (injected JS tries to read the in-memory key or password) | Could exfiltrate live key while tab is unlocked | Strict CSP (`script-src 'self' 'wasm-unsafe-eval'`, no inline/remote), vendored libs + SRI, no third-party scripts/analytics on key pages, auto-lock shrinks the unlocked window, telemetry input-scrubbing | A successful first-party-bundle compromise (operator ships malicious JS) defeats this — see *malicious operator* |
| **Network MITM** | Tries to read/alter traffic, swap the served bundle or a fetched blob | TLS everywhere; **pubkey pinning** (invite strings and `barter-bank.json` carry the bank pubkey, compared on connect); AAD-bound blobs and self-validating signed docs detect tampering before any use | TLS-stripping on first contact if the user typed a bare URL with no pinned pubkey — UI requires the `<pubkey>@<url>` form for trust |
| **Offline brute force of a stolen blob** | Runs a password dictionary against the ciphertext | Argon2id `m=64MiB,t=3` (or PBKDF2 600k) makes each guess expensive; per-blob random salt kills rainbow tables; min-length + strength meter on passwords | Weak user passwords remain crackable — irreducible; we nudge for length and offer the mnemonic kit instead of relying on a weak password |
| **Lost password** | User locked out | By design irreversible; one-time recovery kit (encrypted file + BIP39 mnemonic) offered at creation is the only path | No kit ⇒ account permanently lost (v1: lose key ⇒ lose account) |
| **Malicious bank operator** | Controls the served JS and could ship key-stealing code, or could refuse/withhold the blob | Vendored + SRI-pinned bundle and published CSP make malicious bundles *detectable* by auditors and reproducible-build checkers; users who don't trust the operator use **ephemeral / no-server-backup** mode and keep their own mnemonic, so the operator never holds even ciphertext; trust is social per the protocol | A determined operator can still serve bad JS to a non-vigilant user — fundamental to any web-served key UI; mitigated, not eliminated, by audit + the no-backup escape hatch |

**Online enumeration note:** because blob fetch is by `handle`, the custom backend SHOULD rate-limit and avoid distinguishing "no such handle" from "handle exists" beyond what's necessary, to slow handle harvesting. This is a custom-backend control (see Bank UI Backend API); it does not weaken the offline guarantee, which stands on the KDF alone.

### Hand-offs

- **Bank UI Backend API** — exact shapes/URLs/errors for: keystore put/get, handle-availability, session challenge/verify/refresh, trusted-issuer list, poll preferences; and the rate-limit policy on blob fetch.
- **Screens & Navigation** — Register / Connect / Unlock / Forgot-password / Recovery-kit / Auto-lock screens.
- **Barter Link format** & **QR & Landing Journeys** — the `#`-fragment inline-payload convention this section relies on for the "never reaches the server" guarantee.
- **Core Object Flows** — how the in-memory key, once unlocked, signs `Order`/`Voucher`/`Account`/holder `Signature` docs and submits them via `submit_docs`.

## 5. The Barter Link — a dual-purpose landing-page + signed-document carrier

A **Barter Link** is a single HTTPS URL, served by the bank UI origin, that does two jobs at once:

1. Opened in an ordinary phone camera or browser, it renders a human **landing page** (owned by *QR & Landing Journeys*) that explains what was shared and invites the viewer to register, add a trusted issuer, or act on an Invoice/Cheque/Offer.
2. Fetched or inspected by a barter **webapp**, it exposes the underlying **signed protocol documents** (`Voucher`, `Order` in its invoice/cheque specialization, `Offer`, `Account`, `Signature`) so the webapp can extract, verify, and act on them with no separate API call.

This lives entirely in the **custom layer** (base.md §6). It defines no new standard document schema and no new RPC semantics: every payload a Barter Link carries is a standard signed doc, and every server-side resolution it triggers uses existing methods (`get_voucher`, `get_invoice`, `get_cheque`, `list_offers`, `list_accounts`). A client that speaks only the standard protocol never needs a Barter Link; the link is a convenience skin over docs and methods that already exist.

The design is deliberately a recombination of proven web standards rather than an invention:

| Borrowed from | What we take |
|---|---|
| **BIP-21** `bitcoin:` URIs / **LNURL** | one string that is both human-shareable and machine-actionable; a custom scheme mirror |
| **OpenGraph / Twitter Cards** | rich link previews in chat apps from `<meta>` tags |
| **JSON-LD** (`<script type="application/ld+json">`) | machine payload embedded in the human page |
| **RSS/Atom autodiscovery** (`<link rel="alternate">`) | a typed pointer from HTML to its machine representation |
| **HTTP content negotiation** | one URL, multiple representations via `Accept` |
| **Apple App Clips / Android App Links** | native-app open from an HTTPS URL, web fallback otherwise |
| **`data:` URLs** | self-contained, offline-verifiable inline payloads |

> Human UX of each journey (copy, buttons, what the viewer sees and taps) is owned by **QR & Landing Journeys**. The concrete server route handlers are owned by **Bank UI Backend API**; this section names the routes and defines their *contract*, not their implementation.

### URL namespaces

Every Barter Link is rooted at the bank UI origin so that a single pinned `<bank-url>` covers the human page, the machine payload, and the App-Clip/App-Link association. Paths are short, single-letter, and lowercase to keep the QR byte budget small (see *QR specifics*) and to avoid case-folding ambiguity in Crockford base32 / base58 tokens that follow.

| Kind | Path | Carries (signed docs) | Server resolves via |
|---|---|---|---|
| **Issuer profile** | `/i/<pubkey>` | the issuer's `Voucher`s + an `Address` pointer; *no* counterparty `Order` | `get_voucher`, `list_vouchers`, `get_address` |
| **Invoice** (credit-only `Order`) | `/v/<token>` | the invoice `Order` (+ author `Account` docs) | `get_invoice(hash)` |
| **Cheque** (debit-only `Order`) | `/q/<token>` | the cheque `Order` (+ author `Account` docs) | `get_cheque(hash)` |
| **Offer** | `/o/<offer-hash>` | a bank-signed `Offer` | `list_offers` / direct lookup |
| **Invite / deal** | `/x/<token>` | a full bilateral invite (`barter://` payload) or `barterdeal:` token | self-contained; bank only mirrors |

Path-letter rationale (QR-friendly, mnemonic, collision-free):

- **`/i/`** — **i**ssuer. The funnel entry point (Requirement 5): "this is me and the vouchers I vow to deliver."
- **`/v/`** — in**v**oice. A request to be paid: a credit-only `Order` (`debit` omitted). `i` was taken by issuer, so the invoice borrows the **v**.
- **`/q/`** — che**q**ue. A debit-only `Order` (`credit` omitted): "spend this against me." `q` is unambiguous and otherwise unused.
- **`/o/`** — **o**ffer. A bank-derived, bank-signed `Offer`, the discovery primitive matchmakers scan.
- **`/x/`** — e**x**change. A complete two-sided deal: the existing `barter://` invite or `barterdeal:` token, the only kind that already ships as a self-validating string.

The `<pubkey>` in `/i/` is a base58 ed25519 key. The `<token>` in `/v/`, `/q/`, `/x/` is mode-dependent (next section): in REFERENCE mode it is a short opaque/hash token the bank can resolve; in INLINE mode the path token is just a stable short id and the doc rides in the fragment.

> All five paths are also valid **autodiscovery roots**: appending `.json` or `?format=json`, or sending `Accept: application/barter+json`, yields the machine representation of the same resource (see *Content negotiation*).

### Two carrying modes

A Barter Link carries its docs in one of two modes. The mode is a property of how the link was minted, and a barter webapp can always tell them apart by structure: INLINE links have a `#b=` fragment, REFERENCE links do not.

#### Reference mode — the bank resolves the docs

A short URL that contains only an identifier; the actual signed docs are **fetched from the bank**, which already holds them:

```
https://bank.example/banks/alice/v/9F3KQ2  ← invoice, server-resolved
```

The token (`9F3KQ2`) maps server-side to an invoice `Order` hash. When a webapp negotiates `application/barter+json` (or hits the `.json` sibling), the backend runs `get_invoice(hash)` and returns the signed `Order` plus any author `Account` docs.

**Use reference mode when:**

- The doc is **already published to the bank** — issuer profiles (`Voucher`s submitted via `submit_docs`), `Offer`s (`submit_docs(..., publish_offers:true)`), and invoices/cheques the user has registered. Nothing extra to embed; the bank is the source of truth for its own voucher's records.
- The doc is **large** or open-ended (a profile with many `Voucher`s) — a fixed-length token keeps the QR small and scannable regardless of catalog size.
- You want a **stable, revocable** link: the bank can later expire or 404 the token.

Trade-off: resolution requires a round-trip to the bank, and the bank learns that *someone* fetched the doc (a minor metadata leak — it cannot see who the viewer is, only that the link was opened).

#### Inline mode — the doc rides in the fragment

The complete signed doc(s) are packed into the URL **fragment**, which browsers never send to the server:

```
https://bank.example/banks/alice/v/_#b=eJyrVkrLz1eyUlA...   ← invoice, self-contained
                                    └── #b = base64url(deflate(canonical JSON of signed docs))
```

- Payload key is **`b`** (barter). Value is `base64url( DEFLATE( canonical-JSON( payload ) ) )` where the payload is a small envelope `{ "v": 1, "docs": [ <signed doc>, ... ] }`.
- **Canonical JSON is RFC 8785 / JCS** — the *same* canonicalization used for signing (base.md §2). This is mandatory: the webapp re-canonicalizes each doc minus its `sig` and re-verifies the ed25519 signature, so the bytes must round-trip identically.
- DEFLATE (raw, RFC 1951) before base64url typically halves a JCS doc; base64url (RFC 4648 §5, no padding) keeps it URL- and QR-alphanumeric-adjacent.
- Because it is a **fragment**, the signed doc is **never transmitted to any server** — not even the bank serving the page. The page HTML loads from the path; the doc is reassembled and verified client-side. This mirrors the privacy and offline-verifiability of the existing self-validating `barter://` invite.

**Use inline mode when:**

- The doc is **not (yet) on any bank** — e.g. a freshly signed invoice you want to hand to one specific person before registering it, or a one-time Cheque.
- **Privacy matters** — you do not want the serving bank (or anyone observing the path) to learn the doc was opened, or to be able to enumerate tokens.
- **Offline verification** is required — the recipient can verify the signature with zero network access; only acting on it (submitting `Record`s) needs connectivity.

Trade-off: payload size is bounded by URL/QR limits.

#### Hybrid — reference URL + small signed summary

For mid-size payloads, combine both: a **reference path** (resolvable, previewable, App-Clip-associated) plus a **compact signed summary** in the fragment so the receiver can pin and pre-verify before any fetch:

```
https://bank.example/banks/alice/o/H7..hash#s=eyJ2IjoxLCJzdW0i...
                                          └── #s = base64url(deflate(canonical JSON of a signed summary))
```

The `#s` summary is itself a signed doc — for an `Offer`, the bank-signed `Offer` body (which already hides holder identity and account hashes); for an invoice, a minimal `{voucher, amount, exp, pubkey, sig}` digest signed by the author. The webapp verifies `#s` immediately (self-validation, offline), shows a trustworthy preview, **then** dereferences the reference path for the full doc set if the user proceeds. This keeps the QR scannable while still giving instant, tamper-evident preview. `#b` (full inline) and `#s` (signed summary) are mutually exclusive on a single link.

### Content negotiation + machine extraction

Robustness is the goal: a barter webapp must be able to recover the signed docs through **multiple redundant paths**, so that a stripped HTTP proxy, an over-eager link-preview crawler, or a webview that only got the rendered HTML all still yield the payload.

#### The MIME type

```
application/barter+json
```

- `+json` structured-suffix (RFC 6839): generic JSON tooling still parses it; barter-aware clients recognize the media type.
- Version parameter: **`application/barter+json;v=1`**. Servers SHOULD echo the negotiated version in `Content-Type`; clients MAY request it in `Accept`. The payload envelope *also* carries `"v": 1`, so version survives even if the parameter is stripped.

#### Negotiation paths (any one suffices)

1. **HTTP `Accept`** on the canonical path:
   - `Accept: application/barter+json` → machine payload (envelope of signed docs).
   - `Accept: text/html` (browser default) → the landing page.
2. **`.json` sibling** — `…/v/9F3KQ2.json` always returns the payload, for clients that cannot set headers (camera apps, naive fetchers).
3. **`?format=json`** — `…/v/9F3KQ2?format=json`, same result; survives environments that mangle path suffixes.

All three are equivalent and resolve to the identical envelope. (Routes named in *Bank UI Backend API*.)

#### Embedded-in-HTML payload (last-resort extraction)

Even when a webapp only ends up with the **rendered landing-page HTML** (e.g. a webview handed the page, or a crawler that already fetched `text/html`), it must still recover the docs. The `<head>` therefore embeds the payload three ways:

1. **JSON-LD-style script block** — the canonical embedding, mirroring `<script type="application/ld+json">`:
   ```html
   <script type="application/barter+json" id="barter-payload">…signed docs…</script>
   ```
   For INLINE links this block contains the *full* signed docs (identical to the `#b` fragment, so a server that never sees the fragment can still be the source of an embedded copy only for REFERENCE/hybrid links — INLINE pages render the docs purely client-side from the fragment and MAY omit the block to preserve the never-touches-server property).
2. **Autodiscovery `<link rel="alternate">`** — a typed pointer to the machine representation (RSS/Atom lineage):
   ```html
   <link rel="alternate" type="application/barter+json" href="https://bank.example/banks/alice/v/9F3KQ2.json">
   ```
3. **Typed `<meta name="barter:…">` tags** — flat, crawler-proof key/values that survive aggressive HTML sanitizers which drop `<script>`:
   - `barter:type`, `barter:pubkey`, `barter:bank`, `barter:sig`, `barter:expires`, `barter:version`.

Plus **OpenGraph / Twitter-card** `<meta>` for rich previews in chat apps (owned visually by *QR & Landing Journeys*; the tags live here).

Extraction precedence a webapp SHOULD follow: **`#b` fragment → `Accept`/`.json` negotiation → `<script id="barter-payload">` → `<link rel="alternate">` dereference → `barter:*` meta reconstruction.** It stops at the first source that yields docs whose signatures verify.

### The `barter://` custom-scheme mirror and native deep-linking

The HTTPS Barter Link and the existing OOB strings are **two encodings of the same trust act**, and every Barter Link round-trips to a `barter://`/`barterdeal:` payload:

- **`/x/` is the canonical home of the existing formats.** A `/x/` link in INLINE mode carries, in `#b`, exactly the `barter://<pubkey>@<bank-url>?give=…&get=…&accs=…&exp=…&sig=…` invite or the `barterdeal:` + base64url(canonical JSON) deal token defined in the protocol. The webapp verifies the inviter `sig` *before any network call* — the self-validating property is preserved unchanged.
- **`/i/`, `/v/`, `/q/`, `/o/` extend the same idea** to the doc kinds the protocol's invite string did not cover, using standard signed docs (`Voucher`, invoice/cheque `Order`, `Offer`) as the payload instead of the bespoke invite query-string.

**Native open vs. web fallback** (App Clips / App Links lineage):

- The bank serves an **Apple App Site Association** (`/.well-known/apple-app-site-association`) and an **Android `assetlinks.json`** (`/.well-known/assetlinks.json`) covering the `/i/ /v/ /q/ /o/ /x/` paths. A phone **with** the barter webapp installed opens these HTTPS Barter Links **natively** (universal link / app link); the app reads the same `#b` fragment or negotiates the `.json` payload.
- A phone **without** the app falls through to the **web landing page** — register / add-trusted-issuer / act-on-doc — which is the primary new-user funnel (Requirement 5).
- The `barter://` custom scheme remains the **same-device, app-installed** fast path (and the copy-paste / NFC carrier the protocol already blesses). HTTPS Barter Links are preferred for QR and chat sharing precisely because they degrade gracefully to a web page; `barter://` does not.

One link, three outcomes: **app installed → native open; no app → web landing; webapp fetch → machine payload.**

### Self-validation

A Barter Link is only trusted after its embedded signature(s) verify locally — the bank serving the page is **not** a trust anchor (base.md §5.2). The receiver MUST:

1. **Extract** the signed doc(s) via the precedence order above.
2. **Verify** each doc's ed25519 `sig` over `sha256(canonical(doc minus sig))` using **JCS canonicalization** (base.md §2). For a `/v/` invoice the signed doc is the author's `Order`; for `/o/` it is the bank-signed `Offer`; for `/x/` it is the inviter's invite/deal `sig`; for `/i/` each `Voucher` is verified against its issuer `pubkey`, and `bank` is part of the `Voucher` hash so the issuing bank binding is signed too.
3. **Pin the pubkey** against the URL using `<pubkey>@<bank-url>` semantics: fetch `<bank-url>/barter-bank.json` and compare its `pubkey` to the pinned key; **fail closed** on divergence. The `<pubkey>` in `/i/<pubkey>` and the `pubkey`/`bank` fields inside payload docs are the pinned identities — a tampered host cannot substitute a key without invalidating signatures.
4. **Check expiry** before acting: honor `expires`/`exp` (`Voucher.expires`, invite `exp`, `barter:expires` meta). An expired link renders a "this link has expired" landing state and the webapp refuses to submit `Record`s for it; verification of *authenticity* may still pass, but the doc is not *actionable*.

What is signed, per kind: the **whole doc minus its top-level `sig`** in every case — issuer `Voucher` bodies (including `bank`), the invoice/cheque `Order` (including its `rate`, `debit?`/`credit?` legs, and `lead`), the bank's `Offer`, and the `barter://` invite query (minus `sig`). Account docs carried in `accs`/`#b` are themselves holder-signed and verified the same way.

### QR specifics

- **Error correction: level M (15%)** as the default for Barter Links — balances density against scan reliability on phone cameras and tolerates a small center logo. Use **Q (25%)** only if a larger logo is required.
- **Logo:** an optional centered bank/issuer glyph occupying **≤ 15% of the module area** at ECC-M (≤ 25% at Q). The signed payload is unaffected — the logo overlays redundant modules.
- **Byte budget:** a QR in byte mode tops out near **2 953 bytes** at version 40 ECC-L, but anything past **~300–400 bytes** produces a dense code that mid-range phones struggle to scan at arm's length. Practical guidance:
  - **REFERENCE mode** keeps the URL to ~40–70 bytes (`https://bank.example/banks/alice/v/9F3KQ2`) → a low-version, robust QR. **Prefer REFERENCE (or hybrid) mode for QR** whenever the doc is bank-resolvable.
  - **INLINE `#b`** is viable for small docs (a lone invoice/cheque `Order`, a single-leg invite): after DEFLATE + base64url, a one-`Order` payload is commonly **150–350 bytes** of fragment → keep total URL under ~400 bytes for a reliably scannable QR at ECC-M.
  - If an INLINE payload would blow the budget (multi-`Voucher` profile, fat `accs`), **switch to REFERENCE or hybrid** rather than raising QR version.
- Always uppercase the **origin and path letters**? No — keep them lowercase; QR byte mode handles mixed case, and the base58/base32 tokens are case-significant. (Alphanumeric QR mode is *not* used, because base64url and base58 require lowercase letters.)

> The visual QR rendering, framing, and scan-journey copy are owned by **QR & Landing Journeys**; this section fixes the ECC level, byte budgets, and the reference-vs-inline decision rule that journey depends on.

### Versioning + extensibility

- **Version travels in three redundant places**: the path is implicitly `/v1`-era via the bank's `protocol_version: "barter.game/v1"` in `barter-bank.json`; the MIME parameter `;v=1`; and the payload envelope `{ "v": 1, … }` and `barter:version` meta. A consumer that loses any one channel still recovers the version.
- **Forward-compatible parsing:** unknown payload keys and unknown `barter:*` meta MUST be ignored, not rejected (must-ignore rule). New doc kinds get new single-letter paths; existing kinds keep theirs.
- **Fragment keys are namespaced:** `#b=` (full inline), `#s=` (signed summary); future keys (`#e=` encrypted, etc.) extend without colliding.
- The whole construct is additive **custom layer**: removing every Barter Link route leaves a fully conformant v1 bank. The signed docs inside are unchanged standard docs, so a future protocol version that changes a schema changes the *payload*, not the link envelope.

### Concrete examples

Assume bank `alice` at canonical URL `https://bank.example/banks/alice`, issuer pubkey `7Fk9…q2W` (abbreviated), invoice `Order` hash `H7c…`, offer hash `Of3…`.

**One link per kind, both modes:**

```
# Issuer profile — REFERENCE (the funnel link behind a profile QR)
https://bank.example/banks/alice/i/7Fk9q2W
# Issuer profile — INLINE (self-contained: pubkey + Address pointer + a couple Vouchers)
https://bank.example/banks/alice/i/7Fk9q2W#b=eJyNkc1uwjAQhF8l...

# Invoice — REFERENCE (bank resolves via get_invoice)
https://bank.example/banks/alice/v/9F3KQ2
# Invoice — INLINE (signed credit-only Order in the fragment, never sent to server)
https://bank.example/banks/alice/v/_#b=eJyrVkrLz1eyUlBKLS7...

# Cheque — REFERENCE (bank resolves via get_cheque)
https://bank.example/banks/alice/q/4M2WX8
# Cheque — INLINE (signed debit-only Order in the fragment)
https://bank.example/banks/alice/q/_#b=eJyNzUEKgzAQheG7...

# Offer — REFERENCE (bank-signed Offer, discoverable)
https://bank.example/banks/alice/o/Of3hash
# Offer — HYBRID (reference path + pre-verifiable signed Offer summary)
https://bank.example/banks/alice/o/Of3hash#s=eyJ2IjoxLCJkb2Nz...

# Invite / deal — INLINE (carries the existing self-validating barter:// invite)
https://bank.example/banks/alice/x/_#b=eJyNkMFqwzAQRH9l...   (decodes to barter://7Fk9q2W@https://bank.example/banks/alice?give=…&get=…&exp=…&sig=…)
# Invite / deal — REFERENCE (bank mirrors a registered deal token)
https://bank.example/banks/alice/x/D3AL01
```

**Complete `<head>` for an invoice landing page** (REFERENCE link `…/v/9F3KQ2`, with the full signed `Order` embedded so a fetched page still yields the doc):

```html
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Invoice from 7Fk9…q2W · 100 COFFEE</title>

  <!-- Autodiscovery: typed pointer to the machine representation (RSS/Atom lineage) -->
  <link rel="alternate" type="application/barter+json;v=1"
        href="https://bank.example/banks/alice/v/9F3KQ2.json">

  <!-- Native deep-link association (App Clip / App Link) -->
  <link rel="apple-touch-icon" href="/banks/alice/icon.png">
  <meta name="apple-itunes-app" content="app-clip-bundle-id=game.barter.clip">

  <!-- Flat, sanitizer-proof barter:* tags (survive when <script> is stripped) -->
  <meta name="barter:version" content="1">
  <meta name="barter:type"    content="order">      <!-- invoice = credit-only Order -->
  <meta name="barter:kind"    content="invoice">
  <meta name="barter:pubkey"  content="7Fk9q2W…">   <!-- author of the Order -->
  <meta name="barter:bank"    content="9Bk2…aL1">   <!-- issuing bank pubkey, pinned -->
  <meta name="barter:sig"     content="3sN…order-sig">
  <meta name="barter:expires" content="1771286400">

  <!-- Rich link preview (OpenGraph + Twitter card) -->
  <meta property="og:type"        content="website">
  <meta property="og:title"       content="Invoice · 100 COFFEE">
  <meta property="og:description" content="7Fk9…q2W is requesting 100 COFFEE. Scan to pay or register.">
  <meta property="og:image"       content="https://bank.example/banks/alice/v/9F3KQ2/preview.png">
  <meta property="og:url"         content="https://bank.example/banks/alice/v/9F3KQ2">
  <meta name="twitter:card"       content="summary_large_image">

  <!-- JSON-LD-style embedded machine payload: the signed docs themselves -->
  <script type="application/barter+json" id="barter-payload">
  {
    "v": 1,
    "docs": [
      {
        "type": "order",
        "pubkey": "7Fk9q2W…",
        "ulid": "01J9Z3K7QH8X2M4N6P0R5T7V9B",
        "rate": "1",
        "credit": {
          "account": "Ac1…hash",
          "voucher": "Vc0ffee…hash",
          "bank": "9Bk2…aL1",
          "min": "100",
          "max": "100"
        },
        "lead": false,
        "sig": "3sN…order-sig"
      }
      /* author Account doc(s) referenced by credit.account included here when present */
    ]
  }
  </script>
</head>
```

A barter webapp loading this page: reads `#b` (none here → REFERENCE), reads `<script id="barter-payload">`, re-canonicalizes the `Order` minus `sig` via JCS, verifies `3sN…order-sig` against `7Fk9q2W…`, pins `9Bk2…aL1` against `…/barter-bank.json`, checks `expires`, and only then offers the user the "create the matching `Record`s / submit_docs" action (flow owned by *Core Object Flows*). A normal browser ignores all of it and renders the human landing page (owned by *QR & Landing Journeys*).

### Handoffs

- **Human UX** of each landing journey (issuer-profile registration funnel, invoice/cheque pay screens, invite acceptance, expired/empty states) → **QR & Landing Journeys**.
- **Server routes** that back these links — `GET /i/:pubkey`, `GET /v/:token`, `GET /q/:token`, `GET /o/:hash`, `GET /x/:token`, each with `.json` / `?format=json` / `Accept`-negotiated variants, plus `/.well-known/apple-app-site-association` and `/.well-known/assetlinks.json` — and their mapping to `get_voucher` / `get_invoice` / `get_cheque` / `list_offers` / `get_address` → **Bank UI Backend API**.
- **What the user does** with an extracted+verified doc (authoring `Order`s, presenting `Account`s, the matchmaker path to `ready`/`hold`/`settle`) → **Core Object Flows**.
- **Key pinning + decryption** that gates "act on this link" → **Identity / Key Custody**.

## 6. QR Codes & Landing-Page Journeys (onboarding + social mechanics)

This section specifies the human and webapp flows for the three QR / Barter-Link journeys served by the bank's custom web UI (base.md §6). It covers **what each QR encodes**, the **logged-out camera-browser path** (phone camera → web landing → register/login), the **barter-webapp path** (signed-doc extraction with no landing chrome), the **trust auto-add** semantics, what is **pre-filled**, and the **security gating** ("verify the embedded signature before any network call").

This section owns *flows and decision logic only*. It does **not** define:

- The Barter Link wire format — the embedded `<script type="application/barter+json">`, `<link rel="alternate" type="application/barter+json">`, OpenGraph meta, content negotiation, and **reference vs inline** modes — see **Barter Link format**.
- Key generation / encryption / decryption-in-browser — see **Identity/Key Custody**.
- Concrete screen layouts and component specs — see **Screens & Navigation**.
- Backend routes that mint links, serve landing HTML, and store custom UI state (trusted issuers, known banks) — see **Bank UI Backend API**.
- The Order/Offer/Record/Confirm/settle mechanics a PAY or CLAIM ultimately triggers — see **Core Object Flows**.

All three journeys ride **one URL** that is simultaneously a human landing page and a signed-document carrier. The protocol-standard primitives in play are unchanged: a journey is a transport for an **Issuer profile** (pubkey @ bank + featured Vouchers/Offers), an **invoice Offer** (credit-only), or a **cheque Offer** (debit-only). Nothing here alters a standard schema or RPC.

---

### 1. The three Barter Links and what they encode

Every journey is a single HTTPS URL on the bank UI (`<bank-url>/...`). The path namespace and the link minting endpoint are owned by **Bank UI Backend API**; here we fix the *semantic contract* of each link type.

| Journey | URL shape (illustrative) | `kind` in `application/barter+json` | Carried signed docs | Human landing headline |
|---|---|---|---|---|
| Issuer Profile announce / friend-invite | `<bank-url>/i/<pubkey>` | `profile` | Featured **Voucher** bodies + optional **Offer** bodies (bank-signed); the owner's **Address** doc | "Meet *\<handle\>* — trust them to start trading" |
| Invoice (request for payment) | `<bank-url>/v/<offer-hash>` | `invoice` | The credit-only **Offer** (bank-signed) + its **Voucher** body | "Pay *\<amount\> \<voucher\>* to *\<issuer\>*" |
| Cheque (claim funds) | `<bank-url>/q/<offer-hash>` | `cheque` | The debit-only **Offer** (bank-signed) + its **Voucher** body | "Claim *\<amount\> \<voucher\>* from *\<issuer\>*" |

Notes:

- The URL **path itself never contains a private key or a holder Account hash.** Account hashes are hidden inside the bank-derived Offer (per the invoice/cheque scenarios). The profile link carries only the public `pubkey`, the bank pubkey (pinned), and bank-signed Offers.
- **Reference vs inline mode** (defined in Barter Link format) is chosen by the minter: short links use *reference* mode (the embedded JSON gives a hash + a `<link rel="alternate">` the webapp fetches), large or self-contained shares use *inline* mode (full signed bodies embedded). A webapp MUST handle both; the journeys below are mode-agnostic and say "extract the signed Offer" without caring which mode delivered it.
- Every link MAY carry `&exp=<unix>`. The invoice/cheque Offers also carry their own protocol `expires?` on the Voucher and `min/max` on the Offer. **Two expiries exist** (link expiry and doc/Voucher expiry); the UI must honor the stricter of the two (see §6).

#### 1.1 Generating a link (owner side)

Generation lives on the owner's authenticated dashboard (screen specs in **Screens & Navigation**; mint route in **Bank UI Backend API**). The owner:

1. Picks the journey (Profile / Invoice / Cheque). For invoice/cheque the owner first creates the underlying **Order** with `debit` omitted (invoice) or `credit` omitted (cheque) and `submit_docs(..., publish_offers:[hash])` so the bank derives and signs the **Offer** — this is the *same* Step 1 as the invoice/cheque scenarios. The link is minted *over the returned Offer hash*; no new doc type is introduced.
2. For Profile, picks which owned **Vouchers** and live **Offers** to feature.
3. Receives: a rendered **QR** (PNG/SVG), the raw URL, and Copy / Print / Share-sheet actions. The QR's payload is exactly the URL — no app-specific scheme, so any phone camera resolves it.

> The QR encodes a normal `https://` URL, never a `barter://` deep-link. Deep-linking into an installed webapp is achieved by **universal links / app links** keyed on that same `https://` URL (§5), so one artifact serves both audiences.

---

### 2. Client-side decision logic: webapp vs web landing

The same URL must dispatch to (a) an installed barter webapp that extracts signed docs, or (b) a plain browser that renders the human landing page. Detection is layered, most-capable first, with a manual fallback.

```
Scan a Barter Link URL
        │
        ▼
┌─────────────────────────────────────────────┐
│ A. OS universal/app-link / App-Clip          │
│    The https URL is registered to the barter  │
│    webapp (apple-app-site-association /        │
│    assetlinks.json on <bank-url>).             │
│    OS opens the webapp directly with the URL.  │
└───────────────┬───────────────────────────────┘
                │ not installed / not registered / desktop
                ▼
┌─────────────────────────────────────────────┐
│ B. Bank serves landing HTML (always).         │
│    The page is a valid human page AND a doc    │
│    carrier (embedded barter+json, rel=alternate│
│    OG meta — see Barter Link format).          │
└───────────────┬───────────────────────────────┘
                │ page JS runs in the browser
                ▼
┌─────────────────────────────────────────────┐
│ C. In-page handoff probe:                      │
│    1. Is this an in-app webview that speaks    │
│       barter? (window.barter bridge present)   │
│         → hand the embedded docs to the bridge,│
│           hide landing chrome.                 │
│    2. Else is the user logged in to THIS bank's│
│       web UI (session cookie + decryptable key │
│       in this browser)?                        │
│         → render the "logged-in" variant       │
│           (prefilled action, trust one-tap).   │
│    3. Else render the "logged-out" landing      │
│       (register/login CTA).                     │
└───────────────┬───────────────────────────────┘
                │ user wants the app but auto-open failed
                ▼
┌─────────────────────────────────────────────┐
│ D. Manual fallback banner:                     │
│    "Open in barter app" button → tries the     │
│    custom scheme barter://open?u=<url-enc>,    │
│    with a timeout that reveals "Continue in     │
│    browser". Also a "Copy Barter Link" button.  │
└─────────────────────────────────────────────┘
```

Key properties:

- **The bank ALWAYS returns a usable landing page** for the URL. Universal-link interception (A) is an OS optimization on top of a page that already works without it. There is no broken state if the app isn't installed.
- **Content negotiation** (Barter Link format) lets a webapp that *does* perform a network fetch ask for `Accept: application/barter+json` and receive just the signed docs instead of HTML. A browser gets `text/html`. The journeys treat both identically once the docs are in hand.
- The probe in (C) is pure client JS reading already-delivered, already-embedded docs. It performs **no network call** before signature verification (§6).
- "Logged in to this bank's web UI" means the browser holds a session for `<bank-url>` *and* can decrypt the stored key (Identity/Key Custody). A cross-bank link (a profile link for `other-bank`) opened in this browser is treated as logged-out unless the user has a session there too; trust/known-bank state is per-user and synced server-side (Bank UI Backend API).

---

### 3. Journey 1 — Issuer Profile announce / friend-invite + new-user funnel

Purpose: a holder advertises their **issuer profile** (their `pubkey @ bank` plus featured **Vouchers**/**Offers**) and recruits friends, who on registering **auto-trust** the announcer.

#### 3.1 What the QR encodes

`kind:"profile"` carrying: owner `pubkey`, owner's signed **Address** doc (or the pinned `pubkey@<bank-url>`), bank `pubkey` (pinned) + `barter-bank.json` reference, and the featured **Voucher** bodies + bank-signed **Offer** bodies. "Trust" is a *custom UI list of issuer pubkeys* (per product requirement 4) — it is **not** a protocol concept and never appears in any signed doc.

#### 3.2 Camera-browser viewer (likely NOT registered)

```
Phone camera → https://<bank-url>/i/<pubkey>
   │
   ▼  Bank serves landing HTML; page JS verifies embedded Address sig
   │  against <pubkey> (offline, no network) → render
   ▼
┌──────────────────────────────────────────────┐
│ ISSUER PROFILE LANDING                          │
│ • Handle + avatar                               │
│ • Pubkey shown, truncated, "pinned" badge        │
│ • Bank name + bank pubkey (pinned; compared to   │
│   barter-bank.json AFTER user opts in)           │
│ • Featured Vouchers (name, image_svn, desc_md)   │
│ • Live Offers (sell/buy, rate, min–max)          │
│ • Trust-cues: "Verified signature ✓",            │
│   "N mutual trusted issuers" (only if logged in)  │
│                                                  │
│ [ Register & trust <handle> ]   ← PRIMARY        │
│ [ I already have an account → log in & trust ]   │
└──────────────────────────────────────────────┘
```

**Primary CTA — "Register & trust \<handle\>":**

```
1. Run Register flow (create NEW keypair in browser; choose
   decryption password; encrypted key stored server-side —
   Identity/Key Custody). Warn: forgetting password = lose
   key = lose account (v1: no recovery, no rotation).
2. On success, ATOMIC post-register hook:
     a. Add <bank-url>+bank-pubkey to the new user's KNOWN BANKS
        (pinned pair), validating barter-bank.json == pinned pubkey.
     b. Add owner <pubkey> to the new user's TRUSTED ISSUERS list.
     c. Import the featured Voucher bodies into the user's local
        catalog (cache only; bodies are content-addressed).
3. Confirmation toast: "You now trust <handle>. Their N vouchers
   are in your catalog." with an [Undo] that removes the trust entry.
```

The trust auto-add is **presented and reversible**, not silent, for a new registrant: the registration's final screen states explicitly "Completing registration will add \<handle\> to your trusted issuers" before the keypair is committed, and the post-register toast offers Undo. No signed doc is produced by trusting — it mutates only custom UI state (Bank UI Backend API).

**Secondary CTA — "I already have an account → log in & trust":** runs the Login flow (decrypt existing key in browser), then performs steps 2a–2c above, with a single explicit "Trust \<handle\>?" confirm (because an existing user has standing trust state to protect).

#### 3.3 Barter-webapp viewer (already a user)

App-link interception (§2-A) opens the webapp with the URL; the webapp reads the embedded/`rel=alternate` docs, verifies the **Address**/Offer signatures offline against `<pubkey>` / bank pubkey, then:

- **One-tap sheet** (no full landing chrome): "Trust \<handle\> and import N vouchers?" → **[Trust]** adds the issuer pubkey to the trusted list, adds the bank to known banks (pinned), imports Voucher bodies. If the issuer is already trusted, the sheet degrades to "Already trusted — view profile / import new vouchers."
- Silent path is allowed only for **idempotent re-imports** (re-scanning an already-trusted issuer refreshes featured Voucher/Offer bodies without a prompt). A *new* trust relationship always requires the one tap.

---

### 4. Journey 2 — Invoice landing (request for payment)

Purpose: the issuer published a **credit-only Offer** (invoice — `debit` omitted Order, per `scenarios/invoice.md`). The viewer is the *payer*: they must produce the matching **debit-only (cheque-side) Order/Offer** and let a matchmaker pair them.

#### 4.1 Camera-browser viewer

```
Phone camera → https://<bank-url>/v/<offer-hash>
   │
   ▼  Landing HTML; page JS verifies the embedded invoice Offer's
   │  bank signature against the bank pubkey (offline)
   ▼
┌──────────────────────────────────────────────┐
│ INVOICE LANDING                                 │
│ "Pay <amount> <voucher-name> to <issuer-handle>"│
│ • Voucher (name, image, description_md, due?)    │
│ • Amount window: min–max (from Offer)            │
│ • Issuer pubkey (pinned) + Bank (pinned)         │
│ • rate shown if non-1 (cross-voucher exchange)   │
│ • Expiry banner if exp / Voucher.expires near    │
│                                                  │
│ [ Register & pay ]   [ Log in & pay ]            │
└──────────────────────────────────────────────┘
```

**Register & pay / Log in & pay → prefilled PAY flow:**

```
1. Register or Login (Identity/Key Custody). For Register, the
   new user also gets the invoice's BANK added to known banks
   (pinned) — they need an Account at that bank to pay (or a
   cross-bank Offer at rate ≠ 1).
2. Open PAY screen PREFILLED from the invoice Offer:
     • counterparty issuer pubkey + bank   (read-only, pinned)
     • voucher hash + name                  (read-only)
     • amount = invoice amount (or editable within min–max)
     • rate   = invoice Offer.rate          (shown; user's debit
                Order rate must satisfy it in aggregate at ready)
     • the user's own debit Account on that voucher/bank
       (selected; created implicitly when its signed Account doc
        is first presented — there is no open_account call)
3. User confirms → the UI builds the user's matching cheque-side
   Order (credit omitted) + Account doc, signs the Order with the
   in-browser-decrypted key, and submit_docs(..., publish_offers)
   so the bank derives the user's debit-only Offer. A matchmaker
   pairs invoice⨯cheque (Core Object Flows). lead/follow per the
   Orders (the payer's debit Order may lead, per invoice scenario).
```

Only **the user's own Order is signed in the browser**; the invoice Offer is consumed read-only. The payer never signs the issuer's doc.

#### 4.2 Barter-webapp viewer

App opens with the URL; extracts the signed invoice **Offer** (+ Voucher body) from metadata; verifies the bank signature offline; opens the **PAY screen prefilled** exactly as in step 2 above, skipping the landing chrome. If the user lacks an Account/known-bank entry for the invoice's bank, the app inlines a "add this bank + create Account" step before signing.

---

### 5. Journey 3 — Cheque landing (claim funds)

Purpose: the issuer published a **debit-only Offer** (cheque — `credit` omitted Order, per `scenarios/cheque.md`), authorizing anyone to debit the issuer. The viewer is the *recipient*: they produce the matching **credit-only (receiving) Order/Offer** to claim.

#### 5.1 Camera-browser viewer

```
Phone camera → https://<bank-url>/q/<offer-hash>
   │
   ▼  Landing HTML; verify embedded cheque Offer's bank sig (offline)
   ▼
┌──────────────────────────────────────────────┐
│ CHEQUE LANDING                                  │
│ "Claim <amount> <voucher-name> from <issuer>"   │
│ • Voucher (name, image, description_md)          │
│ • Amount window min–max; rate if ≠ 1              │
│ • Issuer pubkey (pinned) + Bank (pinned)         │
│ • Expiry banner                                  │
│                                                  │
│ [ Register & claim ]   [ Log in & claim ]        │
└──────────────────────────────────────────────┘
```

**Register & claim / Log in & claim → prefilled CLAIM flow:**

```
1. Register or Login; on Register add the cheque's BANK to known
   banks (pinned). The recipient needs a receiving Account on
   that voucher/bank.
2. Open CLAIM screen PREFILLED from the cheque Offer:
     • payer (issuer) pubkey + bank        (read-only, pinned)
     • voucher hash + name                  (read-only)
     • amount within min–max (default = max claimable)
     • the recipient's own credit Account   (selected/implicit)
3. User confirms → UI builds the recipient's matching credit-only
   (receiving) Order (debit omitted) + Account doc, signs the
   Order in-browser, submit_docs(..., publish_offers). Matchmaker
   pairs cheque⨯receiving; the cheque's lead=true debit Order
   leads, follower cites it in Signature.seen (Core Object Flows).
```

#### 5.2 Barter-webapp viewer

App opens with the URL; extracts the signed cheque **Offer** (+ Voucher); verifies bank signature offline; opens the **CLAIM screen prefilled** as above, no landing chrome; inlines bank-add / Account-create if missing.

---

### 6. Security gating — "verify before any network call"

This property is mandatory across all three journeys and both viewer types. The embedded docs are **self-validating**: the receiver verifies signatures **before** any RPC, exactly like the existing invite-string and `barterdeal:` formats. Tampering invalidates the link and the UI refuses to act.

**Verification order (client, offline):**

1. **Parse** the embedded `application/barter+json` (inline) or fetch the `rel=alternate` resource (reference mode) — note: reference-mode *does* fetch, but the fetch returns only signed docs which are then verified before any *action* RPC, and the fetch target is on the pinned `<bank-url>`.
2. **Recompute** `SHA-256(canonical(doc minus sig))` (RFC 8785 / JCS) and verify the ed25519 **signature**:
   - Profile **Address** / Voucher → signed by the issuer `pubkey` in the path.
   - Invoice/cheque **Offer** → signed by the **bank** pubkey (Offers are bank-derived, bank-signed).
3. **Pin check:** compare the link's bank pubkey to `barter-bank.json` fetched from `<bank-url>` (this is the *first* permitted network read, and it only confirms pinning; it triggers no ledger mutation). Divergence ⇒ **fail closed**, banner: "This bank's key does not match — do not proceed."
4. **Display the signer:** every landing/sheet shows the **signer pubkey** (truncated + copyable) and the **pinned bank** before any actionable button is enabled.

**Warnings (block or require explicit override):**

| Condition | UI behavior |
|---|---|
| Embedded signature invalid / hash mismatch | **Hard block.** "This link was tampered with or is corrupt." No CTA. |
| Link `exp` or Voucher `expires?` in the past (use the stricter) | **Hard block** for actions; profile may still render read-only with an "expired offer" badge. |
| Bank pubkey ≠ `barter-bank.json` | **Hard block.** Fail closed (step 3). |
| Bank not in user's known banks (unknown bank) | **Warn + confirm.** "You've never traded with this bank. Add and pin its key?" Requires explicit add before PAY/CLAIM. |
| Issuer pubkey not in trusted list | **Soft caution** on invoice/cheque ("You don't trust this issuer yet"); on profile this is expected (the whole point is to start trusting). |
| Amount near/at `max`, or amount editable | Show min–max window; on PAY, restate "You authorize debiting up to \<amount\>" before signing the user's Order. |
| `rate ≠ 1` (cross-voucher) | Surface the implied exchange and that the user's debit Order `rate` is a **limit checked in aggregate at ready**, not a guaranteed price. |

**No-network-before-verify guarantees:**

- The camera-browser path verifies the embedded signature in page JS **before** enabling any CTA; the only pre-CTA network touch is the pinning fetch of `barter-bank.json` (a read, never a mutation).
- The webapp path verifies the extracted Offer/Address signature **before** opening the prefilled PAY/CLAIM/trust sheet.
- **No `submit_docs`, `create_records`, `submit_confirm`, or trust-list write occurs until** (a) signatures verify, (b) pinning matches, and (c) the user confirms. A failed verification produces **zero** ledger or custom-state side effects.

---

### 7. Cross-journey summary table

| Aspect | Profile | Invoice | Cheque |
|---|---|---|---|
| Viewer's role | future friend / new user | payer | recipient |
| Carried signed doc | Address + featured Vouchers/Offers (issuer/bank-signed) | credit-only Offer (bank-signed) | debit-only Offer (bank-signed) |
| New-user trigger | Register & trust (auto-trust + add bank) | Register & pay (add bank, create Account) | Register & claim (add bank, create Account) |
| Existing-user (webapp) | one-tap trust + import vouchers | open prefilled PAY | open prefilled CLAIM |
| User signs in browser | nothing (trust = UI state) | their cheque-side **Order** | their receiving **Order** |
| Auto-trust side effect | issuer → trusted list, bank → known banks | bank → known banks | bank → known banks |
| Prefilled | n/a (catalog import) | counterparty, voucher, amount(min–max), rate, own debit Account | counterparty, voucher, amount(min–max), rate, own credit Account |
| Settlement path | none (social only) | matchmaker pairs invoice⨯cheque; lead/follow → ready→hold→settle | matchmaker pairs cheque⨯receiving; cheque leads; follower cites `seen` |

---

### 8. Future (out of scope)

Direct messaging between issuer and viewer from the landing page, and voucher "blogs" surfaced on the profile landing, are explicitly **future** and not part of this version. The profile link reserves room for them but the v1 UI ships profile/invoice/cheque journeys only.

## 7. Bank UI Backend API (custom layer)

This section defines every **new HTTP endpoint** the bank process adds to serve and support the web UI. These endpoints live entirely in the **custom layer** sanctioned by `base.md §6`: they MUST NOT alter any standard document schema, the JSON-RPC envelope, or the semantics of the methods in `bank-rpc.md`. A client that speaks only the standard protocol (`/rpc`, `/barter-bank.json`, `/address/<pubkey>`) never touches any route below and remains fully interoperable. Everything here is convenience, aggregation, and CORS plumbing wrapped around the same signed docs.

> **Invariant restated for this layer:** Every custom endpoint either (a) stores/returns *public-derived or client-encrypted* state, or (b) forwards an **already-client-signed** standard artifact. The bank is never trusted to forge authority — all money-moving artifacts (Order, Offer, Confirm, Record, Signature) are produced and signed exactly as the protocol defines them. Custom error codes use the `-32006..-32099` range; HTTP-level errors use ordinary status codes.

### Conventions

- **Base path.** All custom routes are under `/ui/`. Two families:
  - `/ui/*` — the SPA bundle and the JSON API (this section).
  - Public **landing routes** (`/i/`, `/v/`, `/q/`, `/o/`, `/x/`) — the canonical Barter Link namespace (§3.4); rendered HTML for human scans, `application/barter+json` for webapp scans. Format owned by **The Barter Link** (§5).
- **Content type.** JSON API requests/responses are `application/json; charset=utf-8` unless noted.
- **CORS.** `/ui/*` JSON endpoints serve `Access-Control-Allow-Origin` for the bank's own UI origin only (the SPA is same-origin with its bank, so CORS is permissive-to-self, strict-to-others). The cross-bank problem the SPA actually has — calling *other* banks' `/rpc` from the browser — is solved by [`/ui/relay`](#6-cross-bank-relay--proxy), not by asking every bank to open CORS.
- **Pubkeys & hashes** are base58 strings exactly as in the protocol; `:pubkey`, `:hash`, `:handle`, `:deal_id` path params are URL-path-safe (base58/Crockford base32 are already URL-safe; handles are validated to `[a-z0-9_-]{3,32}`).
- **Crypto pipeline** (KDF, keystore blob shape, signing) is owned by **Identity / Key Custody**. This section only moves the resulting blobs and verifies the resulting signatures.

### Endpoint summary

| # | Method & path | Auth | Purpose |
|---|---|---|---|
| 1 | `GET /ui/handle/:handle` | none | Handle availability + pubkey lookup |
| 1 | `POST /ui/register` | none (proof on first use) | Reserve handle, store pubkey + keystore blob |
| 1 | `GET /ui/keystore/:handle` | none (rate-limited) | Return encrypted keystore blob (never plaintext) |
| 1 | `PUT /ui/keystore` | signed-request | Rotate password = re-upload re-encrypted blob |
| 1 | `GET /ui/challenge` | none | One-time nonce for login proof (optional) |
| 3 | `GET /ui/state` | signed-request | Read full per-user app-state blob |
| 3 | `PUT /ui/state` | signed-request | Replace per-user app-state blob |
| 3 | `POST /ui/trusted` | signed-request | Add a trusted issuer pubkey |
| 3 | `DELETE /ui/trusted/:pubkey` | signed-request | Remove a trusted issuer |
| 3 | `GET/POST/DELETE /ui/contacts[/:pubkey]` | signed-request | Contacts CRUD |
| 3 | `GET/POST/DELETE /ui/banks[/:pubkey]` | signed-request | Known-banks list CRUD |
| 3 | `GET/PUT /ui/catalog` | signed-request | Voucher/issuer catalog cache |
| 3 | `GET/PUT/DELETE /ui/drafts[/:id]` | signed-request | Saved Order/Voucher drafts |
| 3 | `GET/PUT /ui/prefs` | signed-request | UI preferences |
| 4 | `GET /ui/portfolio` | signed-request | Aggregate balances across known issuer banks |
| 4 | `GET /ui/history` | signed-request | Assembled transaction history |
| 4 | `GET /ui/orders` | signed-request | User's active/past Orders + derived Offers |
| 5 | `POST /ui/discover` | signed-request | Poll known banks' `list_offers`, merged |
| 6 | `POST /ui/relay` | signed-request (outer) | Forward a client-signed envelope to another bank |
| 6 | `POST /ui/relay_signatures` | signed-request | Pull `get_record_signatures` → push `notify_signatures` (the "Nudge") |
| 6 | `GET /ui/resolve/:pubkey` | none | Address-cache resolution (pubkey → url) |
| 7 | `POST /ui/propose_deal` | signed-request | Bank acts as matchmaker on user's behalf |
| 7 | `GET /ui/deal/:deal_id` | signed-request | Deal progress (ready/hold/settle) |
| 8 | `GET /ui/`, `/ui/app/*` | none | SPA shell + static assets |
| 8 | `GET /i/:pubkey`, `/v/:token`, `/q/:token`, `/o/:hash`, `/x/:token` | none | Public landing routes (Barter Link, §3.4 / §5) |

---

### 2. Signed-request auth (one reusable scheme)

Every per-user mutating call and every private read uses **one** scheme, deliberately reusing the protocol's signing primitive (`base.md §4`) so the SPA has a single signer code path. The unlocked browser holds the plaintext private key in memory only (decrypted client-side per Key Custody) and signs a compact auth envelope over the request body.

The signed material is sent in an `Authorization`-style header so the JSON body stays exactly the request payload:

```
POST /ui/trusted
Content-Type: application/json
X-Barter-Auth: <base64url(canonical(authdoc minus sig))>.<base58 sig>

{ "pubkey": "BvK9...issuer" }
```

The decoded `authdoc` is:

```json
{
  "pubkey":  "9aXf...user",      // signer = the user's pubkey (the per-user key)
  "method":  "POST",            // HTTP method, bound to prevent verb swap
  "path":    "/ui/trusted",     // exact request path (no query for mutations; full path+query for GETs)
  "id":      "01J9Z...ULID",    // ULID, claimed in the bank's replay window (same window as /rpc)
  "ts":      1750420000000,     // ms timestamp; bank rejects outside ±120s skew
  "body_sha256": "Gdi7...base58" // SHA-256(raw request body); omitted/null for empty-body GETs
}
```

- `sig = ed25519(sha256(canonical(authdoc minus sig)))` — identical hashing/canonicalization to protocol doc signing (RFC 8785 / JCS), so the SPA reuses the same `sign()`.
- **Replay** is enforced on `(pubkey, id)` in the same sliding window as `/rpc`; duplicate → `409` + `{"code":-32002}`. `ts` bounds window membership.
- **Binding** of `method`, `path`, and `body_sha256` stops a captured header from being replayed against a different route or a tampered body.
- The bank verifies the signature locally; **no plaintext key ever crosses the network** (Goal 3). There is no server-side password — auth is pure signature.
- **`pubkey` is the account identity.** Per-user state is keyed by this pubkey, never by handle. Handles are a UX alias only (see group 1).

`GET /ui/challenge` (optional, for clients that prefer a server-issued nonce over a timestamp): returns `{"nonce":"<ulid>","exp":<ms>}`; if used, the SPA puts that nonce in `authdoc.id` and the bank verifies it was issued and unspent. The `ts`/replay-window scheme is the default and sufficient; the challenge is for stricter deployments.

Errors common to all signed-request endpoints:

| HTTP | code | Meaning |
|---|---|---|
| 401 | `-32001` | Missing/invalid `X-Barter-Auth` signature |
| 400 | `-32600` | Malformed authdoc / `body_sha256` mismatch |
| 409 | `-32002` | Replayed `id` |
| 408 | `-32006` | Timestamp skew outside ±120s |
| 403 | `-32007` | Signer pubkey not registered (where registration is required) |

---

### 1. Auth & keystore

These endpoints store the **encrypted** private-key blob on the server and hand it back only to be decrypted in the browser. The blob's internal shape (`ciphertext`, `nonce`, `salt`, `kdf` params) is defined by **Key Custody**; this layer treats it as opaque bytes plus a small metadata header it does not interpret.

#### `GET /ui/handle/:handle`
Availability + reverse lookup. No auth.

- **200** `{ "handle":"alice", "available":false, "pubkey":"9aXf..." }` — taken; returns the bound pubkey so a returning user can fetch their keystore.
- **200** `{ "handle":"alice", "available":true }` — free to register.
- **400** `{ "code":-32600, "message":"invalid handle" }` — fails `[a-z0-9_-]{3,32}`.

#### `POST /ui/register`
Reserve a handle and store the pubkey + encrypted keystore. No auth header (the handle is unclaimed, so there is nothing yet to sign against), but the request body carries a **self-proof**: it is signed by the very `pubkey` being registered, proving the registrant holds the key.

Request:
```json
{
  "handle": "alice",
  "pubkey": "9aXf...user",
  "proof":  "<base58 sig over sha256(canonical({handle,pubkey,keystore_sha256}))>",
  "keystore": {
    "ciphertext": "<base64url>",
    "nonce":      "<base64url>",
    "salt":       "<base64url>",
    "kdf":        { "name":"argon2id", "t":3, "m":65536, "p":1 }  // shape owned by Key Custody
  }
}
```

Response:
- **201** `{ "handle":"alice", "pubkey":"9aXf...user" }`
- **409** `{ "code":-32008, "message":"handle taken" }`
- **409** `{ "code":-32009, "message":"pubkey already registered" }`
- **401** `{ "code":-32001, "message":"proof signature invalid" }`
- **400** `{ "code":-32600 }` — bad handle, oversized blob (> 16 KiB), or missing kdf params.

> The bank enforces handle uniqueness and one-handle-per-pubkey. Losing the decryption password means the `ciphertext` is undecryptable and the account is lost — consistent with v1 "lose key ⇒ lose account" (Goal 3). The bank cannot help recover it; it never sees the password or the plaintext key.

#### `GET /ui/keystore/:handle`
Returns the encrypted blob for the browser to decrypt locally. No auth (the blob is useless without the password) but **strictly rate-limited** to blunt offline-dictionary harvesting.

- **200** `{ "handle":"alice", "pubkey":"9aXf...", "keystore": { "ciphertext","nonce","salt","kdf" } }`
- **404** `{ "code":-32005, "message":"unknown handle" }`
- **429** `{ "code":-32010, "message":"rate limited", "retry_after": 30 }` — e.g. > 5 fetches / handle / minute and > 30 / IP / minute.

> Never returns plaintext. The bank has none to return.

#### `PUT /ui/keystore`
Password rotation = re-encrypt locally and re-upload. **Auth: signed-request** (the user proves key possession by signing; rotating the *password* changes the blob, not the keypair, so the signature still validates with the same key).

Request body: the new keystore object (same shape as register's `keystore`). The `X-Barter-Auth` signer MUST equal the pubkey currently bound to the keystore.

- **200** `{ "handle":"alice", "rotated_at": 1750420000000 }`
- **401** `{ "code":-32001 }` — signer ≠ bound pubkey.
- **400** `{ "code":-32600 }` — malformed blob.

> There is no key *rotation* in v1, only password (blob) rotation. The `pubkey` is immutable; rebinding a handle to a new pubkey is not offered.

---

### 3. Per-user app state (custom, server-stored, keyed by pubkey)

This is pure UI state the protocol has no concept of. **All of it is public-derived or user-authored metadata** — trusted-issuer pubkeys, contacts, known banks, a cached voucher/issuer catalog, saved drafts, and UI prefs. It is keyed by the signed-request `pubkey`.

**Storage recommendation.** Because this blob is *not secret* (trusted issuers and known banks are pubkeys/URLs that are already public, contacts are pubkeys, drafts are unsigned proposals), the default is **plaintext server-side storage** so the same account works from any device after a single keystore unlock. A privacy-conscious deployment MAY instead store an opaque **client-encrypted** blob (same envelope family as the keystore) and treat `/ui/state` as a sealed bucket; the server then cannot index `trusted`/`banks` for the aggregation helpers in group 4, so those helpers would have to receive the lists as request params instead. **Recommendation: plaintext-by-default, with an opt-in `prefs.encrypt_state` flag** that, when set, makes the server store and return `/ui/state` as a single sealed blob and disables server-side fan-out using stored lists (the SPA then passes lists explicitly to `/ui/portfolio` etc.).

Canonical state document (server merges sub-resource writes into this):
```json
{
  "pubkey": "9aXf...user",
  "trusted": ["BvK9...issuerA", "Cd3p...issuerB"],
  "contacts": [{ "pubkey":"De4q...", "handle":"bob", "note":"coffee guy" }],
  "banks": [{ "pubkey":"Z1bank...", "url":"https://b.example/bank" }],
  "catalog": [{ "voucher":"<hash>", "bank":"Z1bank...", "name":"Coffee", "cached_at":1750419000000 }],
  "drafts": [{ "id":"01J9...", "kind":"order", "body":{ /* unsigned Order draft */ }, "updated_at":1750419000000 }],
  "prefs": { "theme":"dark", "default_bank":"Z1bank...", "encrypt_state":false },
  "rev": 42
}
```

#### `GET /ui/state` / `PUT /ui/state`
- `GET` → **200** the full document above. **404** `-32005` if the user has no state yet (SPA treats as empty).
- `PUT` replaces the whole document (optimistic concurrency via `If-Match: <rev>` or body `rev`; stale write → **409** `-32011`). **200** `{ "rev": 43 }`.

#### Sub-resource CRUD (convenience over the blob)
- `POST /ui/trusted` `{ "pubkey":"BvK9...issuer" }` → **200** `{ "trusted":[...], "rev":44 }`. Idempotent add. **422** `-32012` if not a valid base58 pubkey. This is the operation behind the QR "add to trusted" funnel (Goal 5 / 4).
- `DELETE /ui/trusted/:pubkey` → **200** `{ "trusted":[...], "rev":45 }`. **404** `-32005` if absent.
- `GET /ui/contacts`, `POST /ui/contacts` `{pubkey,handle?,note?}`, `DELETE /ui/contacts/:pubkey` — same pattern.
- `GET /ui/banks`, `POST /ui/banks` `{pubkey,url}`, `DELETE /ui/banks/:pubkey` — known-banks list that drives groups 4 & 5. The bank validates `url` is well-formed; it does **not** verify the peer here (verification happens lazily in `/ui/resolve` via `barter-bank.json` pinning).
- `GET /ui/catalog`, `PUT /ui/catalog` — bulk replace of the cached voucher/issuer catalog.
- `GET /ui/drafts`, `PUT /ui/drafts/:id` `{kind,body}`, `DELETE /ui/drafts/:id` — drafts are **unsigned** proposals only; a draft becomes real only when the SPA signs it and pushes it through `submit_docs` (locally or via `/ui/relay`).
- `GET /ui/prefs`, `PUT /ui/prefs`.

All sub-resource writes require **signed-request** auth and bump `rev`.

---

### 4. Aggregation / read helpers

The issuing bank is the **sole authority** for balances of vouchers it issues (`bank-rpc.md §2.4`), but a user holds vouchers across **many** banks, and the browser cannot fan out to all of them (CORS, and the per-call signing burden). These helpers run **server-side fan-out**: the bank, on the user's behalf, calls the standard read methods on each relevant peer bank, then merges. The user's *signed-request* authorizes the bank to act as their read proxy; where a downstream call needs a *protocol* signature (e.g. `get_account_balance` is holder→issuer), the SPA either (a) supplies pre-signed `/rpc` envelopes in the request, or (b) the helper restricts to peers where the read is unauthenticated. The simplest design, used below: **the SPA supplies a short-lived bundle of pre-signed read envelopes** the backend replays, so the bank still forges nothing.

#### `GET /ui/portfolio`
Aggregate balances by walking the user's known issuer banks. The backend, for each `(bank, account)` the user holds, calls that issuer bank's `list_accounts` / `get_account_balance` and assembles a portfolio. Query: `?refresh=1` to bypass the short server cache (default cache TTL ~10 s).

Request body (signed-request; carries the pre-signed read envelopes so the bank only relays):
```json
{
  "reads": [
    { "bank":"Z1bank...", "url":"https://b.example/bank", "envelope": { /* signed /rpc list_accounts */ } },
    { "bank":"Q2bank...", "url":"https://c.example/bank", "envelope": { /* signed /rpc list_accounts */ } }
  ]
}
```
Response:
```json
{
  "as_of": 1750420000000,
  "holdings": [
    {
      "bank":"Z1bank...", "voucher":"<hash>", "name":"Coffee",
      "account":"<account-hash>", "current": 18, "pending": -2,
      "issuer":"BvK9...", "trusted": true
    }
  ],
  "unreachable": [ { "bank":"Q2bank...", "error":"timeout" } ]
}
```
- `trusted` is annotated from the user's `/ui/state.trusted`.
- **207-style partial success**: HTTP **200** with a non-empty `unreachable[]` when some banks fail; the SPA renders the rest.

#### `GET /ui/history`
Transaction history assembled from `get_record_signatures`. For each record the user participated in (discovered from the user's accounts / known deals), the backend pulls the record body and its `ready`/`hold`/`settle`/`reject` Signature docs and folds them into a timeline.

Query: `?account=<hash>&since=<ms>&limit=100&cursor=<opaque>`.
```json
{
  "events": [
    {
      "deal_id":"01J9...", "record":"<record-hash>", "pair":"01J9...",
      "voucher":"<hash>", "amount": 5, "direction":"credit",
      "counterparty_bank":"Q2bank...",
      "state":"settled",
      "signatures": ["<sig-hash>","<sig-hash>"],
      "settled_at": 1750419500000
    }
  ],
  "next_cursor": "..."
}
```
`state` is derived from the strongest action seen (`settled` > `held` > `ready` > `rejected` > `created`). Errors: **200** with partial data + `unreachable[]`; **400** `-32602` for bad query.

#### `GET /ui/orders`
The user's active and past Orders plus the bank-derived Offers for them. The backend reads stored Orders (from drafts that were submitted, and from peers' `list_offers` filtered to the user's Offer hashes) and reports lifecycle.
```json
{
  "orders": [
    {
      "order":"<hash>", "ulid":"01J9...", "rate":"0.9", "lead": true,
      "debit":{ "voucher":"<hash>","bank":"Z1bank...","min":0,"max":100 },
      "credit":{ "voucher":"<hash>","bank":"Q2bank...","min":0,"max":90 },
      "kind":"two-sided",           // or "invoice" (credit-only) / "cheque" (debit-only)
      "offers":["<offer-hash>"],
      "state":"open",               // open | matched | settled | expired
      "matched_deals":["01J9..."]
    }
  ]
}
```

> All three helpers are **read-only convenience**. They invent no authority: every figure traces to a standard read method's signed response, and the SPA can reproduce any of them by hand against the issuing bank. The backend caches responses ~10 s to keep fan-out cheap.

---

### 5. Discovery

#### `POST /ui/discover`
Backend polls the user's known banks' `list_offers` for the user's vouchers and intentions, merges, dedupes by Offer hash, and returns interesting exchange requests (Goal 8). This is the "poll known banks for orders for your vouchers" engine.

Request (signed-request). `banks` are `{pubkey,url}` objects (the SPA needs the URL for fan-out) and `intentions` is an array so one call covers both directions:
```json
{
  "vouchers":   ["<hashA>","<hashB>"],                         // optional; default = vouchers from /ui/portfolio + catalog
  "banks":      [ {"pubkey":"Z1bank...","url":"https://b.example/bank"}, {"pubkey":"Q2bank...","url":"https://c.example/bank"} ], // optional; default = /ui/state.banks
  "intentions": ["sell","buy"]                                 // one or both; each maps to a list_offers(voucher, intention) poll
}
```
Response:
```json
{
  "as_of": 1750420000000,
  "offers": [
    {
      "offer":"<hash>", "bank":"Q2bank...", "rate":"1.1", "lead": false,
      "debit":{ "voucher":"<hashB>","bank":"Q2bank...","min":1,"max":50 },
      "credit":{ "voucher":"<hashA>","bank":"Z1bank...","min":1,"max":55 },
      "discovered_at": 1750419990000
    }
  ],
  "polled": ["Z1bank...","Q2bank..."],
  "unreachable": [ { "bank":"Z3bank...","error":"dns" } ]
}
```
- **Caching & cadence.** The backend caches each `(bank, voucher, intention)` result (TTL ≈ 15 s) and the Marketplace foreground-polls `/ui/discover` every ~30 s; a background poll runs every ~5 min for the user's own Vouchers. `?refresh=1` forces a live poll. All cadence/cache constants are centralized in §11 (Polling, Cadence & Caching).
- Errors: **200** with `unreachable[]`; **400** `-32602` if an `intentions` entry is neither `sell` nor `buy`.

---

### 6. Cross-bank relay / proxy

The browser cannot `POST` to *other* banks' `/rpc` (CORS, and those banks need not open CORS for arbitrary origins). The relay forwards an **already-client-signed** protocol envelope. Because the envelope is signed by the **user's** key and bound to a specific recipient via `to`, **the relaying bank cannot forge or mutate it** — any tampering breaks the signature and the destination bank rejects with `-32001`. The relay is a dumb, authenticated pipe.

#### `POST /ui/relay`
Outer **signed-request** auth (so the relay isn't an open proxy and is rate-limitable per user). Inner `envelope` is a complete standard JSON-RPC request per `base.md §4`, already signed by the user for the destination bank.

Request:
```json
{
  "bank_url": "https://c.example/bank",
  "envelope": {
    "jsonrpc":"2.0", "id":"01J9...", "method":"submit_docs",
    "params": { "docs":[ /* signed Order/Account/Voucher/Address */ ], "publish_offers":["<order-hash>"] },
    "pubkey":"9aXf...user", "to":"Q2bank...", "sig":"<base58>"
  }
}
```
Response: the destination bank's raw JSON-RPC result, passed through verbatim:
```json
{ "ok": true, "status": 200, "result": { "stored":["<hash>"], "offers":["<offer-hash>"] } }
```
- The outer-auth `pubkey` SHOULD equal `envelope.pubkey` (a user relaying their own request); the bank MAY relay on behalf of a different signer but MUST NOT alter the envelope.
- **Pinning.** Before forwarding, the backend resolves `bank_url`, fetches `/barter-bank.json`, and compares its `pubkey` to `envelope.to`. Mismatch → **409** `{ "ok":false, "code":-32013, "message":"pubkey pinning mismatch" }` (fail closed, per `base.md §5.2`).
- Pass-through errors: the destination's `-32000..-32005` and HTTP status are surfaced inside `result`/`status`; transport failure → **502** `{ "ok":false, "code":-32014, "message":"upstream unreachable" }`.

#### `POST /ui/relay_signatures`
A distinct, higher-level relay for the **signature-recovery** ("Nudge") path of §8.14 / §9.6: when direct bank-to-bank delivery stalls, pull `Signature` docs from the bank that has them and push them to the bank that needs them. Unlike `/ui/relay` (a dumb single-envelope pipe), this performs the two-call `get_record_signatures → notify_signatures` sequence server-side. **Signed-request** auth. It forges nothing — a relayer lacks bank keys; it only moves already-signed `Signature` docs.

Request:
```json
{
  "from":          { "pubkey":"<bank-with-sigs>",    "url":"https://b.example/bank" },
  "to":            { "pubkey":"<bank-missing-sigs>", "url":"https://c.example/bank" },
  "record_hashes": [ "<r1>", "<r2>" ]
}
```
Response: `{ "ok": true, "relayed": 2, "advanced": true }` — `relayed` counts signatures pushed; `advanced` is the destination's report of whether the advance engine progressed. Pin-checks both `from` and `to` against `barter-bank.json` before calling (mismatch → `-32013`); transport failure → `-32014`.

#### `GET /ui/resolve/:pubkey`
Address-cache resolution. The backend returns its cached/looked-up endpoint for a bank or user pubkey, sourced from the Address registry (`get_address` / `GET /address/<pubkey>`) and `barter-bank.json`, so the SPA can fill `bank_url` for a relay without a CORS-blocked lookup. No auth (public directory data).
```json
{ "pubkey":"Q2bank...", "url":"https://c.example/bank", "source":"address-doc", "address_ulid":"01J9...", "verified": true }
```
- **404** `-32005` if no Address/discovery doc is known. `verified` reflects a successful `barter-bank.json` pubkey-pin check.

---

### 7. Matchmaker trigger (optional bank-operated convenience)

A user who accepts a discovered Offer can have the bank run the **matchmaker** role for them (`bank-rpc.md §4`): share Address docs (`get_address` + `submit_docs`), call `create_records` on each participating bank, build and `submit_confirm` per-bank `Confirm` docs, then let each bank's advance engine drive `ready → hold → settle`. This is a **convenience only** — a user can self-matchmake by issuing the same standard calls through `/ui/relay`. The bank-as-matchmaker holds no extra authority: every gate still flows from the user's signed Order and the matchmaker's signed Confirm.

#### `POST /ui/propose_deal`
Signed-request. The user references the two sides and the amounts; the user's Order (which carries `lead`/`follow` and `rate`-as-limit) must already be submitted (the SPA signs and submits it first, locally or via relay).

Request:
```json
{
  "offer1": { "hash":"<my-offer-hash>",   "debit_amount":100, "credit_amount":90 },
  "offer2": { "hash":"<their-offer-hash>","debit_amount":90,  "credit_amount":100 },
  "banks":  ["Z1bank...","Q2bank..."],     // participating banks (issuers of each voucher)
  "lead_bank":"Z1bank..."                   // hint; must match a lead Order/Offer side
}
```
The backend mints a `deal_id` (ULID), shares Address docs among `banks`, calls `create_records({offer1,offer2,deal_id})` on each, collects record bodies, signs per-bank `Confirm {deal_id, bank, records[]}` with the **bank's own matchmaker key**, and `submit_confirm`s them.

Response:
```json
{
  "deal_id":"01J9DEAL...",
  "participating_banks":["Z1bank...","Q2bank..."],
  "records":{ "Z1bank...":["<rec-hash>","<rec-hash>"], "Q2bank...":["<rec-hash>","<rec-hash>"] },
  "state":"confirming"
}
```
- Errors map the underlying `create_records`/`submit_confirm` failures: **422** `-32000` (amount/limit/min-max violation), **409** `-32003` (lock conflict on a debit account), **502** `-32014` (a bank unreachable mid-deal; the backend reports which banks committed so the SPA can fall back to manual relay or retry).
- The lead bank settles first; followers cite predecessors' `settle` Signatures in `Signature.seen` exactly as the protocol requires — the trigger does not change that.

#### `GET /ui/deal/:deal_id`
Signed-request. Polls/assembles deal progress across participating banks via `get_record_signatures`.
```json
{
  "deal_id":"01J9DEAL...",
  "state":"settled",                       // record states: created | approved | held | settled | rejected
                                           // (plus the custom UI-only pre-state "confirming" = records created, awaiting Confirm + bound Orders; see §3.3)
  "legs": [
    { "bank":"Z1bank...","records":["<h>"],"ready":true,"hold":true,"settle":true,"role":"lead" },
    { "bank":"Q2bank...","records":["<h>"],"ready":true,"hold":true,"settle":true,"role":"follow",
      "seen":["<lead-settle-sig-hash>"] }
  ],
  "updated_at": 1750420100000
}
```
The SPA polls this (e.g. every few seconds) to drive a deal-status screen (see **Screens & Navigation**). **404** `-32005` for an unknown `deal_id` at this bank.

---

### 8. Landing routes

These GET routes serve **the same link** both as a human landing page (rendered HTML inviting registration / showing a profile, invoice, or cheque) and as a carrier for the **signed docs** (exposed in page metadata and `<link rel>` headers so a barter webapp can extract them without a separate API). The precise on-page encoding (meta tags, `<link rel="barter-doc">`, embedded `application/barter+json`, `barter://` / `barterdeal:` payloads) is owned by the **Barter Link** section and the **QR & Landing Journeys** section; this layer only commits to the routes and their content-negotiation contract.

These are the canonical Barter Link namespace of §3.4. Each also serves its machine representation via `Accept: application/barter+json`, a `.json` sibling, or `?format=json`.

| Route | Renders (HTML) | Carries (signed docs / JSON) |
|---|---|---|
| `GET /i/:pubkey` | **Issuer-profile landing**: the user's public issuer profile + their Vouchers, with a "Register & add to trusted" CTA (the primary new-user funnel, Goal 5). The QR a user shares encodes this URL. | Issuer pubkey + `Address` pointer + Voucher doc bodies; an `add-trusted` intent the webapp turns into `POST /ui/trusted` after register. |
| `GET /v/:token` | **Invoice landing** (credit-only Order, `get_invoice`): "you've been invoiced" page. | The signed invoice `Order` doc + any embedded `Account` docs, for a webapp to act on (Goal 6). |
| `GET /q/:token` | **Cheque landing** (debit-only Order, `get_cheque`): "claim this cheque" page. | The signed cheque `Order` doc. |
| `GET /o/:hash` | **Offer landing**: a discoverable bank-signed `Offer`. | The bank-signed `Offer` doc. |
| `GET /x/:token` | **Invite / deal landing**: a `barter://` invite or `barterdeal:` token, with a "Register to accept" CTA. | The self-validating invite / deal-token payload. |

**Content negotiation (the "same link, two readers" contract):**
- A **normal phone browser** (`Accept: text/html`) gets the rendered landing page; the signed docs ride along in `<meta>`/`<link>` for any scanner that wants them.
- A **barter webapp** requests `Accept: application/barter+json` (or appends `?format=json`) and receives only the signed doc payload:
  ```json
  { "kind":"invoice", "docs":[ { /* signed Order */ } ], "issuer":"9aXf...", "bank":"Z1bank...", "link":"barter://..." }
  ```
- Both forms embed the self-validating `barter://` invite or `barterdeal:` token where applicable, so the receiver **verifies the signature before any network call** (existing OOB format guarantee). The bank serving the page is untrusted: tampering invalidates the embedded signatures.

`GET /ui/` and `/ui/app/*` serve the SPA shell and static assets (no auth); the SPA boots, reads `/ui/state` after the user unlocks their key, and wires screens per **Screens & Navigation**.

---

**Hand-offs.** Keystore blob shape, KDF, and client-side decrypt/sign → **Identity / Key Custody**. The `barter://` / `barterdeal:` / `application/barter+json` encodings and meta/`<link>` placement → **Barter Link**. Which screen calls which endpoint and in what order → **Screens & Navigation** and **QR & Landing Journeys**. The standard `create_records` / `submit_confirm` / advance-engine semantics the matchmaker trigger drives → **Core Object Flows** and `bank-rpc.md`.

## 8. Screens, Navigation & Behavior

This section is the complete screen inventory and information architecture for the bank-served web UI. It is a single-page application (SPA): one HTML shell, a hash/`history`-based router, and JS modules per screen. The UI is part of the **custom layer** (base.md §6) — it never alters standard doc schemas or RPC semantics. Anything that produces, signs, or reads a standard doc routes through the protocol surface (`submit_docs`, `create_records`, `list_offers`, etc.); anything else (encrypted key blobs, trusted-issuer lists, pinned banks, contact labels) lives in custom endpoints owned by **Bank UI Backend API**.

Conventions used below:
- **Calls** are named, never redefined. Protocol RPCs are in `monospace` (`submit_docs`); custom endpoints are written `CUSTOM /ui/...` and owned by **Bank UI Backend API**.
- Signing of any standard doc, key decryption, and the password/KDF model are owned by **Identity/Key Custody**. Screens here say "sign in browser (see Identity/Key Custody)" and never expose plaintext keys.
- Doc-field → screen-field mapping detail and the wave choreography (`ready`→`hold`→`settle`) are owned by **Core Object Flows**; screens render its state, they do not define it.
- Link/QR payload formats are owned by **Barter Link** and **QR & Landing Journeys**; screens here invoke `buildBarterLink()` / `renderQR()` as black boxes.

### 1. Information Architecture Overview

Two top-level zones gated by an **auth/lock state machine**:

| State | Meaning | Zone shown |
|---|---|---|
| `anonymous` | no session, no key chosen | Public zone |
| `selected` | a key is chosen but its private key is not decrypted | Unlock screen |
| `unlocked` | private key decrypted in memory (browser only) | Authenticated shell |
| `locked` | was unlocked, auto-lock/manual lock cleared the in-memory key | Unlock screen (returns to last route after unlock) |

The plaintext private key lives only in a JS in-memory variable during `unlocked`; it is zeroized on transition to `locked`/`anonymous`. All "create/sign" actions require `unlocked`; pure reads of public data (a landing page, a public Issuer Profile, a marketplace browse) can render in `anonymous`.

#### 1.1 Navigation Map (authenticated)

```
Global Header (brand · account switcher · notifications · LOCK)
│
├─ Home / Dashboard                     [/]
├─ Wallet                               [/wallet]
│    └─ Account detail (per voucher)    [/wallet/:voucherHash]
├─ Activity (Transaction History)       [/activity]
│    └─ Record detail drawer            [/activity/:recordHash]
├─ Vouchers (My Vouchers — issuer)      [/vouchers]
│    ├─ Create Voucher                  [/vouchers/new]
│    └─ Voucher detail / Edit           [/vouchers/:voucherHash]
├─ Orders                               [/orders]
│    ├─ Create Order                    [/orders/new]
│    └─ Order detail                    [/orders/:orderHash]
├─ Invoices                             [/invoices]
│    ├─ Create Invoice                  [/invoices/new]
│    └─ Invoice detail (QR)             [/invoices/:hash]
├─ Cheques                              [/cheques]
│    ├─ Create Cheque                   [/cheques/new]
│    └─ Cheque detail (QR)              [/cheques/:hash]
├─ Discover (Marketplace)               [/discover]
│    └─ Offer detail → Deal flow        [/discover/:offerHash]
├─ Network
│    ├─ Trusted Issuers                 [/network/trusted]
│    ├─ Issuer Profile                  [/i/:pubkey]
│    ├─ Contacts                        [/network/contacts]
│    └─ Known Banks                     [/network/banks]
├─ Deal flow (modal/overlay route)      [/deal/:dealId]
└─ Settings                             [/settings]
     ├─ Security                        [/settings/security]
     ├─ Banks                           [/settings/banks]
     └─ About                           [/settings/about]
```

> **SPA routes vs. server Barter Link routes.** The bracketed paths above are the **SPA client-router routes** — in-app screens the user navigates. They are distinct from the **server Barter Link routes** a user *shares* with others — `/i/<pubkey>`, `/v/<token>`, `/q/<token>`, `/o/<offer-hash>`, `/x/<token>` (§3.4 / §5), which the bank serves as landing pages. The Share modal (§13) and the deep-link handler (§17) always emit and consume those canonical Barter Link routes; the SPA's own management screens (e.g. `/invoices/:hash`, `/cheques/:hash`) are internal and never the thing a user sends.

**Primary nav** (persistent, max 6 items so it survives the mobile tab bar): **Home · Wallet · Activity · Discover · Vouchers · Orders**. **Invoices, Cheques, Network, Settings** live under an overflow "More" menu on mobile and as secondary nav (left rail) on desktop. The account switcher and LOCK live in the global header on every authenticated screen.

#### 1.2 Responsive layout

- **Desktop (≥1024px):** left rail (primary + secondary nav), top header, main content, optional right drawer (record/offer detail).
- **Tablet (640–1023px):** collapsible left rail (hamburger), header, content; drawers overlay.
- **Mobile (<640px):** bottom tab bar (5 primary items + "More"), top header collapses brand + account avatar + LOCK; detail screens become full-screen pushes, drawers become bottom sheets.

### 2. Public / Logged-out Screens

#### 2.1 Welcome / Landing — `/`

- **Purpose:** front door for an anonymous visitor; entry to Register or Connect; renders the bank's identity.
- **Layout regions:** hero (bank name + `protocol_version`), primary CTA pair, "what is this" blurb, footer (About, protocol version).
- **Data displayed:** bank `name`, `pubkey` (truncated, copyable), `url` — fetched from `GET /barter-bank.json`.
- **Action elements:**
  - **Register (create new keypair)** button → `/register`.
  - **Connect (existing keypair)** button → `/connect`.
  - **Copy bank pubkey** icon-button → clipboard.
- **States:** _loading_ (skeleton while `barter-bank.json` resolves); _error_ (bank unreachable → "This bank is offline" + retry); _success_ (default).
- **Transitions/validations:** none beyond routing. If a session already exists in `selected`/`locked`, redirect to `/unlock`; if `unlocked`, redirect to `/`.
- **Calls:** `GET /barter-bank.json` (discovery, base.md §5.1).

#### 2.2 Register — `/register`

- **Purpose:** create a brand-new ed25519 keypair, set a decryption password, persist the **encrypted** private key on the server.
- **Layout regions:** form card, security-warning banner, progress on submit.
- **Action elements:**
  - **Handle / display name** input — custom UI label only (not protocol identity).
  - **Password** + **Confirm password** inputs — strength meter; this password is the only thing that decrypts the key.
  - **KDF cost** advanced disclosure (Argon2id parameters) — defaults provided; owned by Identity/Key Custody.
  - **Acknowledge "no recovery"** checkbox — required; reflects v1 "lose key ⇒ lose account."
  - **Create account** submit.
- **Data displayed:** generated **pubkey** preview (shown after keygen, before final submit).
- **Flow:** keygen in browser → derive encryption key from password (KDF) → encrypt private key in browser → upload ciphertext blob + pubkey + handle. Plaintext key never leaves the browser.
- **States:** _empty_ (pristine form); _loading_ (generating/encrypting/uploading); _error_ (pubkey already registered at this bank, weak password, upload failed); _success_ (transition to `unlocked`, route to `/` with a "publish your first Voucher?" nudge).
- **Validations:** passwords match; password ≥ policy minimum; acknowledgement checked; handle non-empty.
- **Calls:** `CUSTOM POST /ui/register` (store encrypted blob, owned by Bank UI Backend API). No standard RPC yet — the pubkey becomes a protocol identity only when it first signs a doc (e.g., an Account presented via `submit_docs`).

#### 2.3 Connect (existing keypair) — `/connect`

- **Purpose:** attach an already-existing keypair to this bank UI session. Two sub-modes via a toggle.
- **Action elements:**
  - **Mode toggle:** _Import private key_ ↔ _Restore from recovery kit_.
  - _Import private key:_ **private key** input (base58 or recovery phrase) + **new password** + **confirm** → encrypt in browser → upload blob. The key is verified by deriving its pubkey locally.
  - _Restore from recovery kit:_ **file picker** for the exported encrypted kit (see Settings §11) → **password** to decrypt.
  - **Already stored on this bank?** link → `/unlock` (if the user just wants to unlock an existing server-side blob, see §2.4).
  - **Connect** submit.
- **Data displayed:** derived **pubkey** preview before submit; warning that pasting a private key is sensitive.
- **States:** _empty / loading / error_ (invalid key material, pubkey mismatch with kit, upload failed) / _success_ (→ `unlocked`).
- **Validations:** key material parses to a valid ed25519 private key; derived pubkey matches kit metadata if restoring.
- **Calls:** `CUSTOM POST /ui/register` (store/replace encrypted blob).

#### 2.4 Unlock — `/unlock`

- **Purpose:** decrypt a server-stored encrypted private key blob into browser memory. Reached when state is `selected`/`locked`.
- **Layout regions:** centered card with the active account's handle + pubkey avatar, password field, secondary actions.
- **Action elements:**
  - **Account chooser** (if multiple keys stored) — selects which stored **handle** to unlock (each handle binds one keystore blob + pubkey).
  - **Password** input.
  - **Unlock** submit.
  - **Use a different keypair** → `/connect`. **Forgot password?** → static explainer ("no recovery in v1; the account is lost").
- **Flow:** fetch ciphertext blob **by handle** → derive key from password (KDF) → decrypt in browser → hold plaintext key in memory → set `unlocked`.
- **States:** _idle / loading_ (KDF can be intentionally slow); _error_ (wrong password → generic "couldn't unlock"; never reveal whether the blob exists beyond what auth allows); _locked_ is the entry state itself; _success_ (→ resume `returnTo` route or `/`).
- **Validations:** decryption MAC/AEAD check passes.
- **Calls:** `CUSTOM GET /ui/keystore/:handle` (fetch ciphertext, owned by Bank UI Backend API). Decryption is local.

#### 2.5 Incoming Barter Link — logged-out variants

A **Barter Link** is one URL that is simultaneously a human landing page and a carrier of signed docs (format owned by **Barter Link**; landing UX owned by **QR & Landing Journeys**). When such a link is opened by a normal phone browser while `anonymous`, the SPA routes to a public landing variant rather than a gated screen:

| Link kind | Barter Link route | Landing behavior (logged-out) |
|---|---|---|
| Issuer profile | `/i/<pubkey>` | Public profile + **"Register & add to Trusted"** CTA → carries `?next=/i/<pubkey>&trust=<pubkey>` into `/register`. |
| Invoice | `/v/<token>` | Renders invoice terms read-only + **"Register to pay"** CTA; signed `Order` doc is embedded in page metadata for webapp scanners. |
| Cheque | `/q/<token>` | Renders cheque terms read-only + **"Register to claim"** CTA. |
| Invite / deal | `/x/<token>` (carries a `barter://` invite or `barterdeal:` token) | Renders give/get summary; verifies the inviter signature **before** any network call; **"Register to accept"** CTA → `/register?next=/x/<token>`. |

Routing rule: the router records the original target as `returnTo`/`next` and walks the visitor through Register/Connect/Unlock, then re-dispatches to the authenticated handler for that same link. Deep-link routing is specified fully in §17.

### 3. Authenticated Shell

#### 3.1 Global header (every authenticated route)

- **Regions:** brand (→ Home), account switcher, notifications bell, **LOCK** button.
- **Action elements:**
  - **Account switcher** (dropdown): lists locally-stored keys by handle + truncated pubkey; selecting a different account moves to `selected` for that key → `/unlock` (each key has its own password/in-memory session; switching never carries plaintext across keys). Footer item **"Add / connect another keypair"** → `/connect`.
  - **Notifications bell**: badge count of unseen events (incoming deal proposals, records that reached `held`/`settled`, matched Orders, rejected records). Opens a popover list; each item deep-links to the relevant detail (record/order/deal). Source: signature/event polling and any push from `subscribe` (see §16 + Core Object Flows).
  - **LOCK** button: immediately zeroizes the in-memory private key, sets `locked`, routes to `/unlock`. Always available.
- **Data displayed:** active handle, avatar derived from pubkey, unseen-count.
- **States:** notifications _empty_ ("You're all caught up"), _loading_, _error_ (polling failed → silent retry + stale badge).

#### 3.2 Primary navigation

As in §1.1. Active-route highlight; mobile bottom tab bar + "More" sheet. Secondary nav (Invoices/Cheques/Network/Settings) appears in the desktop left rail and the mobile "More" sheet.

### 4. Home / Dashboard — `/`

- **Purpose:** at-a-glance portfolio + recent activity + quick actions; the post-unlock landing.
- **Layout regions:** (a) portfolio summary cards, (b) quick actions row, (c) recent activity feed, (d) attention strip (deals awaiting action).
- **Data displayed:**
  - Portfolio: per-Voucher net position aggregated across the banks this user uses, each showing **current** vs **pending** balance.
  - Recent activity: last N records/signatures with state chips (`created`/`approved`/`held`/`settled`/`rejected`).
  - Attention strip: Orders that just matched, deals stuck mid-cascade, records rejected.
- **Action elements (quick actions):** **Create Voucher** → `/vouchers/new`; **Create Order** → `/orders/new`; **New Invoice** → `/invoices/new`; **New Cheque** → `/cheques/new`; **Share my profile (QR)** → opens QR modal (§13); **Poll banks** → triggers Discover poll (§12).
- **States:** _empty_ (new user → onboarding checklist: "Create your first Voucher", "Add a trusted issuer", "Share your profile"); _loading_ (skeleton cards); _error_ (per-card error, others still render); _locked_ (never shown here — gated by shell).
- **Transitions:** cards deep-link to Wallet/Activity/Orders.
- **Calls:** `list_accounts` (+ `get_account_balance` per account for current/pending), `list_offers`/`get_record_signatures` for activity hydration, `CUSTOM GET /ui/feed` (aggregated activity convenience, owned by Bank UI Backend API).

### 5. Wallet / Balances — `/wallet`

- **Purpose:** every Account the user holds, grouped per Voucher, aggregated across issuer banks; current vs pending.
- **Layout regions:** filter bar; voucher-grouped list; per-row balance + bank chips.
- **Data displayed:** per Voucher: name, image, issuer bank(s), **current** balance, **pending** (delta from in-flight holds/settles), `limit`/`integer` badges, `due`/`expires` if set. A negative row is labeled **"you owe (issuer)"** when this user is the Voucher's issuer.
- **Action elements:**
  - **Search / filter** input (by voucher name, bank).
  - **Toggle "show zero balances."**
  - **Row → Account detail** `/wallet/:voucherHash`.
  - **Row quick actions:** **Trade** (→ Create Order pre-filled with this voucher), **Invoice** (request this voucher), **Cheque** (spend this voucher).
- **Account detail `/wallet/:voucherHash`:** full Voucher body (from `get_voucher`), this user's Account(s) for it, current/pending, recent records for this voucher, and the Orders currently authorizing movement on it.
- **States:** _empty_ ("No balances yet — receive an Invoice or trade to get started"); _loading_; _error_ (per-bank fetch failure shows a "couldn't reach bank X" chip, other rows still render); _pending_ visualized as a sub-amount with a clock icon.
- **Calls:** `list_accounts` (returns accounts + Voucher bodies), `get_account_balance` per account → `{current, pending}`, `get_voucher` for hydration.

### 6. Transaction History (Activity) — `/activity`

- **Purpose:** filterable ledger of records touching the user, with a detail drawer exposing signatures and the settle cascade.
- **Layout regions:** filter bar; virtualized list; right drawer (desktop) / bottom sheet (mobile) for detail.
- **Data displayed (list rows):** direction (debit/credit), amount, Voucher, counterparty (where derivable), `deal_id`, timestamp (from record ULID), **state chip**, and which Order/Offer authorized it (`Record.order`).
- **Action elements:**
  - **Filters:** voucher (multi-select), direction (debit/credit), state (`created`/`approved`/`held`/`settled`/`rejected`), date range, bank, `deal_id` search.
  - **Row → Record detail drawer** `/activity/:recordHash`.
- **Record detail drawer:**
  - **Data:** `Record` body (`amount`, `order`, `details`→`pair`/`deal_id`/`holder`/`account`), the authorizing Order/Offer summary, and **all `Signature` docs** anchored to this record hash — rendered as a timeline: bank `ready` → `hold` → `settle` (or `reject`, with `reason`).
  - **Settle cascade view:** for follower records, render the `seen[]` chain — each predecessor `settle` Signature this bank cited, as a verifiable lineage (lead → follow). Show lead/follow role per the resolved Order's `lead` flag.
  - **Action elements:** **Copy record hash**; **Refresh signatures** (re-poll); **Relay signatures** (manual recovery: pull from one bank, push to the bank that's stuck — see §14.4 and Core Object Flows); **View deal** → `/deal/:dealId`.
- **States:** _empty_ ("No transactions match these filters"); _loading_ (skeleton rows); _error_; _partial_ (a signature still missing → "waiting for settle from bank Y" with spinner).
- **Calls:** `CUSTOM GET /ui/history?...filters` (server-side filtered list, owned by Bank UI Backend API) for the list; `get_record_signatures(record_hash)` for the drawer; `notify_signatures` when relaying.

### 7. My Vouchers (Issuer) — `/vouchers`

#### 7.1 List — `/vouchers`

- **Purpose:** Vouchers this user issues (where `Voucher.pubkey == user` and bound to a bank).
- **Data displayed:** per Voucher: name, image, `limit` (or "unbounded"), `integer` flag, `due`/`expires`, **net issued** (sum of negative issuer position = outstanding supply), redemptions/activity count.
- **Action elements:** **Create Voucher** → `/vouchers/new`; **row → detail** `/vouchers/:voucherHash`; per-row **Share QR** (issuer/voucher QR, §13); **Create Order** to seed liquidity for this voucher.
- **States:** _empty_ ("You haven't issued any vouchers"); _loading_; _error_.
- **Calls:** `list_vouchers(filter=mine)`, `get_account_balance` on the issuer account for outstanding supply.

#### 7.2 Create Voucher — `/vouchers/new`

- **Purpose:** author and store a signed `Voucher`.
- **Action elements / inputs (→ `Voucher` fields):**
  - **Name** → `name` (required).
  - **Image** uploader/SVG paste → `image_svn` (optional, square).
  - **Description (Markdown)** → `description_md` (optional, live preview).
  - **Due date** → `due` (optional, ISO 8601).
  - **Expires** → `expires` (optional, ISO 8601).
  - **Supply limit** → `limit` (optional number; empty = unbounded).
  - **Integer amounts only** toggle → `integer`.
  - **Issuing bank**: fixed to this bank's pubkey (`bank`), shown read-only with a note that `bank` is part of the Voucher hash; if the UI is multi-bank aware, a select among pinned banks (§9.3).
  - **Create & publish** submit.
- **Flow:** assemble doc → canonicalize (JCS) → sign in browser (see Identity/Key Custody) → `submit_docs`. Field mapping detail owned by Core Object Flows.
- **States:** _empty/loading_; _error_ (validation `-32000`, e.g. bad shape; or `-32001` sig); _success_ (→ `/vouchers/:hash` with QR-share nudge); _locked_ (sign requires `unlocked`; if lock kicks in mid-flow, draft is preserved, route to `/unlock?returnTo=...`).
- **Validations:** name present; dates valid ISO 8601; `limit` ≥ 0; image within size budget.
- **Calls:** `submit_docs(docs:[voucher])`.

#### 7.3 Voucher detail / Edit — `/vouchers/:voucherHash`

- **Purpose:** inspect a Voucher and its issuance/redemption activity. Vouchers are content-addressed and **immutable**; "Edit" means **issue a new Voucher** (new hash) and optionally deprecate the old one in custom UI state.
- **Data displayed:** full Voucher body, hash, outstanding supply vs `limit`, recent records, Orders/Offers referencing it.
- **Action elements:** **Share QR**; **Create Order** (seed/redeem); **"Supersede"** → opens Create Voucher prefilled (new doc); **Copy hash**.
- **Calls:** `get_voucher(hash)`, `list_offers(voucherHash, …)`, `CUSTOM GET /ui/history?voucher=hash`.

### 8. Orders

#### 8.1 Orders list — `/orders`

- **Purpose:** active and past Orders authored by the user.
- **Data displayed:** per Order: a human "give X / get Y" summary derived from `debit`/`credit` sides, `rate`, min/max, the limit fields, `lead` flag, published-as-Offer indicator, cumulative matched amount vs `*_order_limit`, status (active / exhausted / effectively-cancelled).
- **Action elements:** **Create Order** → `/orders/new`; tabs **Active / Past**; **row → detail** `/orders/:orderHash`; filter by voucher/side.
- **States:** _empty_ ("No orders yet"); _loading_; _error_. An Order with a drained debit account is shown as **"inactive (no balance)"** — the v1 cancel mechanism.
- **Calls:** `CUSTOM GET /ui/orders` (the user's own Orders + derived Offers, owned by Bank UI Backend API), `list_offers` for published visibility.

#### 8.2 Create Order — `/orders/new`

- **Purpose:** unified sell/buy authoring of a signed `Order` (the only holder authorization primitive). One form covers two-sided swaps, invoices (omit debit), and cheques (omit credit).
- **Layout regions:** intention selector; "You give" panel (debit); "You receive" panel (credit); rate & limits; advanced; review.
- **Action elements / inputs (→ `Order` fields):**
  - **Intention** segmented control: **Swap** (both sides) · **Invoice** (omit `debit`) · **Cheque** (omit `credit`). Selecting Invoice/Cheque hides the omitted panel and routes the user toward §10/§11 templates but produces the same `Order` doc type.
  - **You give (debit):** Voucher picker (→ `debit.voucher`), account auto-selected/created for that voucher (→ `debit.account`), issuing **bank** auto-filled (→ `debit.bank`), **min**/**max** per match (→ `debit.min`/`debit.max`).
  - **You receive (credit):** Voucher picker (→ `credit.voucher`), account (→ `credit.account`), **bank** (→ `credit.bank`), **min**/**max** (→ `credit.min`/`credit.max`).
  - **Rate** input (→ `rate`): labeled "max debit ÷ credit ratio you'll accept (checked in aggregate at ready)"; helper computes implied price both directions.
  - **Order limits (advanced):** **debit_order_limit**, **credit_order_limit** (cumulative caps), **debit_account_limit** (balance floor), **credit_account_limit** (balance ceiling / anti-overstock).
  - **Lead** toggle (→ `lead`): "Let my bank hold & settle before peers" (explainer links to lead/follow in Core Object Flows).
  - **Publish as Offer** toggle: if on, request derived Offer publication (`publish_offers:[orderHash]`).
  - **Review & sign** → **Sign & submit**.
- **Flow:** build `Order` → sign in browser → `submit_docs(docs:[order, account?], publish_offers?)`. Same signed Order must go to each bank that issues a referenced Voucher; the UI fans out (see Core Object Flows / Backend API).
- **States:** _empty_; _validation_ (inline: min ≤ max, positive `rate`, at least one side present, `Order.pubkey` matches account pubkeys); _loading_ (submitting/fanning out to multiple banks — show per-bank progress); _error_ (`-32000` rule, `-32005` unknown voucher/account, partial fan-out failure → retry per bank); _success_ (→ `/orders/:hash`, with optional QR for the invoice/cheque case). _locked_ → preserve draft, `/unlock`.
- **Validations:** every referenced Account belongs to the user; positive `rate`; `min ≤ max` per present side; for Swap both sides required; numeric/integer constraints honor each Voucher's `integer`.
- **Calls:** `submit_docs` (with optional `publish_offers`), `list_accounts`/`get_voucher` for pickers.

#### 8.3 Order detail — `/orders/:orderHash`

- **Purpose:** inspect one Order, its derived Offer, matched records, and cumulative usage; "cancel."
- **Data displayed:** full `Order` body; derived `Offer` (if published) with its hidden-identity terms; list of matched Records (each linking to §6 drawer) with their states; cumulative matched vs `*_order_limit`; current free balance on the debit account.
- **Action elements:** **Edit-as-new** (Orders are immutable; supersede); **Cancel order** → guided flow that **drains/moves the debit account balance** (the protocol cancel mechanism — empties available balance so nothing can `ready`); **Unpublish Offer** (custom: stop advertising — note the Order itself persists); **Share QR** (for invoice/cheque specializations); **Copy hash**.
- **States:** _loading/error/empty-matches_; _success_.
- **Calls:** `get_record_signatures` per matched record, `CUSTOM GET /ui/orders/:hash` (match summary), `submit_docs` (for the cancel transfer Order, if used).

### 9. Network

#### 9.1 Trusted Issuers — `/network/trusted`

- **Purpose:** manage the per-user **trusted issuers** list — a list of issuer pubkeys the user trusts. This is **custom UI state**; the protocol has no trust concept.
- **Data displayed:** each trusted issuer: handle/label, pubkey (truncated), their Vouchers (if discoverable), date added, source (QR scan, invite, manual).
- **Action elements:** **Add trusted issuer** (paste pubkey or `<pubkey>@<bank-url>`); per-row **Untrust**; **View profile** → `/i/:pubkey`; **Share my profile QR**.
- **States:** _empty_ ("Add the people whose vouchers you trust"); _loading/error_.
- **Calls:** `CUSTOM GET/POST/DELETE /ui/trusted` (owned by Bank UI Backend API). Voucher hydration via `get_voucher`/`list_vouchers`.

#### 9.2 Issuer Profile — `/i/:pubkey`

- **Purpose:** public (works `anonymous`) profile of an issuer: who they are, their Vouchers, their published Offers; the target of the **issuer-profile QR** (Goal 5).
- **Layout regions:** header (avatar from pubkey, handle if known, pinned bank), Vouchers grid, open Offers, trust controls, share.
- **Data displayed:** issuer pubkey, bank (pinned `pubkey@url`), their Vouchers (`list_vouchers`), their published Offers (`list_offers`).
- **Action elements:**
  - **Trust / Untrust** toggle (writes `/ui/trusted`); when `anonymous`, this becomes **"Register & add to Trusted"** → `/register?next=/i/:pubkey&trust=:pubkey` (the registration funnel, Goal 5).
  - **Share QR** (issuer-profile link/QR, §13).
  - Per-Voucher **Trade / Request (Invoice) / Pay (Cheque)** → pre-filled Create Order / Invoice / Cheque.
  - **Add to Contacts**.
- **States:** _anonymous_ (CTA emphasizes register-then-trust); _loading/error_ (unknown pubkey at this bank → show what's discoverable + "this issuer may live on another bank"); _success_.
- **Calls:** `list_vouchers`, `list_offers`, `get_voucher`; `CUSTOM /ui/trusted`, `CUSTOM /ui/contacts`.

#### 9.3 Contacts — `/network/contacts`

- **Purpose:** local address book mapping pubkeys → labels (custom UI state); convenience for picking counterparties.
- **Action elements:** **Add contact** (pubkey + label + optional `pubkey@url`); **Edit/Delete**; **View profile**; **Promote to Trusted**.
- **States:** _empty/loading/error_.
- **Calls:** `CUSTOM GET/POST/PUT/DELETE /ui/contacts`.

#### 9.4 Known Banks — `/network/banks`

- **Purpose:** add and **pin** banks by URL + pubkey so the user can poll them for Offers and so cross-bank Orders resolve peer banks. Pinning is the v1 security model (base.md §5.2).
- **Data displayed:** per bank: name, `url`, pinned `pubkey`, reachability/last-poll status, protocol_version.
- **Action elements:**
  - **Add bank** input: accepts a bank URL; UI fetches `GET <url>/barter-bank.json`, shows the returned pubkey, and requires the user to **confirm/pin** it (or paste the expected pubkey to compare — fail closed on mismatch).
  - Per-bank **Poll for offers** → Discover (§12); **Unpin/remove**; **Set as default issuing bank**.
- **States:** _empty_ (only this serving bank pinned by default); _loading_ (discovery fetch); _error_ (`pubkey` mismatch → red "pin rejected: served pubkey ≠ expected"; unreachable).
- **Calls:** `GET <bank-url>/barter-bank.json`, `get_address(pubkey)` for current URL; `CUSTOM GET/POST/DELETE /ui/banks` (persist pinned set).

### 10. Invoices

#### 10.1 Create Invoice — `/invoices/new`

- **Purpose:** author an **Invoice** = an `Order` with `debit` omitted (credit-only), authorizing an unconditional credit to the holder; produce a shareable link/QR.
- **Action elements / inputs:** Voucher to receive (→ `credit.voucher`), account (→ `credit.account`), bank (→ `credit.bank`), amount/min/max (→ `credit.min`/`credit.max`), `rate` (informational but must be positive), optional `credit_order_limit`/`credit_account_limit`, **memo** (custom, not in doc), **expiry hint** for the link (carried by Barter Link, not the Order). **Create & get QR**.
- **Flow:** build invoice Order → sign → `submit_docs`; the resulting hash is retrievable via `get_invoice(hash)`.
- **States:** _empty/validation/loading/error/success_ (success → detail with QR).
- **Calls:** `submit_docs(docs:[order])`.

#### 10.2 Invoices list — `/invoices`

- Active/past invoices the user issued; status by matched credit vs `credit_order_limit`. Row → detail. **Calls:** `CUSTOM GET /ui/orders?kind=invoice`, `get_invoice`.

#### 10.3 Invoice detail (with QR) — `/invoices/:hash`

- **Purpose:** human-readable invoice + the **same link** that carries the signed Order for webapp scanners (Goal 6/Goal 7).
- **Data displayed:** terms (receive N of Voucher V), issuer, hash, matched-so-far, the signed Order embedded in page `<meta>`/`<link rel>` for scanners (format owned by Barter Link / QR & Landing Journeys).
- **Action elements:** **Show QR**, **Copy link**, **Download PNG**, **Mode toggle (reference vs inline)** (§13), **Revoke** (drain/limit the Order so it can't match), **View matched records**.
- **States:** _logged-out_ → public "Register to pay" landing variant (§2.5); _loading/error/paid-out_ (`credit_order_limit` reached).
- **Calls:** `get_invoice(hash)`, `get_record_signatures` for matched records.

### 11. Cheques

Symmetric to Invoices. A **Cheque** = an `Order` with `credit` omitted (debit-only), authorizing an unconditional debit from the holder; whoever holds the cheque may attach it to a transfer to pull funds.

- **Create Cheque — `/cheques/new`:** inputs map to the `debit` side (`debit.voucher`/`account`/`bank`/`min`/`max`), positive `rate`, optional `debit_order_limit`/`debit_account_limit`, **lead** toggle, memo. **Calls:** `submit_docs`.
- **Cheques list — `/cheques`:** **Calls:** `CUSTOM GET /ui/orders?kind=cheque`, `get_cheque`.
- **Cheque detail (QR) — `/cheques/:hash`:** same dual-purpose link/QR; logged-out → "Register to claim" variant. **Calls:** `get_cheque(hash)`. Warning banner: a cheque is bearer-like — anyone with the link can pull funds up to the limits.

### 12. Discover / Marketplace — `/discover`

- **Purpose:** browse Offers across pinned banks and **poll known banks** for Offers matching the user's Vouchers to find interesting exchange requests (Goal 8).
- **Layout regions:** filter bar; bank-poll control; Offer results (cards/table); empty/onboarding.
- **Data displayed (per Offer):** give/get vouchers, `rate`, min/max, `lead`, issuing bank, derived implied price, trust badge if the underlying issuer is in the user's Trusted list.
- **Action elements:**
  - **Voucher filter** (which Voucher you care about) + **Intention** select: **sell** | **buy** (maps to `list_offers(voucher_hash, intention)`).
  - **Poll known banks** button: iterates pinned banks (§9.4), calling `list_offers` per (voucher, intention); shows per-bank progress and merges results. Optional **auto-poll** toggle with interval.
  - **Sort** (best rate, newest), **Trusted-only** toggle.
  - **Offer → detail / accept** → `/discover/:offerHash` → Deal flow (§14).
- **States:** _empty_ ("No offers found — try another voucher or poll more banks"); _loading_ (per-bank spinners); _error_ (one bank failing doesn't block others — show a chip); _partial_.
- **Calls:** `list_offers(voucher_hash, intention)` per pinned bank; `get_voucher` for hydration; `get_address` to resolve a foreign bank's URL when an Offer cites a peer `bank`.

### 13. QR / Share modals

A single reusable **Share modal** parameterized by kind. Every share produces a **Barter Link** — one URL that is both a human landing page and a carrier of signed docs (Goal 7). The link format and the page-metadata embedding are owned by **Barter Link** / **QR & Landing Journeys**; this modal is the UI around them.

- **Kinds (each emits a canonical Barter Link, §3.4 / §5 — never the SPA's internal management path):** **Issuer profile** (`/i/<pubkey>`), **Invoice** (`/v/<token>`), **Cheque** (`/q/<token>`), **Offer** (`/o/<offer-hash>`), **Invite / deal** (`/x/<token>`, carrying `barter://<inviter-pubkey>@<inviter-bank-url>?give=…&get=…[&accs=…]&exp=…&sig=…` or a `barterdeal:` token).
- **Layout:** QR canvas, link text, action row, mode toggle, expiry/preview.
- **Action elements:**
  - **Copy link** (clipboard).
  - **Download PNG** (rasterize QR).
  - **Mode toggle — Reference vs Inline:**
    - _Reference_: QR/link points at the URL; the receiving webapp fetches the signed doc(s) from page metadata / `get_invoice`/`get_cheque`/`get_voucher`.
    - _Inline_: the signed doc(s) are embedded directly in the link payload (e.g. invite `accs=` base64url Account docs; `barterdeal:` + base64url canonical JSON), self-validating before any network call.
  - **Regenerate** (new `exp`/fresh sig for invite), **Share via OS sheet** (mobile).
- **Data displayed:** what the receiver will see (give/get summary, issuer, expiry), and a note that the receiver verifies the signature **before** any network call (tamper-evident).
- **States:** _ready_; _error_ (payload too large for a reference-only QR → suggest Reference mode; signing failed → `/unlock`); _expired_ (invite past `exp` → prompt Regenerate).
- **Calls:** none directly for rendering reference links; **Inline/invite** modes call into Identity/Key Custody to sign (`barter://…sig`, `barterdeal:`); doc fetch by scanners uses `get_invoice`/`get_cheque`/`get_voucher`.

### 14. Accept-offer / Deal flow — `/discover/:offerHash` → `/deal/:dealId`

This is the multi-step money-moving flow. The UI **authorizes and observes**; the matchmaker orchestrates `create_records`/`submit_confirm`; banks self-advance `ready`→`hold`→`settle` (Core Object Flows owns the choreography). Reachable from an Offer, an inbound invite (`barter://…`) or deal token (`barterdeal:…`).

#### 14.1 Review terms

- **Data displayed:** the two sides (give/get), resolved Vouchers, `rate`, min/max, `lead`, counterparty bank(s), the implied amounts to be matched, and a **trust check** (is the counterparty/issuer in Trusted?). For an inbound invite/deal token, the signature is verified **before** any network call; tampering shows a hard error.
- **Action elements:** **Adjust amount** (within min/max), **Accept** (→ sign Order step), **Decline** (back), **Inspect raw docs** (advanced).
- **States:** _loading_ (resolving Offers/Vouchers via `get_voucher`, `get_address` for peer bank); _error_ (invalid/expired/tampered → blocked); _untrusted-warning_ (counterparty not Trusted → confirm-to-proceed).

#### 14.2 Sign Order

- **Action:** build the matching `Order` (the user's authorization), sign in browser, `submit_docs` to every bank issuing a referenced Voucher (with `publish_offers` if needed for the matchmaker). Show **per-bank submit progress**.
- **States:** _loading_ (fan-out), _error_ (`-32000`/`-32005` per bank, retry), _success_ → progress watch.

#### 14.3 Watch ready → hold → settle

- **Purpose:** live progress of the cascade for this `deal_id`.
- **Data displayed:** a stepper per participating bank/record over the canonical record states **created → approved → held → settled** (the bank's `ready` Signature is what drives a record into `approved`; see §3.3), sourced from `Signature` docs (`ready`/`hold`/`settle`/`reject`). Lead bank settles first; followers show their `seen[]` predecessor proofs. Show `deal_id`, all records, and per-record state chips.
- **Action elements:** **Refresh** (poll), **View record** (→ §6 drawer), **Abort/Reject** (where the user is entitled — surfaces a bank `reject` releasing holds), **Relay if stuck** (§14.4).
- **States:** _in-progress_ (animated stepper); _held-waiting_ ("locked, waiting for lead settle"); _settled_ (success — balances update, optimistic→confirmed, §16); _rejected_ (show `Signature.reason`, holds released); _lock-conflict_ (`-32003` → explain another in-flight deal locked the account; offer Retry/Abort); _stuck_ (no progress past a timeout → surface Relay).

#### 14.4 Relay-if-stuck

- **Purpose:** manual recovery when direct bank-to-bank delivery stalls (the spec's relay fallback).
- **Action elements:** **Pull signatures** (`get_record_signatures` from the bank that has them) → **Push** (`notify_signatures` to the bank that's missing them). Per-record selection; progress + result.
- **States:** _idle/loading/error/success_ ("relayed N signatures; deal advanced").
- **Calls (whole flow §14):** `submit_docs`; reads `get_record_signatures`, `get_voucher`, `get_address`; recovery `notify_signatures`. (`create_records`/`submit_confirm` are matchmaker-side; if this UI also acts as a simple matchmaker for a direct two-party deal, those are invoked per Core Object Flows.)

### 15. Settings — `/settings`

#### 15.1 Security — `/settings/security`

- **Action elements:**
  - **Auto-lock timeout** select (e.g. Off / 1 / 5 / 15 / 60 min of inactivity) → drives §16 auto-lock.
  - **Change password**: re-encrypt the private key under a new password — decrypt in browser with old password, re-encrypt with new, upload new blob (`CUSTOM PUT /ui/keystore`). Never sends plaintext key.
  - **KDF cost** (Argon2id memory/iterations) — advanced; re-encrypts on change (owned by Identity/Key Custody).
  - **Export recovery kit**: download the **encrypted** key blob + metadata (pubkey, KDF params) as a file; explicit warning that the password is still required and there is **no recovery** if forgotten.
  - **Lock now** (same as header LOCK).
- **States:** _success_ toasts; _error_ (wrong old password on change). _locked_ blocks re-encryption (requires `unlocked`).
- **Calls:** `CUSTOM PUT /ui/keystore`.

#### 15.2 Banks — `/settings/banks`

Shortcut into Known Banks management (§9.4): default issuing bank, pinned set, re-verify `barter-bank.json`. **Calls:** as §9.4.

#### 15.3 About — `/settings/about`

Static: bank `name`/`pubkey`/`url`/`protocol_version` (from `barter-bank.json`), UI version, links to protocol docs, and a clear statement of v1 constraints (no key recovery, no key rotation; lose key ⇒ lose account). **Future (out of scope, mentioned only):** direct messaging, voucher blogs.

### 16. Route Table

| Path | Screen | Auth | Primary calls |
|---|---|---|---|
| `/` (anon) | Welcome / Landing | none | `GET /barter-bank.json` |
| `/register` | Register | none | `CUSTOM POST /ui/register` |
| `/connect` | Connect | none | `CUSTOM POST /ui/register` |
| `/unlock` | Unlock | `selected`/`locked` | `CUSTOM GET /ui/keystore/:handle` |
| `/` (auth) | Home / Dashboard | `unlocked` | `list_accounts`, `get_account_balance`, `CUSTOM GET /ui/feed` |
| `/wallet` | Wallet | `unlocked` | `list_accounts`, `get_account_balance`, `get_voucher` |
| `/wallet/:voucherHash` | Account detail | `unlocked` | `get_voucher`, `get_account_balance`, `CUSTOM /ui/history` |
| `/activity` | Transaction History | `unlocked` | `CUSTOM GET /ui/history` |
| `/activity/:recordHash` | Record detail drawer | `unlocked` | `get_record_signatures`, `notify_signatures` (relay) |
| `/vouchers` | My Vouchers | `unlocked` | `list_vouchers`, `get_account_balance` |
| `/vouchers/new` | Create Voucher | `unlocked` | `submit_docs` |
| `/vouchers/:voucherHash` | Voucher detail | `unlocked`* | `get_voucher`, `list_offers`, `CUSTOM /ui/history` |
| `/orders` | Orders list | `unlocked` | `CUSTOM GET /ui/orders`, `list_offers` |
| `/orders/new` | Create Order | `unlocked` | `submit_docs`, `list_accounts`, `get_voucher` |
| `/orders/:orderHash` | Order detail | `unlocked` | `CUSTOM /ui/orders/:hash`, `get_record_signatures`, `submit_docs` |
| `/invoices` | Invoices list | `unlocked` | `CUSTOM /ui/orders?kind=invoice`, `get_invoice` |
| `/invoices/new` | Create Invoice | `unlocked` | `submit_docs` |
| `/invoices/:hash` | Invoice detail / QR (SPA manage) | `unlocked` | `get_invoice`, `get_record_signatures` |
| `/cheques` | Cheques list | `unlocked` | `CUSTOM /ui/orders?kind=cheque`, `get_cheque` |
| `/cheques/new` | Create Cheque | `unlocked` | `submit_docs` |
| `/cheques/:hash` | Cheque detail / QR (SPA manage) | `unlocked` | `get_cheque`, `get_record_signatures` |
| `/discover` | Marketplace | `unlocked` | `list_offers`, `get_voucher`, `get_address` |
| `/discover/:offerHash` | Offer detail → Deal | `unlocked` | `get_voucher`, `get_address`, `submit_docs` |
| `/deal/:dealId` | Deal flow (watch) | `unlocked` | `get_record_signatures`, `notify_signatures`, `submit_docs` |
| `/network/trusted` | Trusted Issuers | `unlocked` | `CUSTOM /ui/trusted`, `get_voucher` |
| `/i/:pubkey` | Issuer Profile | none (public) | `list_vouchers`, `list_offers`, `CUSTOM /ui/trusted` |
| `/network/contacts` | Contacts | `unlocked` | `CUSTOM /ui/contacts` |
| `/network/banks` | Known Banks | `unlocked` | `GET /barter-bank.json`, `get_address`, `CUSTOM /ui/banks` |
| `/x/:token` | Invite/deal landing (Barter Link) | none (public) → gated accept | verify-then `submit_docs` (Deal flow) |
| `/settings/security` | Security | `unlocked` | `CUSTOM PUT /ui/keystore` |
| `/settings/banks` | Banks | `unlocked` | `CUSTOM /ui/banks`, `GET /barter-bank.json` |
| `/settings/about` | About | none | `GET /barter-bank.json` |
| `/v/:token`, `/q/:token`, `/o/:hash` | Invoice / Cheque / Offer landing (server Barter Link, §7.8) | none (public) → gated act | `get_invoice` / `get_cheque` / `list_offers`, then Deal flow |

\* Voucher detail can render publicly read-only when reached via an issuer-profile link; management actions require `unlocked`.

### 17. Deep-link routing for incoming Barter Links

One link, two readers (Goal 7): a **normal browser** sees a landing page; a **barter webapp** extracts signed docs from page metadata/metadata links (formats owned by Barter Link / QR & Landing Journeys). The SPA router classifies the inbound URL, then branches on auth state.

```
inbound URL ──► classify(kind ∈ {profile, invoice, cheque, invite, deal})
                         │
       ┌─────────────────┴─────────────────┐
   anonymous/locked                     unlocked
       │                                    │
  render PUBLIC landing               render AUTHENTICATED handler
  (read-only terms, signature           (profile trust toggle, pay invoice,
   verified locally before any          claim cheque, accept deal → §14)
   network call)
       │
  CTA: Register/Connect/Unlock with
  returnTo = original URL  ──► after auth, re-dispatch SAME link
```

Branch table:

| Inbound (Barter Link, §3.4) | Classified | Logged-out lands on | Logged-in lands on |
|---|---|---|---|
| `…/i/<pubkey>` | profile | Public Issuer Profile + "Register & add to Trusted" (`?next=/i/<pubkey>&trust=<pubkey>`) | Issuer Profile with live Trust toggle (§9.2) |
| `…/v/<token>` | invoice | Read-only invoice + "Register to pay" | Deal flow to pay the invoice (§14) |
| `…/q/<token>` | cheque | Read-only cheque + "Register to claim" | Deal flow to claim (§14) |
| `…/o/<offer-hash>` | offer | Read-only Offer terms + "Register to trade" | Offer detail → Deal flow (§14) |
| `…/x/<token>` (carries `barter://…` invite) | invite | give/get summary + "Register to accept"; **sig verified first** | Review terms → Accept (§14.1) |
| `…/x/<token>` (carries `barterdeal:…` token) | deal | summary + register CTA; **self-validating, verified first** | Deal flow watch/accept (§14) |

Key rule: **self-validating payloads (invite, deal token) are verified locally before any RPC**; a tampered link never triggers a network call and shows a hard error. After Register/Connect/Unlock, the router re-dispatches the **same** original URL to the authenticated handler via `returnTo`.

### 18. Global behaviors

#### 18.1 Auto-lock & session

- Inactivity timer (configurable, §15.1) → on expiry, zeroize in-memory private key, set `locked`, route to `/unlock?returnTo=<current>`; in-flight drafts (Create Voucher/Order/Invoice/Cheque) are preserved in memory/sessionStorage and restored after unlock.
- Manual **LOCK** (header) does the same immediately.
- Tab close / refresh ⇒ in-memory key is gone ⇒ next load starts at `selected`→`/unlock`. Encrypted blob stays on the server; plaintext is never persisted anywhere.
- Account switch = independent per-key session; switching keys always passes through `/unlock` for the target key.

#### 18.2 Optimistic vs confirmed state

- Reads render the **confirmed** ledger (`get_account_balance` → `{current, pending}`): `current` is settled; `pending` reflects in-flight holds/settles.
- Writes are **optimistic with a confirmation gate**: after `submit_docs`/accept, the UI shows an optimistic chip (`submitting…` → `pending`) but a balance change is only shown as **confirmed** once the corresponding `settle` `Signature` is observed (via poll or `subscribe` push). Until then it appears under `pending`. A `reject` `Signature` rolls the optimistic change back and surfaces `reason`.
- The Deal stepper (§14.3) is the canonical place where optimistic→confirmed resolves per the `ready`/`hold`/`settle` cascade.

#### 18.3 Error & toast model

- **Transient/info** → toast (auto-dismiss): "Order submitted", "Polled 4 banks".
- **Actionable/blocking** → inline panel or modal (validation, lock conflict, signature failure).
- **RPC error mapping** (user-facing copy; codes from base.md §4.2):
  | Code | User message | Action offered |
  |---|---|---|
  | `-32000` | "This doesn't pass the bank's rules." | show field/rule, edit |
  | `-32001` | "Signature couldn't be verified." | re-sign (likely re-unlock) |
  | `-32002` | "Already submitted." | de-dupe, no-op |
  | `-32003` | "That account is locked by another in-flight deal." | Retry / Abort |
  | `-32005` | "The bank doesn't know one of these documents yet." | re-submit prerequisite docs |
  | `-32006..-32099` | custom-layer message from server | as provided |
- **Network/unreachable bank**: non-fatal per-bank chips; multi-bank operations continue with partial success and a retry-per-bank affordance.
- **Locked mid-action**: route to `/unlock`, preserve draft, return.

#### 18.4 Polling / refresh

- **Default model:** polling, since `subscribe` is optional. Each live screen owns a poll loop with backoff:
  - Wallet/Home balances: periodic `get_account_balance` (e.g. 15–30s when visible; paused when tab hidden).
  - Activity / Record drawer / Deal stepper: `get_record_signatures` / `CUSTOM /ui/history` on a tighter interval (e.g. 3–5s) while a deal is in-flight, relaxing after `settled`.
  - Discover: manual **Poll known banks** + optional auto-poll interval (§12).
- **Push augmentation:** if the UI has registered a `Subscription` (via `subscribe`) pointing at a custom UI notification endpoint, the notifications bell and stepper consume pushed signatures and reduce poll frequency. Subscriptions are optional and never required for correctness.
- **Refresh affordances:** every list/detail has a manual refresh; pull-to-refresh on mobile.
- **Visibility:** polling pauses on `document.hidden` and resumes (with an immediate fetch) on focus.

## 9. Core Object Flows — Vouchers, Orders, Discovery & Deal Execution

This section maps every user action in the bank-served web UI onto concrete protocol documents (per `bank-schema.md` / `base.md`) and RPC calls (per `bank-rpc.md`). Each flow gives the form fields, the resulting signed doc(s) with field-by-field mapping, the RPC and custom-layer calls in order, and the resulting UI state.

Everything in this section lives in the **custom layer** (`base.md` §6): the UI builds standard documents and calls standard methods. Where the UI needs a server helper, it calls a bank-private `/ui/*` endpoint (shapes owned by **Bank UI Backend API**) that fans out to standard RPC. No standard schema or RPC semantics are altered. A client speaking only the standard protocol can reproduce every flow here with `submit_docs` / `create_records` / `submit_confirm` / the read methods directly.

### Conventions used in this section

- **Who signs what.** Holders sign Vouchers, Accounts, Orders, Addresses, and the JSON-RPC envelope. Banks sign Offers, Records' `ready`/`hold`/`settle` Signatures, and their own Address. Holders never sign Records (`bank-schema.md` §1.3). All signing happens **in the browser** with the decrypted private key (see **Identity/Key Custody**); the plaintext key never leaves the page.
- **Canonicalization.** Every doc is hashed as `SHA-256(canonical(doc minus sig))` (JCS / RFC 8785) and signed ed25519; the base58 of that hash is the doc's content hash and the value other docs reference (`base.md` §2). The UI computes hashes client-side so it can reference a doc (e.g. in `publish_offers`) before the server round-trip.
- **Envelope.** Every RPC is the signed envelope `{jsonrpc, id:<ulid>, method, params, pubkey:<user>, to:<bank-pubkey>, sig}` (`base.md` §4). `to` is the pinned bank pubkey, not the URL. The UI signs the envelope in the browser too.
- **`this bank`** = the bank pubkey/URL serving the UI, read from `GET <bank-url>/barter-bank.json` and pinned in client config (`base.md` §5).
- **`<...>`** denotes a content hash or ULID computed at runtime.

---

### 1. CREATE VOUCHER

A user mints a personal currency they vow to deliver. The Voucher is bound to **this bank** (the `bank` field is part of the Voucher hash, `bank-schema.md` §1.1), so a Voucher minted in this UI is always issued at this bank.

#### Form fields (screen owned by **Screens & Navigation**)

| Field | Type | Required | Maps to |
|---|---|---|---|
| Name | text | yes | `Voucher.name` |
| Image | square image upload | no | `Voucher.image_svn` (inlined; UI enforces square + size cap) |
| Description | markdown editor | no | `Voucher.description_md` |
| Maturity date | date-time | no | `Voucher.due` (ISO 8601) |
| Expiration | date-time | no | `Voucher.expires` (ISO 8601) |
| Max supply | number | no | `Voucher.limit` |
| Integer amounts only | checkbox | no | `Voucher.integer` (omit ⇒ float) |

#### Resulting signed doc

```jsonc
{
  "type": "voucher",
  "pubkey": "<user-pubkey>",          // issuer = the signed-in user
  "ulid": "<new ULID>",
  "bank": "<this-bank-pubkey>",       // part of the hash; pinned this bank
  "name": "1 hour consulting",
  "image_svn": "<inlined square image>",   // omitted if no upload
  "description_md": "Pair-programming...", // omitted if empty
  "due": "2026-12-31T00:00:00Z",           // omitted if empty
  "expires": "2027-12-31T00:00:00Z",       // omitted if empty
  "limit": 1000,                            // omitted if empty
  "integer": true                           // omitted ⇒ float amounts
}
// signed: sig = ed25519(sha256(canonical(doc minus sig)))
```

The UI drops empty optional keys entirely (JCS drops `undefined`), so two users who leave the same fields blank produce comparable hashes.

#### Calls, in order

1. The UI **auto-creates the issuer Account** for this Voucher (Flow 2) so the issuer can immediately place sell Orders that drive its own balance negative. The Voucher hash is needed to build the Account, so the UI computes `<voucher-hash>` locally first.
2. `submit_docs` to this bank with both docs:

```jsonc
{ "method": "submit_docs",
  "params": { "docs": [ <voucher>, <issuer-account> ] },
  "pubkey": "<user-pubkey>", "to": "<this-bank-pubkey>" }
// → { storedHashes: [<voucher-hash>, <account-hash>], offers: [] }
```

> **No mint step.** Creating a Voucher does **not** create supply. Supply appears the first time the issuer's own sell Order is matched: a debit/credit pair is minted that drives the issuer Account negative (this is the issuer's vow to deliver) and credits the buyer (`bank-schema.md` §3.2). The UI must state this plainly on the success screen: *"You now own this currency. Nothing is in circulation until you place a sell Order and someone trades for it."*

#### Resulting UI state

- Voucher appears in **My Vouchers** with balance `0 / 0` (current/pending) on its issuer Account.
- A **Create Order** call-to-action is enabled for this Voucher (sell side pre-selected).
- The **Issuer Profile QR** for this Voucher becomes generatable (hand off to **QR & Landing Journeys**).

---

### 2. CREATE ACCOUNT (implicit)

There is **no `open_account` call**. An Account is a holder-signed doc, created the moment the UI first needs to reference a named bucket for a Voucher (`bank-schema.md` §1.2). The bank stores it (it must, to validate `details.account` ownership on records) but the `name` is treated as private to the holder.

#### When the UI auto-creates and signs an Account

The UI maintains, per signed-in user, **one Account per Voucher the user touches**, lazily:

1. **On Voucher creation** — issuer Account for the new Voucher (Flow 1).
2. **On building any Order** — if a `debit`/`credit` side names a Voucher the user has no Account for yet, the UI mints one before constructing the Order, because `Order.{debit,credit}.account` must reference a stored Account owned by `Order.pubkey`.
3. **On accepting an Offer / registering from a QR** — if the user is about to receive a Voucher they don't yet hold (e.g. landing from an Issuer Profile QR and adding the issuer to their trusted issuers, then trading), the UI mints the receiving Account.

The UI keeps the mapping `voucher-hash → {account-ulid, account-hash, local name}` in client state (see **Identity/Key Custody** for where per-user UI state is persisted). Names default to the Voucher name (`"1 hour consulting"`) and are editable locally; the bank sees the chosen name but the protocol treats it as private (`coordinator-arbitrage.md` attack #9).

#### Resulting signed doc

```jsonc
{
  "type": "account",
  "pubkey": "<user-pubkey>",        // holder
  "ulid": "<new ULID>",
  "name": "consulting (mine)",      // local label, defaults to voucher name
  "voucher": "<voucher-hash>"
}
// signed by the holder
```

#### Calls, in order

Account docs are not submitted on their own; they ride along inside the `submit_docs` of whatever Order/Voucher first references them (see every flow below: the `docs` array always carries the referenced Account docs, matching `invoice.md`/`cheque.md`). If the UI needs to confirm an Account is already stored (e.g. after recovering on a new device), it calls `list_accounts()` and reconciles.

#### Resulting UI state

Account appears in **Balances** with `current=0, pending=0` until a record settles. Account is never shown to peers; only its derived Offers (which hide it) are public.

---

### 3. CREATE ORDER — unified SELL / BUY

The Order is the **only holder authorization primitive** (`bank-schema.md` §1.4). The UI presents one form; "Sell" and "Buy" are just which side the user fills first. A two-sided Order is a swap; omitting a side yields an Invoice or Cheque (Flow 4).

#### Form fields

| Field | Maps to | Notes |
|---|---|---|
| I give (voucher) | `debit.voucher` (+ `debit.bank`) | picker over My Vouchers + trusted issuers; `debit.account` auto-filled from Flow 2; `debit.bank` from the Voucher's `bank` |
| I give: min / max per match | `debit.min` / `debit.max` | anti-fragmentation floor / per-match cap |
| I want (voucher) | `credit.voucher` (+ `credit.bank`) | picker; `credit.account` auto-filled |
| I want: min / max per match | `credit.min` / `credit.max` | |
| Rate | `rate` | **max acceptable `debit/credit` ratio**, checked in aggregate at `ready` (see callout) |
| Total I'll give (cap) | `debit_order_limit` | cumulative debit ceiling across all matches of this Order |
| Total I'll receive (cap) | `credit_order_limit` | cumulative credit ceiling |
| Don't let my give-account drop below | `debit_account_limit` | balance floor on the debit account (issuers leave blank to allow negative) |
| Don't let my get-account exceed | `credit_account_limit` | overstock cap on the credit account |
| Settle first (lead) | `lead` | toggle; see Lead UX below |

The UI derives a friendly **price preview** from `rate`, `min`/`max` (e.g. "give 1–100 of X, receive ≥90 of Y; never worse than 100 X per 90 Y"). All amounts respect the Voucher's `integer` flag.

#### Rate semantics (UI must explain)

`rate = max(total_debit / total_credit)` for the whole deal, **not per pair**, checked at `ready` once every record of the deal matched to this Order is known (`bank-schema.md` §1.4 rule 7; `coordinator-arbitrage.md` rate callout). The UI computes `rate` from the user's "give/get" numbers (`rate = give ÷ get`) and shows it read-only with an editable "worst acceptable price" advanced control. For one-sided Orders `rate` is informational but must be positive; the UI defaults it to `1`.

#### Lead UX and risk (UI must state plainly)

`lead: true` authorizes **this bank to hold and settle this user's records before peer banks have locked or settled** (`bank-schema.md` §1.4; `coordinator-arbitrage.md`). Present it as a single toggle with a plain-language explanation, not jargon:

- **Off (follow, default for swaps):** *"Your bank waits for the other side's bank to lock and settle first. Safer — your balance only moves after theirs is committed."*
- **On (lead):** *"Your bank moves first. The other side's bank could still fail to reciprocate, and there is no automatic timeout or reversal in v1 — you'd have to resolve it socially."* (This is exactly the lead/follow risk in `coordinator-arbitrage.md` attacks #1, #2.)
- The UI must warn if **both** sides of a contemplated deal would be `follow` (deadlock) or surface that at least one side must lead; for Invoice/Cheque the payer side leads by convention (Flow 4).

#### Resulting signed doc (two-sided swap)

```jsonc
{
  "type": "order",
  "pubkey": "<user-pubkey>",
  "ulid": "<new ULID>",
  "rate": 1.1111,                          // 100 give / 90 get
  "debit":  { "account": "<give-account-hash>", "voucher": "<X-hash>", "bank": "<X-bank-pubkey>", "min": 1,  "max": 100 },
  "credit": { "account": "<get-account-hash>",  "voucher": "<Y-hash>", "bank": "<Y-bank-pubkey>", "min": 90, "max": 90 },
  "debit_order_limit": 100,                // omitted keys dropped
  "lead": false
}
// signed by the holder
```

#### Calls, in order

1. Auto-mint any missing Account docs for the referenced Vouchers (Flow 2).
2. Compute `<order-hash>` locally.
3. `submit_docs` **with `publish_offers`** so the bank derives a public Offer (hiding identity + account hashes, `bank-schema.md` §1.5):

```jsonc
{ "method": "submit_docs",
  "params": {
    "docs": [ <order>, <give-account>, <get-account> ],
    "publish_offers": [ "<order-hash>" ]
  },
  "pubkey": "<user-pubkey>", "to": "<this-bank-pubkey>" }
// → { storedHashes: [...], offers: [ "<offer-hash>" ] }
```

4. **Cross-bank Orders.** If `debit.bank ≠ credit.bank`, the *same signed Order* (byte-identical, same hash) must be submitted to **each referenced Voucher's bank** (`bank-schema.md` §1.4; `bank-rpc.md` §4 step 1). For the foreign bank the UI submits to its pinned `{pubkey,url}`; the foreign bank checks only the side whose Voucher it issues. The UI fans this out, optionally via the backend helper `/ui/submit_order` which loops over the distinct `bank` values (shape owned by **Bank UI Backend API**). Each bank independently may `publish_offers`.

#### Resulting UI state

- Order appears under **My Orders** as `open`, with a derived Offer hash per bank that accepted it.
- A **price/inventory** badge shows the Order is bounded by current account balance + limits (Orders never expire — Flow 8).
- If cross-bank, the UI shows per-bank acceptance status (e.g. "Offer live at bank-alice, bank-bob").

---

### 4. INVOICE and CHEQUE (one-sided Order specializations)

An **Invoice** is an Order with `debit` omitted (authorizes an unconditional *credit* to the holder — "pay me"). A **Cheque** is an Order with `credit` omitted (authorizes an unconditional *debit* from the holder — "anyone may pull from me"). These are not new doc types (`bank-schema.md` §1.4 Specializations; scenarios `invoice.md`, `cheque.md`).

#### Form fields

The same Order form with one side hidden. The UI offers two entry points "Request payment (Invoice)" and "Write a cheque (Cheque)".

| Invoice field | Maps to | Cheque field | Maps to |
|---|---|---|---|
| Voucher to receive | `credit.voucher`/`.bank` | Voucher to give | `debit.voucher`/`.bank` |
| Account to credit | `credit.account` (auto) | Account to debit | `debit.account` (auto) |
| min / max per payment | `credit.min`/`.max` | min / max per draw | `debit.min`/`.max` |
| Stop after receiving total | `credit_order_limit` | Stop after giving total | `debit_order_limit` |
| Max balance after | `credit_account_limit` | Min balance floor | `debit_account_limit` |
| (lead defaults `false`) | `lead:false` | (lead defaults `true`) | `lead:true` |

Lead convention: the **payer's** side leads. An Invoice is `lead:false` (the paying cheque leads); a Cheque is `lead:true` (the cheque authorizes the unconditional debit). This matches `invoice.md` step 1 and `cheque.md` step 1.

#### Resulting signed docs

```jsonc
// INVOICE (credit-only)
{ "type":"order", "pubkey":"<user>", "ulid":"<new>", "rate":1,
  "credit": { "account":"<acct-hash>", "voucher":"<V-hash>", "bank":"<V-bank>", "min":1, "max":1000 },
  "credit_account_limit": 10000, "lead": false }

// CHEQUE (debit-only)
{ "type":"order", "pubkey":"<user>", "ulid":"<new>", "rate":1,
  "debit": { "account":"<acct-hash>", "voucher":"<V-hash>", "bank":"<V-bank>", "min":1, "max":100 },
  "credit_order_limit": 1000, "lead": true }
```

#### Calls, in order

1. Auto-mint the referenced Account if needed (Flow 2).
2. `submit_docs` with `publish_offers: [<order-hash>]` to the issuing Voucher's bank (one-sided Orders are single-bank by construction; the one named Voucher's `bank` is the only target). The bank derives an **invoice offer** / **cheque offer** (one-sided Offer) and returns its hash.
3. **Hand off to QR/Link.** The UI then generates the **Barter Link + QR** carrying the *signed Order doc itself* so a scanner can pay/cash it. The link is human-landable and doc-carrying (the same URL), per **QR & Landing Journeys** and **Barter Link format**. The UI passes them the signed Order body and the returned Offer hash; it also exposes `get_invoice(<hash>)` / `get_cheque(<hash>)` so a webapp scanner can re-fetch the canonical doc.

#### Resulting UI state

Invoice/Cheque appears under **My Orders** tagged `invoice`/`cheque`, with a **Share** button (QR + copyable Barter Link). Status tracks matches as they settle (Flow 6 watch path).

---

### 5. DISCOVERY — polling for Offers

Users discover interesting exchange requests by polling **known banks** for Offers on (a) Vouchers they issue/hold and (b) Vouchers on their **trusted issuers** (the per-user trusted-issuer list — custom UI state, `bank-schema.md` has no trust concept). The marketplace merges these into one view.

#### Inputs

- **Voucher set** = `{ My Vouchers } ∪ { Vouchers of trusted issuers }`. The UI resolves a trusted issuer pubkey to its Vouchers via `list_vouchers(filter)` on that issuer's bank (filter is bank policy; the UI passes e.g. `{ issuer: <pubkey> }`).
- **Bank set** = the distinct `{pubkey,url}` banks behind that Voucher set, plus any banks the user has pinned.
- **Intention** = `sell` and/or `buy` — the UI queries both so it can show "people selling X" and "people buying X".

#### Per-bank standard call

```jsonc
{ "method": "list_offers",
  "params": { "voucher_hash": "<V-hash>", "intention": "sell" },
  "pubkey": "<user-pubkey>", "to": "<bank-pubkey>" }
// → [ <Offer>, <Offer>, ... ]   // bank-signed, identity-hiding
```

#### Backend aggregation: `/ui/discover`

Fanning out to many banks from the browser is slow and leaks the user's polling pattern to every bank. The UI instead calls **one** custom endpoint on **this** bank, which performs the fan-out, dedups by Offer hash, and caches (shape owned by **Bank UI Backend API**):

```jsonc
// browser → this bank (custom layer)
POST <this-bank-url>/ui/discover
{ "vouchers": [ "<V1-hash>", "<V2-hash>" ],
  "banks":    [ { "pubkey":"<b1>", "url":"<u1>" }, ... ],
  "intentions": [ "sell", "buy" ] }

// ← aggregated, cache-tagged
{ "offers": [
    { "offer": <Offer>, "bank": "<bank-pubkey>", "intention": "sell",
      "fetched_at": "2026-06-20T12:00:00Z" }, ... ],
  "stale_banks": [ "<bank-that-timed-out>" ] }
```

The backend still issues only standard `list_offers` calls under the hood, signed as **this bank** or relayed with the user's signed envelope (the security boundary — whose key signs the outbound poll — is owned by **Bank UI Backend API**).

#### Cadence & caching

- **Foreground:** the Marketplace polls `/ui/discover` on open and on a **30 s** interval while visible; the backend serves from a short TTL cache (**~15 s** per `(bank, voucher, intention)`), so rapid UI refreshes don't hammer peers.
- **Background:** a lighter poll (e.g. **5 min**) for Offers touching the user's own Vouchers powers a "new requests" badge.
- Offers carry no expiry; the UI must reconcile each poll against the last set and mark vanished Offers as `withdrawn` (the underlying Order was emptied/superseded — Flow 8).
- Optional push: a user MAY `subscribe` (with `voucher` filter) so a bank pushes matching signatures instead of being polled; the UI treats Subscriptions as an optimization layered on top of polling, never a requirement (`bank-schema.md` §1.7).

#### Resulting UI state

A **Marketplace** list of counter-Offers grouped by Voucher and intention, each row showing terms (rate, min/max, lead flag), the issuing bank, and a trusted issuers/trust badge. Each row has **Accept** → Flow 6.

---

### 6. ACCEPT OFFER / EXECUTE DEAL

The user picks a counter-Offer; their own published Offer is the other side. Execution is the matchmaker recipe (`bank-rpc.md` §4): share Address docs, `create_records` on each bank, `submit_confirm`, then **the banks self-advance `ready → hold → settle`** while the UI **watches**. The web UI can act as matchmaker itself, or delegate to the bank-as-matchmaker via `/ui/propose_deal`.

#### Inputs (from the Marketplace row)

- `myOffer` = the user's own Offer hash on the relevant bank(s).
- `theirOffer` = the selected counter-Offer hash.
- `amount` within both Offers' overlapping `[min,max]` (and respecting both `rate`s); the UI proposes the largest mutually valid amount and lets the user adjust.
- A fresh `deal_id` (ULID), generated client-side.

#### Path A — bank-as-matchmaker (default, simplest)

The UI hands the two Offer hashes and the chosen amounts to **this bank's** custom endpoint; the bank runs the standard matchmaker recipe on the user's behalf:

```jsonc
POST <this-bank-url>/ui/propose_deal
{ "deal_id": "<ULID>",
  "offer1": { "hash": "<myOffer>",    "debit_amount": 100, "credit_amount": 90 },
  "offer2": { "hash": "<theirOffer>", "debit_amount": 90,  "credit_amount": 100 } }
// → { deal_id, records: [<record-hash>...], banks: [<bank-pubkey>...] }
```

Internally the bank performs exactly the standard steps below (it is just another matchmaker keypair). The amount-mapping rule per bank is from `bank-rpc.md` §2.2: each bank uses the two amounts that apply to *its* Voucher.

#### Path B — UI-as-matchmaker (client orchestration, no trusted backend)

The browser drives the standard calls itself, signing envelopes as the user (the user is the matchmaker `M.pub`):

1. **Share Address docs** (`bank-rpc.md` §4 step 3). For each peer bank in the deal, fetch its current Address and submit it to the other participating bank(s):

```jsonc
// fetch peer Address
{ "method":"get_address", "params":{ "pubkey":"<peer-bank-pubkey>" },
  "pubkey":"<user>", "to":"<peer-bank-pubkey>" }     // → <Address doc>

// submit it to the other bank
{ "method":"submit_docs", "params":{ "docs":[ <Address doc> ] },
  "pubkey":"<user>", "to":"<other-bank-pubkey>" }
```

For a same-bank Invoice/Cheque (single bank) this step is skipped.

2. **`create_records`** on every participating bank with the same `offer1`/`offer2` shape and shared `deal_id` (`bank-rpc.md` §2.2):

```jsonc
{ "method":"create_records",
  "params":{
    "offer1":{ "hash":"<myOffer>",    "debit_amount":100, "credit_amount":90 },
    "offer2":{ "hash":"<theirOffer>", "debit_amount":90,  "credit_amount":100 },
    "deal_id":"<ULID>" },
  "pubkey":"<user>", "to":"<bank-pubkey>" }
// → { records: [ <debit-record>, <credit-record> ] }
```

3. **`submit_confirm`** — build a per-bank Confirm listing *that bank's* records, sign as the user, submit (`bank-rpc.md` §2.1):

```jsonc
{ "method":"submit_confirm",
  "params":{ "confirm": {
    "type":"confirm", "pubkey":"<user>", "ulid":"<new>",
    "deal_id":"<ULID>", "bank":"<bank-pubkey>",
    "records":[ "<debit-hash>", "<credit-hash>" ] } },
  "pubkey":"<user>", "to":"<bank-pubkey>" }
```

4. **Banks self-advance.** Once each bank has the Confirm + bound Orders, its advance engine issues `ready`, then `hold`, then `settle` automatically; banks discover each other via the `bank` fields on the Orders and push signatures peer-to-peer via `notify_signatures` (`bank-rpc.md` §4 step 6; `coordinator-arbitrage.md` Phase 5). The UI does **not** drive hold/settle.

#### Matchmaker-bilateral mechanics the UI surfaces (read-only)

For a two-bank swap the UI shows the lead/follow cascade so the user understands ordering and risk (`coordinator-arbitrage.md` Phase 5):

- The bank whose holder's Order is `lead:true` is the **lead**; it issues `hold` then `settle` first.
- The **follow** bank waits for the lead's `hold` before locking, and for the lead's `settle` before applying its deltas; its `settle` Signature cites the lead's `settle` hashes in `Signature.seen` — the verifiable cascade proof (`base.md` §3.1).
- The UI renders this as a stepper: `ready (both) → hold (lead) → hold (follow) → settle (lead) → settle (follow)`, each step lit when the corresponding Signature is observed.

#### Watching the cascade

The UI watches each record by hash and renders the stepper from observed Signatures:

```jsonc
{ "method":"get_record_signatures", "params":{ "record_hash":"<record-hash>" },
  "pubkey":"<user>", "to":"<bank-pubkey>" }
// → { record: <Record>, signatures: [ {action:"ready",...}, {action:"hold",...}, {action:"settle", seen:[...]}, ... ] }
```

- **Poll** `get_record_signatures` for every record in the deal on a short interval (e.g. **2 s**) until all show `settle` (or any shows `reject`).
- **Push (optional):** the user may `subscribe({ record:<hash>, url:<ui-callback> })` so the bank pushes `notify_signatures`; the UI still keeps the poll as a backstop (`bank-schema.md` §1.7).

#### Relay path (push lost / follow stalled)

If a follow bank is missing a predecessor's `settle` (e.g. the lead pushed to a stale Address), any party may relay by hand: read the signatures from the bank that has them and re-deliver them to the bank that needs them (`bank-rpc.md` §4 step 7; `coordinator-arbitrage.md` attack #3). The UI exposes this as a one-click **"Nudge / Relay"** via a custom endpoint:

```jsonc
POST <this-bank-url>/ui/relay_signatures
{ "from": { "pubkey":"<bank-with-sigs>", "url":"<u>" },
  "to":   { "pubkey":"<bank-missing-sigs>", "url":"<u>" },
  "record_hashes": [ "<r1>", "<r2>" ] }
// backend: get_record_signatures(from) → notify_signatures(to); re-runs advance engine
```

This is pure transport: it never forges signatures (a relayer lacks bank keys), it only moves already-signed `Signature` docs from one bank to another.

#### Resulting UI state

- Deal card shows live stepper; on completion, **Balances** update (`current` reflects applied deltas) and the deal moves to **History**.
- On `reject` or lock conflict (`-32003`), the card shows the failure and which record/account conflicted; holds release automatically and the user may retry with a different amount/counter-Offer.
- Stalled lead-after-hold (no `settle`) surfaces a "Pending — contact counterparty" state with the Relay/Nudge action, reflecting the no-timeout reality of v1.

---

### 7. READS — balances, history, orders/offers

#### Balances

```jsonc
{ "method":"list_accounts", "params":{},
  "pubkey":"<user>", "to":"<bank-pubkey>" }
// → { accounts: [ <Account> ], vouchers: [ <Voucher> ] }   // accounts + their Voucher bodies

{ "method":"get_account_balance", "params":{ "account_hash":"<acct-hash>" },
  "pubkey":"<user>", "to":"<bank-pubkey>" }
// → { current: 120, pending: -10 }   // pending = effect of held-but-unsettled records
```

The UI calls `list_accounts` per pinned bank, then `get_account_balance` per Account, and renders `current` / `pending` (held funds shown as encumbered). Issuer Accounts may show **negative** `current` — the UI labels this "in circulation / owed by you", not an error (`bank-schema.md` §3.2).

#### Transaction history

History is reconstructed from record Signatures. The UI keeps the set of record hashes touching the user (learned from `create_records` returns, Confirms it built, and Subscription pushes) and calls `get_record_signatures(<record-hash>)` for each, ordering by the records' ULIDs and showing the final `ready/hold/settle/reject` state and the settle cascade (`seen`). A backend convenience endpoint MAY index this per holder (shape owned by **Bank UI Backend API**); the canonical source remains `get_record_signatures`.

#### Orders / Offers list

- **My Orders:** local client state (the signed Orders the UI built) reconciled against the bank, each annotated with its published Offer hash(es). Status derived from `get_account_balance` (can this Order still ready?) and observed matches.
- **My Offers / public Offers:** `list_offers(<voucher>, intention)` filtered to `Offer.order ∈ my orders` to confirm what the bank is advertising on the user's behalf.

#### Resulting UI state

Dashboard tiles: per-Voucher balance (current/pending), recent settled transfers, open Orders with their live Offers, and any in-flight deals (Flow 6).

---

### 8. CANCEL / WITHDRAW an Order

Orders have **no expiry**; they remain on the ledger indefinitely, bounded only by **account balance + limits** (`bank-schema.md` §1.4). There is no `cancel_order` RPC. The UI offers two standard-protocol mechanisms:

1. **Empty the debit account (true cancel of a sell/cheque).** A holder cancels an Order by draining its `debit.account` so the bank has no free balance to `ready` against (`bank-schema.md` §1.4). The UI does this by placing a quick Order/transfer that moves the balance to another Account the user controls (or, for an issuer, accepting that the negative obligation is already in circulation and cannot be unilaterally clawed back). The Order then matches nothing because every `ready` fails the free-balance check.
2. **Supersede / starve via limits.** For a still-funded Order, the UI submits a **replacement** Order (new ULID) with the desired terms and sets the old Order's effective ceiling to its already-matched total by lowering availability — practically, the UI marks the old Order `withdrawn` in client state and stops advertising it. Because the bank only acts on Offers presented to matchmakers, a no-longer-shared Order is inert; the UI also stops including it in `/ui/discover` results and ceases any Subscription tied to it.

The UI must be explicit in copy: *"Orders can't be deleted from the ledger. We cancel them by removing the balance they could spend and by no longer advertising them. Anything already matched and settled is final."* Invoices/Cheques are withdrawn the same way (drain the debit account for a Cheque; lower/stop the Invoice's `credit_order_limit` exposure and stop sharing the link).

#### Resulting UI state

Order shows `withdrawn` locally; its Offer disappears from subsequent `list_offers` polls (Flow 5 reconciliation marks it gone for peers too). Balances reflect any transfer used to drain the account.

---

### End-to-end worked examples

#### Example A — Create and run a cross-bank **sell** Order (swap)

Alice sells `100` Avoucher (issued at Abank) for `90` Bvoucher (issued at Bbank); she follows. This mirrors `coordinator-arbitrage.md`.

1. **Vouchers/Accounts exist.** Alice already issued Avoucher (Flow 1) and holds a Bvoucher Account (Flow 2, auto-minted when she builds the Order). Account hashes: `<A-acct>`, `<B-acct>`.
2. **Build + sign Order** (Flow 3), `rate = 100/90`:

```jsonc
{ "type":"order", "pubkey":"A.pub", "ulid":"<new>", "rate":1.1111,
  "debit":  { "account":"<A-acct>", "voucher":"<Avoucher>", "bank":"Abank.pub", "min":1,  "max":100 },
  "credit": { "account":"<B-acct>", "voucher":"<Bvoucher>", "bank":"Bbank.pub", "min":90, "max":90 },
  "lead": false }
```

3. **Submit cross-bank** (Flow 3 step 4): same signed Order to **Abank** and **Bbank**, each with `publish_offers:[<order-hash>]` and the relevant Account docs. Abank publishes Alice's sell-Avoucher Offer; Bbank publishes the mirrored buy side.
4. **Discovery** (Flow 5): Alice's Marketplace (or a matchmaker's) surfaces Bob's opposite Offer (sell `100` Bvoucher for `90` Avoucher, `lead:true`).
5. **Execute** (Flow 6): share Abank↔Bbank Address docs; `create_records` at Abank (`offer1.debit_amount=100, offer2.credit_amount=100` for Avoucher) and at Bbank (Bvoucher amounts); per-bank `submit_confirm`.
6. **Self-advance + watch:** Bbank leads (Bob `lead:true`), Abank follows. Stepper lights `ready(both) → hold(Bbank) → hold(Abank) → settle(Bbank) → settle(Abank)`; Abank's `settle` cites Bbank's in `seen`.
7. **Result:** Alice `−100` Avoucher (her issuer Account goes/stays negative), `+90` Bvoucher; History gains one settled transfer per side.

#### Example B — Pay an **invoice** from a scanned Barter Link

Bob pays Alice's `10` Bvoucher invoice (Alice's Order has `debit` omitted, `lead:false`). This mirrors `invoice.md`.

1. **Scan → extract.** Bob's webapp scans Alice's invoice QR; the Barter Link carries Alice's signed invoice Order (verified locally before any network call — see **Barter Link format** / **QR & Landing Journeys**). The UI reads `credit.voucher = <Bvoucher>`, `credit.bank = Bbank.pub`, and the published invoice **Offer** hash.
2. **Build Bob's cheque side** (Flow 4, Cheque), `debit` Bvoucher from Bob's account, `lead:true`:

```jsonc
{ "type":"order", "pubkey":"B.pub", "ulid":"<new>", "rate":1,
  "debit": { "account":"<bob-bvoucher-acct>", "voucher":"<Bvoucher>", "bank":"Bbank.pub", "min":1, "max":1000 },
  "lead": true }
```

`submit_docs` to Bbank with `publish_offers:[<order-hash>]` (auto-mints Bob's Bvoucher Account if missing).
3. **Execute** (Flow 6, single bank ⇒ no Address sharing): `create_records` at Bbank with `offer1=<invoice-offer>{debit_amount:0,credit_amount:10}`, `offer2=<bob-cheque-offer>{debit_amount:10,credit_amount:0}`, fresh `deal_id`; then `submit_confirm` listing `[<bob-debit-hash>, <alice-credit-hash>]`.
4. **Self-advance + watch:** Bob's cheque is `lead:true`; Bbank issues `ready → hold → settle` in one bank. UI polls `get_record_signatures` until both records show `settle`.
5. **Result:** Bob `−10` Bvoucher, Alice `+10` Bvoucher. Bob's UI shows "Invoice paid"; Alice's UI (if watching/subscribed) shows the credit. Neither holder signed a payment-specific doc beyond their standing Orders; the matchmaker (here Bob's own UI) never saw account hashes other than via Offer hashes.

---

### Hand-offs

- **Screens & Navigation** — owns the actual form layouts, marketplace/dashboard screens, and the stepper component referenced above.
- **Identity/Key Custody** — owns key creation/decryption, where the plaintext key is used to sign these docs (browser-only), and where per-user UI state (trusted issuers, account-name map, my-orders list) is stored.
- **Barter Link format** — owns the self-validating link/doc-carrier format used to share Invoices/Cheques and Issuer Profiles.
- **QR & Landing Journeys** — owns QR generation and the dual human-landing / webapp-extraction behavior for those links.
- **Bank UI Backend API** — owns the exact request/response shapes, auth, and signing boundary of every `/ui/*` endpoint named here (`/ui/discover`, `/ui/submit_order`, `/ui/propose_deal`, `/ui/relay`, and any history indexer).

## 10. Security Summary

This section consolidates the cross-cutting security guarantees stated throughout the spec. Each is owned in detail by the cited section; here they live once, as the contract a reviewer checks.

### 10.1 Blind-custodian keystore

- The server stores only the **keystore blob** — AEAD ciphertext of the 32-byte ed25519 seed, plus `nonce`, `salt`, and KDF parameters — and the public `pubkey`/`handle`. It never holds the password or plaintext key (§4).
- KDF: **Argon2id** (`m=64 MiB, t=3, p=1`) primary, **PBKDF2-HMAC-SHA-256** (`600 000` iterations) fallback; AEAD: **XChaCha20-Poly1305** (AES-256-GCM alternate), with the pubkey bound as AAD so a blob cannot be swapped between identities (§4).
- **Forgot password = lose account.** There is no server reset, operator override, or email recovery. The one-time **recovery kit** (encrypted `.barterkey` file and/or BIP39 mnemonic), offered only at creation, is the sole recovery path — consistent with v1 "lose key ⇒ lose account" (`protocol/README.md` trust model).

### 10.2 The key never crosses the network

- All key generation, KDF, AEAD, and ed25519 signing run in **first-party client JS/WASM**. Only ciphertext + public values and **finished signed docs** ever leave; the raw seed, password, and derived KEK never touch `fetch`/`XHR`/`WebSocket`/`sendBeacon` (§4).
- **Strict CSP** on every UI page (`script-src 'self' 'wasm-unsafe-eval'`, no inline/remote scripts, no analytics), vendored crypto libs with SRI, telemetry input-scrubbing by allowlist (§4).
- **URL fragments (`#…`) never reach the server.** Inline Barter Link payloads ride in the `#b=` / `#s=` fragment precisely so the bank serving the page never receives them; an inline landing page renders the docs purely client-side and MAY omit the embedded `<script id="barter-payload">` block to preserve this property (§5, *Two carrying modes* / *Content negotiation*).

### 10.3 Verify-before-act, and pubkey pinning everywhere

- A Barter Link or OOB string is trusted only after its embedded signature(s) **verify locally** (`SHA-256(canonical(doc minus sig))`, JCS) and its bank pubkey is **pinned** against `barter-bank.json` — **fail closed** on divergence (§5 *Self-validation*, §6.6). The only network read permitted before verification is the pinning fetch of `barter-bank.json`, which triggers no mutation.
- The same pin-check applies server-side: `POST /ui/relay` fetches `barter-bank.json` for the target and compares its pubkey to `envelope.to`, refusing to forward on mismatch (`-32013`, §7.6). The relay is a dumb authenticated pipe — it cannot forge or mutate a client-signed envelope.
- Self-validating payloads (`barter://` invite, `barterdeal:` token) are verified before **any** RPC; a tampered link triggers zero network calls and zero side effects (§6.6, §8.17).

### 10.4 Signed-request authentication

- Every per-user custom call uses one scheme: an `X-Barter-Auth` header carrying an ed25519 signature (by the user's key) over a compact authdoc binding `method`, `path`, `id` (ULID, replay-windowed), `ts` (±120 s skew), and `body_sha256` (§7.2). This reuses the protocol's signing primitive, so the SPA has one signer code path and the bank gets the same replay protection as `/rpc`.

### 10.5 Anti-harvesting and operator risk

- `GET /ui/keystore/:handle` is **rate-limited** (≈ 5/handle/min, 30/IP/min; §11) — the only defense against online blob/handle harvesting. It does not weaken the offline guarantee, which rests on the KDF cost alone.
- A **malicious bank operator** could ship key-stealing JS; this is fundamental to any web-served key UI. Mitigations: vendored + SRI-pinned bundle and a published CSP make a bad bundle **detectable** by auditors, and the **no-server-backup / ephemeral** mode (§4) lets a distrustful user keep their own mnemonic so the operator never holds even ciphertext. Trust remains social, per the protocol.

### 10.6 Settlement risk is real and social

- The UI surfaces, but does not hide, the **lead/follow** risk: a lead party moves before the follower's bank proves it will reciprocate, and v1 has **no protocol-level timeout or rollback** (§9.3, §9.6). Stuck deals surface a "Pending — contact counterparty" state and the manual **Nudge / relay** path; recourse is social.

## 11. Polling, Cadence & Caching

Because `subscribe` (push) is optional in v1, the UI is polling-first. All refresh, poll, cache, and rate-limit constants live **here**; every other section references these rather than restating numbers. Implementations MAY tune them, but the relationships (in-flight deals poll fastest; balances slower; discovery is server-cached; everything pauses when hidden) are the contract.

| What | Cadence | Notes |
|---|---|---|
| **Deal / record signatures** (in-flight) | poll `get_record_signatures` (or `GET /ui/deal/:deal_id`) every **2–3 s** | drives the deal stepper (§8.14, §9.6); relaxes/stops once every record is `settled` or any is `rejected`. |
| **Balances / Wallet / Home** | refresh `get_account_balance` / `GET /ui/portfolio` every **15–30 s** while visible | shows `current` vs `pending`; cache TTL ≈ 10 s on `/ui/portfolio`. |
| **Discovery (foreground)** | `POST /ui/discover` on open and every **30 s** while the Marketplace is visible | backend serves from a **≈ 15 s** cache per `(bank, voucher, intention)`; `?refresh=1` forces a live poll. |
| **Discovery (background)** | every **5 min** for Offers touching the user's own Vouchers | powers the "new requests" badge. |
| **Activity / history** | `GET /ui/history` on open + manual refresh; tighter while a watched deal is in-flight | confirmed ledger; assembled from `get_record_signatures`. |
| **Visibility** | **pause all polling on `document.hidden`**, resume with an immediate fetch on focus | applies to every loop above. |
| **Push augmentation** | if a `Subscription` is registered, consume pushed signatures and **reduce** poll frequency | optional; never required for correctness (`bank-schema.md` §1.7). |

### Security-relevant rate limits and windows

| Control | Value | Owner |
|---|---|---|
| `GET /ui/keystore/:handle` rate limit | ≈ **5 / handle / min**, **30 / IP / min** | §7.1, §10.5 |
| Signed-request timestamp skew | **± 120 s** | §7.2 |
| Signed-request replay window | same sliding `(pubkey, id)` window as `/rpc` (`base.md` §4.1) | §7.2 |
| Auto-lock idle timeout (default) | **15 min** (configurable Off / 1 / 5 / 15 / 60 in Settings) | §4, §8.15, §8.18 |

## 12. Future Work

These are explicitly **out of scope** for this version of the UI. They are recorded here so the design leaves room for them, not because they are specified.

- **Direct messaging.** Person-to-person messages (e.g. between an issuer and a viewer of their profile landing). The issuer-profile landing (§6.3) reserves space for a future "message" affordance; v1 ships profile / invoice / cheque journeys only.
- **Voucher blogs.** A public, append-only feed an issuer can attach to their profile to announce vouchers and updates, surfaced on the issuer-profile landing. Reserved; not in this version.
- **Re-encrypt-to-Argon2id on availability.** When a keystore blob was created with the PBKDF2 fallback (Argon2id WASM unavailable at the time), offer to transparently re-encrypt under Argon2id once it loads (§4).
- **Opt-in encrypted per-user state.** A `prefs.encrypt_state` mode that stores `/ui/state` as a single client-encrypted sealed blob; this disables server-side fan-out using stored lists, so the SPA must then pass `trusted` / `banks` explicitly to the aggregation helpers (§7.3).
- **Key rotation & richer recovery.** Protocol-level key rotation and social/hardware recovery remain out of scope (v1 forever-keys); see [`TODOS.md`](./TODOS.md). The UI's recovery kit (§4) is the only recovery this version offers.
- **Cross-bank global discovery directory.** This UI polls the user's **known banks** (§6, §9.5 of the protocol); a federated bank directory is a separate, later track.

## Appendix A — Custom error-code registry

The custom layer reuses the **standard** JSON-RPC / protocol codes from `base.md` §4.2 with their standard meanings (`-32600` invalid request, `-32602` invalid params, `-32000` validation, `-32001` signature invalid, `-32002` replay, `-32003` lock conflict, `-32005` unknown doc). All **custom-specific** semantics use the reserved `-32006..-32099` range, registered once here. Every `/ui/*` endpoint and the UI's error/toast mapping (§8.18) reference these.

| Code | HTTP | Meaning | Raised by |
|---|---|---|---|
| `-32006` | 408 | Timestamp skew outside ± 120 s | signed-request auth (§7.2) |
| `-32007` | 403 | Signer pubkey not registered (where registration is required) | signed-request auth (§7.2) |
| `-32008` | 409 | Handle already taken | `POST /ui/register` (§7.1) |
| `-32009` | 409 | Pubkey already registered | `POST /ui/register` (§7.1) |
| `-32010` | 429 | Rate limited (e.g. keystore fetch) — body carries `retry_after` | `GET /ui/keystore/:handle` (§7.1) |
| `-32011` | 409 | Stale revision (optimistic-concurrency conflict on per-user state) | `PUT /ui/state` and sub-resource writes (§7.3) |
| `-32012` | 422 | Malformed pubkey / not valid base58 | `POST /ui/trusted`, contacts/banks writes (§7.3) |
| `-32013` | 409 | Pubkey pinning mismatch (`barter-bank.json` pubkey ≠ pinned / `envelope.to`) | `POST /ui/relay`, `GET /ui/resolve` (§7.6) |
| `-32014` | 502 | Upstream bank unreachable mid-operation | `/ui/relay`, `/ui/relay_signatures`, `/ui/propose_deal`, aggregation helpers (§7.4–§7.7) |

Standard JSON-RPC codes `-32700` (parse) and `-32603` (internal) are also surfaced unchanged where applicable. Aggregation/discovery endpoints prefer **HTTP 200 with a non-empty `unreachable[]` / `stale_banks[]`** over a hard failure when only some peers fail, so the SPA can render partial results (§7.4, §7.5).
