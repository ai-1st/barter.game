# barter.game protocol — v1 (Invariant Contract)

> **This document is the protocol contract.** Every implementation of barter.game v1 MUST follow the rules in this file. Where it says "MUST," compatibility depends on it. Where it says "SHOULD," interoperability is smoother if you do. Anything not in this document is an implementation detail — you may change it.
>
> If you are building your own bank or client, read this file first, then see `IMPLEMENTATION.md` for how the reference team chose to build it. `SETTLEMENT_WALKTHROUGH.md` is the canonical narrative of one bilateral deal end to end.

A federated mutual-credit ledger. A deal is a chain of paired credit/debit transfers — one or more holders moving promises among themselves across one or more banks — completed via signed JSON-RPC, ending with every participating bank agreeing on the new balances.

The simplest deal is bilateral: two holders at two banks swap. But the same machinery covers a single holder moving value inside one bank, a three-party ring (`A → B → C → A`), and arbitrarily complex multi-bank settlements. What never changes: a deal is a set of credit/debit pairs, each holder authorizes their own view of it by signing **their own Tx**, and one or more **lead** banks settle first while everyone else follows. See §2.

### Core concepts: Promise, issuer, holder, bank

A **Promise** is a signed, content-addressed document in which one party (the **issuer**) commits to deliver a specific good or service — "1 logo," "1 hour of consulting," "a hand-drawn portrait." The Promise is bound to a single **bank** (an ed25519 keypair operating a ledger) that tracks every unit of that Promise issued, held, and transferred.

- **Issuer**: the owner of the Promise doc (`pubkey` field). The issuer decides what the Promise means, how many exist (`limit`), and when it matures (`due`). The issuer is personally accountable for redemption.
- **Holder**: any user with a positive balance in an Account for that Promise. Holders trade Promises among themselves; they are not accountable for the issuer's delivery, only for their own ledger position.
- **Bank**: the ledger operator whose pubkey appears in `Promise.bank`. The bank is the sole source of truth for balances of that Promise. It stores the docs presented to it, verifies signatures, and applies transfers. **The only artifacts a bank creates are ledger records and signatures.** It does not guarantee the issuer's performance — that trust is social, out-of-band.

A **transfer** moves a Promise from one holder to another. The debit holder's balance decreases; the credit holder's balance increases. The sum across all Accounts for a given Promise is always zero.

**Minting is a transfer too.** Issuing a Promise creates the first debit/credit record pair between two of the issuer's own accounts: the *issue* account goes negative, the *holding* account goes positive. There is no special mint balance logic — the same mechanism that moves value in trades creates it at mint.

---

## 1. Trust model

barter.game v1 is built on three behavioral assumptions. They are not enforced by cryptography; they are the social substrate that makes the protocol's risk posture coherent.

1. **Users already know the issuers of the Promises they hold.**
   Discovery is out of band — DM, in-person, group chat. The protocol does not search for trading partners, rate issuers, or verify delivery.

2. **Trust is socially enforced.**
   If Alice delivers and Bob ghosts, Alice yells at Bob. The protocol records the deal cryptographically; it does not arbitrate. Recourse is human, not algorithmic.

3. **Bank operators are accountable to their issuers.**
   Anyone can run a bank, but the issuers who route their Promises through it have a real relationship with the operator. An operator can erase its ledger or abort transactions — there is no cryptographic prevention — but it cannot forge a plausible alternative history alone, because every deal requires interlinked signatures from multiple independent parties.

### 1.1 v0 openness

Banks are open by default. The v1 reference posture:

- Banks allow minting **any** promise that references them.
- Banks accept new ledger records for new accounts and new promises; they only check that the promise references the bank.
- Banks accept and store any docs/signatures linked to promises that reference this bank, **from anyone** — the sender of a request need not be the doc's owner (counterparties legitimately carry each other's Account docs and relay each other's signatures).
- All calls to bank APIs are signed by the sender's key. Moderation is **key-blocking**, not gatekeeping: banks MAY refuse service to spammers and abusers based on their pubkey.

> **Extensibility:** Implementers MAY add additional trust, reputation, KYC, or audit mechanisms on top of the protocol. Such extensions MUST be backward-compatible: they must not prevent a client and bank from interacting using only the base v1 wire format.

---

## 2. Settlement model — direct approval, three waves, lead/follow

A deal executes in three waves: **approve → hold → settle**. Wave 1 (*direct approval*) is driven by the holders; waves 2 and 3 are driven by the **banks themselves** — banks self-advance as signatures arrive, and there is no client hold or settle call.

### 2.0 Wave 1 — direct approval

Each holder authorizes their own view of the deal:

1. The initiating client asks each participating bank to **create the ledger records** (`create_records`) — the bank is the sole creator of records; it assigns their ULIDs and the mandatory `pair` cross-references, and stores the client-supplied deal grouping key and settle topology alongside.
2. Each holder assembles **their own Tx** (§5.5): the ordered list of record ULIDs sitting on *their* accounts, possibly at several banks. Together the holder Txs of a deal partition its records exactly.
3. Each holder signs a Signature over their Tx hash — the **initiator with `action="lead"`**, every other holder with `action="follow"` — and the signed Tx is presented to every bank owning any of its records (`submit_tx`). Anyone may relay a signed Tx; the authority is the holder's signature, not the envelope sender.
4. For each record it owns in a submitted Tx, the bank **checks limits and validity and issues a per-record `approve` or `reject` Signature** (§5.6).

A holder's Tx signature is simultaneously their spend authorization (for their debits) and their **receipt confirmation** (for their credits) — there is no separate confirm step.

The v1 approve-time policy: credits always approve; a non-issuer debit requires `balance − active holds − amount ≥ 0`; an issuer debiting their own promise's account is bounded only by `Promise.limit` (if set). Authorization MAY alternatively come from a matching `Order` doc (§5.7); invoices and cheques are reserved for v1.5+.

A bank's **leg** of the deal becomes `approved` once every record it owns under the deal is bound to a holder-signed Tx and carries the bank's per-record `approve`.

### 2.1 Wave 2 — hold (bank-advanced)

When its leg is `approved`, the bank — on its own — locks the debit accounts among its records, signs a deal-level `hold` Signature, and fans it out (§2.4). Holds are per-account and per-bank; a conflicting in-flight deal leaves the leg `approved` and the hold is retried on the next event (§9.1).

### 2.2 Wave 3 — settle (bank-advanced, lead/follow)

Settlement is an ordered cascade, not a single atomic flip. Every deal names a **lead set** of banks; the rest are **followers**, each with a set of **predecessor** banks:

- a **lead** bank settles first — but only once it has observed a `hold` Signature from **every other bank in the deal**, so the whole graph is locked before anyone moves;
- a **follow** bank settles only after it has verified a deal-level `settle` Signature from **every one of its predecessors**, and cites their hashes in its own settle's `Signature.seen` (§5.6) — a verifiable chain in which every link proves the prior link committed.

Settling means: apply the deltas of every owned record, release the holds, sign `settle`, fan out.

The lead set is whichever banks must move before anyone downstream can be made whole. Three shapes:

- **Bilateral** (the degenerate case): one lead bank, one follow bank.
- **Ring** (`A → B → C → A`): one lead breaks the cycle; the settle propagates around it.
- **Multiple leads**: when a node's inbound depends on more than one giver, *every* such giver's bank must lead. For

  ```
  A → C      B → C      C → D      D → A      D → B
  ```

  C is made whole only once **both** A and B give, so the lead set is `{A's bank, B's bank}`. After they settle, C's bank settles `C → D`, then D's bank settles `D → A` and `D → B`, closing both cycles.

If any downstream bank refuses to apply (compromise, malice, downtime), every leg that already settled stays settled: their promises moved, the rest of the chain didn't. The protocol accepts this risk because the trust model says the lead party knows the operators personally. Leads choose to carry it; followers wait for upstream proof before moving.

> **Invariant:** There is no protocol-level rollback mechanism and no protocol-level timeout. An implementation MAY add a sweeper that releases stuck holds for hygiene, but that is an implementation convenience, not a correctness mechanism.

### 2.3 Visibility — every bank sees only its own legs

**No bank ever sees the whole deal.** A bank sees only the transfers of the promises *it issues* — "this much of my promise leaves holder X; this much arrives at holder Y" — and nothing about the other legs.

This falls straight out of the issuer-authority rule (§5.3, §9): a transfer of promise `P` lives entirely at `P`'s issuer bank (debit and credit are both `P`-accounts there), and every record carries `pubkey =` `P`'s issuer bank. A bank only ever locks, applies, and signs records whose `pubkey` is its own.

The **initiating client** is the one party that legitimately knows the whole deal — it designed it — so it builds the graph and hands each bank only that bank's slice:

- **Record bodies it gets:** only the credit/debit records whose promise this bank issues.
- **Tx ULID lists it gets:** the holder Txs presented to it contain record ULIDs from other banks — but these are *ULIDs*, not hashes. The bank cannot infer another leg's amount, account, holder, or promise from a ULID alone.
- **Routing it gets:** the deal grouping ULID, its own `role`, its `predecessors` (whose settles it must verify), and the deal's bank list (so a lead knows whose holds to await). It learns *that* peer banks participate, not *what* they transfer.

> **Invariant:** This visibility boundary is load-bearing. Any implementation that lets a bank see another bank's record bodies violates the protocol.

### 2.4 Signature fan-out — Subscriptions, push, and relay

Banks advance on **signatures**, wherever they come from. The delivery topology is the initiator's choice, expressed as **Subscription docs** (§5.8) sent to the banks:

- **Bank-to-bank push** (the reference default): the initiator cross-subscribes the participating banks to each other's deal signatures. When a bank creates a Signature matching a watched key, it POSTs a bank-signed `notify_signatures` envelope to the subscription's URL, fire-and-forget.
- **Client relay** (the floor): signatures carry their own authority — signer pubkey plus an ed25519 signature over the doc — so *anyone* may deliver them. A client can read one bank's signatures (`get_deal`) and hand them to another (`notify_signatures`). A lost push is recovered by relay; the system needs no reliable delivery.

Every received-and-verified signature re-evaluates the bank's advance engine for the deals it touches. Banks never *depend* on calling each other; push is an optimization over relay.

---

## 3. Identity

Every party — user or bank — is an ed25519 keypair. The pubkey is base58-encoded and used as the identity in every doc.

- **User**: a person holding a private key.
- **Bank**: a process holding a private key.

There is no separate "address" or "DID"; the pubkey IS the identity.

> **Invariant:** ed25519 + base58 encoding is mandatory for v1 interoperability.

---

## 4. Canonical JSON (RFC 8785)

Every doc is signed over `SHA-256(canonical(doc))` where `canonical()` is the JCS algorithm:

- Object keys sorted by Unicode code-unit order.
- Numbers serialized via ECMAScript `ToString(Number)` (negative zero → `"0"`).
- Strings escape control chars + `"` + `\`; other UTF-8 passes through.
- `undefined` keys dropped.

When signing a doc, **the top-level `sig` field is removed** before canonicalization. The hash that the signature commits to is therefore content-addressed by the unsigned doc.

> **Invariant:** Two implementations must produce byte-identical canonical JSON for the same document, or every signature becomes unverifiable across implementations. You MUST implement RFC 8785 (or equivalent JCS) and you MUST verify cross-runtime parity before claiming v1 compatibility.

---

## 5. Document types

All docs share the `BaseDoc` shell:

```ts
type BaseDoc = {
  type: "promise" | "pocket" | "account" | "tx" | "credit" | "debit"
      | "signature" | "order" | "subscription";
  pubkey: Base58PubKey;   // owner / signer
  ulid: ULID;              // 26-char Crockford base32, generated at creation
}
```

Encoded fields:

- `Base58PubKey`, `Base58Signature`, `Base58SHA256` — base58 strings.
- `ULID` — `01ABC...` 26-char. Used as both identity and time ordering.
- `DateString` — `YYYY-MM-DD`.

The eight concrete types:

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

**`bank` is part of the Promise hash.** Two promises with the same name issued at different banks are different promises.

> **Invariant:** The Promise schema fields and their types are fixed in v1.

### 5.2 Pocket

A holder's logical grouping of accounts. **Pocket bodies never leave the holder's machine** — banks reference pockets only by hash; the name is private.

```ts
Pocket: BaseDoc & {
  type: "pocket";
  name: string;           // local label, typically not public
}
```

> **Invariant:** A bank MUST NOT accept or store Pocket bodies. `Account.pocket` is an opaque hash to the bank.

### 5.3 Account

The issuer bank's record of a holder's stake in a given Promise.

```ts
Account: BaseDoc & {
  type: "account";
  pocket: Base58SHA256;   // hash of holder's Pocket doc
  promise: Base58SHA256;  // hash of the Promise this account holds
}
```

Account hash = `base58(sha256(canonical(account_doc)))`.

**Accounts are implicit.** There is no call to open an account: the holder authors the Pocket and Account docs locally, and the Account body travels with later requests (the `docs[]` parameter of any mutating call, an invite, a deal token). The bank stores what it is shown and creates the balance row — at zero — the first time the doc is presented. Minting requires **two** Account docs on **two distinct Pocket hashes** (the issue account and the holding account).

> **Invariant:** The issuer of a Promise is the sole source of truth for balances of that Promise. No other bank may issue or mutate accounts for a Promise it does not own.

### 5.4 Record

One half of a paired credit/debit entry in the double-entry ledger.

```ts
LedgerRecord: BaseDoc & {
  type: "credit" | "debit";
  amount: number;         // positive
  account: Base58SHA256;  // hash of the Account doc (still content-addressed)
  pair: ULID;             // ULID of the peer record — MANDATORY, set by the bank at creation
}
```

A **transfer** is one debit + one credit of the same Promise for the same `amount`: value leaves the debited holder's account and lands in the credited holder's account, both at that Promise's issuer bank. `pair` links the two halves by ULID. Transfers **chain** when the holder credited by one transfer is the holder debited by another — that holder is passing value along (`A → B → C`). The chain may be a line, a ring, or a general graph, spanning one bank or many.

Records are **bank-minted**: the bank assigns their ULIDs, sets `pair`, and ensures uniqueness. They are NOT content-addressed, and they carry **no Tx back-reference** — the binding direction is Tx → records (`Tx.records[]`). A bank MAY track which Tx bound each record internally.

Records are the atomic unit of bank approval: the bank issues its `approve`/`reject` Signature per record (`Signature.record`, §5.6). Holder authorization is at the Tx level — signing a Tx authorizes every record it lists.

### 5.5 Tx

A **Tx is a single holder's view of a barter deal**: "what am I giving and what am I getting?" `pubkey` is the holder; `records` are the bank-assigned ULIDs of the ledger records **on that holder's accounts**, in transfer order, possibly at several banks. The holder Txs of a deal partition its records exactly — each record appears in exactly one holder's Tx.

For example, if Alice and Bob exchange promises X (Alice's, at Xbank) and Y (Bob's, at Ybank):

- **ATx** binds the **debit of X** and the **credit of Y** in Alice's accounts — her view of the deal.
- **BTx** binds the **credit of X** and the **debit of Y** in Bob's accounts — his view.
- Xbank sees only that some X moved from one holder to another; it learns nothing about the Y side. Ybank sees the reverse.

```ts
Tx: BaseDoc & {
  type: "tx";
  records: ULID[];           // ordered list of record ULIDs touching this holder
  order?: Base58SHA256;      // optional originating Order doc
  // invoice?: Base58SHA256; // v1.5+ alternative authorization
  // cheque?: Base58SHA256;  // v1.5+ alternative authorization
}
```

A signed Tx — a holder's `lead`/`follow` Signature over the Tx hash — **is the authorization for the bank to execute the listed ledger records**. `Tx.pubkey` MUST own every account referenced by `records`; a bank rejects a Tx that lists a record sitting on someone else's account. A Tx may carry at most one of `order`, `invoice`, or `cheque` (alternative authorization sources, §5.7).

Cardinality is **open** — a holder's Tx lists however many records touch them, across however many banks the deal spans.

> **Invariant:** One Tx per holder is normative in v1. `Tx.records[]` is unbounded; any cap on banks or transfer pairs is an implementation limitation, not a protocol constraint.

### 5.6 Signature

Attestations are first-class docs. A signature with an `action` anchors to **exactly one** of three targets:

```ts
Signature: BaseDoc & {
  type: "signature";
  hash?: Base58SHA256;       // content-addressed target (a Tx hash, a Promise hash)
  record?: ULID;             // per-ledger-record target (bank approve/reject)
  deal?: ULID;               // leg-level target (hold / settle / reject)
  action?: "approve" | "reject" | "hold" | "settle"
         | "lead" | "follow" | "timeout";
  seen?: Base58SHA256[];     // hashes of upstream settle Signature docs
  reason?: string;
  sig?: Base58Signature;     // ed25519 sig over canonical(doc minus sig)
}
```

`pubkey` may be a user OR a bank. The action map:

| Action | Signer | Target | Meaning |
|---|---|---|---|
| `lead` | initiating holder | `hash` = their Tx hash | authorizes the Tx's records; accepts moving first |
| `follow` | every other holder | `hash` = their Tx hash | authorizes the Tx's records; doubles as receipt confirmation |
| `approve` / `reject` | bank | `record` = a record ULID | the bank's per-record limits/validity verdict |
| `approve` | bank | `hash` = a Promise hash | the bank's mint attestation |
| `hold` | bank | `deal` = the deal ULID | this bank's debit accounts are locked for the deal |
| `settle` | bank | `deal` = the deal ULID | this bank applied its records' deltas |
| `reject` | bank | `deal` = the deal ULID | this leg is dead; holds released |
| `timeout` | — | — | reserved for hygiene sweeps |

`seen` is the load-bearing field for multi-party settlement: a follower bank's `settle` lists the hashes of the upstream banks' `settle` Signature docs it verified before applying its own records. That turns the lead→follow handoff into a verifiable settle chain — every link proves the prior link committed.

> **Invariant:** `Signature.seen` carries the cascade proof. A follower MUST verify its predecessors' settle signatures before applying balances and MUST cite them in `seen`. The exactly-one-target rule for actioned signatures is protocol.

### 5.7 Order

A standing instruction that authorizes a bank to process matching **records** on the holder's behalf — an alternative to a per-deal Tx signature. Orders have no expiration; they remain valid as long as the holder maintains sufficient balance in the referenced accounts.

```ts
Order: BaseDoc & {
  type: "order";
  credit: Base58SHA256;     // account to credit (what the holder wants to receive)
  debit: Base58SHA256;      // account to debit (what the holder is willing to give)
  rate: number;             // debit_amount / credit_amount; must be positive
  min: number;              // minimum credit amount per matched record; prevents dust
  limit: number;            // maximum cumulative debit amount this order may generate
  lead: boolean;            // if true, holder authorizes lead role for matched records
  approvers?: Base58PubKey[]; // pubkeys whose signatures may substitute for the owner's
}
```

**Order-record matching.** A pair of records (credit + debit) matches an Order `O` when: the credit record's `account` equals `O.credit`; the debit record's `account` equals `O.debit`; debit ÷ credit equals `O.rate` (within the bank's documented rounding policy); the credit amount is ≥ `O.min`; and the cumulative matched debit does not exceed `O.limit`. If `O.lead` is false, the match only authorizes follow-role participation.

A matching Order substitutes for the holder's Tx signature in wave 1: the bank checks free balance and issues the per-record `approve` on the Order's behalf. A holder cancels an Order by emptying its `debit` account.

> **Invariant:** Order docs are first-class, content-addressed, and signed by the holder. A bank MUST verify the Order signature before treating it as authorization. The matching arithmetic MUST be deterministic and documented. (The v1 reference implementation validates Order docs but does not yet match them.)

### 5.8 Subscription

The initiating party's instruction to a bank: *push the Signature docs you create concerning these items to this URL.* This is how the initiator chooses the deal's delivery topology (§2.4).

```ts
Subscription: BaseDoc & {
  type: "subscription";
  records?: ULID[];        // watch keys matching Signature.record
  hashes?: Base58SHA256[]; // watch keys matching Signature.hash
  deals?: ULID[];          // watch keys matching Signature.deal
  url: string;             // http(s) endpoint to POST bank-signed notify envelopes to
  to?: Base58PubKey;       // delivery target behind url (defaults to the creator)
  until?: DateString;      // optional expiry; banks default one (reference: 7 days)
}
```

`pubkey` is the **creator** (who signs the request); `to` is the **delivery target** behind `url` — a peer bank or another party. At least one watch list must be non-empty. When the bank creates a Signature whose `record`/`hash`/`deal` matches a watch key, it POSTs a bank-signed `notify_signatures` JSON-RPC envelope (addressed `to` the target) to `url`.

Fan-out is **fire-and-forget**: no retry, no delivery guarantee, and a failed push never fails the originating request. Client relay (§2.4) is the recovery path.

> **Invariant:** The Subscription doc shape and the fire-and-forget semantics are protocol. Push timeout, SSRF hardening (https-only, no redirects), and per-subscriber caps are implementation details — but a bank MUST NOT let fan-out failures affect ledger state.

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
- `to` binds the request to this specific recipient. A peer bank with a different pubkey rejects the request even if the URL routes correctly.
- `sig` is `ed25519(sha256(canonical(envelope minus sig)))`, signed by the private key corresponding to `pubkey`.
- `pubkey` is a user pubkey on user-facing calls and a bank pubkey on fan-out pushes (`notify_signatures`).

### 6.1 Replay protection

The recipient maintains a sliding window of seen `(sender_pubkey, id, to)` triples. A duplicate triple is rejected with code `-32002`. The window MUST be large enough to tolerate out-of-order delivery and MUST be pruned to prevent unbounded growth.

> **Invariant:** The envelope shape, the `to` binding, and the replay-protection semantics are protocol. The exact window size, pruning policy, and storage backend are implementation details.

### 6.2 Error codes

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

> **Invariant:** These error codes and their meanings are part of the v1 contract. Custom codes MUST use the `-32006..-32099` range.

---

## 7. Method surface

Wave 1 is client-driven; waves 2–3 run inside the banks. Any mutating call MAY carry a `docs[]` array of supporting Promise/Account bodies — that is how implicit accounts come into existence (§5.3). Banks MUST NOT accept Pocket bodies in `docs[]`.

| Method | Caller | Side effect |
|---|---|---|
| **Issuance** |
| `mint_promise(promise, debit_account, credit_account, amount, docs?)` | issuer → issuing bank | Validate (promise references this bank; both accounts are the sender's, reference the promise, and use **distinct pocket hashes**; `integer`/`limit` respected). Store the docs, create the first debit/credit pair under a fresh deal ULID, and **settle it immediately** — single signer, single bank, zero counterparty risk. Sign per-record approvals, the mint-deal settle, and a promise attestation. |
| **Wave 1 — direct approval** |
| `create_records(deal, role, predecessors, banks, transfers, docs?)` | initiating client → each bank | Intake `docs`; validate each transfer (both accounts exist and hold the same promise issued here; positive amount; `integer` respected). Mint the debit/credit pairs with mandatory `pair` and the deal grouping key; store the leg topology (`role`, `predecessors`, full `banks` list); return the record bodies. Leg state → `created`. |
| `submit_tx(tx, holder_sig, docs?)` | any relayer → each bank owning records in `tx.records` | Verify `holder_sig` is a valid `lead`/`follow` by `tx.pubkey` over the Tx hash; every owned record must sit on an account owned by `tx.pubkey`, belong to one deal, and not be bound to a different Tx (idempotent re-submit allowed). Persist Tx + signature; bind records; issue per-record `approve`/`reject`. Leg → `approved` when every owned record under the deal is Tx-bound and approved; then the bank **self-advances** (§2.1–2.2). |
| **Fan-out** |
| `subscribe(subscription)` | creator → bank | Validate (§5.8; `subscription.pubkey` = sender); store the doc and its watch keys. |
| `notify_signatures(signatures)` | peer bank or any relayer → bank | Verify each signature against its signer pubkey; store the valid ones; re-run the advance engine for every deal they touch. Invalid entries are skipped, not fatal. |
| **Abort** |
| `reject_deal(deal, reason?)` | a deal participant → each bank | Caller must hold an account in the deal; refuse if the leg already settled. Release this bank's holds for the deal, sign a deal-level `reject`, fan out. Leg → `rejected`. |
| **Read-only** |
| `get_deal(deal)` | any → bank | Return the leg state, this bank's record bodies, and every signature anchored to the deal or its records. Used by follow parties verifying a deal token, by watchers, and by relaying clients. |
| `get_promise(promise_hash)` | any → any | Return the Promise doc body |
| `get_account_balance(account_hash)` | user → issuer bank | Return the current balance |
| `list_accounts()` | user → bank | Return all accounts owned by the sender at this bank, with Promise bodies |

### 7.1 Orchestration

The initiating client builds the deal as a set of transfers (each: promise, amount, debit holder, credit holder), generates the **deal ULID** (the grouping key), and computes the settle topology — `role` and `predecessors` per bank, plus the topological `order` (leads first; the lead set must break every cycle).

1. **create_records** on every participating bank with its own transfers, its slice of the topology, and any Account doc bodies the transfers need.
2. **Partition per holder**: each transfer's debit ULID goes to the giver's Tx, the credit ULID to the receiver's Tx. Build one unsigned Tx per holder.
3. **subscribe**: cross-subscribe the banks to each other's deal signatures (or pick another topology — §2.4).
4. **submit_tx** the initiator's own Tx, signed `lead`, to every bank owning its records.
5. Hand every other holder their unsigned Tx (plus the record bodies and bank URLs — e.g. a deal token, §11). Each verifies against the banks (`get_deal`), signs `follow`, and submits.
6. **The banks do the rest.** Watch with `get_deal`; if a push was lost, relay signatures by hand (`get_deal` → `notify_signatures`).

The deal ULID and the topology hints (`role`, `predecessors`, `banks`) are **unsigned orchestration keys**, not authority: every gate that moves money — Tx binding, per-record approvals, hold preconditions, settle proofs — flows from signed artifacts. A client lying about grouping or topology can only fragment or stall *its own* deal.

> **Invariant:** The method names, parameter shapes, and side-effect semantics above are the protocol. The exact HTTP client, retry policy, and how the client stores the deal graph are implementation details.

---

## 8. State machine (per-deal, per-bank leg)

Each bank runs its own state machine over its own leg of each deal. Wave 1 transitions happen on client calls; from `approved` onward the bank advances **itself**, re-evaluating on every event (a `submit_tx` completing approval, a verified signature arriving via `notify_signatures`).

```
   per-bank leg state (one machine per (deal, bank))

        create_records ───────────▶ ┌──────────┐
        (client; records minted,    │ created  │
         topology stored)           └────┬─────┘
                                         │ submit_tx × holders — every owned
                                         │ record Tx-bound + bank-approved
                                         ▼
                                    ┌──────────┐
                                    │ approved │  per-record approve sigs issued
                                    └────┬─────┘
                                         │ self: lock owned debit accounts,
                                         │ sign {deal, hold}, fan out
                                         ▼
                                    ┌──────────┐
                                    │   held   │  debit accounts locked
                                    └────┬─────┘
                  lead: hold sigs observed from every other bank in the deal
                  follow: verified settle sigs from every predecessor (→ seen)
                                         │ self: apply deltas, release holds,
                                         │ sign {deal, settle, seen}, fan out
                                         ▼
                                    ┌──────────┐
                                    │ settled  │  terminal
                                    └──────────┘

   reject_deal (participant) or an unmet approve gate ends a leg from any
   pre-settled state → `rejected` (holds released, deal-level reject signed).
   If a follower's bank never advances, upstream legs stay `settled` with no
   rollback — the lead/follow risk (§2.2).
```

> **Invariant:** These states, their transitions, and their preconditions are the protocol. The storage representation and the event loop that drives self-advancement are implementation details — but a bank MUST NOT settle without its lead/follow precondition met, and MUST NOT apply a leg's deltas twice.

---

## 9. Concurrency

### 9.1 Double-spend prevention

When a bank's leg reaches `approved`, it acquires a hold on each debit account among its records (summing when one account is debited several times in the deal). **At most one active hold per account** — a conflicting deal cannot lock the same account; the loser's leg simply stays `approved` and retries on the next event, or dies via `reject_deal`. Holds are bank-local and released on settle or reject.

The approve-time balance check (§2.0) is computed net of active holds, so a deal cannot be approved against balance that another in-flight deal has locked.

> **Invariant:** At most one active hold per account MUST be enforced. How (database unique index, mutex, optimistic locking) is an implementation detail.

### 9.2 Mutual-credit balance semantics

- **Issuers go negative.** Minting debits the issuer's issue account below zero; that negative balance *is* the outstanding supply. The network owes the negative side nothing; the holder owes the network nothing. Each side is accountable for their own ledger position.
- **No credit floor for issuers in v1.** An issuer's debt is bounded only by `Promise.limit` (if set). Non-issuer debits require sufficient free balance at approve time.
- **Sum invariant**: across all accounts for a given Promise, balances always sum to zero. The bank enforces this structurally — value only ever moves in debit/credit pairs.

> **Invariant:** The sum invariant is the load-bearing correctness guarantee of the ledger. Every implementation MUST preserve it on every settle.

---

## 10. Bank discovery + pubkey pinning

### 10.1 Discovery

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

The `url` field is the canonical RPC URL — the location clients should use, not necessarily the one they fetched from (banks behind reverse proxies need this).

Banks SHOULD maintain a cache of `(peer_pubkey, peer_url)` for banks they have heard from — subscription push (§2.4) delivers to URLs named in Subscription docs, and the peer cache supports verifying and replying to pushing banks.

### 10.2 Pubkey pinning (security)

`.well-known` is **not a trust anchor**. A compromised DNS / hosting provider could serve a different pubkey, and TOFU clients would be fooled. v1 pins pubkey alongside URL everywhere trust is established:

- The client config map stores `{pubkey, url}` per bank.
- Invite strings carry `<pubkey>@<bank-url>` syntax (see §11).
- `.well-known` is fetched and *compared* against the pinned pubkey; if divergent, the operation fails closed.

In the v1 trust model the OOB channel that establishes the relationship already conveys the pubkey, so pinning is cheap.

> **Invariant:** The `.well-known` format and the pinning semantics are protocol. How the client stores its config is an implementation detail.

---

## 11. Invites and deal tokens

Both OOB handoffs are self-validating signed strings: the receiver verifies the signature before any network call, and tampering invalidates it.

### 11.1 Invite strings

The inviter's offer:

```
barter://<inviter-pubkey>@<inviter-bank-url>
  ?give=<promise-hash>:<amount>:<account-hash>
  &get=<promise-hash>:<amount>:<account-hash>
  [&accs=<base64url(JSON Account bodies)>]
  &exp=<unix-seconds>&sig=<inviter-sig>
```

- `give`: what the inviter offers — promise, amount, and the inviter's **funded account** it will be debited from.
- `get`: what the inviter wants — promise, amount, and the inviter's **receiving account** (authored locally; accounts are implicit).
- `accs`: the bodies of the inviter's Account docs referenced by the legs, so the initiator can present them to the banks.
- `sig`: ed25519 over canonical JSON of the invite minus `sig`, by the inviter's pubkey.

### 11.2 Deal tokens

The initiator → follow-holder handoff, after records exist:

```
barterdeal:<base64url(canonical JSON of SignedDealToken)>

SignedDealToken = {
  pubkey:  <initiator>,
  deal:    <deal ULID>,
  tx:      <the recipient's UNSIGNED Tx body>,
  records: [<bodies of the records tx references>],
  banks:   [{ pubkey, url }],   // where to submit the follow-signed Tx
  exp:     <unix-seconds>,
  sig:     <initiator sig>
}
```

The recipient MUST verify the token signature **and** cross-check the record bodies against each bank (`get_deal`) before follow-signing — a token cannot lie about bank-minted records, because the banks are the source of truth.

> **Invariant:** Both formats, their fields, and their self-validating property are protocol. How the strings are conveyed (QR code, NFC, deep link, copy-paste) is an implementation detail.

---

## 12. Protocol design decisions, locked

| Decision | Resolution | Invariant? |
|---|---|---|
| Risk model | Lead/follow; no protocol-level rollback | **Yes** |
| Trust model | Counterparties already know each other; discovery OOB | **Yes** |
| Openness | v0 banks accept any docs tied to promises referencing them; moderation = key-blocking | **Yes** |
| Authorization | One Tx per holder; the holder's `lead`/`follow` signature over their Tx hash authorizes its records and confirms receipt — no separate confirm step | **Yes** |
| Bank approvals | Per ledger record (`Signature.record`), issued at `submit_tx` time | **Yes** |
| Coordinator pattern | Client drives wave 1; **banks self-advance** waves 2–3, observing each other via Subscription fan-out or client relay | **Yes** |
| Signature transport | Signatures carry their own authority; anyone may relay them; fan-out is fire-and-forget | **Yes** |
| Visibility | Each bank sees only the records of the promises it issues + opaque peer ULIDs + the deal's bank set and its predecessors | **Yes** |
| Issuer authority | Issuer's bank is sole source of truth for its Promise's balances | **Yes** |
| Minting | Mint = the first debit/credit pair between two issuer accounts on distinct pockets; settled immediately | **Yes** |
| Accounts | Implicit — created when the Account doc is first presented; no open_account call; Pocket bodies never reach a bank | **Yes** |
| Record `pair` | Mandatory, bank-set at creation; no Tx back-reference in the record body | **Yes** |
| Concurrent holds | At most one active hold per account; conflicting deals wait or reject | **Yes** |
| Key recovery | Out of scope (lose key → lose account) | **Yes** |
| Key rotation | Out of scope; redeploy with new secret if compromised | **Yes** |
| Canonicalization | RFC 8785 / JCS; cross-runtime golden vectors | **Yes** |
| Promise fungibility | Fungible: any "1 logo" issued by Alice is interchangeable; NFT-style is v2 | **Yes** |
| Deal cardinality | Open: any number of transfers, holders, and banks; bilateral is the simplest case | **Yes** |

---

## 13. What the protocol does NOT do

These are out of scope for v1. An implementation MAY add them, but they are not part of the barter.game v1 contract:

- **No web UI.** The protocol is transport-agnostic; a web UI is a client-layer concern.
- **No protocol-level rollback.** If a follow bank goes rogue after the lead settles, the lead is out. Recourse is social.
- **No guaranteed delivery.** Fan-out is fire-and-forget; client relay is the recovery path. There is no message queue in the protocol.
- **No key recovery, no key rotation.** Forever-keys in v1.
- **No NFT-like Promises.** Issued Promises are fungible.
- **No reputation, dispute resolution, or stakes.** Pure protocol; recourse is social.
- **No bank discovery directory.** Hardcoded URL+pubkey config is the v1 baseline; a federated directory is a v1.5+ extension.

---

## 14. Implementing barter.game

If you are building your own bank or client:

1. Read this file cover to cover. Everything here is the contract.
2. Read `SETTLEMENT_WALKTHROUGH.md` — the canonical bilateral narrative, doc snippets included.
3. See `IMPLEMENTATION.md` for how the reference team built it: Supabase, Edge Functions, Postgres, the CLI, and the specific file map.
4. See `SCHEMA.md` for the v1 reference database schema — useful as a starting point, but you may use any storage that enforces the invariants in §8–§9.
5. See `packages/protocol/src/` for the reference canonicalizer, crypto primitives, and schema validators. You may reuse this code directly (MIT) or reimplement in your language of choice.
