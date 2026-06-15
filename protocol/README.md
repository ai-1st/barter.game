# barter.game protocol — v1 overview

> **This directory is the protocol contract.** Every implementation of barter.game v1 MUST follow the rules in these files. Where it says "MUST," compatibility depends on it. Where it says "SHOULD," interoperability is smoother if you do. Anything not in these documents is an implementation detail — you may change it.
>
> If you are building your own bank or client, read this overview first, then see:
>
> - [`base.md`](./base.md) — identity, canonical JSON, `BaseDoc`, `Signature`, `Address`, the JSON-RPC envelope, replay protection, and request signing.
> - [`bank-schema.md`](./bank-schema.md) — bank document schemas (`Voucher`, `Account`, `Record`, `Tx`, `Order`, `Offer`, `Subscription`) and ledger semantics (state machine, concurrency, balance invariants).
> - [`bank-rpc.md`](./bank-rpc.md) — the bank JSON-RPC API and REST address-directory endpoints.
>
> `MASTER-INPUT.md` is the source-of-truth design narrative from the product owner; `scenarios/*.md` are step-by-step interaction traces. `IMPLEMENTATION.md` explains how the reference team built it.

A federated mutual-credit ledger enabling multi-party barter deals where parties issue Vouchers for their goods and services and exchange them with others. A deal is a chain of paired credit/debit transfers — one or more holders moving Vouchers among themselves across one or more banks — completed via signed JSON-RPC, ending with every participating bank agreeing on the new balances.

The simplest non-trivial deal is bilateral: two holders at two banks swap. But the same machinery covers a single holder moving value inside one bank, a three-party ring (`A → B → C → A`), and arbitrarily complex multi-bank settlements. What never changes: a deal is a set of credit/debit pairs, each holder authorizes their own view of it by signing **their own Tx**, and one or more **lead** banks settle first while everyone else follows.

### Core concepts: Voucher, Issuer, Holder, Bank

A **Voucher** is a signed, content-addressed document in which one party (the **Issuer**) commits to deliver a specific good or service — "1 logo," "1 hour of consulting," "a hand-drawn portrait." The Voucher is bound to a single **Bank** (an ed25519 keypair operating a ledger) that tracks every unit of that Voucher issued, held, and transferred.

- **Issuer**: the owner of the Voucher. The issuer decides what the Voucher means and how many may exist. The issuer is personally accountable for redemption.
- **Holder**: any user with a positive balance in an Account for that Voucher. Holders trade Vouchers among themselves; they are not accountable for the issuer's delivery, only for their own ledger position.
- **Bank**: the ledger operator whose pubkey appears in `Voucher.bank`. The bank is the sole source of truth for balances of that Voucher. It stores the docs presented to it, verifies signatures, and applies transfers. **The only artifacts a bank creates are ledger records and signatures.** It does not guarantee the issuer's performance — that trust is social, out-of-band.

A **transfer** moves a Voucher from one holder to another. The debit holder's balance decreases; the credit holder's balance increases. The sum across all Accounts for a given Voucher is always zero.

**Minting is a transfer too.** Issuing a Voucher creates the first debit/credit record pair between two of the issuer's own accounts: the *issue* account goes negative, the *holding* account goes positive. There is no special mint balance logic — the same mechanism that moves value in trades creates it at mint.

---

## 1. Trust model

barter.game v1 is built on three behavioral assumptions. They are not enforced by cryptography; they are the social substrate that makes the protocol's risk posture coherent.

1. **Users already know the issuers of the Vouchers they hold.**
   Discovery is out of band — DM, in-person, group chat. The protocol does not search for trading partners, rate issuers, or verify goods/service delivery.

2. **Trust is socially enforced.**
   If Alice delivers and Bob ghosts, Alice yells at Bob. The protocol records the deal cryptographically; it does not arbitrate. Recourse is human, not algorithmic.

3. **Bank operators are accountable to their issuers and holders.**
   Anyone can run a bank, but the issuers who route their Vouchers through it and holders have to trust the operator. An operator can erase its ledger or abort transactions — there is no cryptographic prevention — but it cannot forge a plausible alternative history alone, because every deal requires holder signatures.

### 1.1 v1 openness

Banks are open by default. The v1 reference posture:

- Banks allow minting **any** voucher that references them.
- Banks accept new ledger records for new accounts and new vouchers; they only check that the voucher references the bank.
- Banks accept and store any docs/signatures linked to vouchers that reference this bank, **from anyone** — the sender of a request need not be the doc's owner (counterparties legitimately carry each other's Account docs and relay each other's signatures).
- All calls to bank APIs are signed by the sender's key. Moderation is **key-blocking**, not gatekeeping: banks MAY refuse or rate-limit service to spammers and abusers based on their pubkey.

> **Extensibility:** Implementers MAY add additional trust, reputation, KYC, or audit mechanisms on top of the protocol. Such extensions MUST be backward-compatible: they must not prevent a client and bank from interacting using only the base v1 wire format.

---

## 2. Settlement model — direct approval, three waves, lead/follow

A deal executes in three waves: **ready → hold → settle** sanctioned by the holders. Banks self-advance as signatures arrive, and there is no client `hold` or `settle` call.

### 2.0 Three-wave execution model: ready → hold → settle

**1. Ready** — A bank issues a record-level `ready` signature on each of its own Records when it has authorization from the Holder. Authorization is independent: Alice can authorize without waiting for Bob. Authorization can come from:

- A direct holder `lead` or `follow` signature on the holder's own **Tx**.
- A matching `Order` doc (see `bank-schema.md`). When a holder is represented by an Order, the holder's bank issues `ready` on the matched Records on the holder's behalf, checking at ready time that the relevant accounts have sufficient free balance.
- A matching `Offer` doc (see `bank-schema.md`) — a bank-issued derivation of an Order. The holder still signs the Tx that references the Offer.
- An invoice or cheque specialization of an Order or Offer (one side omitted, see `bank-schema.md`).

If a bank sees both a direct Tx signature and a matching Order/Offer for the same Records, either one satisfies the ready gate. 

**2. Hold** — once all of a bank's records are `ready`, the bank locks the amount in the debit accounts among those records, issues record-level `hold` Signatures, and fans them out. A bank holds when:

- any holder Tx touching its records is `lead`, **or**
- every holder Tx touching its records is `follow` AND every predecessor bank whose output those holders depend on has already issued `hold` signatures on its own records.

A bank may issue a `hold` only if the debit is covered. Coverage means either:

- the account has enough available balance after existing holds, **or**
- the account will receive a credit in this deal that has already been held by this bank.

The bank MUST NOT hold an amount that would make the account's effective balance negative. If several debits compete for the same available balance or held credit, the bank SHOULD prefer debits whose covering credit is in the same holder Tx.

If a record cannot be held — because its debit is uncovered, the account is unknown, or any other precondition fails — the bank MUST issue a `reject` signature for that record. The reject propagates to the record's paired counterpart and is fanned out to peer banks; any bank that has records depending on the rejected ones MUST reject those as well. A single reject therefore aborts the deal cascade.

**3. Settle** — settlement is an ordered cascade of record-level signatures, not a single atomic flip:

- a **lead** bank settles first on its own records — but only once it has observed `hold` Signatures on the corresponding records from **every other bank in the deal**, so the whole graph is locked before anyone moves;
- a **follow** bank settles on its own records only after it has verified record-level `settle` Signatures from **every one of its predecessors**, and cites their hashes in its own settle's `Signature.seen` (see `base.md`).

Settling means: apply the deltas of every owned record, release the holds, issue `settle` signatures, fan out.

> **Implementation note:** The v1 reference implementation calls `create_records` on each bank, then each holder builds their own Tx and calls `submit_tx` on every bank that owns records touching their accounts. `submit_tx` issues per-record `ready` (or `reject`) signatures. Once all its records are approved, the bank's advance engine issues `hold` and `settle` signatures automatically as preconditions are satisfied.

### 2.1 Authorization sources

A bank advances a record only when it has valid authorization — a holder-signed Tx or matching Order/Offer — for every **Record** (credit or debit) touching a holder's account. See `bank-schema.md` for the doc shapes and `bank-rpc.md` for how `submit_tx` resolves them.

### 2.2 Risk — lead and follow

The lead set is whichever holders must move before anyone downstream can be made whole. Three shapes:

- **Bilateral** (the degenerate case): one lead bank, one follow bank. The lead settles first on its own records; the follower settles on its own records once the client relays the lead's record-level `settle` signatures.
- **Ring** (`A → B → C → A`): one lead breaks the cycle by settling first; the settle then propagates `B → C → A` until the ring closes.
- **Multiple leads**: when a node's inbound depends on more than one giver, *every* such giver must lead. For

  ```
  A → C      B → C      C → D      D → A      D → B
  ```

  C is made whole only once **both** A and B give, so the lead set is `{A's bank, B's bank}`. After they settle, C's bank settles `C → D`, then D's bank settles `D → A` and `D → B`, closing both cycles.

If any downstream bank refuses to apply (compromise, malice, downtime), every record that already settled stays settled: their vouchers moved, the rest of the chain didn't. The protocol accepts this risk because the trust model says the lead party knows the operators personally. Leads choose to carry it; followers wait for upstream proof before moving.

> **Invariant:** There is no protocol-level rollback mechanism and no protocol-level timeout. An implementation MAY add a sweeper that releases stuck holds for hygiene, but that is an implementation convenience, not a correctness mechanism.

### 2.3 Visibility — every bank sees only its own records

**No bank ever sees the whole deal.** A bank sees only the transfers of the vouchers *it issues* — "this much of my voucher leaves holder X; this much arrives at holder Y" — and nothing about the other records.

This falls straight out of the issuer-authority rule: a transfer of voucher `P` lives entirely at `P`'s issuer bank (debit and credit are both `P`-accounts there), and every record carries `pubkey =` `P`'s issuer bank. A bank only ever locks, applies, and signs records whose `pubkey` is its own.

The **initiating client** is the one party that legitimately knows the whole deal — it designed it — so it builds the graph and hands each bank only that bank's slice:

- **Bodies it gets:** only the credit/debit records whose voucher this bank issues.
- **Hashes it gets:** the record hashes in each holder Tx presented to it. These are opaque identifiers. A bank needs them to verify that its own records are included in each Tx; it cannot infer another record's amount, account, holder, or voucher from a record hash alone.
- **Routing it gets:** for the settle cascade, the pubkeys of its immediate **predecessor banks** (so it can verify their record-level `settle` signatures, see `base.md`). It learns *that* a peer bank participates, not *what* that peer transfers.

> **Invariant:** This visibility boundary is load-bearing. Any implementation that lets a bank see another bank's record bodies violates the protocol.

### 2.4 Signature fan-out — Subscriptions, push, and relay

Banks advance on **signatures**, wherever they come from. The delivery topology is the initiator's choice, expressed as **Subscription docs** (see `bank-schema.md`) sent to the banks:

- **Bank-to-bank push** (the reference default): the initiator cross-subscribes the participating banks to each other's record signatures. When a bank creates a Signature matching a watched hash, it POSTs a bank-signed `notify_signatures` envelope to the subscription's URL, fire-and-forget.
- **Client relay** (the floor): signatures carry their own authority — signer pubkey plus an ed25519 signature over the doc — so *anyone* may deliver them. A client can read one bank's signatures (`get_record_signatures`) and hand them to another (`notify_signatures`). A lost push is recovered by relay.

Every received-and-verified signature re-evaluates the bank's advance engine for the records it touches. Banks never *depend* on calling each other; push is an optimization over relay.

---

## 3. Invite strings and deep links

Both OOB handoffs are self-validating signed strings: the receiver verifies the signature before any network call, and tampering invalidates it.

### 3.1 Invite strings

The inviter's offer:

```
barter://<inviter-pubkey>@<inviter-bank-url>
  ?give=<voucher-hash>:<amount>:<account-hash>
  &get=<voucher-hash>:<amount>:<account-hash>
  [&accs=<base64url(JSON Account bodies)>]
  &exp=<unix-seconds>&sig=<inviter-sig>
```

- `give`: what the inviter offers — voucher, amount, and the inviter's **funded account** it will be debited from.
- `get`: what the inviter wants — voucher, amount, and the inviter's **receiving account** (authored locally; accounts are implicit).
- `accs`: the bodies of the inviter's Account docs referenced by the records, so the initiator can present them to the banks.
- `sig`: ed25519 over canonical JSON of the invite minus `sig`, by the inviter's pubkey.

### 3.2 Deal tokens

Users share these as short deep links, typically rendered as QR codes. When another user scans the link with a smartphone camera, it opens a bank webapp that suggests creating a new key or logging into an existing app. Inside the app the user adds the voucher, address, or issuer to their personal catalog. The exact UX is implementation-specific; the link format and its self-validating property are protocol.

> **Invariant:** The invite string format, its fields, and its self-validating property are protocol. How the invite is conveyed (QR code, NFC, deep link, copy-paste) is an implementation detail.

---

## 4. Protocol design decisions, locked

| Decision | Resolution | Invariant? |
|---|---|---|
| Risk model | Lead/follow; no protocol-level rollback | **Yes** |
| Trust model | Counterparties already know each other; discovery OOB | **Yes** |
| Coordinator pattern | **Client-orchestrated**: the proposing user calls each bank with its own slice and relays signatures; banks never call each other on the trade path | **Yes** |
| Visibility | Each bank sees only the records of the vouchers it issues + the holder Tx hash lists + its predecessor bank pubkeys; no bank sees the full deal | **Yes** |
| Issuer authority | Issuer is sole source of truth for its Voucher's balances | **Yes** |
| Concurrent holds | Rejected `-32003`; first-write-wins on per-Account lock | **Yes** |
| Key recovery | Out of scope (lose key → lose account) | **Yes** |
| Key rotation | Out of scope; redeploy with new secret if compromised | **Yes** |
| Canonicalization | RFC 8785 / JCS; cross-runtime golden vectors | **Yes** |
| Account creation | Accounts are opened by presenting an unsigned Account doc to the issuing bank; there is no separate protocol operation | **Yes** |
| Voucher fungibility | Fungible: any "1 logo" issued by Alice is interchangeable; NFT-style is v2 | **Yes** |
| Tx cardinality | Open: `K ≥ 1` transfer pairs across 1..N banks; bilateral (`K=2`) is the simplest case | **Yes** |
| Tx ownership | **One Tx per participating holder**, containing only records that touch that holder's accounts | **Yes** |
| Holder authorization | Holders sign Voucher, Order, Tx, and Address docs; banks sign Record and Offer docs | **Yes** |
| Balance floor | Holder-authorized transfers cannot overdraw the debit account; negative balances are created only by issuer minting | **Yes** |
| Offers | Banks MAY derive and publish Offer docs from Orders; Offers hide holder identity and account hashes | **Yes** |

---

## 5. What the protocol does NOT do

These are out of scope for v1. An implementation MAY add them, but they are not part of the barter.game v1 contract:

- **No web UI.** The protocol is transport-agnostic; a web UI is a client-layer concern.
- **No protocol-level rollback.** If a follow bank goes rogue after the lead settles, the lead is out. Recourse is social.
- **No guaranteed delivery.** Fan-out is fire-and-forget; client relay is the recovery path. There is no message queue in the protocol.
- **No key recovery, no key rotation.** Forever-keys in v1.
- **No NFT-like Vouchers.** Issued Vouchers are fungible.
- **No automated settle-cascade retry.** The advance engine re-evaluates whenever a new signature arrives, but if a follower bank goes permanently offline after the lead settles, the lead remains settled — the lead/follow risk, resolved socially. The protocol provides only per-record `reject` for pre-settled aborts.
- **No reputation, dispute resolution, or stakes.** Pure protocol; recourse is social.
- **No global bank discovery directory.** `barter-bank.json`, Address docs, and direct URL+pubkey pinning are the v1 baseline; a global federated directory is a v1.5+ extension.

---

## 6. Implementing barter.game

If you are building your own bank or client:

1. Read this overview cover to cover.
2. Read [`base.md`](./base.md) for the wire format and signature rules.
3. Read [`bank-schema.md`](./bank-schema.md) for the document schemas and ledger invariants.
4. Read [`bank-rpc.md`](./bank-rpc.md) for the bank API methods.
5. Read `MASTER-INPUT.md` — the canonical bilateral narrative, doc snippets included.
6. See `IMPLEMENTATION.md` for how the reference team built it: Deno Deploy, Deno KV, the CLI, and the specific file map.
7. See `SCHEMA.md` for the v1 reference database schema — useful as a starting point, but you may use any storage that enforces the invariants in `bank-schema.md`.
