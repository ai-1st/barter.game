# barter.game protocol — v1

A federated mutual-credit ledger. A deal is a chain of paired credit/debit
transfers — one or more holders moving promises among themselves across one or
more banks — completed via signed JSON-RPC, ending with every participating bank
agreeing on the new balances.

The simplest deal is bilateral: two holders at two banks swap. But the same
machinery covers a single holder moving value inside one bank, a three-party
ring (`A → B → C → A`), and arbitrarily complex multi-bank settlements. What
never changes: a deal is a set of credit/debit pairs, and one or more **lead**
holders hold first and settle first while everyone else follows. See §2.

This document is the protocol contract. Where it overlaps `packages/protocol/`
(canonical JSON, crypto, doc schemas, the wire envelope) the package is
authoritative and any divergence is a doc bug. The reference handlers in
`supabase/functions/` implement the full client-orchestrated N-party flow
(§7.1); the multi-party demo in `scripts/demo.sh` exercises it end to end.

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

## 2. Settlement model — lead, follow, and visibility

### Risk — lead and follow

A Tx settles as an ordered cascade, not a single atomic flip. Every Tx names a
**lead set** — one or more (holder, bank) — and the rest are **followers**. The
lead set holds first and settles first; each follower applies its own balance
change only after observing the signed `settle` of its predecessor(s) in the
transfer chain. The follower's own `settle` cites those upstream sigs in
`Signature.seen` (§5.6), so the cascade is a verifiable chain — every link
proves the prior link committed.

The lead set is whichever holders must move before anyone downstream can be
made whole. Three shapes:

- **Bilateral** (the degenerate case): one lead bank, one follow bank. The lead
  settles first; the follower settles once the client relays it the lead's
  `settle`.
- **Ring** (`A → B → C → A`): one lead breaks the cycle by settling first; the
  settle then propagates `B → C → A` until the ring closes.
- **Multiple leads**: when a node's inbound depends on more than one giver,
  *every* such giver must lead. For

  ```
  A → C      B → C      C → D      D → A      D → B
  ```

  C is made whole only once **both** A and B give, so the lead set is `{A, B}`.
  After A and B settle, C settles `C → D`, then D settles `D → A` and `D → B`,
  closing both cycles. No single party could safely lead alone — C's downstream
  move depends on two upstream settles.

If any downstream bank refuses to apply (compromise, malice, downtime), every
participant that already settled is out: their promises moved, the rest of the
chain didn't. The protocol accepts this risk because the trust model says the
lead party knows the operators personally. Leads choose to carry it; followers
choose to wait for upstream proof before moving.

**No protocol-level timeouts; no signed rollback docs.** The 24-hour
abandonment sweeper releases stuck locks for hygiene; it is not a
correctness mechanism.

### Visibility — every bank sees only its own legs

**No bank ever sees the whole transaction.** A bank sees only the transfers of
the promises *it issues* — "this much of my promise leaves holder X; this much
arrives at holder Y" — and nothing about the other legs.

This falls straight out of the issuer-authority rule (§5.3, §9): a transfer of
promise `P` lives entirely at `P`'s issuer bank (debit and credit are both
`P`-accounts there), and every record carries `pubkey = P`'s issuer bank. A bank
only ever holds, locks, applies, and signs records whose `pubkey` is its own.

The coordinator is therefore **the proposing client, not a bank.** The client is
the one party that legitimately knows the whole deal — it designed it — so it
builds the graph and hands each bank only that bank's slice:

- **Bodies it gets:** only the credit/debit records whose promise this bank
  issues.
- **Hashes it gets:** the Tx's full `records[]` list — but these are *hashes*.
  A bank needs them to recompute and verify the Tx hash (§5.5); it cannot invert
  a hash into another leg's amount, account, holder, or promise.
- **Routing it gets:** for the settle cascade, the pubkeys of its immediate
  **predecessor banks** (so it can verify their `settle` signatures, §5.6). It
  learns *that* a peer bank participates, not *what* that peer transfers.

What a bank can infer is bounded and deliberate: the number of legs (length of
`records[]`) and the identities of the banks directly upstream of it. It learns
nothing else. **Banks do not call each other during a trade** — the client
relays each signature to exactly the bank that needs it. (Discovery's
`bank_peers`, §10, is unused on the trade path under this model.)

Worked: in the multi-lead example above, A/B/C/D each issue their own promise at
their own bank. `bank-A` sees only `A → C` (its promise moving from A to C);
`bank-D` sees only `D → A` and `D → B`. `bank-A` never learns that B also paid
C, that C paid D, or what amounts flowed — only that the Tx has some number of
records and that, were it a follower, certain named banks settle before it.

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

A **transfer** is one debit + one credit of the same Promise for the same
`amount`: value leaves the debited holder's account and lands in the credited
holder's account, both at that Promise's issuer bank. `pair` links the two
halves. Transfers **chain** when the holder credited by one transfer is the
holder debited by another — that holder is passing value along (`A → B → C`). A
Tx is the full set of transfers in one deal; the chain may be a line, a ring,
or a general graph, spanning one bank or many.

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

`records` holds `2K` hashes encoding `K ≥ 1` transfer pairs (one debit + one
credit each). Cardinality is **open** — there is no two-bank cap:

- `K = 1`, one bank — a single transfer (gift, in-bank move).
- `K = 2`, two banks — the bilateral swap (the common case; the reference
  handlers optimize this path, §7.1).
- `K` pairs across `M` banks — rings and multi-party settlements.

A bank identifies the records it must act on as those whose `pubkey` equals its
own bank pubkey (each record's `pubkey` is set to the issuer bank of the
transferred Promise). A bank only holds, applies, and signs for its own
records; it relays the rest. Across the whole Tx, debits and credits per
Promise sum to zero by construction.

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

`seen` is the load-bearing field for multi-party settlement: a follower bank's
`settle` lists the upstream `settle` signatures it observed before applying its
own. That turns the flat lead→follow handoff into a verifiable settle chain —
each link proves the prior link committed, so a follower can refuse to move
until its predecessors demonstrably have. `action` `"lead"` / `"follow"` tag a
participant's role for the Tx; `"hold"`, `"approve"`, `"reject"` mark the other
phases.

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

The trade path is **client-orchestrated**: the proposing client calls every
method below on each participating bank directly, and relays signatures between
them. `envelope.pubkey` on the trade-path methods is the **proposing user**, not
a bank. Banks do not call each other (§2 Visibility). Read-only and account
methods keep their usual user→bank shape.

| Method | Caller | Side effect |
|---|---|---|
| `mint_promise(promise, pocket?)` | user → issuer bank | Store signed Promise + auto-Pocket + auto-Account (issuer's negative-balance row); sign bank attestation |
| `open_account(account, pocket?)` | user → issuer bank | Store holder-signed Account (and Pocket if supplied) so the holder can receive that Promise |
| `propose_leg(tx, records, proposer_approve, role, predecessors)` | client → each bank | Validate + persist the Tx (full hash list) and **only this bank's own records**; record role + predecessor banks; sign the bank's `approve` and return it |
| `hold_leg(tx_hash)` | client → each bank | Acquire holds on this bank's owned debit accounts for the Tx; sign + return the bank's `hold`. `-32003` on conflict |
| `confirm_receipt(tx_hash, user_confirm)` | holder → each bank they touch | Persist the holder's settle-action signature. The leg becomes `confirmed` once **every holder in this bank's own records** has signed |
| `settle_leg(tx_hash, upstream_settles)` | client → each bank, in topo order | Verify the leg is `confirmed` and every **predecessor** bank's `settle` is present + valid; apply this bank's deltas; release its holds; sign + return the bank's `settle` (with `seen` = the upstream sigs) |
| `reject_leg(tx_hash, reason)` | client → each bank | Release any holds this bank acquired for the Tx; mark its leg `rejected` |
| `get_promise(promise_hash)` | any → any | Return the Promise doc body |
| `get_account_balance(account_hash)` | user → issuer bank | Return current and pending balance |
| `list_accounts()` | user → bank | Return all accounts owned by the sender at this bank, with Promise bodies |

### 7.1 Orchestration & the per-bank slice

The proposing client builds the deal as a set of transfers (each: promise,
amount, debit holder, credit holder), then:

1. **Build** the `2K` records and the Tx (`records[]` = all record hashes). Sign
   a `proposer_approve` over the Tx hash.
2. **Slice.** For each participating bank, select only the records whose
   `pubkey` is that bank, compute its `role` (`lead`/`follow`) and its
   `predecessors` (the issuer banks of promises credited to this bank's
   debit-holders; empty for leads — leads break cycles by going first).
3. **propose_leg** on every bank with its slice; collect each bank's `approve`.
4. **hold_leg** on every bank; on any `-32003`, **reject_leg** everywhere and
   abort.
5. Wait for **confirm_receipt** from every holder (each holder signs once; the
   client delivers that signature to each bank where the holder appears).
6. **settle_leg** in topological order: leads first (`upstream_settles = []`),
   then each follower once the client holds valid `settle` sigs from all of its
   predecessors, passing them in as `upstream_settles`. The cascade ends when
   every bank has settled.

Because the client is the only holder of the full graph, no bank needs another
bank's records, URL, or even existence beyond its immediate predecessors. The
doc schemas (`Tx.records[]` is unbounded; `Signature.seen` carries the cascade)
and the wire envelope are unchanged from the bilateral case — only the
orchestration fans out.

---

## 8. State machine (per-Tx, per-bank)

Each bank runs its own state machine over its own legs, advanced entirely by
the proposing client's calls (§7.1). A bank never advances on a peer bank's
message — only on a client call carrying the proofs it needs. `held` waits for
the leg's holders to confirm; `confirmed` waits for the client to deliver
`settle_leg` with valid predecessor sigs.

```
   per-bank leg state (driven by the client; one machine per bank)

        propose_leg ──────────────▶ ┌──────────┐
        (client → bank, this                    │ approved │  leg persisted,
         bank's records only)                   └────┬─────┘  approve signed
                                                     │ hold_leg (client → bank)
                                                     ▼
                                                ┌──────────┐
                                                │   held   │  debit accounts locked
                                                └────┬─────┘
                              confirm_receipt from every holder in THIS leg
                                                     │
                                                     ▼
                                                ┌──────────┐
                                                │confirmed │  ready to apply
                                                └────┬─────┘
                          settle_leg(upstream_settles) — client supplies a valid
                          `settle` from each predecessor bank (none for a lead)
                                                     │
                                                     ▼
                                                ┌──────────┐
                                                │ settled  │  deltas applied,
                                                └──────────┘  holds released,
                                                              `settle` signed (seen=upstream)

   The client sequences these across banks in topological order: leads reach
   `settled` first, then each follower once its predecessors' `settle`s are in
   hand. If a follower's bank refuses, upstream banks are already `settled`
   with no rollback — the lead/follow risk (§2). `reject_leg` ends a leg from
   any pre-`settled` state and releases its holds.
```

---

## 9. Concurrency

### Double-spend prevention

When a bank receives `hold_leg` for one of its owned debit accounts, it
acquires a row in `holds` keyed on `(account_hash, tx_hash,
bank_pubkey)`. A **partial unique index** on `(account_hash, bank_pubkey)
WHERE active` enforces *at most one active hold per account*.

A concurrent hold attempt against an already-locked account returns
`-32003` (Postgres unique violation translated by the handler). The
coordinator then releases every hold acquired so far — across all
participating banks — and rejects the Tx. Holds span the full participant
set, but each per-account lock is independent and bank-local.

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

When a bank first hears from a peer it may record `(peer_pubkey, peer_url)`
in `bank_peers`. Under the client-orchestrated trade path (§2, §7) banks do
not call each other, so `bank_peers` is vestigial on the hot path in v1 — kept
for discovery and future bank-to-bank features.

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
| Coordinator pattern | **Client-orchestrated**: the proposing user calls each bank with its own slice and relays signatures; banks never call each other on the trade path |
| Visibility | Each bank sees only the records of the promises it issues + the Tx hash list + its predecessor bank pubkeys; no bank sees the full Tx |
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
| Account auto-creation | Receivers `open_account` before a trade; `propose_leg` requires the accounts in its records to already exist |
| Promise fungibility | Fungible: any "1 logo" issued by Alice is interchangeable; NFT-style is v2 |
| Tx cardinality | Open: `K ≥ 1` transfer pairs across 1..N banks; bilateral (`K=2`) is the simplest case |

---

## 13. What v1 does not do

- **No web UI.** CLI only. Web is v1.5.
- **No `barter doctor`.** Self-health-check command lands in v1.5.
- **No cross-bank inbox aggregation.** Each `barter inbox` hits one bank.
- **No automated multi-user confirm collection.** The client must reach each
  holder to gather `confirm_receipt` signatures; there is no push/notification
  layer (10s inbox polling only).
- **No NFT-like unique Promises.** Issued Promises are fungible.
- **No reputation, dispute resolution, or stakes.** Pure protocol; recourse is social.
- **No key rotation or recovery.** Forever-key in v1.
- **No automated settle-cascade retry.** If a downstream `settle_leg` fails,
  the client retries or the deal stalls with upstream legs already settled —
  the lead/follow risk (§2), resolved socially.

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
