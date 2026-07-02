# Mandate validation in multi-leg deals — analysis & proposal

*2026-07-06. Follow-up to the owner's question: what exactly must a bank validate when Mandates join several Orders — e.g. `A→B, B→C, B→A`, or a chain `A→B→C`? Status: bilateral case implemented; multi-leg needs the Mandate change proposed in §4.*

## 1. The validation principle

A bank validates **every Order its records reference** — one Mandate per (Order, bank), each record checked against its own Order. The conditions split into three classes with very different reach:

| Class | Scope | Where checkable |
|---|---|---|
| **Per-record hard bounds** — side exists, account matches, `min ≤ amount ≤ max` | one record | locally, at `create_records` and re-checked at ready |
| **Per-order local aggregates** — `debit_order_limit`/`credit_order_limit`, account floors/ceilings, balance coverage | all of the order's records *at this bank* | locally, at ready |
| **Per-order deal-wide aggregates** — `rate` = total debit / total credit across the whole deal | all of the order's records *at every bank* | **not fully checkable locally** — this is the open problem |

## 2. Case walkthroughs

### 2.1 `A→B, B→C, B→A` — three Orders at one bank

Concretely: legs `B→C` and `B→A` are B's voucher (bank **V_B**); leg `A→B` is A's voucher (bank **V_A**).

At **V_B** the records are: debit B ×2 (to C, to A), credit C, credit A — referencing **three Orders**:
- **B's Order** (debit V_B-voucher; credit A-voucher @ V_A) — covers both debits; V_B checks per-record min/max and B's *cumulative* debit limits across both records.
- **C's Order** (credit-only) — covers credit C.
- **A's Order** (debit A-voucher @ V_A; credit B-voucher @ V_B) — covers credit A.

All three Orders are present at V_B (each touches it), so every *local* condition is verifiable. The one condition that is not: **B's rate** — `(β+γ)/α ≤ B.rate` where β, γ are B's two local debits and α is B's foreign credit at V_A.

### 2.2 `A→B→C` — the pass-through holder

If both legs are the same voucher P (B receives P from A and forwards P to C), everything is local to P's bank: B's Order is two-sided *in the same voucher* and the existing local aggregate rate check covers it. The interesting case is cross-voucher (leg 1 = X @ bank X, leg 2 = Y @ bank Y): bank Y holds B's and C's Orders (2 orders — A's Order never touches Y), and B's rate again spans banks.

## 3. Why pairwise `counter_amount` is only correct for bilateral deals

The implemented check validates the counter amount **per create_records pairing**: it must fit *both* Orders' windows for the foreign side and satisfy *both* rates. For a bilateral swap (one pairing, two Orders) this is exactly right and fully bank-asserted.

For multi-leg topologies it breaks down structurally:

1. **Compensation may come from a third party.** In §2.1, B's debit to C is not compensated by C — it's compensated by A's payment at another bank. A pairwise "giver's credit vs receiver's debit" check either demands a counter leg from C that doesn't exist, or validates B's rate against a number that isn't B's actual compensation.
2. **Per-leg rate checks double-count.** B's rate is over *totals* (`(β+γ)/α`), not per leg. Checking `β/α` and `γ/α` separately silently under-counts the debit side; each leg passes while the total violates.
3. **The missing-leg attack.** A coordinator can mandate only the give-side legs of a two-sided Order. Local windows all pass; the aggregate rate is unverifiable locally ("cannot check yet"); if the holder's Order is `lead`, the bank settles the give side and the compensation never existed. *(For followers the cascade stalls harmlessly — annoying, not theft.)*

So today: **bilateral = sound and bank-asserted; multi-leg = per-record bounds only, deal-wide rate unenforced.** Same class of gap as the deferred `seen`-binding discussion — both are "how does a bank correlate its slice with foreign slices without seeing foreign bodies."

## 4. Proposal: the Mandate enumerates the Order's deal-wide slices

Extend the Mandate (per Order, per bank — unchanged scoping) with the Order's **whole-deal footprint**, in hashes and totals only, never record bodies:

```ts
Mandate: BaseDoc & {
  type: "mandate";
  deal_id: ULID;
  order: Base58SHA256;
  bank: Base58PubKey;            // addressed bank (unchanged)
  records: Base58SHA256[];       // this bank's records for the order (unchanged)
  slices?: Array<{               // NEW — the same order's records elsewhere
    bank: Base58PubKey;          // the bank owning that slice
    records: Base58SHA256[];     // opaque hashes — no bodies, no accounts
    debit_total: number;         // total of the order's debits in that slice
    credit_total: number;        // total credits in that slice
  }>;
}
```

What each bank can then verify:

1. **Its own slice, exactly.** The `slices` entry for this bank must match its actual records and totals — a lying coordinator is caught by *every* bank it lies to about that bank's own voucher.
2. **Foreign totals against the Order's windows.** For a foreign slice with `n` records, `n × min ≤ total ≤ n × max` from the Order's own side definition — signed by the holder, held locally.
3. **The rate, numerically.** `Σ debit_total / Σ credit_total ≤ rate` over coordinator-asserted—but now *cross-checked*—totals: every asserted number is exactly verified by the bank that owns that voucher, and the deal only settles if **all** banks advance. A split-brain coordinator (different Mandates to different banks) is caught the moment signatures carry the Mandate hash (see below).
4. **The missing-leg attack dies:** a two-sided Order's Mandate must enumerate credit slices satisfying the rate, and the bank refuses `ready` until it has verified **foreign `ready` signatures on those exact record hashes** — the protocol already fans `ready` to peer banks; the enumeration finally tells the receiver *which* hashes to expect from *which* bank.
5. **Reject and settle binding come free.** The same enumeration gives a bank the exact foreign hash set whose `reject`/`hold`/`settle` signatures concern this deal — closing the correlation gap that today makes a foreign reject un-bindable and lets any settle-from-that-signer unblock a follower. This is the concrete anchor for the deferred `seen` discussion: `seen` stays an opaque partial order, but the *reader* now knows which hashes it should find in it.

Anti-forgery note: banks only act on signatures they verify against the signer bank's pinned pubkey (unchanged); the enumeration adds correlation, not authority. Visibility boundary preserved: hashes and per-voucher totals for an Order the bank already holds reveal nothing about accounts, holders, or other orders' terms.

Cost: the coordinator must assemble slice lists it already has (it created every record); Mandate size grows linearly with the order's deal footprint.

## 5. Implemented now vs. proposed

| | Status |
|---|---|
| Pairwise bank-asserted counter validation (both windows, both rates, same foreign voucher, 0 for one-sided) | **Implemented** (`create_records`) |
| Reject as bank-issued Signature: permanent-failure detection, deal-wide cascade, hold release, fan-out | **Implemented** (`advance.ts`; `e2e-reject.ts`) |
| Cross-bank reject/settle **binding** (acting on a foreign reject; per-deal settle correspondence) | **Needs §4** — foreign hashes are unbindable today |
| Deal-wide rate enforcement for multi-leg orders; missing-leg attack on lead orders | **Needs §4** |

## 6. Questions for the owner

1. Does the `slices` extension fit your intent for the Mandate as "unit of work," or should the enumeration live elsewhere (e.g. a deal-digest doc all banks receive)?
2. Should banks require `ready` signatures from every foreign slice **before their own `ready`** (strict, one extra round-trip) or before `hold` (current wave semantics, minimal change)?
3. Signatures could carry the Mandate hash (e.g. in `seen`) so peers can detect split-brain Mandates for a shared Order — fold that into the deferred `seen` discussion?
