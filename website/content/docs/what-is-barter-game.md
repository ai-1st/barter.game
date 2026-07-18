---
title: What is barter.game?
---

For 40+ years, every "alternative currency" attempt — LETS, time banks, mutual credit cooperatives — has run into the same wall: **bootstrap**. They needed strangers to trust each other before the system was useful, and strangers don't.

barter.game takes the opposite stance: **trust is local — and it attaches to the issuer, not your counterparty.** You trust whoever's promise backs the voucher ("Alice will actually make the logo"), and the bank that settles it. You do *not* need to trust the person on the other side of the trade: banks settle against signed Orders, so that counterparty is interchangeable and usually anonymous — two strangers at an event can swap a mug voucher for a t-shirt voucher without ever exchanging names.

So strangers *can* trade here safely. What the protocol declines to do is tell you whether a promise is any good — there is no reputation score and no arbitration. It gives trust a verifiable surface: signed receipts, atomic settlement, no ambiguity about who owes whom.

## The core loop

1. **Mint** a personal currency — "1 logo", "1 hour of consulting", "1 home-cooked dinner" — issued by you, signed by you, redeemable from you.
2. **Trade** — offer your voucher for theirs with a signed invite string. Each holder signs their own Order; a coordinator — often just your own web app — builds the deal: ledger records on each bank, cleared by a signed Mandate per Order.
3. **Authorize** — your signed Order is both authorization and receipt confirmation. There is no separate accept step.
4. **Banks settle** — on their own, lead bank first, each citing cryptographic proof of the previous step. Sum per Voucher = 0.

## What makes it different

| Traditional alt-currency | barter.game |
|---|---|
| Strangers must trust each other | Trust the voucher's **issuer** and the **bank** — never your counterparty |
| Central clearing house | Every user is their own bank; federation is native |
| Reputation scores and arbitration | Social enforcement; the protocol records, it does not judge |
| Pre-funded collateral | Mutual credit: issuers go negative, holders go positive, sum = 0 |

## Federation is table stakes

Every bank is its own URL, its own ed25519 key, its own ledger. Banks talk to each other via signed HTTP. Anyone running the codebase can be a peer. The demo collapses several banks into one Deno Deploy process and one Deno KV database for operational simplicity; the *protocol* doesn't know or care.

If barter.game ever centralized — even subtly, even for "the demo" — we have built the wrong thing.

## Be your own bank

The fantasy is older than money: you, sovereign, issuing your own currency backed by something you can deliver. Not a token wrapping a stablecoin. Not a loyalty point. A signed voucher — "1 logo, by Alice, due on demand." Yours. You decide how many exist. You decide who gets them. You decide what they cost.

The system exists to make this fantasy practical, not theoretical.
