# TODOS

Deferred items from the v1 design doc. Each entry: **what / why / context / depends on**.

## v1.5 — likely-next-up

### Cross-bank inbox aggregation
- **What:** A single inbox UI/CLI view that shows all of a user's pending Txs across every bank that issued a Promise they hold.
- **Why:** v1 inbox is scoped to one bank at a time; a user with Promises across 3 banks has to open 3 inbox tabs.
- **Context:** Per the design's Architectural Note, the issuing bank is the sole authority for its Promise's balances. The user's client would need to hit every issuer bank for the user's accounts and merge the results. Hardcoded bank list (v1) makes this feasible; a directory (below) makes it scalable.
- **Depends on:** v1 protocol must be stable; design the merge order (last-write-wins by ULID?).

### Federated bank directory
- **What:** A registry where banks publish themselves so clients/peers can discover them beyond the hardcoded v1 list.
- **Why:** v1 hardcodes bank URLs in the client config. Adding a third bank means a code change. Doesn't scale beyond demo.
- **Context:** Could be a simple shared JSON file, an Ethereum-style on-chain registry, a Mastodon-style relay model, or even just a public Gist that everyone agrees on. Decision pending. The trust model already says "users know their counterparties" — a directory is for discovery, not trust.
- **Depends on:** Decide whether directory is decentralized or a barter.game-operated good-citizen service.

### Key rotation
- **What:** Allow a bank or user to roll their ed25519 key without orphaning existing Promises/Accounts.
- **Why:** v1's "lose key → lose account" is acceptable for a demo but unworkable for anything resembling production.
- **Context:** Implementation requires either (a) signed key-rotation docs that link old pubkey → new pubkey, or (b) a separate authority root that signs key rotations. Each has tradeoffs around bootstrapping the rotation trust.
- **Depends on:** Decide rotation model first. Document the migration path for existing v1 Promises.

### Account recovery
- **What:** Some way for a user to recover their account if they lose their browser localStorage / private key.
- **Why:** v1's hard "lose key, lose account" rule is a UX cliff. Real users WILL lose keys.
- **Context:** Options include social recovery (M-of-N trusted parties sign a key replacement), hardware wallet integration, server-side encrypted backup with passphrase. All carry trust trade-offs.
- **Depends on:** Key rotation infrastructure (above). Without rotation, recovery is impossible without breaking the cryptographic identity model.

### Per-bank Supabase project (split out of multi-tenant)
- **What:** Migrate from "one Supabase project hosts N bank functions" to "each bank runs in its own Supabase project."
- **Why:** v1's multi-tenant arrangement collapses operational independence — one Postgres outage takes down all banks. True federation requires process and DB isolation.
- **Context:** The protocol already supports cross-project federation (Edge Functions verify `to` against own pubkey, treat peer banks via HTTP). v1.5 work is mostly deployment scripting and updating the bank-config schema to support arbitrary project URLs.
- **Depends on:** Stable v1 protocol so the migration doesn't reintroduce bugs.

### Browser key UX deep tune
- **What:** Production-grade Argon2id-in-WASM tuning for browser-side private key encryption.
- **Why:** Plan defers this to "implementation-time"; the right choice is Argon2id but it's heavy (~100ms cold start), and PBKDF2 iteration counts need real-device benchmarks.
- **Context:** Either pick fast-enough PBKDF2 with bumped iterations OR ship Argon2id via WASM + add a loading state. The web UI design depends on the choice. Out of scope if web UI is cut from v1.
- **Depends on:** Web UI being in scope for the revisit.

### Cold-start warm-up on inbox session
- **What:** Fire a no-op RPC on inbox.html load to wake the Edge Function before the first real poll.
- **Why:** 10s polling against a cold Edge Function adds ~150ms to the first poll. Annoying for the demo.
- **Context:** ~5 LOC change. Skip if web UI is cut from v1.
- **Depends on:** Web UI in scope.

### Web UI (apps/web)
- **What:** Browser-based mint/trade/inbox UI as a thin wrapper over `packages/client`.
- **Why:** CLI-only is a barrier for non-technical users. The web UI is the natural growth path once protocol is proven.
- **Context:** Cut from v1 per outside-voice review (reclaims ~1.5 weekends). All protocol code is CLI-driven; web is purely a UI skin reusing `packages/client`. Argon2id vs PBKDF2 tuning becomes a real concern at this point (see Browser key UX deep tune above). 10s polling on inbox; cold-start warm-up ping; standard SPA patterns.
- **Depends on:** v1 CLI shipped and stable; client package's API surface frozen.

### Per-bank custom domain (clean URLs)
- **What:** Drop the `/functions/v1/` URL prefix; serve banks at clean subdomains (`a.barter.game`, `b.barter.game`).
- **Why:** Pretty URLs. No functional difference.
- **Context:** Requires Cloudflare Workers or similar in front to rewrite paths. $5-25/mo per bank on Supabase Pro plan, OR free with a Worker. Cosmetic.
- **Depends on:** Real users complaining about URLs (probably never).

## v2+ — bigger swings

### N-bank Tx (multi-party barter)
- **What:** Remove the v1 bilateral cap so a single Tx can involve 3+ banks (the legacy `Tx.records[]` is unbounded by design).
- **Why:** True multi-party barter is the legacy notes' original vision.
- **Context:** Multi-leg fan-out (who calls whom in what order across 3+ banks) is a meaningfully different protocol than bilateral. Needs a coordinator-election scheme OR a fully symmetric N-party protocol like a saga / paxos variant. Big spec work.
- **Depends on:** v1 stable; protocol team consensus on coordinator model.

### NFT-like unique Promises
- **What:** Each `1 logo` Promise instance is a distinct, non-fungible token (vs v1 where any "1 logo" issued by Alice is interchangeable).
- **Why:** Some use cases need provenance (signed art, specific event tickets).
- **Context:** Schema change: Records reference Promise instances by ULID, not just Promise type. Bigger rewrite of balance accounting.
- **Depends on:** Use case demand.

### Reputation / dispute resolution
- **What:** Some on-protocol mechanism for "Alice settled but Bob never delivered."
- **Why:** v1's social-recourse model breaks at scale.
- **Context:** Options: stakes/bonds (Alice posts collateral), arbitration (mutually-trusted third bank as arbiter), public shame board (signed dispute docs). Each fundamentally changes the trust model.
- **Depends on:** Real users hitting the dispute problem at sufficient frequency that protocol-level intervention is worth the complexity. Likely the LAST thing to build, not the first.

### Hardware wallet / Ledger integration
- **What:** Allow private keys to live on hardware (Ledger, YubiKey) rather than browser localStorage.
- **Why:** Security upgrade for users with material value in their accounts.
- **Context:** Requires WebAuthn / U2F integration; significant client work; specifically punts on recovery (key never leaves device).
- **Depends on:** Use cases where account value > "1 logo for a friend."
