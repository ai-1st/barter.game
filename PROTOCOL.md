# barter.game protocol — v1 (Invariant Contract)

> **This document has been split.** The v1 invariant contract now lives in the `protocol/` directory:
>
> - **[`protocol/README.md`](./protocol/README.md)** — overview, trust model, settlement model, invite strings, design decisions, and out-of-scope items.
> - **[`protocol/base.md`](./protocol/base.md)** — identity, canonical JSON, `BaseDoc`, `Signature`, `Address`, JSON-RPC envelope, replay protection, error codes, request signing, discovery, and pubkey pinning.
> - **[`protocol/bank-schema.md`](./protocol/bank-schema.md)** — banking document schemas (`Promise`, `Account`, `Record`, `Tx`, `Order`, `Offer`, `Subscription`) and ledger semantics (state machine, concurrency, balance invariants).
> - **[`protocol/bank-rpc.md`](./protocol/bank-rpc.md)** — bank JSON-RPC methods, REST address-directory endpoints, discovery, and orchestration recipe.
>
> If you are building your own bank or client, read `protocol/README.md` first, then the three split files. `MASTER-INPUT.md` is the source-of-truth design narrative; `scenarios/*.md` are step-by-step interaction traces; `IMPLEMENTATION.md` describes the reference implementation.
