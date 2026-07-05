# barter.game — UI Specification

> This document specifies the **web UI** for barter.game v1.5. It is served by
> the bank, drives the protocol end-to-end in the browser, and adds a
> server-side API surface for backend calls the UI needs (encrypted-key store,
> doc submission, read views). It is **not** a protocol contract: the invariants
> live in `protocol/`. Anything here is an implementation choice on top of the
> protocol and may be changed without breaking the wire format.
>
> Companion docs to read first:
>
> - `protocol/README.md`, `protocol/base.md`, `protocol/bank-schema.md`,
>   `protocol/bank-rpc.md` — the contract the UI speaks.
> - `ETHOS.md §8` — "The CLI is the protocol's truest surface." The web UI is a
>   polish layer that reuses the same crypto, canonicalizer, and signing flow;
>   it never invents a hidden RPC.
> - `TODOS.md` — "Web UI (apps/web)" and "Browser key UX deep tune" are the
>   parent roadmap entries this spec realizes.

---

## 1. Goals and non-goals

### 1.1 Goals

1. A browser-only client that does everything the CLI does for the v1.5 user
   surface: connect with an existing keypair or create one, create Vouchers and
   Orders, maintain a trusted-issuer list, view balances / history / orders,
   discover Orders others have placed for the user's Vouchers, and produce
   shareable QR codes.
2. Private keys are **stored on the bank server, encrypted**. Decryption
   happens **only in the browser**; the passphrase / plaintext key never
   traverses the network.
3. A single shareable link works two ways: as a **landing page** for a regular
   browser, and as a **carrier of signed documents** for the webapp. Issuer
   profiles, invoices, and cheques all use this mechanism.
4. A clear registration path: scanning a friend's issuer-profile QR opens a
   landing page that invites the scanner to register and immediately adds the
   original issuer to the new user's trusted list.

### 1.2 Non-goals (explicitly deferred)

- **No messaging, no voucher blogs.** Out of scope for this version.
- **No new protocol methods.** The UI calls the existing JSON-RPC surface plus
  the new server-side API defined in §8. It does not extend the protocol
  contract.
- **No mobile native app.** The webapp is installable (PWA shell) but the same
  HTML+JS.
- **No key recovery.** Forgot passphrase → lose the keypair and its accounts
  (see `ETHOS §5`, `TODOS.md` "Account recovery"). This is documented in the
  UI, not papered over.
- **No server-side signing for users.** The bank never holds a decryptable user
  private key. It only stores ciphertext.

---

## 2. Architecture overview

```
┌─────────────────────────────────────────────────────────────────┐
│                          Browser (UI)                            │
│                                                                  │
│  ┌────────────┐   ┌──────────────┐   ┌────────────────────────┐ │
│  │ UI screens │──▶│  UI client   │──▶│ Protocol lib (browser) │ │
│  │ (HTML+JS)  │   │ (orchestrate)│   │ canonical, ed25519,    │ │
│  └────────────┘   └──────┬───────┘   │ Argon2id, sign/verify  │ │
│                          │           └────────────────────────┘ │
│                          │  HTTPS                                  │
│   passphrase ──▶ decrypts│  key in memory only; never sent       │
│                          ▼                                        │
└─────────────────────────────────────────────────────────────────┘
                           │
            ┌──────────────┴───────────────┐
            ▼                              ▼
   ┌────────────────────┐        ┌──────────────────────┐
   │ Bank UI API (new)  │        │ Bank JSON-RPC (v1)   │
   │ §8 — UI-only calls │        │ protocol/bank-rpc.md │
   │ encrypted key blob │        │ submit_docs, reads…  │
   │ landing pages, etc.│        │                      │
   └─────────┬──────────┘        └──────────┬───────────┘
             │                              │
             ▼                              ▼
        ┌────────────────────────────────────────┐
        │  Deno KV (bank-scoped, §protocol)      │
        └────────────────────────────────────────┘
```

### 2.1 Where logic lives

| Concern | Lives in | Rationale |
|---|---|---|
| ed25519 key generation | browser (`@noble/ed25519`) | The bank must never see the plaintext private key. |
| Passphrase → key (KDF) | browser (Argon2id via WASM, see §6.3) | Same. |
| Canonical JSON / signing | browser (`packages/protocol` compiled for the web) | Identical bytes to the CLI; cross-runtime parity must hold. |
| Encrypted-key storage | bank server (new UI API, §8) | Survives device loss; encrypted at rest with a key the server never has. |
| Doc submission / RPC signing | browser signs, then calls `/rpc` | Unchanged from the CLI. The UI just signs in JS instead of Node. |
| Read views (balances, offers) | bank server (existing `list_*` / `get_*` RPCs) | Same surface as the CLI. |
| Matchmaking (multi-party) | browser, in the UI's "Initiate deal" flow | The user IS the matchmaker when they assemble a deal from their own or others' Offers. |

### 2.2 Bank identity and pinning

The UI is served by exactly one bank — the bank whose URL the user opened. The
UI's first job on load is to fetch `<bank-url>/barter-bank.json`, display the
bank name and pinned pubkey, and store `{pubkey, url}` in `localStorage` (the
web equivalent of `~/.barter/profile.json`'s `defaultBankUrl`). Pubkey pinning
rules from `base.md §5.2` apply unchanged: a divergent `barter-bank.json` fails
closed.

---

## 3. Identity, sessions, and key storage

### 3.1 Two entry states

The UI opens in one of two states:

- **Anonymous / unauthenticated.** The user has no in-memory key. They see the
  landing flows (§7) and an auth screen prompting them to connect or register.
- **Unlocked.** A decrypted private key lives in a JS variable for the
  duration of the tab. Closing the tab clears it. There is no long-lived
  server session; the bank's UI API treats every call as stateless and
  identifies the user by the pubkey derived from the encrypted blob.

### 3.2 The encrypted-key record

The bank stores one record per user in Deno KV, scoped by the bank's pubkey as
every other key is:

```
[bankPubkey, "ui", "keystore", userPubkey] -> {
  user_pubkey:   Base58PubKey,            // ed25519 public key
  kdf:           "argon2id",
  kdf_params:    { m, p, t, salt_len },   // tunable, see §6.3
  salt:          Base58,                  // per-user random
  nonce:         Base58,                  // XSalsa20 / XChaCha20 nonce
  ciphertext:    Base58,                  // encrypted private key + metadata
  created_at:    ISO8601,
  updated_at:    ISO8601,
}
```

- `ciphertext` is `encrypt(key_material, key=KDF(passphrase, salt))`.
- `key_material` is canonical JSON of `{ privateKey, profile }` where `profile`
  holds UI-only state (default account, trusted issuers seed, display name).
  Trusted issuers are also queryable server-side (§8.4) so the landing-page
  registration flow can verify trust; the encrypted blob is the source of truth
  and the server-side index is a non-authoritative cache rebuilt on unlock.
- The bank has **no way** to recover the plaintext. Losing the passphrase
  means the record is unrecoverable; the user must re-register under a new
  keypair (the old pubkey's balances remain on the ledger but are inaccessible
  — the protocol has no key rotation in v1, per `ETHOS §5`).

### 3.3 Connect vs register

| Flow | Trigger | Steps |
|---|---|---|
| **Register** | "Create new account" button, or completing a landing-page invite | (1) Generate ed25519 keypair in browser. (2) Prompt for passphrase (twice). (3) Derive KDF key, encrypt `key_material`. (4) `POST /ui/keystore` with `{user_pubkey, kdf_params, salt, nonce, ciphertext}`. (5) Store decrypted key in memory; route to the screen the landing page requested. |
| **Connect** | "I already have a key" button | (1) Either import a base58 private key (paste / QR / file) **or** enter a passphrase to fetch and decrypt the existing blob. (2) For the passphrase path: `GET /ui/keystore/:pubkey` → derive key → decrypt → verify by re-deriving the pubkey from the decrypted private key and comparing. Mismatch = wrong passphrase; surface as "incorrect passphrase" with no leakage of whether the pubkey exists. (3) Store in memory; route home. |
| **Import raw key** | Sub-option of Connect | Accept a base58 private key, derive pubkey, optionally offer to store an encrypted copy on this bank for next time (calls Register's step 4). |

> **Privacy:** `GET /ui/keystore/:pubkey` returns a generic blob regardless of
> whether the pubkey exists, with the same byte shape, to avoid user-enumeration
> via timing or 404s. A "no record" is indistinguishable from a "wrong
> passphrase" failure to the caller; both yield the same error code.

### 3.4 Logout / lock

- **Lock** (explicit button or idle timeout): zero the in-memory key, return to
  the auth screen. Encrypted blob stays on the server.
- **Forget this device** (explicit): zero the in-memory key and remove the
  `localStorage` marker that offered one-tap unlock. The encrypted blob stays
  on the server; the user can reconnect from another device with the
  passphrase.

---

## 4. Navigation model

The UI is a single-page app with a small set of top-level destinations and a
left rail (desktop) / bottom tab bar (mobile). Every authenticated screen
shares a header showing the bank name, the user's truncated pubkey, and a
Lock button.

### 4.1 Top-level destinations

| Destination | Route | Purpose |
|---|---|---|
| **Home / Wallet** | `#/` | Balances across accounts, recent activity, quick actions. |
| **Vouchers** | `#/vouchers` | Vouchers the user issues + Vouchers they hold. |
| **Orders** | `#/orders` | Standing Orders the user has placed; marketplace discovery (§5.4). |
| **Trusted issuers** | `#/trust` | The user's trusted-issuer list; add/remove; generate issuer QR. |
| **Share** | `#/share` | Generate QR codes: issuer profile, invoice, cheque. |
| **History** | `#/history` | Transaction history across accounts. |
| **Settings** | `#/settings` | Bank info, pinned pubkey, export key, lock, forget device. |

### 4.2 Action elements (global)

- **Header:** bank name (links to `barter-bank.json` raw view), user pubkey
  chip (click → copy full pubkey), Lock button, theme toggle.
- **Floating action button (FAB):** "New" — opens a quick menu: *Create
  voucher · Place order · New invoice · New cheque · Share profile*.
- **Toasts:** transient feedback for every signing action ("Order submitted ·
  `<hash>`"), with a "View on ledger" link that opens the doc's hash in a
  read-only viewer.

### 4.3 Empty states

Every list screen has an empty state that explains what the thing is and offers
the primary action. Empty Vouchers → "You haven't issued any Vouchers yet.
Create your first." Empty trusted list → "Add issuers you know, or share your
own profile to let friends add you." These double as onboarding.

### 4.4 Deep linking and the hash router

All client state lives in the URL hash (`#/vouchers/<hash>`), so links are
shareable and the back button works. Landing-page flows (§7) parse the same
URL but in `pathname`/`search` so they work without JS bootstrap for crawlers
and QR scanners that just fetch HTML.

---

## 5. Screens — detailed

Each screen below lists: purpose, layout, action elements, data calls, and
behavior on success/error.

### 5.1 Auth screen (unauthenticated)

- **Purpose:** choose Register or Connect.
- **Layout:** centered card. Two primary buttons, a divider, then "I have a
  raw private key" (expandable). Below: a short "What is barter.game?" blurb
  with a link to the protocol README.
- **Action elements:**
  - *Create new account* → passphrase prompt (§3.3 Register).
  - *Connect with passphrase* → pubkey + passphrase prompt (§3.3 Connect).
  - *Import raw key* → base58 paste / file picker / QR scan.
- **Behavior:** on success, transition to the destination the URL requested
  (home, or the landing page's `next` target). On failure: generic error; no
  pubkey enumeration.

### 5.2 Home / Wallet (`#/`)

- **Purpose:** at-a-glance state of the user's positions.
- **Layout:**
  - Top: total "issued" vs "held" summary, computed client-side from the
    accounts list.
  - Grid of account cards: one per `(voucher, account)` the user holds, each
    showing voucher name, issuer chip, balance, and pending-hold amount.
  - Recent activity strip: last 5 settled transfers touching any of the user's
    accounts.
  - Quick actions: *New voucher · Place order · Share profile · Scan QR*.
- **Data calls:** `list_accounts` (own accounts + balances) for every bank
  the user has accounts at; the UI keeps a bank registry in `localStorage`
  and queries each, merging by ULID. (Cross-bank inbox aggregation — see
  `TODOS.md` — is realized here as multi-bank fan-out.)
- **Behavior:** tap a card → Voucher detail (`#/vouchers/<hash>`). Pull to
  refresh re-queries. Long-running polls refresh every 10s while the tab is
  visible (matches the polling cadence in `TODOS.md` "Cold-start warm-up").

### 5.3 Vouchers (`#/vouchers`)

Two tabs: **Issued by me** and **Held by me**.

#### 5.3.1 Issued by me

- **Purpose:** manage Vouchers the user is the issuer of.
- **Layout:** list of Voucher cards (name, bank chip, supply used vs `limit`,
  `due`/`expires` if set). Each card → detail view.
- **Action elements:**
  - *Create voucher* (also in FAB) → form (§5.3.3).
  - Per-Voucher: *Place order · Share as QR · Edit description*.
- **Detail view** (`#/vouchers/<hash>`): full Voucher doc, issuer info, all
  accounts that hold it (holders are identified by pubkey only — no names
  cross the bank boundary; the UI shows "holder `<truncated-pubkey>`"),
  recent transfers, outstanding Orders against it. A "View raw doc" expander
  shows the canonical JSON and hash.

#### 5.3.2 Held by me

- **Purpose:** Vouchers others issued that the user holds a balance in.
- **Layout:** cards with issuer chip (clickable → adds to a *pending trust*
  state, see §5.5), balance, and a "Place order to trade this" shortcut.
- **Behavior:** tapping "trust this issuer" moves them from pending to
  trusted and stores the decision in the encrypted profile (§3.2) and the
  server-side trust index (§8.4).

#### 5.3.3 Create voucher form

Fields map 1:1 to `Voucher` (`protocol/bank-schema.md §1.1`):

| Field | UI control | Notes |
|---|---|---|
| `name` | text input | "1 logo", "1 hour consulting". Required. |
| `description_md` | markdown textarea | Optional. |
| `image_svn` | image upload | Optional; cropped to square, inlined. |
| `due` | date picker | Optional ISO 8601 datetime. |
| `expires` | date picker | Optional. |
| `limit` | number input | Optional max supply. |
| `integer` | checkbox | Amounts must be integer. |

- **Behavior:** on submit, the browser builds the `Voucher` doc (pubkey =
  user, bank = pinned bank pubkey), signs it, and calls `submit_docs`. The
  first trade is what brings supply into existence — there is no *mint* step
  (`protocol/README.md §2`). The UI makes this explicit: "This Voucher has no
  supply yet. It comes into existence the first time you place a sell Order
  against it."

### 5.4 Orders (`#/orders`)

Two tabs: **My orders** and **Discover**.

#### 5.4.1 My orders

- **Purpose:** standing Orders the user has placed.
- **Layout:** list of Order cards: side(s), voucher chips, `rate`, `min`/`max`,
  `lead` flag, cumulative matched vs `debit_order_limit` / `credit_order_limit`
  if set, current state (open / exhausted / cancelled).
- **Action elements:**
  - *New order* (also in FAB) → form.
  - Per-Order: *Cancel*. Cancellation is mechanical (`ETHOS §5`,
    `bank-schema.md §1.4`): the UI creates a new Account with zero balance and
    points future debits there, or simply empties the debit account by
    transferring the balance to a sibling account. The UI explains this in
    plain language: "Cancelling moves your balance out of the debited account
    so the Order can no longer match."

#### 5.4.2 Discover

- **Purpose:** poll known banks for Orders/Offers against the user's Vouchers
  so they can discover interesting exchange requests.
- **Layout:** for each Voucher the user issues, a list of buy Offers (people
  wanting to acquire it) with their `rate`, `min`/`max`, and lead/follow.
  Filterable by counter-voucher.
- **Data calls:** `list_offers(voucher_hash, "buy")` at every known bank.
- **Action elements:** *Match* — opens the deal-initiation flow (§5.6) with
  the chosen Offer pre-filled as one side.

#### 5.4.3 New order form

Drives the full `Order` schema (`bank-schema.md §1.4`):

- **Type:** *Two-sided swap · Invoice (receive only) · Cheque (pay anyone)*.
  Selecting one hides the irrelevant side.
- **Debit side:** account selector (from the user's accounts of the chosen
  voucher), voucher selector, `min`, `max`.
- **Credit side:** symmetric.
- **Rate:** numeric `debit_amount / credit_amount`. Live preview shows the
  implied price both ways. For one-sided Orders the field is informational and
  locked at 1.
- **Limits:** optional `debit_order_limit`, `credit_order_limit`,
  `debit_account_limit`, `credit_account_limit`.
- **Lead / follow:** radio with a one-line explainer: "Lead = you settle first
  and carry the risk if the other party abandons. Follow = safer, but the deal
  only completes once the lead has settled." Defaults to *follow* for new
  users; the UI never lets both sides of a two-Order deal be `lead=false`
  (deadlock — see `coordinator-arbitrage.md` attack #8).
- **Behavior:** browser signs the Order, calls `submit_docs` with
  `publish_offers: [<order-hash>]` on every bank that issues a Voucher on
  either side (per `bank-rpc.md §4` step 1). Toast confirms with the Offer
  hash.

### 5.5 Trusted issuers (`#/trust`)

- **Purpose:** the user's personally-vouched-for issuer list. This is the
  social-trust substrate (`ETHOS §2`) made concrete.
- **Layout:** list of issuer cards: display name (a local label stored in the
  encrypted profile), pubkey chip, the Vouchers they issue, a "trusted on"
  timestamp. Search/filter by name or pubkey.
- **Action elements:**
  - *Add issuer* — by pubkey, by scanning a QR, or by accepting a pending
    suggestion from Held-by-me (§5.3.2).
  - *Remove* — moves them to a "previously trusted" history (kept locally so
    re-adding is one tap; not broadcast).
  - *Share my profile* — generates the issuer-profile QR (§7.1).
- **Storage:** trusted list lives in the encrypted profile blob (§3.2) and is
  mirrored to the server-side trust index (§8.4) so other users can verify
  "this pubkey is trusted by N people I also trust" without leaking the full
  graph. The index stores only `(truster, trustee, ts)` tuples; names and
  account details never leave the encrypted blob.

### 5.6 Deal initiation ("Initiate deal")

- **Purpose:** let the user act as matchmaker for a bilateral or N-party deal,
  reusing the orchestration recipe in `bank-rpc.md §4`.
- **Layout:** a transfer-builder. The user adds rows of the form "A gives X of
  Voucher V₁ to B" — each row becomes a debit/credit record pair. The UI
  validates the graph: every transfer has a debit account with sufficient
  balance (or the debiting holder is the issuer), rates are within every
  referenced Order's `rate`, and at least one holder is `lead`.
- **Action elements:**
  - *Add transfer · Add party · Validate · Submit*.
  - *Scan invite* — paste/scan a `barter://` invite string to pre-fill one
    side.
- **Behavior on Submit:** the UI runs the matchmaker sequence client-side:
  1. Ensure every referenced Account doc is submitted to its bank
     (`submit_docs`).
  2. Share Address docs between participating banks (`get_address` →
     `submit_docs`).
  3. `create_records` on each bank with the shared `deal_id`.
  4. Build per-bank `Confirm` docs, sign with the user's key, `submit_confirm`.
  5. Banks self-advance; the UI polls `get_record_signatures` and updates a
     per-record status panel (`ready → held → settled`).
- **Error handling:** if any `create_records` call fails, the UI does **not**
  retry blindly — it shows the failure with the bank's error code and offers
  "Abort (no records were settled)" or "Continue with remaining banks". A
  rejected record surfaces the `reject` signature's `reason`.

### 5.7 History (`#/history`)

- **Purpose:** transaction history across all the user's accounts.
- **Layout:** filterable, sortable table. Columns: time, voucher, counterparty
  pubkey, amount, deal id, state. Row click → deal detail with the full
  signature chain.
- **Data calls:** per-account record listings from each issuing bank; merged
  client-side by deal ULID.

### 5.8 Settings (`#/settings`)

- **Bank info:** name, pinned pubkey, canonical URL, fetched-vs-pinned
  comparison result, link to raw `barter-bank.json`.
- **Security:** change passphrase (decrypt with old, re-encrypt with new,
  `PUT /ui/keystore`), export raw private key (with a scary warning),
  Lock now, Forget this device.
- **Banks:** the list of known banks in `localStorage`; add/remove; pin a new
  bank by URL.
- **About:** protocol version, link to source, link to ETHOS.

---

## 6. Cryptography in the browser

### 6.1 Protocol library, unchanged

The UI bundles `packages/protocol` compiled for the browser. Canonical JSON,
ed25519 sign/verify, SHA-256, base58 — all the same code paths the CLI uses.
The cross-runtime parity guarantee (`packages/protocol/README.md`) extends to
the browser: a Voucher signed in the UI must verify under Bun and Deno.

### 6.2 Doc construction and signing flow

Every mutating action follows the same shape:

1. Build the doc object in JS (no `sig` field).
2. `hashDoc(doc)` → content hash, used for references and display.
3. `signDoc(doc, privateKeyBytes)` → base58 signature.
4. Attach `sig`, call the appropriate RPC (`submit_docs`, etc.).
5. On success, persist the doc in a local IndexedDB doc store (the web
   equivalent of `~/.barter/docs/`) so the UI can render history offline and
   re-derive hashes without a round-trip.

### 6.3 Passphrase-based key encryption

- **KDF:** Argon2id (the choice `TODOS.md` "Browser key UX deep tune"
  anticipated). Parameters are tunable per record and stored alongside the
  ciphertext so they can be raised over time. Defaults target ~100ms on a
  mid-range phone.
- **Cipher:** XChaCha20-Poly1305 (via a WASM build of libsodium), with a
  per-record random nonce. Authenticated encryption — a wrong passphrase fails
  the Poly1305 tag, which is the only "wrong passphrase" signal.
- **Verification:** after decryption, re-derive the pubkey from the recovered
  private key and compare to the stored `user_pubkey`. A mismatch is treated
  identically to a tag failure (defensive; should never happen if the record
  was written correctly).
- **Passphrase change:** decrypt with old, re-encrypt with new (new salt, new
  nonce), `PUT /ui/keystore`. The private key never leaves the browser.

### 6.4 Threat model (recap)

| Threat | Mitigation |
|---|---|
| Bank operator reads user private keys | Impossible — ciphertext only, KDF key never on server. |
| Attacker sniffs passphrase on the wire | Impossible — passphrase never leaves the browser; only ciphertext and the KDF output travel, and the KDF output is never sent. |
| Attacker steals the ciphertext blob and brute-forces | Argon2id with memory-hard params; rate limit on `GET /ui/keystore` (§8.3). |
| User forgets passphrase | Unrecoverable. Documented at register time with a checkbox. |
| XSS exfiltrates the in-memory key | CSP, no `eval`, subresource integrity on the WASM, and a short idle lock. The key lives in a closure, not a global. |
| Bank serves a tampered UI to steal the key | Out of scope for v1.5 (same trust posture as the CLI trusting its own binary); future work could pin the UI hash or load it from a separate static origin. |

---

## 7. Shareable links, QR codes, and landing pages

This is the load-bearing UX mechanism: one link that works as both a human
landing page and a machine-readable document carrier.

### 7.1 The unified link format

Every shareable artifact uses the same URL shape, served by the bank:

```
https://<bank-url>/<kind>/<id-or-hash>[?params]
```

where `<kind>` is one of `profile`, `voucher`, `invoice`, `cheque`, `invite`.

The link carries signed documents in **HTML metadata** so a single fetch
returns both a renderable page and a machine-parseable payload:

```html
<!doctype html>
<html>
  <head>
    <title>Alice · issuer profile</title>
    <meta name="barter.kind"        content="profile">
    <meta name="barter.version"     content="1">
    <meta name="barter.bank"        content="<bank-pubkey>">
    <meta name="barter.bank_url"    content="https://<bank-url>">
    <link rel="barter-doc"
          type="application/json"
          hreflang="barter"
          title="issuer-profile"
          href="/ui/doc/<profile-doc-hash>.json">
    <link rel="barter-doc"
          type="application/json"
          title="address"
          href="/ui/doc/<address-doc-hash>.json">
    <!-- one link per voucher the issuer publishes -->
    <link rel="barter-doc"
          type="application/json"
          title="voucher"
          href="/ui/doc/<voucher-doc-hash>.json">
  </head>
  <body>
    <!-- server-rendered landing page (§7.4); the webapp hydrates over this -->
  </body>
</html>
```

Design notes:

- **`<link rel="barter-doc">`** is the standards-inspired carrier. It mirrors
  how `<link rel="alternate">` and `<link rel="webmention">` announce
  machine-readable equivalents of a page. Crawlers and the webapp both follow
  these links to fetch canonical JSON docs by hash.
- **`/ui/doc/<hash>.json`** returns the raw, signed, canonical doc. The hash
  in the URL must match `hashDoc(doc)`; the bank returns `421 Misdirected` (or
  `404`) on mismatch — content addressing means the URL is self-validating.
- **`meta[name=barter.*]`** gives a scanner a one-shot summary without parsing
  links: kind, version, bank identity. This is what a QR-phone-camera flow
  reads first to decide whether to hand off to an app or show the landing page.
- The same HTML is returned regardless of who fetches it. A browser renders
  the landing page; the webapp (detected via a `Sec-Fetch-Dest` or a
  `?format=json` hint) may skip rendering and just harvest the `<link>`s.

### 7.2 QR code content

The QR encodes **the plain HTTPS URL** of the artifact — not a custom scheme.
This is deliberate:

- A phone camera opening an HTTPS URL always works: it shows the landing page.
- The barter webapp, registered as a handler for the bank's origin (via PWA
  URL handling) or invoked by a custom QR-scanner button inside the webapp,
  takes over and reads the metadata.
- We avoid `barter://` deep links for QR scanning because OS handling of
  custom schemes is inconsistent; an HTTPS URL is universally renderable and
  still carries everything via metadata.

(Existing `barter://` invite strings from `protocol/README.md §3` remain valid
for CLI-style OOB handoff and can be embedded *inside* an artifact page as a
`<meta name="barter.invite">` convenience, but the QR itself is the HTTPS
URL.)

### 7.3 Artifact kinds

| Kind | Path | Carries | Landing page (browser) | Webapp behavior |
|---|---|---|---|---|
| **profile** | `/profile/<user-pubkey>` | Address doc, issuer-profile doc, published Voucher docs | "Meet `<name>`. They issue `<vouchers>`. Register and add them to your trusted list." (§7.4) | Add issuer to trusted list; subscribe to their published Vouchers; offer to place a buy Order. |
| **voucher** | `/voucher/<voucher-hash>` | The Voucher doc, issuer profile link | "Get to know this Voucher. Trust the issuer to start accepting it." | Add to watched Vouchers; if issuer is trusted, offer to open an account and place an Order. |
| **invoice** | `/invoice/<order-hash>` | The invoice Order + derived Offer | "Pay this invoice: `<amount>` of `<voucher>` to `<issuer>`." | If holder of the debit voucher, initiate a one-step payment (cheque-side Order auto-created). |
| **cheque** | `/cheque/<order-hash>` | The cheque Order + derived Offer | "Cash this cheque: `<amount>` of `<voucher>` from `<issuer>`." | If trusted-issuer (or user confirms), accept the credit. |
| **invite** | `/invite/<invite-id>` | A `barter://` invite string + Account docs | "Alice offers X for Y. Accept the trade." | Pre-fill the deal-initiation flow (§5.6). |

### 7.4 Landing page behavior (regular browser)

The landing page is server-rendered HTML so it works with no JS and is
crawlable. It always shows:

1. The artifact's human description (issuer name and vouchers, or invoice
   amount, etc.).
2. The bank identity (`barter-bank.json` chip).
3. A primary call to action depending on detected state:
   - **Not registered at this bank:** "Register on `<bank-name>` to continue."
     The register flow (§3.3) runs, then the user is routed to the artifact's
     `next` target with the artifact pre-loaded.
   - **Registered but locked:** unlock prompt, then route to the target.
   - **Registered and unlocked (webapp open):** the page hydrates into the
     in-app view directly.

#### 7.4.1 The issuer-profile registration loop

This is the primary growth mechanic. Alice shares her profile QR. Bob scans
it with a phone camera:

1. Browser opens `https://<alice-bank>/profile/<alice-pubkey>`.
2. Landing page renders: "Alice issues *1 logo* and *1 hour consulting* on
   `<bank>`. Register to add Alice to your trusted list and start accepting
   her Vouchers."
3. Bob taps *Register*. The register flow creates Bob's keypair and encrypted
   keystore entry.
4. On success, the UI adds Alice to Bob's trusted list (§5.5) and opens a
   wizard: "You trust Alice. Want to open an account for *1 logo*?" → places
   a receiving Order if Bob agrees.
5. Alice now has a new holder; her next published Voucher is automatically
   acceptable to Bob.

The "add to trusted list" step is the registration reward: it makes the
social-trust graph grow with every share, consistent with `ETHOS §2`
(trust is local; the protocol formalizes it).

### 7.5 Webapp metadata extraction

When the webapp opens one of these URLs (via the in-app scanner, a paste, or
PWA URL handling), it:

1. Fetches the HTML.
2. Reads `meta[name=barter.*]` to confirm kind, version, and bank.
3. Follows every `<link rel="barter-doc">` to fetch the canonical JSON docs.
4. Verifies each doc's signature against its signer pubkey and its hash
   against the URL — the URL is content-addressed, so a tampered doc fails.
5. Offers the kind-specific action (§7.3 right column).

This satisfies the requirement: the same link is a landing page for a browser
and a document carrier for the webapp, with no separate "API mode" and no
custom URL scheme required for the QR.

---

## 8. Bank UI API (new)

This section defines the **new** server-side surface the UI needs, served by
the bank alongside the existing `/rpc` and `/barter-bank.json` endpoints. All
of it is implementation layer (`base.md §6` — custom API); none of it changes
the protocol contract.

### 8.1 Conventions

- All routes are prefixed with the bank name as today: `/<name>/ui/...`,
  consistent with `/<name>/rpc` and `/<name>/barter-bank.json`.
- Auth model: the keystore endpoints identify the caller by the `user_pubkey`
  in the path/body and rate-limit by IP + pubkey. They are **not** signed with
  the user's private key (the user is not yet unlocked); instead, the
  ciphertext itself is the bearer. Doc-submission and read endpoints that
  need authority still go through the signed `/rpc` envelope — the UI API does
  not duplicate signing authority.
- Errors use the same JSON shape as the RPC layer: `{ error: <code>, detail:
  <string> }`.

### 8.2 Encrypted keystore

| Method & path | Purpose | Body / response |
|---|---|---|
| `POST /<name>/ui/keystore` | Register a new encrypted key blob. | `{ user_pubkey, kdf, kdf_params, salt, nonce, ciphertext }` → `{ ok: true, user_pubkey }`. `409` if a blob already exists for `user_pubkey`. |
| `GET /<name>/ui/keystore/:pubkey` | Fetch the encrypted blob for passphrase-based unlock. | Returns the blob, or a **synthetic** blob of the same shape if none exists (anti-enumeration, §3.3). |
| `PUT /<name>/ui/keystore/:pubkey` | Replace the blob (passphrase change, re-encryption). | Requires proof of possession: the request must include a `replacement_sig` = `signDoc({user_pubkey, new_salt, new_nonce, ts}, oldPrivateKey)` proving the caller had the old key. This prevents an attacker who can hit the endpoint from overwriting a victim's blob without the key. |
| `DELETE /<name>/ui/keystore/:pubkey` | Wipe the blob. | Same `replacement_sig` proof-of-possession. The UI exposes this as "erase my encrypted key from this bank" — recoverable only by re-registering. |

> **Why the synthetic blob?** Pubkeys are public by design, so hiding whether
> one has a keystore entry is weak protection; but returning 404 for unknown
> pubkeys makes wrong-passphrase vs no-record trivially distinguishable. The
> synthetic blob forces both paths to the same client-side failure (Poly1305
> tag mismatch / pubkey mismatch), closing the enumeration oracle.

### 8.3 Rate limiting

- `GET /ui/keystore/:pubkey` is rate-limited per IP and per target pubkey
  (e.g. 10/min per IP, 5/min per pubkey). Brute-forcing Argon2id through this
  endpoint is impractical and the limit makes it slower still.
- All other UI endpoints inherit the bank's standard abuse controls
  (`README.md §1.1` — key-blocking, not gatekeeping).

### 8.4 Trust index (server-side cache)

The trusted-issuer list is stored encrypted in the user's keystore blob
(§3.2). For the landing-page flow to verify "this issuer is trusted by people
the scanner trusts", the bank maintains a **non-authoritative** public cache:

| Method & path | Purpose | Body / response |
|---|---|---|
| `GET /<name>/ui/trust/:trustee_pubkey` | How many (and optionally which) trusted-by-me pubkeys vouch for `trustee`. | `{ trustee, count, tristers?: [pubkey…] }`. The list is optional and opt-in per truster (stored in their encrypted profile). |
| `POST /<name>/ui/trust` | Add a trust edge. | Signed by the truster via `/rpc` `submit_docs`-style envelope; the bank updates the index only after verifying the signature. The trust doc is `type: "address"`-shaped (a signed attestation) — protocol-compatible. |

The encrypted blob remains the source of truth; on every unlock the UI
reconciles the cache by re-submitting trust edges that are missing. The cache
may lag; the landing page shows counts as "at least N".

### 8.5 Document serving (content-addressed)

| Method & path | Purpose |
|---|---|
| `GET /<name>/ui/doc/:hash.json` | Return the canonical signed doc stored at `hash`. `404` if unknown. `421` if the served doc's recomputed hash ≠ path hash (defensive; should never happen). |
| `GET /<name>/ui/profile/:pubkey` | Server-rendered issuer landing page + metadata links (§7.4). |
| `GET /<name>/ui/voucher/:hash` | Server-rendered voucher landing page + metadata links. |
| `GET /<name>/ui/invoice/:hash` | Invoice landing page + the invoice Order/Offer as `barter-doc` links. |
| `GET /<name>/ui/cheque/:hash` | Cheque landing page + the cheque Order/Offer as `barter-doc` links. |
| `GET /<name>/ui/invite/:id` | Invite landing page + the `barter://` string + Account docs as links. |

These complement (do not replace) the existing JSON-RPC reads in
`bank-rpc.md §2.4`. The RPC reads remain the path for authenticated,
holder-scoped queries (`list_accounts`, `get_account_balance`); the `/ui/doc`
path is the public, content-addressed, crawler-friendly path.

### 8.6 Aggregated read views

To avoid the UI fanning out to N banks for every screen, the bank may optionally
serve aggregated views scoped to the caller's pubkey:

| Method & path | Purpose |
|---|---|
| `POST /<name>/ui/views/balances` | Body: `{ pubkeys: [bank-pubkey…] }` for banks this bank knows about. Returns merged account balances for the signed-in user across those banks, fetched server-to-server using cached Address docs. Opt-in; falls back to client fan-out. |
| `POST /<name>/ui/views/offers` | Body: `{ voucher_hashes: […] }`. Returns matching buy/sell Offers across known banks. Powers the Discover tab (§5.4.2). |

These are convenience aggregators. They reuse the existing RPC methods
internally and add no new protocol authority.

### 8.7 Static UI hosting

| Method & path | Purpose |
|---|---|
| `GET /<name>/ui/app/...` | Static assets for the webapp (HTML, JS, CSS, WASM). Cacheable, subresource-integrity-pinned. |
| `GET /<name>/` (when `Accept: text/html`) | The app shell — server-rendered `<html>` that boots the SPA, or a landing page if the path matches a `/ui/<kind>/...` route. |

The bank serves the UI from its own origin so that bank identity and UI
identity share a TLS boundary and the `barter-bank.json` pinning applies to the
UI host too.

---

## 9. End-to-end flows (tying screens to API)

### 9.1 New user registers via a friend's profile QR

1. Alice generates her profile QR in *Share → Issuer profile*; the QR is
   `https://<alice-bank>/ui/profile/<alice-pubkey>`.
2. Bob scans with a phone camera; browser opens the URL.
3. Landing page renders server-side (§7.4); Bob taps *Register*.
4. Browser generates a keypair, prompts for passphrase, encrypts, `POST
   /ui/keystore`.
5. UI adds Alice to the trusted list (writes to encrypted profile, submits
   signed trust edge → `POST /ui/trust`).
6. Wizard offers to open an account for one of Alice's Vouchers and place a
   receiving Order; on accept, browser builds the Account + Order, signs, and
   `submit_docs` with `publish_offers`.
7. Alice's next published Voucher is now acceptable to Bob; the deal completes
   through normal advance.

### 9.2 Pay an invoice via QR

1. Alice generates an invoice QR in *Share → Invoice*; the QR is
   `https://<bank>/ui/invoice/<order-hash>`.
2. Bob scans with the webapp's scanner.
3. Webapp reads `meta[name=barter.kind]=invoice`, follows the `barter-doc`
   links, verifies signatures.
4. Webapp shows "Pay `<amount>` of `<voucher>` to Alice?" with Bob's debit
   account selector.
5. On confirm, the webapp creates Bob's cheque-side Order (one-sided),
   `submit_docs` with `publish_offers`, then drives the deal-initiation flow
   (§5.6) to pair the invoice Offer with Bob's cheque Offer via
   `create_records` + `submit_confirm`. The bank self-advances and settles.

### 9.3 Discover and match an Order

1. Carol opens *Orders → Discover*; the UI calls `list_offers(v, "buy")` at
   her known banks.
2. She sees Bob's buy Offer for her voucher at an attractive rate.
3. She taps *Match*; the deal-initiation flow opens with Bob's Offer
   pre-filled as one side and her sell side auto-suggested.
4. On Submit, the matchmaker sequence (§5.6) runs; the UI polls
   `get_record_signatures` and updates the per-record status panel until
   `settled`.

### 9.4 Connect with an existing key on a new device

1. Dan opens the bank UI on a new laptop; taps *Connect with passphrase*.
2. Enters his pubkey (or selects it from a previously-trusted list / pastes
   from a backup) and his passphrase.
3. `GET /ui/keystore/:pubkey` → synthetic-or-real blob.
4. Browser Argon2id-decrypts; Poly1305 tag verifies; pubkey re-derive matches.
5. Decrypted key lives in memory; Dan is routed home. His trusted list and
   profile come back from the decrypted blob.

---

## 10. Accessibility, i18n, and progressive enhancement

- **No-JS fallback:** landing pages (§7.4) are fully server-rendered and
  usable without JS. The auth-required app shell needs JS, but the public
  artifact pages (profile, voucher, invoice, cheque) do not.
- **Keyboard navigation:** every action is reachable via tab; the FAB menu
  opens on `?` and the command palette (Ctrl/Cmd-K) jumps to any destination
  or recent doc.
- **Screen readers:** all signing actions announce the doc hash and resulting
  state change; balances are announced as `aria-live` regions on poll.
- **Copy-friendliness:** every hash, pubkey, and signature has a one-tap
  copy button and a "view raw" expander showing canonical JSON. This honors
  `ETHOS §8` — the user can always see what is being signed.
- **i18n:** UI strings are externalized; the protocol field names
  (`Voucher.name`, etc.) are user content and never translated.

---

## 11. Open questions (deferred to implementation)

- **Argon2id parameters:** finalize `m`/`t`/`p` after benchmarking on the
  slowest target device. `TODOS.md` "Browser key UX deep tune" owns this.
- **PWA URL handling scope:** which origins the webapp registers to handle, to
  let the in-app scanner take over from the system browser cleanly. Browser
  support is still uneven; the QR is an HTTPS URL regardless, so the fallback
  is always "open in browser → land on the page → hydrate".
- **Trust-index privacy:** whether to surface truster pubkeys by default or
  only counts. Current spec: opt-in per truster.
- **Subscription wiring in the UI:** whether to expose `subscribe`
  (`bank-rpc.md §2.3`) for push-based signature delivery, or rely on polling
  for v1.5. Polling is simpler and matches the CLI's `barter status` posture;
  push is a v1.5 stretch.

---

## 12. Summary of changes to the bank

Implementing this spec requires the bank to add:

1. **Static UI hosting** under `/<name>/ui/app/...` and the app-shell route
   (§8.7).
2. **Encrypted keystore** (`/<name>/ui/keystore`, §8.2) backed by a new KV
   key prefix `[bankPubkey, "ui", "keystore", userPubkey]`.
3. **Trust index** (`/<name>/ui/trust`, §8.4) backed by
   `[bankPubkey, "ui", "trust", trusteePubkey] -> { count, tristers }`.
4. **Content-addressed doc serving** (`/<name>/ui/doc/:hash.json`, §8.5) — a
   thin read view over the existing `docs` KV space.
5. **Landing-page routes** (`/<name>/ui/profile|voucher|invoice|cheque|invite`,
   §8.5) that server-render HTML with `<link rel="barter-doc">` metadata.
6. **Optional aggregated views** (`/<name>/ui/views/...`, §8.6).

None of these alter the protocol contract in `protocol/`. They are all
custom-API surface explicitly permitted by `base.md §6`. A client that speaks
only the standard protocol (the CLI, a third-party implementation) is
unaffected.
