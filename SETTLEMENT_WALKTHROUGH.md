# Bilateral Settlement Walkthrough — Alice ↔ Bob

> A step-by-step document-by-document trace of the simplest cross-bank trade.

## The deal

- **Alice** runs `bank-alice`. She issues a Promise: "1 logo".
- **Bob** runs `bank-bob`. He issues a Promise: "1 hour".
- They agree to trade: Alice gives 1 logo, Bob gives 1 hour.

## Pre-trade setup

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

**Step 1a.** Create debit record: Alice → Bob, 1 logo  
→ Record: `R[0]` (`type:debit`, `account=A:a→logo`, `amount:1`, `pubkey=bank-alice`)

**Step 1b.** Create credit record: Bob receives 1 logo  
→ Record: `R[1]` (`type:credit`, `account=A:b→logo`, `amount:1`, `pubkey=bank-alice`)

**Step 1c.** Create debit record: Bob → Alice, 1 hour  
→ Record: `R[2]` (`type:debit`, `account=A:b→hour`, `amount:1`, `pubkey=bank-bob`)

**Step 1d.** Create credit record: Alice receives 1 hour  
→ Record: `R[3]` (`type:credit`, `account=A:a→hour`, `amount:1`, `pubkey=bank-bob`)

**Step 1e.** Create Tx with `records = [hash(R[0]), hash(R[1]), hash(R[2]), hash(R[3])]`  
→ `Tx` created (`pubkey=Alice`, `records[4]`)

**Step 1f.** Alice signs `proposer_approve` over `hash(Tx)`  
→ Signature: `Sig:proposer` (`type:signature`, `action:approve`, `hash:hash(Tx)`, `pubkey:Alice`)

---

## Phase 2 — Slice and propose

Alice's client slices the deal per bank and calls `propose_leg` on each.

**Step 2.** Client slices

- bank-alice receives `R[0], R[1]` only.
- bank-bob receives `R[2], R[3]` only.
- Both receive the full `Tx.records[]` hash list.

**Step 3.** `propose_leg` to **bank-alice**

- **API:** `propose_leg(Tx, [R0,R1], proposer_approve, role:lead, predecessors:[])`
- **Stored:** `hash(Tx)`, records `R[0], R[1]`
- **Verified:** `Sig:proposer` against `hash(Tx)`
- **Created:** `Sig:alice-bank-approve` (`action:approve`, `hash:hash(Tx)`, `pubkey:bank-alice`)
- **bank-alice state:** `approved`
- **bank-bob state:** —

**Step 4.** `propose_leg` to **bank-bob**

- **API:** `propose_leg(Tx, [R2,R3], proposer_approve, role:follow, predecessors:[bank-alice])`
- **Stored:** `hash(Tx)`, records `R[2], R[3]`
- **Verified:** `Sig:proposer` against `hash(Tx)`
- **Created:** `Sig:bob-bank-approve` (`action:approve`, `hash:hash(Tx)`, `pubkey:bank-bob`)
- **bank-alice state:** `approved`
- **bank-bob state:** `approved`

> **Key invariant:** No bank sees the other bank's records. bank-alice knows `R[0..3]` exist (from `Tx.records[]`) but only sees the bodies of `R[0]` and `R[1]`.

---

## Phase 3 — Hold

Alice's client calls `hold_leg` on both banks to lock the debit accounts.

**Step 5.** `hold_leg` to **bank-alice**

- **API:** `hold_leg(hash(Tx))`
- **Hold acquired:** `account=A:a→logo`, `tx=hash(Tx)`, `amount=1`
- **Created:** `Sig:alice-bank-hold` (`action:hold`, `hash:hash(Tx)`, `pubkey:bank-alice`)
- **bank-alice state:** `held`
- **bank-bob state:** `approved`

**Step 6.** `hold_leg` to **bank-bob**

- **API:** `hold_leg(hash(Tx))`
- **Hold acquired:** `account=A:b→hour`, `tx=hash(Tx)`, `amount=1`
- **Created:** `Sig:bob-bank-hold` (`action:hold`, `hash:hash(Tx)`, `pubkey:bank-bob`)
- **bank-alice state:** `held`
- **bank-bob state:** `held`

> **Double-spend gate:** If either `hold_leg` returns `-32003` (Lock Conflict), Alice's client must call `reject_leg` on **both** banks and abort.

---

## Phase 4 — Confirm receipt

Each holder signs `confirm_receipt` saying "I acknowledge I'm receiving." The client delivers each signature to every bank where that holder appears.

**Step 7.** Alice signs `confirm_receipt`

- **Created:** `Sig:alice-confirm` (`action:settle`, `hash:hash(Tx)`, `pubkey:Alice`)

**Step 7a.** Deliver `Sig:alice-confirm` to **bank-bob**

- Alice appears as credit holder in `R[3]`.
- **API:** `confirm_receipt(hash(Tx), alice-confirm)`
- **bank-alice state:** `held`
- **bank-bob state:** `confirmed`

**Step 8.** Bob signs `confirm_receipt`

- **Created:** `Sig:bob-confirm` (`action:settle`, `hash:hash(Tx)`, `pubkey:Bob`)

**Step 8a.** Deliver `Sig:bob-confirm` to **bank-alice**

- Bob appears as credit holder in `R[1]`.
- **API:** `confirm_receipt(hash(Tx), bob-confirm)`
- **bank-alice state:** `confirmed`
- **bank-bob state:** `confirmed`

> **Precondition check for settle:** bank-alice waits for Bob's confirm (he's the recipient in bank-alice's records). bank-bob waits for Alice's confirm. In this bilateral case each bank only has one recipient, so one confirm each is enough.

---

## Phase 5 — Settle cascade

The lead settles first; the follower settles after observing upstream proof.

**Step 9.** `settle_leg` to **bank-alice** (lead — no predecessors)

- **API:** `settle_leg(hash(Tx), [])`
- **Verifies:** leg is `confirmed` ✓, no predecessors needed ✓, sum invariant (`-1 + 1 = 0`) ✓
- **Applied:** `A:a→logo` balance `0 → -1`; `A:b→logo` balance `0 → +1`
- **Hold released:** `A:a→logo`
- **Created:** `Sig:alice-bank-settle` (`action:settle`, `hash:hash(Tx)`, `pubkey:bank-alice`, `seen:[]`)
- **bank-alice state:** `settled`
- **bank-bob state:** `confirmed`

**Step 10.** `settle_leg` to **bank-bob** (follow — predecessor is bank-alice)

- **API:** `settle_leg(hash(Tx), [Sig:alice-bank-settle])`
- **Verifies:** leg is `confirmed` ✓, predecessor `bank-alice` settle signature present and valid ✓, sum invariant (`-1 + 1 = 0`) ✓
- **Applied:** `A:b→hour` balance `0 → -1`; `A:a→hour` balance `0 → +1`
- **Hold released:** `A:b→hour`
- **Created:** `Sig:bob-bank-settle` (`action:settle`, `hash:hash(Tx)`, `pubkey:bank-bob`, `seen:[alice-bank-settle]`)
- **bank-alice state:** `settled`
- **bank-bob state:** `settled`

---

## Final state

- **Alice**, "1 logo", bank-alice (issuer) — gave — balance **-1**
- **Bob**, "1 logo", bank-alice (holder) — received — balance **+1**
- **Bob**, "1 hour", bank-bob (issuer) — gave — balance **-1**
- **Alice**, "1 hour", bank-bob (holder) — received — balance **+1**

**Sum per Promise = 0.** The cryptographic version of "we're even."

---

## Signature inventory

Every signature created in this deal:

1. **`Sig:proposer`** — Alice — `approve` — `hash(Tx)` — (no `seen`) — Alice approves the deal she designed.
2. **`Sig:alice-bank-approve`** — bank-alice — `approve` — `hash(Tx)` — (no `seen`) — bank-alice approves its leg.
3. **`Sig:bob-bank-approve`** — bank-bob — `approve` — `hash(Tx)` — (no `seen`) — bank-bob approves its leg.
4. **`Sig:alice-bank-hold`** — bank-alice — `hold` — `hash(Tx)` — (no `seen`) — bank-alice confirms hold acquired.
5. **`Sig:bob-bank-hold`** — bank-bob — `hold` — `hash(Tx)` — (no `seen`) — bank-bob confirms hold acquired.
6. **`Sig:alice-confirm`** — Alice — `settle` — `hash(Tx)` — (no `seen`) — Alice confirms receipt of 1 hour.
7. **`Sig:bob-confirm`** — Bob — `settle` — `hash(Tx)` — (no `seen`) — Bob confirms receipt of 1 logo.
8. **`Sig:alice-bank-settle`** — bank-alice — `settle` — `hash(Tx)` — `[]` — bank-alice confirms balances applied.
9. **`Sig:bob-bank-settle`** — bank-bob — `settle` — `hash(Tx)` — `[Sig:alice-bank-settle]` — bank-bob confirms balances applied, cites upstream.

---

## Visibility check

What each bank **never** saw:

- **bank-alice** never saw `R[2]`, `R[3]` (the hour records), Bob's hour account, or Alice's hour account.
- **bank-bob** never saw `R[0]`, `R[1]` (the logo records), Alice's logo account, or Bob's logo account.
- Neither bank saw the full deal graph — only the client did.
