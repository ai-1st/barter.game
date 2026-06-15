---
title: How it works
---

A barter.game trade is a cascade of signed documents across independent banks. Here's a bilateral swap — the simplest case — step by step.

## The setup

**Alice** runs `bank-alice`. She mints "1 logo" — a voucher to design one logo.
**Bob** runs `bank-bob`. He mints "1 hour" — a voucher to do one hour of consulting.

Alice and Bob already know each other. They agree to trade 1 logo for 1 hour.

## Step 1: Mint

A mint is just the first ledger record pair. Alice presents her signed Voucher plus two Account docs — on two **distinct Pocket hashes** — to bank-alice. The bank creates a debit on her issue account (it goes negative) and a credit on her holding account (it goes positive). There is no special mint logic: the same mechanism that moves value in trades creates it at mint. One signer, one bank, so the bank settles it immediately.

Bob does the same on bank-bob.

There is no "open account" call anywhere in the protocol. Accounts are implicit — they come into existence the first time an Account doc is presented to a bank. And Pocket bodies never leave the holder; banks only ever see Pocket hashes.

## Step 2: The invite

Bob offers the swap: `barter invite --give <1 hour>:1 --get <1 logo>:1`. This prints a signed `barter://` string carrying his offer, his account hashes, and the doc bodies Alice will need. He hands it to Alice — QR code, chat message, whatever.

## Step 3: Records and the lead Tx

Alice runs `barter trade --invite "<barter://...>"`. Her client:

1. Calls `create_records` on **bank-alice** ("1 logo: debit Alice, credit Bob") and on **bank-bob** ("1 hour: debit Bob, credit Alice"). New Account docs travel with the call. Each bank creates a debit/credit record pair — each record carries the mandatory `pair` ULID of its twin — and returns the bodies.
2. Builds one **Tx per holder**. **ATx** binds the records on Alice's accounts (the debit of 1 logo, the credit of 1 hour). **BTx** binds the records on Bob's accounts (the credit of 1 logo, the debit of 1 hour). Each holder authorizes only what touches their own accounts.
3. Signs ATx with action `lead` and submits it to both banks via `submit_tx`. As the lead she settles first — she carries the risk (more below).
4. Sends Subscription docs cross-subscribing the banks to each other's deal signatures, so every new signature is pushed to whoever needs it. No polling.
5. Prints a `barterdeal:` **deal token** for Bob.

On each `submit_tx`, a bank checks limits and balances and issues an `approve` or `reject` signature **per ledger record** it owns. After ATx: bank-alice approves the debit of 1 logo; bank-bob approves the credit of 1 hour.

## Step 4: The deal token and the follow Tx

Alice sends Bob the deal token. It carries his unsigned BTx and the record bodies. Bob's client verifies it against the banks directly (`get_deal`) — the records must match the invite he signed, nothing more, nothing less.

Satisfied, he runs `barter accept "<barterdeal:...>"`: his client signs BTx with action `follow` and submits it to both banks. The follow signature doubles as receipt confirmation — there is no separate confirm step. The banks issue the remaining per-record approvals.

## Step 5: Holds

From here, **the banks advance on their own** — nobody runs a hold or settle command.

Once every record a bank owns under the deal is bound to a holder-signed Tx and approved, its leg is `approved`. The bank locks the debit accounts and signs a `hold` for the deal. A held account cannot be debited by another deal until the hold is released by settlement or rejection. (A hold conflict just blocks quietly; the bank retries on the next incoming signature.)

Each `hold` signature fans out to the subscribers Alice registered.

## Step 6: Settle (the cascade)

Settlement follows the lead/follow order. **bank-alice** is the lead: once it has seen `hold` signatures from every other bank in the deal, it applies its record pair to the balances, releases its holds, and signs `settle`.

**bank-bob** settles after observing bank-alice's settle signature — delivered by fan-out, or relayed by either party with `barter nudge` if a push got lost. Its own settle signature cites the upstream one's hash in `Signature.seen`: a verifiable proof chain that the upstream leg settled first.

The deal is done.

## Final balances

| Account | Voucher | Bank | Balance |
| --- | --- | --- | --- |
| Alice (issue)   | "1 logo" | bank-alice | **-1** (created at mint) |
| Alice (holding) | "1 logo" | bank-alice | **0** (minted +1, gave 1) |
| Bob             | "1 logo" | bank-alice | **+1** (he received) |
| Bob (issue)     | "1 hour" | bank-bob   | **-1** (created at mint) |
| Bob (holding)   | "1 hour" | bank-bob   | **0** (minted +1, gave 1) |
| Alice           | "1 hour" | bank-bob   | **+1** (she received) |

Sum per Voucher = 0. The cryptographic version of "we're even."

## The risk

What if bank-bob refuses to settle after bank-alice already did? Alice's logo moved; Bob's hour didn't. This is the **lead/follow risk**, and it is **accepted by design**. The protocol has no rollback. In our trust model, Alice knows Bob (or his bank operator) personally. She yells at him. The protocol records the deal; it does not arbitrate it.

For multi-party rings and complex graphs, the same machinery scales: the initiator's client creates the records, every holder signs their own Tx, and the banks settle themselves in topological order — leads first, then followers, each citing upstream proof in `Signature.seen`. The initiating client is the only party that knows the full graph; the banks each see only their own voucher's records.
