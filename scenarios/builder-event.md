# Scenario: Builder Event

A builder event's organizers run a bank to promote networking between participants: swag packages are distributed as cheques over email, redeemed at a booth against an invoice QR, split into mug and t-shirt vouchers, and swapped participant-to-participant — all on the v1 wire format. This scenario traces the whole lifecycle at the journey level, naming the protocol operation behind every step and pointing to the existing scenario that traces each mechanic signature-by-signature. It is also honest about the seams: one step (the atomic 1 → 2 split) hits a real schema gap, and two steps lean on the discovery and post-feed surfaces documented in [`discovery.md`](../protocol/discovery.md) and [`post-feed.md`](../protocol/post-feed.md).

## Cast & setup

- **Organizers**: issuer keypair `Org.pub`. One keypair for simplicity; nothing prevents several organizer keypairs each issuing their own vouchers.
- **EventBank**: bank keypair `EventBank.pub`, operated by the organizers. Issues every voucher in this scenario, so all deals are same-bank.
- **Participants**: user keypairs `P1.pub`, `P2.pub`, … — created in the browser on first visit.
- **Booth staff**: run the organizers' client, watching the organizers' accounts at EventBank.
- **Vouchers** (all `bank: EventBank.pub`, `integer: true`, `expires` set to shortly after the event — see Phase 9):
  - `PackageVoucher` — "1 swag package"
  - `MugVoucher` — "1 event mug"
  - `ShirtVoucher` — "1 event t-shirt"

## Phase 1 — Bank setup and landing

The organizers deploy EventBank and link its web UI from the event's main page. The bank announces its identity at `GET <bank-url>/barter-bank.json` (pubkey, canonical RPC URL, protocol version — [`bank-rpc.md`](../protocol/bank-rpc.md) §3, [`discovery.md`](../protocol/discovery.md) §1); clients pin `{pubkey, url}` together. There is deliberately no global bank directory — this bank is discovered by being linked from a page the participants already trust, which is exactly the v1 posture. The landing page itself is a client-layer concern, not protocol; everything it does below reduces to the signed RPC surface.

## Phase 2 — Issuer registration and swag vouchers

The organizers register as issuers by signing a `PackageVoucher` doc and submitting it via `submit_docs`, together with an issuer Account doc for it. There is **no mint step**: units come into existence when the issuer's own Order debits the issuer account below zero ([`README.md`](../protocol/README.md) §2, [`bank-schema.md`](../protocol/bank-schema.md) §3.2). For their own bookkeeping the organizers can export the full record history of any voucher they issue at any time with `list_voucher_records` (paginated, newest-first — [`bank-rpc.md`](../protocol/bank-rpc.md)).

## Phase 3 — Cheques emailed to participants

For each registered participant the organizers issue a **cheque**: a debit-only Order (`credit` omitted) on the issuer's `PackageVoucher` account, `min: 1, max: 1`, `debit_order_limit: 1`, `lead: true`, submitted via `submit_docs`. One cheque Order per participant, so each link can pull exactly one package and no more.

Each participant receives an email with a deep link carrying the cheque Order hash ([`README.md`](../protocol/README.md) §3.2 — self-validating links; the exact mail template is implementation detail). Because the debit side is the issuer's own account, settling the cheque drives it negative — that *is* the issuance.

Mechanics of a cheque, in full: [`cheque.md`](./cheque.md).

## Phase 4 — Participants redeem the cheque

A participant clicks the link and lands on EventBank's UI, where they register (a fresh keypair) or log in. To redeem:

1. The web app creates an Account doc for `PackageVoucher` — the participant enters the account name, which stays a private local label ([`bank-schema.md`](../protocol/bank-schema.md) §1.2).
2. The web app builds a credit-only receiving **Order** (the invoice specialization) crediting that account, `min: 1, max: 1`, and submits Account + Order via `submit_docs`.
3. The web app then **acts as Coordinator** — the coordinator is just a keypair, and the participant's own client qualifies. It calls `create_records` on EventBank (`giver` = cheque Order hash, `receiver` = receiving Order hash, `amount: 1`, `counter_amount: 0` — both Orders one-sided, so the rate check is skipped), then `submit_mandate` once per Order.
4. EventBank's advance engine runs ready → hold → settle. Single bank, cheque Order `lead: true` — it settles immediately. Organizer issuer account `-1`, participant `+1` `PackageVoucher`.

Full signature-level trace of exactly this shape: [`cheque.md`](./cheque.md).

## Phase 5 — Booth redemption via invoice QR

At the booth, a QR code encodes a deep link to the organizers' standing **invoice**: a credit-only Order crediting the organizers' redemption account with `PackageVoucher`, `min: 1, max: 1`, reusable across participants. Scanning it, the participant's web app:

1. Builds a matching cheque Order debiting 1 `PackageVoucher` from the participant's account (`lead: true`), submits it via `submit_docs`.
2. Acts as Coordinator again: `create_records` (participant's cheque = `giver`, organizers' invoice = `receiver`, `amount: 1`, `counter_amount: 0`), then one `submit_mandate` per Order. EventBank settles.

The booth staff's app sees the deal complete — either by a `Subscription` (`subscribe`) watching the organizers' holder key or `PackageVoucher` (the filters Subscriptions support) pushing settle signatures, or by polling `list_account_records` on the redemption account ([`bank-rpc.md`](../protocol/bank-rpc.md)). They hand over the physical package and mark the `deal_id` in a **separate system of record** so a package is never handed out twice. The `deal_id` is sealed inside `RecordDetails` behind a hash, but the booth app runs against the organizers' *own* bank, which can surface it to the credited holder; and knowing a `deal_id` confers no authority anyway — advancing records additionally requires the coordinator's key ([`bank-schema.md`](../protocol/bank-schema.md) §1.3). The hand-over ledger itself is out of protocol scope, exactly like every other delivery attestation in v1.

Full invoice mechanics: [`invoice.md`](./invoice.md).

## Phase 6 — Mug and t-shirt vouchers; public split/merge Offers

The organizers create `MugVoucher` and `ShirtVoucher` via `submit_docs` and want to publish standing orders for **1 package → 1 mug + 1 t-shirt** (and the merge direction back). These orders are marked public: `submit_docs(..., publish_offers: [...])` makes EventBank derive and publish **Offers**, which participants discover through `list_offers` without learning who stands behind them.

### Known gap: the 1 → 2 split is not atomically expressible

A single Order carries at most **one** `debit` block and **one** `credit` block, each naming exactly one voucher, related by one scalar `rate` ([`bank-schema.md`](../protocol/bank-schema.md) §1.4). What the participant *wants* to sign does not exist in v1:

```ts
// NOT valid v1 — an Order has at most one credit block, naming one voucher
{
  type: "order", pubkey: P1.pub, ulid: <new>, rate: ???,   // one scalar rate cannot relate three vouchers
  debit:  { account: <p1-package>, voucher: <package>, bank: EventBank.pub, min: 1, max: 1 },
  credit: [ { voucher: <mug>, min: 1, max: 1 }, { voucher: <shirt>, min: 1, max: 1 } ],  // no such array
  lead: true
}
```

"Give 1 package, receive 1 mug **and** 1 t-shirt" therefore does not fit in one Order, and the two escape hatches both fall short:

- **Two two-sided Orders** ("½ package → 1 mug", "½ package → 1 t-shirt") fail because `PackageVoucher` is `integer: true` — a 1-unit debit cannot be split across two Orders.
- **Composed one-sided Orders** (the [`merge-branch.md`](./merge-branch.md) pattern: participant signs a package cheque plus mug and shirt invoices; organizers sign the mirror set; a Coordinator stitches three transfers into one `deal_id`) *executes*, because rate checks are skipped for one-sided Orders — but the **holder loses atomicity**. The participant's package cheque is an unconditional debit authorization; nothing the participant signed binds "give the package" to receiving *both* items. A dishonest coordinator could pair the cheque with the organizers' package invoice alone.

**The workaround used here is non-atomic and trust-based**: the organizers publish the standing split/merge Offers and simply honor them — each direction settles as its own deal, coordinated by a party the participant already trusts (the organizers run both the issuer keys and the bank). That is consistent with the v1 trust model, but it is a workaround, not an answer. The schema extension (multi-leg Orders, or per-Order all-or-nothing leg grouping) is tracked in [`TODOS.md`](../TODOS.md).

## Phase 7 — Participants split their packages

Participants who want the parts instead of the box discover `MugVoucher` and `ShirtVoucher` through their existing trust in the issuer: `list_vouchers` with an issuer filter against the bank's public voucher registry ([`discovery.md`](../protocol/discovery.md) §2 — the issuer filter is protocol; what enters the registry is bank policy). They create the counter-orders to the organizers' standing split Offers (package cheque + mug/shirt invoices) via `submit_docs`.

Either the **participant's web app** or the **bank itself** assumes the Coordinator role — again, a coordinator is only a keypair, and a bank operator may run one as a service. The coordinator resolves the Offers to their underlying Order hashes (`Offer.order`) and composes one split deal of three transfers, all at EventBank, under a shared `deal_id`:

1. participant → organizers: 1 `PackageVoucher` (participant's cheque, organizers' package invoice),
2. organizers → participant: 1 `MugVoucher` (organizers' mug cheque, participant's mug invoice),
3. organizers → participant: 1 `ShirtVoucher` (organizers' shirt cheque, participant's shirt invoice),

via one `create_records` call per pair, then one `Mandate` per Order via `submit_mandate`. The composed multi-pair pattern, including how one Mandate lists several records satisfying the same Order, is traced in [`merge-branch.md`](./merge-branch.md) — with the atomicity caveat from Phase 6 applying to the participant's side: the composition lives in the coordinator's calls, not in anything the participant signed.

## Phase 8 — T-shirt ↔ mug swaps between participants

Taste diverges: some participants want two mugs, some want two shirts.

- P1 submits a two-sided Order — debit 1 `ShirtVoucher`, credit 1 `MugVoucher`, `rate: 1`, `lead: true` (someone must lead; single bank, so the choice is safe) — via `submit_docs` with `publish_offers`, and EventBank publishes the Offer.
- P2 submits the opposite Order the same way.

Both Offers are public, so **any party can coordinate**: P1's app, P2's app, the bank, or a third party scanning `list_offers`. The coordinator reads both Offers' `order` fields, and — since both vouchers are issued by EventBank — calls `create_records` **twice** with `giver`/`receiver` swapped ([`bank-rpc.md`](../protocol/bank-rpc.md) §2.2, same-bank swap), then sends one `Mandate` per Order listing both of that Order's records. EventBank checks the two-sided rate on each Order over the full record set and settles.

The bilateral-swap mechanics (Offers → Order hashes → records → Mandates → advance) are traced in [`direct-approval.md`](./direct-approval.md); the only difference here is one bank instead of two.

**Participants never learn who the other holder is — and don't need to.** Offers are bank-published, discovery-only derivations that hide holder identity and account hashes ([`bank-schema.md`](../protocol/bank-schema.md) §1.5, [`discovery.md`](../protocol/discovery.md) §3); Records reference Order hashes, never people. What a participant trusts is "the mug" and "the t-shirt" — vouchers whose issuer they know — and the bank the organizers set up. Holders are not trust-bearing; issuers are, and the holder on the other side of an Offer is interchangeable.

## Phase 9 — Post-event worthlessness

The vouchers will probably be worthless after the event — that is entirely **organizer discretion**, and they signal it with the Voucher `expires` field (ISO 8601, [`bank-schema.md`](../protocol/bank-schema.md) §1.1) set when the vouchers were created. Orders themselves have no expiry: a holder cancels a standing Order by emptying its debit account, leaving the bank nothing to `ready` against ([`bank-schema.md`](../protocol/bank-schema.md) §1.4).

## Phase 10 — Participant-minted vouchers and profile QRs

Participants are issuers too. Anyone may sign a Voucher doc with `bank: EventBank.pub` — "1 code review", "1 coffee walk" — and submit it via `submit_docs`; v1 banks accept any voucher whose `bank` field names them ([`README.md`](../protocol/README.md) §1.1). Issuance happens with the first Order that debits the issuer account. Optionally the voucher is listed in the bank's **public registry**, discoverable via `list_vouchers` ([`discovery.md`](../protocol/discovery.md) §2); vouchers kept out of the registry still settle normally — they are simply not browsable.

For hallway networking, a participant generates a **profile QR bundle**: a signed document bundle carrying their pubkey (Address) plus the vouchers they choose to advertise — including ones deliberately kept out of the public registry ([`discovery.md`](../protocol/discovery.md) §4). People they meet scan it, verify every signature locally, and subscribe to / trust that pubkey and its vouchers in their own app — the same self-validating-signed-bytes discipline as invite strings ([`README.md`](../protocol/README.md) §3); the QR itself is just conveyance. Participants who opt an account into public visibility can additionally be looked up via `list_public_balances`, filtered by holder and/or voucher, each result a bank-signed Balance statement ([`discovery.md`](../protocol/discovery.md) §6). For their own history, holders read `list_account_records` and fetch a bank-signed balance with `get_balance` ([`bank-rpc.md`](../protocol/bank-rpc.md)).

## Phase 11 — Voucher feeds

Each voucher doubles as a topic. A **Post** is a signed, content-addressed doc anchored to exactly one voucher, created by any author — the feed is the voucher's, not the author's ([`post-feed.md`](../protocol/post-feed.md) §1). The organizers post "redeem the package at booth 12" against `PackageVoucher`; a participant posts "traded my mug for a great t-shirt" against `MugVoucher`.

- **Write**: anyone submits a Post via `submit_docs` to a bank the voucher lives on. Beyond validity checks (shape, author signature, voucher resolves at this bank), **acceptance is bank policy** — spam filter, allowlist, paywall, per-key rate limits ([`post-feed.md`](../protocol/post-feed.md) §2, §5).
- **Read**: clients poll the banks the issuer uses with `list_posts` for posts anchored to a voucher, newest-first, paginated ([`post-feed.md`](../protocol/post-feed.md) §3).
- **Visibility**: everybody can create a post, but a reader's client filters what it shows by the reader's trust/subscription list — posts by the voucher's issuer, by pubkeys the reader follows, or reposted by either. The issuer may **repost** a valuable third-party post, lending it their audience ([`post-feed.md`](../protocol/post-feed.md) §4).

The two layers — banks accepting or refusing carriage, clients filtering by subscription — are what keep feeds usable: spam neither propagates (untrusted authors are filtered client-side) nor accumulates (banks may refuse it at the door). This is also how comment abuse is contained without any protocol-level moderation authority.

## Known gaps and future work

1. **Atomic 1 → 2 split** (Phase 6). One Order = at most one debit block + one credit block + one scalar rate; `Voucher.integer` blocks fractional workarounds; composed one-sided Orders execute but forfeit holder-level atomicity. Workaround: issuer-honored standing Offers, each direction settling as its own deal. Schema extension tracked in [`TODOS.md`](../TODOS.md). **Status: schema gap.**
2. **Deal searcher** (future). A service that scans public Offers across banks (`list_offers`), combines them with a user's private Orders and past deal history, and runs exhaustive search for closeable deals — a linear-programming reference implementation is planned. Tracked in [`TODOS.md`](../TODOS.md). **Status: future work.**
3. **Post replies, embedded media, embedded documents** (future). The v1 Post is deliberately minimal; threading and attachments are follow-ups to [`post-feed.md`](../protocol/post-feed.md). **Status: future work.**

## Coverage map

| Essay step | Mechanism | Status |
|---|---|---|
| Bank set up, landing linked from event page | `barter-bank.json` identity + web UI (client layer) | protocol-ready |
| Organizers register as issuers, create swag vouchers | Voucher docs via `submit_docs`; no mint step | protocol-ready |
| Cheque per participant, sent by email | Debit-only Order + deep link ([`cheque.md`](./cheque.md)) | protocol-ready |
| Participant redeems cheque in web app | Account + credit-only Order; app as Coordinator: `create_records` + `submit_mandate` | protocol-ready |
| Booth invoice QR, package handed over | Credit-only Order ([`invoice.md`](./invoice.md)); booth watches via `subscribe` / `list_account_records`; `deal_id` marked in external system | protocol-ready |
| 1 package → 1 mug + 1 t-shirt in one Order | Not expressible: one debit + one credit block per Order | **schema gap** |
| Split/merge as issuer-honored public Offers | One-sided Orders + `publish_offers` + [`merge-branch.md`](./merge-branch.md) composition | protocol-ready (non-atomic workaround) |
| Participants split packages; app or bank coordinates | `list_vouchers` issuer filter; Coordinator = any keypair | protocol-ready |
| T-shirt ↔ mug swaps, anyone coordinates | Public Offers + same-bank swap ([`direct-approval.md`](./direct-approval.md)) | protocol-ready |
| Counterparty anonymity | Offers hide holder identity/accounts; trust rides on issuer + bank | protocol-ready |
| Post-event worthlessness | `Voucher.expires`; Orders cancelled by emptying accounts | protocol-ready |
| Participants mint their own vouchers, publish in registry | `submit_docs` + public registry ([`discovery.md`](../protocol/discovery.md)) | reference-impl pending |
| Profile QR: pubkey + vouchers, scan to subscribe | Profile QR bundles ([`discovery.md`](../protocol/discovery.md)) | reference-impl pending |
| Voucher feeds: posts, subscriptions, issuer reposts, bank policy | Post docs via `submit_docs` / `list_posts` ([`post-feed.md`](../protocol/post-feed.md)) | reference-impl pending |
| Deal searcher over public Offers + private Orders + history | Exhaustive search / LP reference implementation | future work |
| Replies, media, documents in posts | Post schema extensions | future work |
