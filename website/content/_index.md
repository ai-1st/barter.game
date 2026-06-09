---
title: barter.game
layout: hextra-home
---

{{< hextra/hero-container >}}
  {{< hextra/hero-headline >}}Be your own bank.{{< /hextra/hero-headline >}}
  {{< hextra/hero-subtitle >}}A federated mutual-credit ledger. Mint personal currencies, trade them with people you trust, and settle cryptographically — no central authority, no middleman.{{< /hextra/hero-subtitle >}}
{{< /hextra/hero-container >}}

<div class="hx-mt-20 hx-mb-20">
{{< hextra/feature-grid >}}
  {{< hextra/feature-card
    title="For Event Managers"
    subtitle="Add a promise marketplace so attendees network better. Turn business-card exchanges into real value trades."
    link="for-event-managers"
    icon="calendar"
  >}}
  {{< hextra/feature-card
    title="For Developers"
    subtitle="Build your own implementation. The protocol is small, invariant, and language-agnostic."
    link="for-developers"
    icon="code"
  >}}
  {{< hextra/feature-card
    title="For Self-Hosters"
    subtitle="Deploy a bank in 10 minutes. Run your own tiny central bank in a federation of peers."
    link="for-self-hosters"
    icon="server"
  >}}
  {{< hextra/feature-card
    title="For Players"
    subtitle="Master the barter play. Learn lead vs. follow, trust dynamics, and portfolio strategy."
    link="for-players"
    icon="star"
  >}}
  {{< hextra/feature-card
    title="For AI Enthusiasts"
    subtitle="Let AI agents trade with each other. Agents can be holders, emitters, even banks."
    link="for-ai-enthusiasts"
    icon="cube"
  >}}
  {{< hextra/feature-card
    title="For Contributors"
    subtitle="Shape the protocol. The spec is small enough to keep in your head."
    link="for-contributors"
    icon="users"
  >}}
{{< /hextra/feature-grid >}}
</div>

<div class="hx-mt-20 hx-mb-20 hx-text-center">

## How it works in one paragraph

Every user and every bank is an **ed25519 keypair**. Promise, Pocket, Account, Signature, and Order docs are canonicalized via RFC 8785 JSON, SHA-256-hashed, and content-addressed. Ledger records are bank-minted with ULIDs. A cross-bank trade walks `create_records → propose → hold → confirm → settle` across any number of banks. The lead bank settles first; followers settle after observing upstream proof. No bank ever sees the full transaction. The math binds everyone together.

[Read the full docs →](docs)

</div>

<div class="hx-mt-20 hx-mb-20"">

## See it work

```bash
git clone https://github.com/ai-1st/barter.game.git
cd barter.game
bun install
./scripts/demo.sh
```

The script narrates each step. By the end, two simulated users have minted personal currencies on different banks, traded them, and settled. Sum per Promise = 0. The cryptographic version of "we're even."

</div>
