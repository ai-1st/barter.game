---
title: What is barter.game?
---

For 40+ years, every "alternative currency" attempt — LETS, time banks, mutual credit cooperatives — has run into the same wall: **bootstrap**. They needed strangers to trust each other before the system was useful, and strangers don't.

barter.game takes the opposite stance: **trust is local**. The system is for people who already know each other and want to formalize their trades. Friends, freelancer collaborators, club members, event attendees. The protocol gives existing trust a verifiable surface — signed receipts, atomic settlement, no ambiguity about who owes whom.

## The core loop

1. **Mint** a personal currency — "1 logo", "1 hour of consulting", "1 home-cooked dinner" — issued by you, signed by you, redeemable from you.
2. **Trade** — offer your voucher for theirs with a signed invite string. The initiator builds the deal: ledger records on each bank, one Tx per participant.
3. **Accept** — each party signs their own Tx. Your signature is both authorization and receipt confirmation.
4. **Banks settle** — on their own, lead bank first, each citing cryptographic proof of the previous step. Sum per Voucher = 0.

## What makes it different

| Traditional alt-currency | barter.game |
|---|---|
| Strangers must trust each other | You only trade with people you already know |
| Central clearing house | Every user is their own bank; federation is native |
| Reputation scores and arbitration | Social enforcement; the protocol records, it does not judge |
| Pre-funded collateral | Mutual credit: issuers go negative, holders go positive, sum = 0 |

## Federation is table stakes

Every bank is its own URL, its own ed25519 key, its own ledger. Banks talk to each other via signed HTTP. Anyone running the codebase can be a peer. The demo collapses four banks into one Supabase project for operational simplicity; the *protocol* doesn't know or care.

If barter.game ever centralized — even subtly, even for "the demo" — we have built the wrong thing.

## Be your own bank

The fantasy is older than money: you, sovereign, issuing your own currency backed by something you can deliver. Not a token wrapping a stablecoin. Not a loyalty point. A signed voucher — "1 logo, by Alice, due on demand." Yours. You decide how many exist. You decide who gets them. You decide what they cost.

The system exists to make this fantasy practical, not theoretical.
