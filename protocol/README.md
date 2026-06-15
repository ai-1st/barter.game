# barter.game protocol — README (v1)

> **Protocol overview.** This document explains the trust model, settlement model, core concepts, and the federated mutual-credit ledger architecture. For the strict invariant contract, see `base.md` (foundational primitives), `bank-schema.md` (banking document types), and `bank-rpc.md` (bank API, state machine, concurrency). For implementation guidance, see `IMPLEMENTATION.md`. For the canonical bilateral narrative, see `MASTER-INPUT.md`. For step-by-step interaction traces, see `scenarios/*.md`.

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

A deal executes in three waves: **ready → hold → settle**. Wave 1 (*direct approval*) is driven by the holders; waves 2 and 3 are driven by the **banks themselves** — banks self-advance as signatures arrive, and there is no client `hold` or `settle` call.

### 2.0 Three-wave execution model: ready → hold → settle

**1. Ready** — every holder whose accounts are touched by the deal must authorize their part of the deal by signing their own **Tx or Order**. Authorization is independent: Alice can authorize without waiting for Bob. A bank then validates those authorizations and issues a record-level `ready` signature on each of its own Records when it is prepared to proceed. Authorization can come from:

- A direct holder `lead` or `follow` signature on the holder's own **Tx**.
- A matching `Order` doc (bank-schema.md §5.7). When a holder is represented by an Order, the holder's bank issues `ready` on the matched Records on the holder's behalf, checking at ready time that the relevant accounts have sufficient free balance.
- A matching `Offer` doc (bank-schema.md §5.8) — a bank-issued derivation of an Order. The holder still signs the Tx that references the Offer.
- An invoice or cheque specialization of an Order or Offer (one side omitted, §5.7).

If a bank sees both a direct Tx signature and a matching Order/Offer for the same Records, either one satisfies the ready gate. For a `lead` Order/Offer, the holder signature may be omitted entirely; the bank executes on the Order/Offer alone.

A bank's records become **approved** once every Record it owns is bound to a valid authorization and carries the bank's per-record `ready`.

**2. Hold** — once all of a bank's records are `ready`, the bank locks the debit accounts among those records, issues record-level `hold` Signatures, and fans them out (§2.4). A bank holds when:

- any holder Tx touching its records is `lead`, **or**
- every holder Tx touching its records is `follow` AND every predecessor bank whose output those holders depend on has already issued `hold` signatures on its own records.

Holds are per-account and per-bank. A `-32003` conflict means some account is already locked by another in-flight deal; the bank retries on the next event. A client may call `reject` on individual records to abort them.

**3. Settle** — settlement is an ordered cascade of record-level signatures, not a single atomic flip:

- a **lead** bank settles first on its own records — but only once it has observed `hold` Signatures on the corresponding records from **every other bank in the deal**, so the whole graph is locked before anyone moves;
- a **follow** bank settles on its own records only after it has verified record-level `settle` Signatures from **every one of its predecessors**, and cites their hashes in its own settle's `Signature.seen` (base.md §5.6).

Settling means: apply the deltas of every owned record, release the holds, issue `settle` signatures, fan out.

> **Implementation note:** The v1 reference implementation calls `create_records` on each bank, then each holder builds their own Tx and calls `submit_tx` on every bank that owns records touching their accounts. `submit_tx` issues per-record `ready` (or `reject`) signatures. Once all its records are approved, the bank's advance engine issues `hold` and `settle` signatures automatically as preconditions are satisfied.

### 2.1 Authorization sources

A bank advances a record only when it has valid authorization — a holder-signed Tx or matching Order/Offer — for every **Record** (credit or debit) touching a holder's account. The authorization sources, in precedence order:

| Source | Signed target | Role implication |
|---|---|---|
| Holder's `lead`-action Signature | Tx | lead |
| Holder's `follow`-action Signature | Tx | follow |
| Matching Order with `lead=true` | Order | lead |
| Matching Order with `lead=false` | Order | follow |
| Matching `lead` Offer | Offer (referenced by the Tx) | lead; no holder signature required |
| Matching `follow` Offer | Offer (referenced by the Tx) | follow |
| Invoice specialization | Order or Offer with `debit` omitted | follow for the sender |
| Cheque specialization | Order or Offer with `credit` omitted | lead; unconditional debit authorized |

A bank MAY support only direct Tx signatures in v1; Order/Offer matching (including invoice/cheque specializations) are optional forward-compatible extensions. When multiple sources are present, any one suffices.

### 2.2 Risk — lead and follow

The lead set is whichever holders must move before anyone downstream can be made whole. Three shapes:

- **Bilateral** (the degenerate case): one lead bank, one follow bank. The lead settles first on its own records; the follower settles on its own records once the client relays the lead's record-level `settle` signatures.
- **Ring** (`A → B → C → A`): one lead breaks the cycle by settling first; the settle then propagates `B → C → A` until the ring closes.
- **Multiple leads**: when a node's inbound depends on more than one giver, *every* such giver must lead. For

  ```
  A → C      B → C      C → D      D → A      D → B
  ```

  C is made whole only once **both** A and B give, so the lead set is `{A's bank, B's bank}`. After they settle, C's bank settles `C → D`, then D's bank settles `D → A` and `D → B`, closing both cycles.

If any downstream bank refuses to apply (compromise, malice, downtime), every record that already settled stays settled: their promises moved, the rest of the chain didn't. The protocol accepts this risk because the trust model says the lead party knows the operators personally. Leads choose to carry it; followers wait for upstream proof before moving.

> **Invariant:** There is no protocol-level rollback mechanism and no protocol-level timeout. An implementation MAY add a sweeper that releases stuck holds for hygiene, but that is an implementation convenience, not a correctness mechanism.

### 2.3 Visibility — every bank sees only its own records

**No bank ever sees the whole deal.** A bank sees only the transfers of the promises *it issues* — "this much of my promise leaves holder X; this much arrives at holder Y" — and nothing about the other records.

This falls straight out of the issuer-authority rule (bank-schema.md §5.3, bank-rpc.md §9): a transfer of promise `P` lives entirely at `P`'s issuer bank (debit and credit are both `P`-accounts there), and every record carries `pubkey =` `P`'s issuer bank. A bank only ever locks, applies, and signs records whose `pubkey` is its own.

The **initiating client** is the one party that legitimately knows the whole deal — it designed it — so it builds the graph and hands each bank only that bank's slice:

- **Bodies it gets:** only the credit/debit records whose promise this bank issues.
- **Hashes it gets:** the record hashes in each holder Tx presented to it. These are opaque identifiers. A bank needs them to verify that its own records are included in each Tx; it cannot infer another record's amount, account, holder, or promise from a record hash alone.
- **Routing it gets:** for the settle cascade, the pubkeys of its immediate **predecessor banks** (so it can verify their record-level `settle` signatures, base.md §5.6). It learns *that* a peer bank participates, not *what* that peer transfers.

> **Invariant:** This visibility boundary is load-bearing. Any implementation that lets a bank see another bank's record bodies violates the protocol.

### 2.4 Signature fan-out — Subscriptions, push, and relay

Banks advance on **signatures**, wherever they come from. The delivery topology is the initiator's choice, expressed as **Subscription docs** (bank-schema.md §5.9) sent to the banks:

- **Bank-to-bank push** (the reference default): the initiator cross-subscribes the participating banks to each other's record signatures. When a bank creates a Signature matching a watched hash, it POSTs a bank-signed `notify_signatures` envelope to the subscription's URL, fire-and-forget.
- **Client relay** (the floor): signatures carry their own authority — signer pubkey plus an ed25519 signature over the doc — so *anyone* may deliver them. A client can read one bank's signatures (`get_record_signatures`) and hand them to another (`notify_signatures`). A lost push is recovered by relay; the system needs no reliable delivery.

Every received-and-verified signature re-evaluates the bank's advance engine for the records it touches. Banks never *depend* on calling each other; push is an optimization over relay.
