---
title: For Players
---

## Master the barter play

barter.game is not just a protocol — it's a game of trust, timing, and strategy. The best players understand the social dynamics as well as the cryptography.

## The currencies you hold are promises

Every "coin" in your wallet is a signed IOU from someone you know. "1 logo from Alice." "1 hour from Bob." The value is not in the token; it's in the relationship behind it.

This changes how you think about your portfolio:

- **Diversify your emitters.** Holding 50 promises from one person is concentration risk. If they ghost, you're holding paper.
- **Pay attention to `due` dates.** A promise with a maturity date is a time-bounded commitment. Trade accordingly.
- **Watch the limit.** If Alice set `limit: 100` on her "1 logo" promise, she can only issue 100 total. Scarcity matters.

## Lead vs. follow: the risk decision

In every cross-bank trade, someone settles first. That party is the **lead**. The other is the **follow**.

- **Lead:** Your balance moves immediately. If the follow bank never settles, you're out. You carry the risk.
- **Follow:** You wait for proof that the lead settled. Your balance only moves after you see a valid upstream signature. You're protected.

### When to be lead

- The amount is small.
- You know the counterparty well.
- You trust their bank operator (it's them, or someone you know).
- You want the deal to close faster.

### When to be follow

- The amount is large.
- The counterparty is new to you.
- Their bank operator is unknown.
- You can afford to wait.

In a ring trade (`A → B → C → A`), one party must break the cycle by leading. The protocol picks based on the graph structure. As a player, you should understand whether you're in the lead set before you confirm.

## The social layer is the enforcement layer

The protocol has no arbitration. If Bob ghosts after you settle as lead, there is no "dispute" button. Your recourse is:

1. **Yell at Bob.** Seriously. The trust model assumes you know him.
2. **Don't trade with Bob again.** His reputation in your social graph degrades.
3. **Tell mutual friends.** Information propagates through the same social network that makes barter.game work.

This is a feature, not a bug. The protocol is precise about what it guarantees (signed receipts, atomic balance updates) and honest about what it doesn't (enforcing delivery).

## Advanced plays

### The liquidity bridge

Alice wants Bob's "1 hour" but Bob doesn't want Alice's "1 logo." Carol wants Alice's "1 logo" and has something Bob wants. The protocol supports N-party rings. Alice proposes a three-way trade. The client builds the graph, slices per bank, and orchestrates the cascade.

### Portfolio rebalancing

If you're holding too many promises from one emitter, offer them to others at favorable rates. "I'll give you 2 of Alice's logos for 1 of your hours." The protocol doesn't price-match; you do. It's barter, not a market.

### The event play

Go to an event with an empty wallet. Mint a promise on arrival — "1 intro to my network." Trade it for other promises throughout the day. Leave with a diversified portfolio of commitments from people you just met. Follow up next week to redeem.

## The meta-game

The ultimate barter.game player is not the one with the highest balance. It's the one with:

- **The most trusted issuer relationships.** People know you'll deliver.
- **The most diverse portfolio.** Many small promises from many emitters.
- **The best timing.** Knowing when to lead and when to follow.
- **The cleanest redemption record.** You settle your debts promptly.

Be a good counterparty. The protocol records everything.
