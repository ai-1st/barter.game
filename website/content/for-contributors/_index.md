---
title: For Contributors
---

## Shape the protocol

barter.game is early. The protocol is small enough to keep in your head. If you find a bug, a mismatch between the spec and the code, or a place where the ETHOS got comvoucherd — open an issue, and bring receipts.

## Principles first

Before you open a PR, read [`ETHOS.md`](https://github.com/ai-1st/barter.game/blob/main/ETHOS.md). It is the north star. Every design decision, when the spec runs out, falls back to the ETHOS.

Key beliefs:
- **Be your own bank.** Sovereignty is non-negotiable.
- **Trust is local.** We do not build marketplaces for strangers.
- **The CLI is the protocol's truest surface.** The web UI is polish; the CLI is truth.
- **Federation is table stakes.** Centralization — even subtle — is failure.

## Where to contribute

### Protocol invariants

`PROTOCOL.md` is the contract. If you find:
- Ambiguity that could cause two implementations to diverge
- Missing edge cases in the state machine
- Security holes in the visibility model

Open an issue with a concrete attack or counterexample.

### Reference implementation

`packages/protocol/`, `apps/cli/`, `supabase/functions/`. Bug fixes, performance improvements, and tests are always welcome. The cross-runtime parity test is especially load-bearing — improvements to canonicalization coverage are high-value.

### Documentation and website

This website (`website/`). Better explanations, more examples, translations, and design improvements.

### Experiments

The `TODOS.md` AI agents section is a brainstorm, not a roadmap. If you build one, share it. The protocol team does not own the agent layer — it's yours to explore.

## Reading order for contributors

1. [`ETHOS.md`](https://github.com/ai-1st/barter.game/blob/main/ETHOS.md) — what we believe (10 minutes)
2. [`PROTOCOL.md`](https://github.com/ai-1st/barter.game/blob/main/PROTOCOL.md) — the invariant contract (45 minutes)
3. [`IMPLEMENTATION.md`](https://github.com/ai-1st/barter.game/blob/main/IMPLEMENTATION.md) — how we built it (30 minutes)
4. `packages/protocol/src/` — the code (an afternoon)
5. `supabase/functions/_shared/bank/handlers/` — the server-side state machine
6. [`TODOS.md`](https://github.com/ai-1st/barter.game/blob/main/TODOS.md) — what's next

## Code of conduct

- No crypto-bro speculation. This is a settlement layer, not a token.
- No surveillance features. The visibility model is load-bearing.
- No centralization shortcuts. Every convenience that centralizes is a bug.
- Bring receipts. Claims about security, performance, or correctness need evidence.

## License

MIT (planned; license file lands with the v1 public release).
