# barter.game protocol — v1

A federated mutual-credit ledger. Two parties at two banks complete a bilateral
trade via signed JSON-RPC, ending with both banks atomically agreeing on the
new balances.

This document is the contract. Implementations should reproduce its semantics
byte-for-byte; if it disagrees with `packages/protocol/`, the package wins,
and this doc is a bug.

---

## 1. Trust model

barter.game v1 assumes:

- **Users already know their counterparties.** Discovery is out of band
  (DM, in person, group chat). The protocol does not search for trading
  partners.
- **Trust is socially enforced.** If Alice delivers and Bob ghosts, Alice
  yells at Bob. The protocol records the deal cryptographically; it does
  not arbitrate.
- **Bank operators are accountable people.** Anyone can run a bank, but
  the bank's users have a real relationship with the operator. v1 has no
  bank-as-a-service for anonymous operators.

## 2. Risk model — lead and follow

Each Tx has a **lead** and a **follow** bank (and corresponding user roles).
The lead bank applies its balance change first. The follow bank applies its
own only after observing the lead's signed `settle`.

If the follow bank refuses to apply (compromise, malice, downtime), the
lead party is out: their promise moved, the counterparty's didn't. v1
accepts this risk because the trust model says the lead party knows
the follow bank's operator personally.

**No protocol-level timeouts; no signed rollback docs.** The 24-hour
abandonment sweeper releases stuck locks for hygiene; it is not a
correctness mechanism.

---

## 3. Identity

Every party — user or bank — is an ed25519 keypair. The pubkey is
base58-encoded and used as the identity in every doc.

- **User**: a person holding a private key (currently on disk in
  `~/.barter/profile.json`).
- **Bank**: an Edge Function process holding a private key via
  `BANK_<NAME>_PRIV_KEY` (Supabase Secrets in v1).

There is no separate "address" or "DID"; the pubkey IS the identity.

## 4. Canonical JSON (RFC 8785)

Every doc is signed over `SHA-256(canonical(doc))` where `canonical()` is
the JCS algorithm:

- Object keys sorted by Unicode code-unit order.
- Numbers serialized via ECMAScript `ToString(Number)` (negative zero →
  `"0"`).
- Strings escape control chars + `"` + `\`; other UTF-8 passes through.
- `undefined` keys dropped.

The reference implementation is `packages/protocol/src/canonical.ts`. It is
hand-rolled (no library dependency) to guarantee byte-identical output
across Bun, Node, Deno, and browser. The cross-runtime parity test is
the load-bearing test in the codebase.

When signing a doc, **the top-level `sig` field is removed** before
canonicalization. The hash that the signature commits to is therefore
content-addressed by the unsigned doc.

## 5. Document types

All docs share the `BaseDoc` shell:

```ts
type BaseDoc = {
  type: "promise" | "pocket" | "account" | "tx" | "credit" | "debit" | "signature";
  pubkey: Base58PubKey;   // owner / signer
  ulid: ULID;              // 26-char Crockford base32, generated at creation
}
```

Encoded fields:

- `Base58PubKey`, `Base58Signature`, `Base58SHA256` — base58 strings.
- `ULID` — `01ABC...` 26-char. Used as both identity and time ordering.
- `DateString` — `YYYY-MM-DD`.

The six concrete types:

### 5.1 Promise

A unit of value the `pubkey` owner promises to deliver.

```ts
Promise: BaseDoc & {
  type: "promise";
  bank: Base58PubKey;     // pubkey of the issuing bank
  name: string;           // "1 logo", "1 hour consulting"
  due?: DateString;       // optional maturity date
  limit?: number;         // optional max supply
  integer?: boolean;      // amounts must be integer; default float
}
```

**`bank` is part of the Promise hash.** Two promises with the same name
issued at different banks are different promises.

### 5.2 Pocket

A holder's logical grouping of accounts. Banks reference pockets only by
hash; the name is private to the holder.

```ts
Pocket: BaseDoc & {
  type: "pocket";
  name: string;           // local label, typically not public
}
```

### 5.3 Account

The issuer bank's record of a holder's stake in a given Promise. Banks
maintain balance and pending state per Account row.

```ts
Account: BaseDoc & {
  type: "account";
  pocket: Base58SHA256;   // hash of holder's Pocket doc
  promise: Base58SHA256;  // hash of the Promise this account holds
}
```

Account hash = `base58(sha256(canonical(account_doc)))`.

### 5.4 Record

One half of a paired credit/debit entry in the double-entry ledger.

```ts
LedgerRecord: BaseDoc & {
  type: "credit" | "debit";
  amount: number;         // positive
  account: Base58SHA256;
  pair?: Base58SHA256;    // hash of the peer record (v1: optional)
  tx?: Base58SHA256;      // hash of containing Tx (v1: optional)
}
```

`pair` and `tx` are optional in v1 because populating them creates a
circular hash dependency (Tx hashes the records that hash the Tx). The
Tx → record binding lives in `Tx.records[]` ordering, and the bank's
`txs` table tracks per-Tx state.

### 5.5 Tx

Groups records into a barter deal.

```ts
Tx: BaseDoc & {
  type: "tx";
  records: Base58SHA256[];   // ordered list of Record hashes
  order?: Base58SHA256;      // optional originating Order doc
}
```

**v1 cardinality cap**: `records.length === 4` (two transfer pairs across
two banks). N-bank trades are v2.

### 5.6 Signature

Attestations are first-class docs.

```ts
Signature: BaseDoc & {
  type: "signature";
  hash?: Base58SHA256;       // doc this signature refers to
  action?: "ack" | "approve" | "hold" | "settle" | "reject"
         | "lead" | "follow" | "timeout";
  seen?: Base58Signature[];  // prior sigs this one acknowledges
  reason?: string;
  sig?: Base58Signature;     // ed25519 sig over canonical(doc minus sig)
}
```

`pubkey` may be a user OR a bank. `action="settle"` signed by a user
means "I confirm receipt; you may settle." `action="settle"` signed by a
bank means "I have applied balances." Same word, different layer.

---

## 6. JSON-RPC envelope

All RPCs are `POST` to `<bank-url>/rpc` with this body shape:

```json
{
  "jsonrpc": "2.0",
  "id":       "<ulid>",
  "method":   "<method-name>",
  "params":   { ... },
  "pubkey":   "<sender pubkey>",
  "to":       "<recipient bank pubkey>",
  "sig":      "<base58 sig>"
}
```

- `id` is a ULID claimed in the recipient's replay window.
- `to` binds the request to this specific recipient. A peer bank with a
  different pubkey rejects the request even if the URL routes correctly.
- `sig` is `ed25519(sha256(canonical(envelope minus sig)))`, signed by
  the private key corresponding to `pubkey`.
- For user-facing methods, `pubkey` is a user pubkey. For inter-bank
  methods, `pubkey` is a bank pubkey.

### Replay protection

The recipient maintains a sliding window of seen `(sender_pubkey, id,
to)` triples in the `replay_window` table. A duplicate triple is rejected
with code `-32002`. The sweeper evicts entries older than 7 days idle
or beyond the per-sender LRU cap (currently 100 IDs).

### Error codes

| Code | Meaning |
|---|---|
| `-32700` | Parse error (body wasn't JSON) |
| `-32600` | Invalid request (envelope malformed) |
| `-32601` | Method not found |
| `-32602` | Invalid params |
| `-32603` | Internal error |
| `-32000` | Validation (doc shape, business rule) |
| `-32001` | Signature invalid (`to` mismatch, bad sig) |
| `-32002` | Replay (ULID already seen) |
| `-32003` | Lock conflict (concurrent hold on same account) |
| `-32004` | Timeout (reserved; not used in v1) |
| `-32005` | Unknown doc (referenced hash not in this bank's DB) |

---

## 7. Method surface

User-facing: caller is a user (`envelope.pubkey` is a user pubkey).
Inter-bank: caller is a bank (`envelope.pubkey` is a bank pubkey).

| Method | Caller | Side effect |
|---|---|---|
| `mint_promise(promise, pocket?)` | user → issuer bank | Store signed Promise + auto-Pocket + auto-Account (issuer's negative-balance row); sign bank attestation |
| `open_account(account, pocket?)` | user → issuer bank | Store holder-signed Account (and Pocket if supplied) for the holder to receive Promise transfers |
| `propose_trade(give, get, peer_pubkey, lead_bank_url)` | user → lead bank | Build 4 records + Tx, sign approve as lead bank, call `approve_trade` on peer, then `hold` on both banks |
| `approve_trade(tx, records, lead_bank_pubkey, lead_bank_url, lead_user_pubkey, peer_user_pubkey, lead_approve)` | lead bank → follow bank | Validate, persist, sign follow's approve |
| `hold(tx_hash, lead_hold)` | lead bank → follow bank | Acquire holds on follow's owned debit accounts, sign follow's hold |
| `confirm_receipt(tx_hash, user_confirm)` | user → own bank | Persist user's settle-action signature, forward to peer bank via `forward_confirm` |
| `forward_confirm(tx_hash, user_confirm)` | bank → bank | Persist a forwarded user confirm, update tx state to `confirmed` if both confirms now present |
| `settle(tx_hash)` | lead user → lead bank | Apply lead-bank balance deltas, release holds, sign lead settle, call `notify_settle` on follow |
| `notify_settle(tx_hash, lead_settle)` | lead bank → follow bank | Verify lead's settle sig, apply follow-bank balance deltas, release follow's holds, sign follow's settle |
| `reject(tx_hash, reason, bank_sig)` | bank → bank | Terminate the Tx; release locks if held |
| `get_promise(promise_hash)` | any → any | Return the Promise doc body |
| `get_account_balance(account_hash)` | user → issuer bank | Return current and pending balance |
| `list_accounts()` | user → bank | Return all accounts owned by the sender at this bank, with Promise bodies |

---

## 8. State machine (per-Tx, per-bank)

Each bank runs its own state machine. The lead bank advances the Tx
through every state; the follow bank waits at `held` until the user
confirms, then waits at `confirmed` until lead's `notify_settle`
arrives.

```
                propose_trade (user → lead bank)
                          │
                          ▼
                    ┌──────────┐
                    │ proposed │
                    └─────┬────┘
              lead bank: signs approve, calls approve_trade
              follow bank: validates, signs approve
                          │
                          ▼
                    ┌──────────┐
                    │ approved │   (both banks)
                    └─────┬────┘
              lead bank: hold local + call hold on peer
              follow bank: acquire locks, sign follow hold
                          │
                          ▼
                    ┌──────────┐
                    │   held   │   (both banks, locks active)
                    └─────┬────┘
              both users sign confirm_receipt (action="settle")
              forward_confirm cross-pollinates
                          │
                          ▼
                    ┌──────────┐
                    │confirmed │   (both banks have both sigs)
                    └─────┬────┘
              lead user calls settle (only valid on lead bank)
              lead bank: apply deltas, release locks, sign settle
                          │
                          ▼
                ┌───────────────┐
                │ settled(lead) │  ← if process dies here,
                └─────┬─────────┘    lead-only state may persist;
              lead bank: notify_settle to follow      that's the lead/follow risk
                          │
                          ▼
              follow bank: apply deltas, release locks, sign settle
                          │
                          ▼
                    ┌──────────┐
                    │ settled  │
                    └──────────┘

reject() may be called by either bank before settle, ending the Tx and
releasing any holds. There is no rollback after a partial settle in v1.
```

---

## 9. Concurrency

### Double-spend prevention

When a bank receives `hold` for one of its owned debit accounts, it
acquires a row in `holds` keyed on `(account_hash, tx_hash,
bank_pubkey)`. A **partial unique index** on `(account_hash, bank_pubkey)
WHERE active` enforces *at most one active hold per account*.

A concurrent hold attempt against an already-locked account returns
`-32003` (Postgres unique violation translated by the handler). The lead
bank then releases any holds it had acquired and rejects the Tx.

### Mutual-credit balance semantics

- **Issuers go negative.** Alice's account for her own Promise starts
  at `0`; after settling one outbound transfer, it sits at `-1`. The
  network owes the negative-balance side nothing; the holder owes the
  network nothing. Each side is accountable for their own ledger
  position.
- **No credit floor in v1.** Holders can run arbitrarily negative. The
  `Promise.limit` field is honored if set; otherwise unbounded.
- **Sum invariant**: across all accounts for a given Promise, balances
  always sum to zero (or the agreed limit). The bank enforces this on
  every `settle`.

---

## 10. Bank discovery + pubkey pinning

### Discovery

Banks publish their identity at:

```
GET <bank-url>/.well-known/barter-bank.json

→ {
    "pubkey": "<base58>",
    "url":    "<canonical bank URL>",
    "name":   "bank-alice",
    "protocol_version": "barter.game/v1"
  }
```

The `url` field is the canonical RPC URL — the location clients should
use, not necessarily the one they fetched from (banks behind reverse
proxies need this).

When a bank first hears from a peer, it records `(peer_pubkey, peer_url)`
in `bank_peers`. Used later to call the peer back during
`forward_confirm` and `notify_settle`.

### Pubkey pinning (security)

`.well-known` is **not a trust anchor**. A compromised DNS / hosting
provider could serve a different pubkey, and TOFU clients would be
fooled. v1 pins pubkey alongside URL everywhere trust is established:

- The client config map stores `{pubkey, url}` per bank.
- Invite strings carry `<pubkey>@<bank-url>` syntax (see §11).
- `.well-known` is fetched and *compared* against the pinned pubkey; if
  divergent, the operation fails closed.

In the v1 trust model the OOB channel that establishes the relationship
already conveys the pubkey, so pinning is cheap.

---

## 11. Invite strings

Trade invitations are exchanged OOB. The format:

```
barter://<inviter-pubkey>@<inviter-bank-url>?give=<promise-hash>:<amount>&get=<promise-hash>:<amount>&exp=<unix-seconds>&sig=<inviter-sig>
```

- `inviter-pubkey` (base58): the user proposing the trade.
- `inviter-bank-url`: full RPC URL.
- `give`: what the inviter offers (promise hash + amount).
- `get`: what the inviter wants in return.
- `exp`: Unix seconds; receivers reject after.
- `sig`: ed25519 over canonical JSON of the invite minus `sig`, by
  inviter's pubkey.

Self-validating: the receiver can verify the signature before any
network call. Tampering with give/get/bank-url invalidates the sig.

v1.5 wires `barter trade <invite>` to drive the full trade flow from
this string. v1 CLI takes the 8 hashes explicitly via flags; the invite
format is implemented but not yet on the trade command's hot path.

---

## 12. v1 design decisions, locked

| Decision | Resolution |
|---|---|
| Risk model | Lead/follow per legacy spec; no protocol-level rollback |
| Trust model | Counterparties already know each other; discovery OOB |
| Coordinator pattern | Caller-driven, lead-bank-led |
| Issuer authority | Issuer is sole source of truth for its Promise's balances |
| Concurrent holds | Rejected `-32003`; first-write-wins on per-Account lock |
| Lock abandonment | 24h sweeper releases stuck holds |
| Key recovery | Out of scope (lose key → lose account) |
| Key rotation | Out of scope; redeploy with new secret if compromised |
| Bank discovery | Hardcoded URL+pubkey config in client; federated directory is v1.5 |
| Canonicalization | Hand-rolled RFC 8785; cross-runtime golden vectors gate every release |
| Inbox notification | 10s polling; SSE/WebSocket deferred |
| Database | Supabase Postgres, multi-tenant via `bank_pubkey` column |
| Migration policy | v1 = no in-place migrations after launch (wipe demo banks if schema changes) |
| Account auto-creation | `approve_trade` creates Account if recipient hasn't `open_account`'d yet; pending until acknowledged |
| Promise fungibility | Fungible: any "1 logo" issued by Alice is interchangeable; NFT-style is v2 |
| Tx cardinality | Bilateral cap: 4 records spanning exactly 2 banks |

---

## 13. What v1 does not do

- **No web UI.** CLI only. Web is v1.5.
- **No `barter doctor`.** Self-health-check command lands in v1.5.
- **No cross-bank inbox aggregation.** Each `barter inbox` hits one bank.
- **No N-bank Tx.** Three-or-more-party barter is v2.
- **No NFT-like unique Promises.** Issued Promises are fungible.
- **No reputation, dispute resolution, or stakes.** Pure protocol; recourse is social.
- **No key rotation or recovery.** Forever-key in v1.
- **No automated forward_confirm retry.** Best-effort notification.

See `TODOS.md` for the v1.5+ roadmap.

---

## 14. Where to read the code

| Concern | Path |
|---|---|
| Canonical JSON | `packages/protocol/src/canonical.ts` |
| Crypto primitives | `packages/protocol/src/crypto.ts` |
| Doc schemas + validators | `packages/protocol/src/schemas.ts` |
| Invite format | `packages/protocol/src/invite.ts` |
| RPC envelope handler | `supabase/functions/_shared/bank/rpc.ts` |
| Per-method handlers | `supabase/functions/_shared/bank/handlers/*.ts` |
| Database queries | `supabase/functions/_shared/bank/db.ts` |
| Peer HTTP client | `supabase/functions/_shared/bank/peer.ts` |
| Bank bootstrap | `supabase/functions/_shared/bank/server.ts` |
| Method registry | `supabase/functions/_shared/bank/registry.ts` |
| CLI client wrapper | `apps/cli/src/client.ts` |
| Schema migrations | `supabase/migrations/*.sql` (see `SCHEMA.md`) |
| Live demo | `scripts/demo.sh` |
