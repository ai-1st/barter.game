---
title: How it works
---

A barter.game trade is a cascade of signed states across independent banks. Here's a bilateral swap — the simplest case — step by step.

## The setup

**Alice** runs `bank-alice`. She mints "1 logo" — a promise to design one logo.
**Bob** runs `bank-bob`. He mints "1 hour" — a promise to do one hour of consulting.

Alice and Bob already know each other. They agree to trade 1 logo for 1 hour.

## Step 1: Build the deal

Alice (the proposer) constructs the deal as a set of transfers:

```
Alice gives 1 logo  → Bob receives 1 logo   (at bank-alice)
Bob   gives 1 hour  → Alice receives 1 hour (at bank-bob)
```

From these transfers, the client builds 4 **records** (2 debits + 2 credits) and a **Tx** that groups them. The Tx contains only the *hashes* of the records — no amounts, no account details, no identities. Just hashes.

## Step 2: Slice per bank

Alice's client slices the deal so each bank sees only its own legs:

- **bank-alice** sees: "1 logo leaves Alice; 1 logo arrives at Bob." Plus the full Tx hash list (opaque). Plus: bank-alice is the **lead**.
- **bank-bob** sees: "1 hour leaves Bob; 1 hour arrives at Alice." Plus the full Tx hash list (opaque). Plus: bank-bob is the **follow**; its predecessor is bank-alice.

Neither bank sees the other's amounts, accounts, or holders.

## Step 3: Propose and hold

Alice calls `propose_leg` on both banks, then `hold_leg` on both:

1. Each bank validates its slice, persists it, and signs `approve`.
2. Each bank locks the debit accounts and signs `hold`.

If either bank can't acquire the hold (concurrent trade on the same account), it returns `-32003` Lock Conflict. Alice's client releases all holds and aborts.

## Step 4: Confirm receipt

Bob signs `confirm_receipt` saying "I acknowledge I'm receiving 1 logo." Alice signs saying "I acknowledge I'm receiving 1 hour." Each signature is delivered to the banks where that holder appears.

Once **every holder in a bank's own records** has confirmed, that bank's leg advances to `confirmed`.

## Step 5: Settle (the cascade)

Alice calls `settle_leg` on **bank-alice** first. It's the lead; it needs no upstream signatures. It applies the balance deltas, releases the hold, and signs `settle`.

Alice relays bank-alice's `settle` signature to **bank-bob**. She calls `settle_leg` there, passing the upstream settle as proof. Bank-bob verifies the signature, applies its own deltas, releases its hold, and signs its own `settle` — citing the upstream one in `Signature.seen`.

The deal is done.

## Final balances

| Holder | Promise | Bank | Balance |
| --- | --- | --- | --- |
| Alice | "1 logo" | bank-alice (issuer) | **-1** (she gave it) |
| Bob   | "1 logo" | bank-alice | **+1** (he received) |
| Bob   | "1 hour" | bank-bob (issuer)   | **-1** (he gave it) |
| Alice | "1 hour" | bank-bob   | **+1** (she received) |

Sum per Promise = 0. The cryptographic version of "we're even."

## The risk

What if bank-bob refuses to settle after bank-alice already did? Alice's logo moved; Bob's hour didn't. This is the **lead/follow risk**, and it is **accepted by design**. The protocol has no rollback. In our trust model, Alice knows Bob (or his bank operator) personally. She yells at him. The protocol records the deal; it does not arbitrate it.

For multi-party rings and complex graphs, the same machinery scales: leads settle first, then followers in topological order, each citing upstream proof in `Signature.seen`. The client is the only party that knows the full graph, so the client orchestrates everything.
