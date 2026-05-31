# Bilateral Settlement Walkthrough — Alice ↔ Bob

> A step-by-step document-by-document trace of the simplest cross-bank trade.

## The deal

- **Alice** runs `bank-alice`. She issues a Promise: "1 logo".
- **Bob** runs `bank-bob`. He issues a Promise: "1 hour".
- They agree to trade: Alice gives 1 logo, Bob gives 1 hour.

## Pre-trade setup (not in the table)

1. Alice `mint_promise("1 logo")` at bank-alice → her issuer account starts at `0`.
2. Bob `mint_promise("1 hour")` at bank-bob → his issuer account starts at `0`.
3. Bob `open_account` for Alice's logo at bank-alice → Bob can now receive the logo.
4. Alice `open_account` for Bob's hour at bank-bob → Alice can now receive the hour.

## Document key

| Shorthand | Meaning |
|---|---|
| `P:logo` | Promise "1 logo" issued by Alice at bank-alice |
| `P:hour` | Promise "1 hour" issued by Bob at bank-bob |
| `A:a→logo` | Alice's issuer account for `P:logo` at bank-alice |
| `A:b→logo` | Bob's holder account for `P:logo` at bank-alice |
| `A:b→hour` | Bob's issuer account for `P:hour` at bank-bob |
| `A:a→hour` | Alice's holder account for `P:hour` at bank-bob |
| `Tx` | The Tx document grouping the deal |
| `R[0..3]` | The 4 LedgerRecords (2 debits + 2 credits) |
| `Sig:*` | Signatures created or verified in the step |

---

## Phase 1 — Alice builds the deal (client-side only)

Alice's CLI constructs the full graph. No network calls yet.

| Step | Action | `P:logo` | `A:a→logo` | `A:b→logo` | `P:hour` | `A:b→hour` | `A:a→hour` | `Tx` | `R[0..3]` | `Sig:*` | API | `@alice` | `@bob` |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Alice builds transfers | — | — | — | — | — | — | — | — | — | — | — | — |
| 1a | Create debit record: Alice → Bob, 1 logo | — | — | — | — | — | — | — | `R[0]` created (`type:debit`, `account=A:a→logo`, `amount:1`, `pubkey=bank-alice`) | — | — | — | — |
| 1b | Create credit record: Bob receives 1 logo | — | — | — | — | — | — | — | `R[1]` created (`type:credit`, `account=A:b→logo`, `amount:1`, `pubkey=bank-alice`) | — | — | — | — |
| 1c | Create debit record: Bob → Alice, 1 hour | — | — | — | — | — | — | — | `R[2]` created (`type:debit`, `account=A:b→hour`, `amount:1`, `pubkey=bank-bob`) | — | — | — | — |
| 1d | Create credit record: Alice receives 1 hour | — | — | — | — | — | — | — | `R[3]` created (`type:credit`, `account=A:a→hour`, `amount:1`, `pubkey=bank-bob`) | — | — | — | — |
| 1e | Create Tx with `records = [hash(R[0]), hash(R[1]), hash(R[2]), hash(R[3])]` | — | — | — | — | — | — | `Tx` created (`pubkey=Alice`, `records[4]`) | — | — | — | — | — |
| 1f | Alice signs `proposer_approve` over `hash(Tx)` | — | — | — | — | — | — | — | — | `Sig:proposer` created (`type:signature`, `action:approve`, `hash:hash(Tx)`, `pubkey:Alice`) | — | — | — |

---

## Phase 2 — Slice and propose

Alice's client slices the deal per bank and calls `propose_leg` on each.

| Step | Action | `P:logo` | `A:a→logo` | `A:b→logo` | `P:hour` | `A:b→hour` | `A:a→hour` | `Tx` | `R[0..3]` | `Sig:*` | API | `@alice` | `@bob` |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 2 | **Client slices** — bank-alice gets `R[0], R[1]` only; bank-bob gets `R[2], R[3]` only. Both get the full `Tx.records[]` hash list. | — | — | — | — | — | — | — | — | — | — | — | — |
| 3 | `propose_leg` to **bank-alice** | — | — | — | — | — | — | `hash(Tx)` stored | `R[0], R[1]` stored | `Sig:proposer` verified against `hash(Tx)` | `propose_leg(Tx, [R0,R1], proposer_approve, role:lead, predecessors:[])` | `approved` | — |
| 3a | bank-alice signs `approve` | — | — | — | — | — | — | — | — | `Sig:alice-bank-approve` created (`action:approve`, `hash:hash(Tx)`, `pubkey:bank-alice`) | — | — | — |
| 4 | `propose_leg` to **bank-bob** | — | — | — | — | — | — | `hash(Tx)` stored | `R[2], R[3]` stored | `Sig:proposer` verified against `hash(Tx)` | `propose_leg(Tx, [R2,R3], proposer_approve, role:follow, predecessors:[bank-alice])` | — | `approved` |
| 4a | bank-bob signs `approve` | — | — | — | — | — | — | — | — | `Sig:bob-bank-approve` created (`action:approve`, `hash:hash(Tx)`, `pubkey:bank-bob`) | — | — | — |

> **Key invariant:** No bank sees the other bank's records. bank-alice knows `R[0..3]` exist (from `Tx.records[]`) but only sees the bodies of `R[0]` and `R[1]`.

---

## Phase 3 — Hold

Alice's client calls `hold_leg` on both banks to lock the debit accounts.

| Step | Action | `P:logo` | `A:a→logo` | `A:b→logo` | `P:hour` | `A:b→hour` | `A:a→hour` | `Tx` | `R[0..3]` | `Sig:*` | API | `@alice` | `@bob` |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 5 | `hold_leg` to **bank-alice** | — | `hold` acquired (`account=A:a→logo`, `tx=hash(Tx)`, `amount=1`) | — | — | — | — | — | — | — | `hold_leg(hash(Tx))` | `held` | — |
| 5a | bank-alice signs `hold` | — | — | — | — | — | — | — | — | `Sig:alice-bank-hold` created (`action:hold`, `hash:hash(Tx)`, `pubkey:bank-alice`) | — | — | — |
| 6 | `hold_leg` to **bank-bob** | — | — | — | — | `hold` acquired (`account=A:b→hour`, `tx=hash(Tx)`, `amount=1`) | — | — | — | — | `hold_leg(hash(Tx))` | — | `held` |
| 6a | bank-bob signs `hold` | — | — | — | — | — | — | — | — | `Sig:bob-bank-hold` created (`action:hold`, `hash:hash(Tx)`, `pubkey:bank-bob`) | — | — | — |

> **Double-spend gate:** If either `hold_leg` returns `-32003` (Lock Conflict), Alice's client must call `reject_leg` on **both** banks and abort.

---

## Phase 4 — Confirm receipt

Each holder signs `confirm_receipt` saying "I acknowledge I'm receiving." The client delivers each signature to every bank where that holder appears.

| Step | Action | `P:logo` | `A:a→logo` | `A:b→logo` | `P:hour` | `A:b→hour` | `A:a→hour` | `Tx` | `R[0..3]` | `Sig:*` | API | `@alice` | `@bob` |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 7 | Alice signs `confirm_receipt` | — | — | — | — | — | — | — | — | `Sig:alice-confirm` created (`action:settle`, `hash:hash(Tx)`, `pubkey:Alice`) | — | — | — |
| 7a | Deliver `Sig:alice-confirm` to **bank-bob** (Alice appears as credit holder in `R[3]`) | — | — | — | — | — | — | — | — | `Sig:alice-confirm` stored | `confirm_receipt(hash(Tx), alice-confirm)` | — | `confirmed` |
| 8 | Bob signs `confirm_receipt` | — | — | — | — | — | — | — | — | `Sig:bob-confirm` created (`action:settle`, `hash:hash(Tx)`, `pubkey:Bob`) | — | — | — |
| 8a | Deliver `Sig:bob-confirm` to **bank-alice** (Bob appears as credit holder in `R[1]`) | — | — | — | — | — | — | — | — | `Sig:bob-confirm` stored | `confirm_receipt(hash(Tx), bob-confirm)` | `confirmed` | — |

> **Precondition check for settle:** bank-alice waits for Bob's confirm (he's the recipient in bank-alice's records). bank-bob waits for Alice's confirm. In this bilateral case each bank only has one recipient, so one confirm each is enough.

---

## Phase 5 — Settle cascade

The lead settles first; the follower settles after observing upstream proof.

| Step | Action | `P:logo` | `A:a→logo` | `A:b→logo` | `P:hour` | `A:b→hour` | `A:a→hour` | `Tx` | `R[0..3]` | `Sig:*` | API | `@alice` | `@bob` |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 9 | `settle_leg` to **bank-alice** (lead — no predecessors) | — | balance: `0 → -1` | balance: `0 → +1` | — | — | — | — | — | — | `settle_leg(hash(Tx), [])` | `settled` | — |
| 9a | bank-alice verifies: leg is `confirmed` ✓, no predecessors needed ✓, sum invariant (`-1 + 1 = 0`) ✓ | — | — | — | — | — | — | — | — | — | — | — | — | — |
| 9b | bank-alice releases hold on `A:a→logo` | — | `hold` released | — | — | — | — | — | — | — | — | — | — |
| 9c | bank-alice signs `settle` | — | — | — | — | — | — | — | — | `Sig:alice-bank-settle` created (`action:settle`, `hash:hash(Tx)`, `pubkey:bank-alice`, `seen:[]`) | — | — | — |
| 10 | `settle_leg` to **bank-bob** (follow — predecessor is bank-alice) | — | — | — | — | balance: `0 → -1` | balance: `0 → +1` | — | — | — | `settle_leg(hash(Tx), [Sig:alice-bank-settle])` | — | `settled` |
| 10a | bank-bob verifies: leg is `confirmed` ✓, predecessor `bank-alice` settle signature present and valid ✓, sum invariant (`-1 + 1 = 0`) ✓ | — | — | — | — | — | — | — | — | — | — | — | — | — |
| 10b | bank-bob releases hold on `A:b→hour` | — | — | — | — | `hold` released | — | — | — | — | — | — | — |
| 10c | bank-bob signs `settle` with `seen = [Sig:alice-bank-settle]` | — | — | — | — | — | — | — | — | `Sig:bob-bank-settle` created (`action:settle`, `hash:hash(Tx)`, `pubkey:bank-bob`, `seen:[alice-bank-settle]`) | — | — | — |

---

## Final state

| Holder | Promise | Bank | Role | Balance |
|---|---|---|---|---|
| Alice | "1 logo" | bank-alice (issuer) | gave | **-1** |
| Bob   | "1 logo" | bank-alice (holder) | received | **+1** |
| Bob   | "1 hour" | bank-bob (issuer) | gave | **-1** |
| Alice | "1 hour" | bank-bob (holder) | received | **+1** |

**Sum per Promise = 0.** The cryptographic version of "we're even."

---

## Signature inventory

Every signature created in this deal:

| # | Signature | Signer | Action | Hash | `seen` | Purpose |
|---|---|---|---|---|---|---|
| 1 | `Sig:proposer` | Alice | `approve` | `hash(Tx)` | — | Alice approves the deal she designed |
| 2 | `Sig:alice-bank-approve` | bank-alice | `approve` | `hash(Tx)` | — | bank-alice approves its leg |
| 3 | `Sig:bob-bank-approve` | bank-bob | `approve` | `hash(Tx)` | — | bank-bob approves its leg |
| 4 | `Sig:alice-bank-hold` | bank-alice | `hold` | `hash(Tx)` | — | bank-alice confirms hold acquired |
| 5 | `Sig:bob-bank-hold` | bank-bob | `hold` | `hash(Tx)` | — | bank-bob confirms hold acquired |
| 6 | `Sig:alice-confirm` | Alice | `settle` | `hash(Tx)` | — | Alice confirms receipt of 1 hour |
| 7 | `Sig:bob-confirm` | Bob | `settle` | `hash(Tx)` | — | Bob confirms receipt of 1 logo |
| 8 | `Sig:alice-bank-settle` | bank-alice | `settle` | `hash(Tx)` | `[]` | bank-alice confirms balances applied |
| 9 | `Sig:bob-bank-settle` | bank-bob | `settle` | `hash(Tx)` | `[Sig:alice-bank-settle]` | bank-bob confirms balances applied, cites upstream |

---

## Visibility check

What each bank **never** saw:

- **bank-alice** never saw `R[2]`, `R[3]` (the hour records), Bob's hour account, or Alice's hour account.
- **bank-bob** never saw `R[0]`, `R[1]` (the logo records), Alice's logo account, or Bob's logo account.
- Neither bank saw the full deal graph — only the client did.
