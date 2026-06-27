# barter.game — Web UI Specification

> **Scope:** browser-based HTML+JS client for barter.game v1. It is served as a static SPA by a bank and talks to that bank and to peer banks through the standard v1 JSON-RPC API, plus a small custom UI API defined in §6.
>
> **Out of scope for this version:** messaging between users, voucher blogs / feeds, automated matchmaking, push notifications, account recovery, key rotation, NFT-style vouchers, reputation.

---

## 1. Overview

The web UI is a **single-page application (SPA)** shipped as plain HTML+TypeScript (or a framework build that emits static files). The bank serves it under its canonical URL, so every bank can optionally host its own branded UI while remaining wire-compatible with every other bank.

The UI is a thin client over the protocol:

- All ledger authority still comes from signed `Voucher`, `Account`, `Order`, `Confirm`, `Signature`, and `Address` docs.
- All state-changing calls to banks use the standard signed JSON-RPC envelope defined in `protocol/base.md`.
- The bank **never** sees the user's private key in plaintext.

Primary user flows:

1. Onboard — create a new ed25519 keypair or import an existing one.
2. Back up the encrypted private key to the serving bank (encrypted in the browser).
3. Create vouchers, accounts, and orders.
4. Maintain a local list of **trusted issuers**.
5. Share and scan QR codes for issuer profiles, invoices, and cheques.
6. Check balances, transaction history, and current orders.
7. Poll known banks for public offers that match vouchers the user holds or trusts.

---

## 2. Security & key model

### 2.1 Principles

- The user's ed25519 **private key lives only in the browser JS heap** while the app is open.
- The private key is encrypted with a password-derived symmetric key **before** any server upload.
- The server stores only the opaque ciphertext; it cannot decrypt or derive the private key.
- The plaintext private key is **never** sent over the network in any request body, header, or URL.
- If the user forgets the encryption password, the backup is unusable and the identity is lost. There is no recovery flow in v1.

### 2.2 Key lifecycle

| Step | Behavior |
|---|---|
| Create new keypair | Browser generates a random 32-byte ed25519 seed with `crypto.getRandomValues`, derives the keypair, shows the user a base58-encoded private key / seed phrase to save offline, then encrypts the seed and uploads the ciphertext to the bank. |
| Import existing key | User pastes a base58 private key or a BIP39-style mnemonic; the browser derives the same keypair locally. |
| Load from bank | User enters their pubkey (or it is already in local config) and password. The browser fetches the encrypted backup from the bank, derives the AES key, and decrypts the seed locally. |
| Encryption | PBKDF2-SHA256 (or Argon2id-in-WASM if shipped) derives a 256-bit AES-GCM key from the password plus a random salt. The seed is encrypted; the resulting object contains `kdf`, `iterations`, `salt`, `iv`, `ciphertext`, `pubkey`. |
| Password change | Decrypt with old password, re-encrypt with new password, upload the new ciphertext (signed by the pubkey). The old ciphertext is overwritten. |
| Log out | Clear the in-memory key, session state, and any password-derived keys from `sessionStorage`. The encrypted backup remains on the server. |
| Forgot password | Show a hard warning: identity is unrecoverable. The only option is to create a new keypair, which starts a new ledger identity. |

### 2.3 Signing RPC calls

Every JSON-RPC request to a bank is signed with the user's private key using the standard envelope (`jsonrpc`, `id`, `method`, `params`, `pubkey`, `to`, `sig`) per `protocol/base.md`. The UI generates ULIDs for envelope ids and keeps a small local replay-window cache so it does not reuse a fresh `id` for a different request.

---

## 3. Browser storage

The UI keeps two tiers of state:

| Tier | Storage | Contents | Notes |
|---|---|---|---|
| Sensitive | JS heap only | Decrypted ed25519 seed, password-derived AES key. | Never persisted to disk. |
| Semi-sensitive | `localStorage` | Trusted issuers list, known banks list, user aliases, last selected bank, UI preferences. | Optional export/import as JSON. |
| Server | Bank KV | Encrypted key backup, submitted signed docs, ledger records, offers. | Docs are content-addressed; the UI can re-fetch anything by hash. |

`sessionStorage` may cache the decrypted key only if the user explicitly opts in to a "remember for this session" mode; by default the app asks for the password on every full reload.

---

## 4. Navigation & layout

### 4.1 URL structure

The bank mounts the SPA at:

```
https://<bank-host>/<bank-name>/ui[/<client-route>]
```

Examples:

- `/alice/ui` — dashboard
- `/alice/ui/wallet`
- `/alice/ui/issuer/<issuer-pubkey>` — issuer landing page
- `/alice/ui/invoice/<offer-hash>` — invoice landing page
- `/alice/ui/cheque/<offer-hash>` — cheque landing page

All non-asset paths under `/<bank-name>/ui/*` return `index.html`. Static assets are served from `/<bank-name>/ui/assets/*`.

### 4.2 Main navigation

On desktop: a left sidebar. On mobile: a bottom tab bar.

| Icon / Label | Route | Purpose |
|---|---|---|
| Dashboard | `/ui` | Balances, recent activity, quick actions. |
| Wallet | `/ui/wallet` | Vouchers, accounts, create voucher/order. |
| Orders | `/ui/orders` | My orders + discover offers. |
| Scan | `/ui/scan` | Camera/file QR scanner. |
| Settings | `/ui/settings` | Key, banks, trusted issuers, preferences. |

A top bar shows the current bank name, the user's pubkey alias, and a sync status indicator.

---

## 5. Screens, actions & behavior

### 5.1 Welcome / gate

Shown when no decrypted key is in memory.

**Elements:**

- App logo + bank name.
- "Create new keypair" button.
- "I already have a key" button.
- Small print: "Your private key is encrypted in the browser before touching the server."

**Behavior:**

- If a deep link was requested (e.g., `/ui/issuer/...`), the app stores the intended route and returns there after key setup.

### 5.2 Create new keypair

**Elements:**

- Password input (twice).
- Strength hint.
- "Generate" button.
- Recovery sheet modal showing the base58 private key and, optionally, a BIP39 mnemonic.
- Checkbox: "I have saved the recovery key."
- "Continue" button.

**Behavior:**

1. Generate seed + keypair.
2. Derive AES key from password, encrypt seed.
3. Sign the backup envelope with the new key.
4. `POST /<bank>/ui/api/key` to store the ciphertext.
5. On success, go to Dashboard.

### 5.3 Import / load existing key

**Elements:**

- Tabs: "Paste private key / seed phrase" and "Load encrypted backup from this bank".
- For import: textarea + password for future backup encryption.
- For load: pubkey input (auto-filled if known), password.

**Behavior:**

- Import path derives keypair, optionally uploads new encrypted backup if none exists.
- Load path fetches backup, decrypts; wrong password surfaces as an AES-GCM tag mismatch.

### 5.4 Dashboard

**Elements:**

- Total vouchers held (count) and net issuer balance (if issuer has gone negative).
- "Create voucher", "Create order", "Scan QR", "Show my QR" quick-action buttons.
- Recent activity list (last 5 records/deals).
- Sync button / last-sync time.

**Behavior:**

- On enter, refresh balances from every known bank (`list_accounts` + `get_account_balance`).
- Pull-to-refresh on mobile.

### 5.5 Wallet — vouchers & accounts

**Elements:**

- Segmented control: "My vouchers" / "My accounts".
- My vouchers list: voucher name, image thumbnail, issuing bank, limit, current issued/owed balance.
- My accounts list: voucher name, account name, bank, current balance, available balance (after holds).
- Floating "+" to create a voucher or account.

**Behavior:**

- Tapping a voucher shows detail, its issuer account, and a "Create invoice / cheque / trade order" button.
- Tapping an account shows history and open orders for that voucher.

### 5.6 Create voucher

**Elements:**

- Voucher name (e.g., "1 hour of consulting").
- Description (markdown).
- Optional square image (resized to data URL).
- Issuing bank selector (from known banks).
- Optional `limit` (max supply).
- `integer` checkbox.
- Optional `due` / `expires` dates.
- "Create" button.

**Behavior:**

1. Build and sign a `Voucher` doc (`type: "voucher"`, `bank: <selected bank pubkey>`, `pubkey: <user pubkey>`).
2. Build and sign an `Account` doc for the issuer's own holding of this voucher (default name "Issuer account").
3. Call `submit_docs` on the selected bank with both docs.
4. On success, show the voucher hash and offer:
   - "Create an invoice for this voucher"
   - "Create a cheque for this voucher"
   - "Share issuer profile QR"

### 5.7 Create order

**Elements:**

- Order type tabs: "Trade" (two-sided), "Invoice" (credit only), "Cheque" (debit only).
- For trade:
  - Debit side: choose account, amount min/max, order/account limits.
  - Credit side: choose target voucher (from trusted issuers or by hash), create an account if missing, amount min/max.
  - Rate (debit amount / credit amount).
  - `lead` toggle.
- For invoice: choose credit account, voucher, amount min/max, `lead` (usually false).
- For cheque: choose debit account, voucher, amount min/max, `lead` (usually true).
- "Publish as public offer" checkbox.
- "Create and sign" button.

**Behavior:**

1. Build and sign the `Order` doc.
2. Build any missing `Account` docs, signed by the user.
3. Call `submit_docs` on every bank referenced in the order, passing the Account docs and `publish_offers: [<order-hash>]` when requested.
4. If published, the bank returns the derived `Offer` hash; the UI shows it and offers a QR.

### 5.8 Orders — my orders & discover

**Elements:**

- Tabs: "My orders" / "Discover".
- My orders: list of signed Orders with type, vouchers, min/max, published offer hash, status.
- Discover:
  - Bank selector.
  - Voucher selector (from my accounts or trusted issuers).
  - Intention selector: "buy", "sell", "any".
  - "Poll" button and auto-poll toggle.
  - List of public `Offer` docs returned by `list_offers`.

**Behavior:**

- Tap an offer to see details and issuer. If the issuer is not trusted, show a warning banner.
- "Accept" on an offer starts the manual matchmaking flow: the UI asks the user to pick a matching order, then calls `create_records` and `submit_confirm` if both sides are present. (Full matchmaking UX is intentionally manual in v1.)

### 5.9 Trusted issuers

**Elements:**

- List of saved issuers: alias, pubkey (truncated), bank URL, known vouchers.
- "Add issuer" button.
- Add flow: scan QR, paste issuer profile URL, or enter pubkey + bank URL manually.
- "Import / export" buttons for the local trusted list.

**Behavior:**

- Opening an issuer profile link (§5.13) automatically adds the issuer after user confirmation.
- The trusted list filters discover results and suppresses warnings for vouchers from these issuers.
- Storage is local-only; the list travels with the browser profile.

### 5.10 My profile / issuer QR

**Elements:**

- User alias, pubkey, bank.
- Large QR code encoding the issuer profile URL.
- "Copy link", "Download QR", "Regenerate" buttons.
- Optional list of vouchers to feature in the profile.

**Behavior:**

- Before generating the QR, the UI signs an `Address` doc (`type: "address"`, `pubkey: <user>`, `url: <bank canonical URL>`) and submits it to the bank.
- The issuer profile URL points to `/<bank-name>/ui/issuer/<user-pubkey>`.
- The alternate JSON representation includes the signed `Address` doc and featured `Voucher` docs (§7.2).

### 5.11 Show invoice / cheque QR

**Elements:**

- Order summary.
- QR code encoding the invoice or cheque landing URL.
- "Copy link", "Download QR".

**Behavior:**

- The URL is `/<bank-name>/ui/invoice/<offer-hash>` or `/<bank-name>/ui/cheque/<offer-hash>`.
- The landing page (§5.14, §5.15) and the JSON alternate carry the signed `Offer` (or underlying `Order`) and the `Voucher` doc.

### 5.12 Scan QR

**Elements:**

- Camera preview with square reticle.
- "Upload image" fallback.
- Recent scanned links.

**Behavior:**

1. Decode QR → URL.
2. If the URL is a barter UI link, determine `link_type` from the path (`issuer`, `invoice`, `cheque`).
3. Fetch the JSON alternate (`Accept: application/vnd.barter+json`) to obtain signed docs.
4. Verify signatures locally, then route to the appropriate screen.

### 5.13 Issuer landing page

URL: `/<bank-name>/ui/issuer/<issuer-pubkey>`

**Elements:**

- Issuer alias (if known), pubkey, bank.
- List of featured vouchers with names and descriptions.
- Primary CTA:
  - If no session: "Join barter.game to trade with <issuer>" → key setup, then auto-add to trusted list.
  - If session: "Add <issuer> to trusted issuers".
- "Already have the app? Open in barter" deep-link button (just the same URL, handled by the PWA if installed).

**Behavior:**

- The server returns HTML for normal browsers and JSON for clients sending `Accept: application/vnd.barter+json`.
- After key setup, the app adds the issuer to `localStorage` trusted list and shows a confirmation toast.

### 5.14 Invoice landing page

URL: `/<bank-name>/ui/invoice/<offer-hash>`

**Elements:**

- "Pay <amount> <voucher-name> to <pubkey>".
- Voucher description / image.
- If no session: "Create a key to pay".
- If session:
  - If user has an account for the voucher: "Pay now".
  - If not: "Create account and pay".
- Trust warning if the invoice issuer is not in the trusted list.

**Behavior:**

- "Pay now" navigates to the create-order screen pre-filled as a matching cheque (debit-only order), or to a matchmaking screen if the user already has a suitable cheque offer.

### 5.15 Cheque landing page

URL: `/<bank-name>/ui/cheque/<offer-hash>`

**Elements:**

- "Deposit <amount> <voucher-name> from <pubkey>".
- If no session: "Create a key to deposit".
- If session:
  - If user has an account for the voucher: "Deposit now".
  - If not: "Create account and deposit".

**Behavior:**

- "Deposit now" navigates to a pre-filled invoice (credit-only order) that pairs with the cheque, or to the matchmaking screen.

### 5.16 Transaction history & deal detail

**Elements:**

- List of records grouped by `deal_id`.
- Each row: time, counterparty alias or pubkey, voucher, amount (signed), state chip (`created`, `ready`, `held`, `settled`, `rejected`).
- Tap to open deal detail.

**Deal detail:**

- Record bodies at this bank.
- Signature timeline.
- "Relay signatures" button: fetches signatures from the source bank (`get_record_signatures`) and pushes them to a peer bank (`notify_signatures`) — the manual recovery path.
- "Reject deal" button if the deal is pre-settled and the user is a holder.

**Behavior:**

- Uses `ui.list_records` and `ui.list_deals` (§6.2) to fetch records the user participates in.
- Polls every 15 seconds while the screen is visible.

### 5.17 Settings

**Elements:**

- Identity: alias, pubkey, bank.
- Security:
  - Change password (re-encrypt backup).
  - Export private key (warn: this reveals the key).
  - Delete encrypted backup from server.
- Data:
  - Manage known banks (add by URL, pin pubkey, remove).
  - Import / export trusted issuers.
  - Clear local data / log out.
- About: protocol version, UI version, bank info.

---

## 6. Backend API extension

The UI reuses the standard bank JSON-RPC API for all ledger operations (`submit_docs`, `create_records`, `submit_confirm`, `notify_signatures`, `get_record_signatures`, `list_accounts`, `get_account_balance`, `list_offers`, `get_voucher`, `get_address`, `subscribe`).

This section defines the **additional** surface a bank must expose to host the UI.

### 6.1 CORS

Because a user may open the UI on bank A but trade through bank B, every bank endpoint used by browsers must emit permissive CORS headers:

```http
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Accept, Authorization
```

Affected paths at minimum: `/barter-bank.json`, `/rpc`, `/address/*`, `/ui/api/key`, `/ui/api/key/*`, `/ui/docs/*`, `/ui/issuer/*`, `/ui/invoice/*`, `/ui/cheque/*`.

### 6.2 Static UI serving

All routes under `/<bank-name>/ui/*` are served by the bank:

| Route | Purpose |
|---|---|
| `GET /<bank-name>/ui` | Returns `index.html`. |
| `GET /<bank-name>/ui/*` (non-asset) | Returns `index.html` so the SPA router handles deep links. |
| `GET /<bank-name>/ui/assets/*` | Static JS, CSS, images, fonts with long cache headers. |

The bank may embed its canonical URL and name into `index.html` as a tiny config block or serve them via `/ui/api/config`.

### 6.3 UI config

```http
GET /<bank-name>/ui/api/config
```

Response:

```json
{
  "bank_pubkey": "<base58>",
  "bank_url": "https://<host>/<bank-name>",
  "bank_name": "alice",
  "protocol_version": "barter.game/v1",
  "ui_version": "1.0.0",
  "key_backup_enabled": true
}
```

### 6.4 Encrypted key backup

#### Store or replace backup

```http
POST /<bank-name>/ui/api/key
Content-Type: application/json
```

Body:

```json
{
  "pubkey": "<base58 user pubkey>",
  "kdf": "pbkdf2-sha256",
  "iterations": 250000,
  "salt": "<base64url>",
  "iv": "<base64url>",
  "ciphertext": "<base64url>",
  "sig": "<base58 ed25519 sig over canonical(body minus sig)>"
}
```

The bank verifies the signature against `pubkey`, then stores the ciphertext keyed by `pubkey`. It rejects malformed bodies or mismatched signatures.

Response:

```json
{ "ok": true, "pubkey": "<base58>", "updated_at": "2026-06-20T07:53:12Z" }
```

#### Fetch backup

```http
GET /<bank-name>/ui/api/key/<pubkey>
```

Response is the same backup object (without requiring authentication — the password is the protection). 404 if none exists.

#### Delete backup

```http
DELETE /<bank-name>/ui/api/key/<pubkey>
Authorization: Bearer <base58-sig-over-DELETE-path-and-timestamp>
```

or an equivalent signed POST endpoint. The bank verifies the signature before deleting.

### 6.5 Landing-page & carrier endpoints

These endpoints are **content-negotiated**:

- `Accept: text/html` (or missing) → human landing page.
- `Accept: application/vnd.barter+json` → machine-readable signed docs.

| Route | HTML purpose | JSON purpose |
|---|---|---|
| `GET /<bank-name>/ui/issuer/<issuer-pubkey>` | Invite a new user to register and add this issuer. | Issuer profile bundle: signed `Address` doc, featured `Voucher` docs. |
| `GET /<bank-name>/ui/invoice/<offer-hash>` | Show invoice terms and a pay button. | Signed invoice `Offer` / `Order`, plus `Voucher` doc. |
| `GET /<bank-name>/ui/cheque/<offer-hash>` | Show cheque terms and a deposit button. | Signed cheque `Offer` / `Order`, plus `Voucher` doc. |

The HTML always includes a `<link rel="alternate" type="application/vnd.barter+json" href="...?format=json">` pointing at the same path with a JSON query flag or `Accept` header.

Raw doc endpoint (used by the alternate link and by apps that already know the URL):

```http
GET /<bank-name>/ui/docs/<type>/<id>
Accept: application/vnd.barter+json
```

where `<type>` is `issuer`, `invoice`, or `cheque`, and `<id>` is the issuer pubkey or offer hash.

Example issuer JSON:

```json
{
  "link_type": "issuer",
  "version": "barter.game/v1",
  "pubkey": "<issuer-pubkey>",
  "bank": {
    "pubkey": "<bank-pubkey>",
    "url": "https://<host>/<bank-name>"
  },
  "docs": [
    { "type": "address", "pubkey": "<issuer-pubkey>", "url": "...", "ulid": "...", "sig": "..." },
    { "type": "voucher", "pubkey": "<issuer-pubkey>", "bank": "<bank-pubkey>", "name": "1 hour consulting", "ulid": "...", "sig": "..." }
  ]
}
```

### 6.6 New JSON-RPC read methods

The UI needs to list records and deals by holder/account. These are custom UI helpers in the `ui.*` namespace; they do not change standard method semantics.

#### `ui.list_records`

```json
{
  "method": "ui.list_records",
  "params": {
    "account": "<optional account hash>",
    "voucher": "<optional voucher hash>",
    "deal_id": "<optional deal ulid>",
    "state": "created|ready|held|settled|rejected",
    "limit": 50,
    "cursor": "<optional ulid>"
  },
  "pubkey": "<user pubkey>",
  "to": "<bank pubkey>"
}
```

Returns records at this bank where the caller is a participant (holder or issuer). Each item includes the record body and its anchored signatures.

#### `ui.list_deals`

```json
{
  "method": "ui.list_deals",
  "params": {
    "voucher": "<optional voucher hash>",
    "state": "created|ready|held|settled|rejected",
    "limit": 50,
    "cursor": "<optional ulid>"
  },
  "pubkey": "<user pubkey>",
  "to": "<bank pubkey>"
}
```

Returns deal groupings with the caller's records at this bank.

#### `ui.get_offer`

Convenience wrapper to fetch an `Offer` doc by hash, including the underlying `Order` if the bank chooses to expose it.

```json
{
  "method": "ui.get_offer",
  "params": { "hash": "<offer hash>" },
  "pubkey": "<any>",
  "to": "<bank pubkey>"
}
```

Custom errors use the range `-32006..-32099` per `protocol/base.md`.

---

## 7. QR / link carrier format

### 7.1 Design goals

- A QR code encodes only a short HTTPS URL.
- The same URL works in a regular browser (landing page) and in the barter webapp (machine docs).
- The signed documents are carried by the landing page, not by the QR, so QR capacity stays small and the docs can be updated server-side without re-printing the QR.

### 7.2 Standards-inspired mechanics

1. **Content negotiation** on the landing URL:
   - Browser → `text/html` landing page.
   - App → `application/vnd.barter+json` JSON bundle.
2. **HTML `<link rel="alternate">`** lets an app that opened the HTML still discover the JSON URL without re-requesting.
3. The JSON bundle is a small envelope containing the link type, the bank identity, and the signed docs. The app verifies each signature before acting.

### 7.3 URL patterns

```
Issuer profile: /<bank-name>/ui/issuer/<issuer-pubkey>[?vouchers=<hash1>,<hash2>]
Invoice:        /<bank-name>/ui/invoice/<offer-hash>
Cheque:         /<bank-name>/ui/cheque/<offer-hash>
```

The `vouchers` query parameter hints which vouchers to feature in the issuer profile JSON; the server may ignore or augment it.

### 7.4 HTML metadata example

```html
<meta name="barter:version" content="barter.game/v1">
<meta name="barter:link-type" content="issuer">
<meta name="barter:pubkey" content="<issuer-pubkey>">
<meta name="barter:bank" content="https://<host>/<bank-name>">
<link rel="alternate"
      type="application/vnd.barter+json"
      href="https://<host>/<bank-name>/ui/docs/issuer/<issuer-pubkey>">
```

### 7.5 App extraction flow

1. Decode QR → URL.
2. `fetch(url, { headers: { Accept: "application/vnd.barter+json" } })`.
3. Validate `version`.
4. Verify every doc signature with the protocol library.
5. Route to the appropriate UI screen.

If the fetch fails or signature verification fails, show a clear error: "This link does not contain a valid barter.game document."

---

## 8. Polling & refresh behavior

- Balances and history refresh on screen focus and on pull-to-refresh.
- Active deal-detail screens poll every 15 seconds.
- Discover screens poll on user action or at most every 30 seconds while visible.
- The UI throttles background polling when the tab is hidden.
- All network errors are surfaced non-modally with a retry button.

---

## 9. Out of scope (explicitly not in this version)

- Direct messaging between users.
- Voucher blogs, public feeds, or social timelines.
- Automated matchmaking / order matching engine.
- Push notifications (Web Push, WebSocket, SSE).
- Account recovery or key rotation.
- On-chain oracles, reputation, dispute resolution, stakes.
- Hardware wallet integration.
- Offline transaction creation (signing while offline is possible but submission requires network).

---

## 10. Implementation notes

- Use the same `@noble/ed25519`, `@noble/hashes`, `@scure/base` stack as the CLI/protocol library; it runs in the browser.
- Use Web Crypto (`crypto.subtle`) for PBKDF2 and AES-GCM; avoid non-standard crypto APIs.
- Bundle the protocol canonicalizer and validators from `packages/protocol/` so the UI produces byte-identical hashes and signatures.
- Keep the SPA static so it can be cached by a CDN and served cheaply by the bank.
- Do not store the decrypted private key in `localStorage` or cookies.
- Mark password fields with `autocomplete="new-password"` / `current-password` appropriately.
