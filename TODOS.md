# TODOS

Deferred items from the v1 design doc. Each entry: **what / why / context / depends on**.

## v1.5 — likely-next-up

### Cross-bank inbox aggregation
- **What:** A single inbox UI/CLI view that shows all of a user's balances and in-flight deals across every bank that issued a Voucher they hold.
- **Why:** v1 inbox is scoped to one bank at a time; a user with Vouchers across 3 banks has to open 3 inbox tabs.
- **Context:** The issuing bank is the sole authority for its Voucher's balances, so the client must hit every issuer bank (`list_accounts` / `get_deal`) and merge. The push half already shipped: Subscription docs let the client point each bank's signature fan-out at its own endpoint (`barter subscribe --url ...`), so aggregation becomes a merge problem, not a polling problem. Hardcoded bank list (v1) makes this feasible; a directory (below) makes it scalable.
- **Depends on:** v1 protocol must be stable; a client-side endpoint to receive `notify_signatures` pushes; design the merge order (last-write-wins by ULID?).

### Hold sweeper & orphaned-record hygiene
- **What:** An operator sweeper that releases holds belonging to deals that died before settling, and garbage-collects ledger records that were created (`create_records`) but never bound to a holder-signed Tx.
- **Why:** Banks self-advance but never time out — the protocol has no clocks (ETHOS §5). An abandoned deal leaves its debit accounts locked until a participant calls `reject_deal`, and created-but-never-signed records sit in the ledger forever.
- **Context:** Hygiene, not correctness: the partial unique index on `holds` stays the double-spend gate either way. A sweep is a per-bank operator policy (interval, or manual-only); it must issue a proper `reject` signature over the deal so the release is part of the audit trail.
- **Depends on:** Decide the operator policy surface (config per bank vs. hardcoded demo default).

### Federated bank directory
- **What:** A registry where banks publish themselves so clients/peers can discover them beyond the hardcoded v1 list.
- **Why:** v1 hardcodes bank URLs in the client config. Adding a third bank means a code change. Doesn't scale beyond demo.
- **Context:** Could be a simple shared JSON file, an Ethereum-style on-chain registry, a Mastodon-style relay model, or even just a public Gist that everyone agrees on. Decision pending. The trust model already says "users know their counterparties" — a directory is for discovery, not trust.
- **Depends on:** Decide whether directory is decentralized or a barter.game-operated good-citizen service.

### Key rotation
- **What:** Allow a bank or user to roll their ed25519 key without orphaning existing Vouchers/Accounts.
- **Why:** v1's "lose key → lose account" is acceptable for a demo but unworkable for anything resembling production.
- **Context:** Implementation requires either (a) signed key-rotation docs that link old pubkey → new pubkey, or (b) a separate authority root that signs key rotations. Each has tradeoffs around bootstrapping the rotation trust.
- **Depends on:** Decide rotation model first. Document the migration path for existing v1 Vouchers.

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

## Done — shipped in v1

### N-bank deals (multi-party barter)
- **What:** A single deal can involve any number of banks and holders (a holder's `Tx.records[]` is unbounded by design).
- **Status:** Shipped, then reworked for the direct-approval model. `barter deal <file.json>` takes a list of transfers, creates the records on every bank, builds ONE Tx PER HOLDER, lead-signs the initiator's, cross-subscribes the banks, and prints a deal token per remaining holder; each holder runs `barter accept`. From there the banks self-advance through hold and settle in topological order (leads first). The N-party Deno integration test verifies a 4-bank branching/merging deal end-to-end.
- **Context:** The initiator holds the full graph; each bank sees only its own slice. Under the rework banks DO push signatures to each other — via Subscription fan-out, with client relay (`barter nudge`) as the floor. The single proposer-signed Tx and `confirm_receipt` are gone: a holder signing their own Tx is both authorization and receipt.

## v2+ — bigger swings

### NFT-like unique Vouchers
- **What:** Each `1 logo` Voucher instance is a distinct, non-fungible token (vs v1 where any "1 logo" issued by Alice is interchangeable).
- **Why:** Some use cases need provenance (signed art, specific event tickets).
- **Context:** Schema change: Records reference Voucher instances by ULID, not just Voucher type. Bigger rewrite of balance accounting.
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

## AI agents — speculative extensions

Brainstorm output, not committed direction. These are agentic layers that could sit on top of v1 without modifying the wire protocol. They explore the seams the trust model opens up: emitter-side trust infrastructure (directory, due-diligence, audit), holder-side automation (inbox, portfolio, matchmaking), and the wider question of whether agents themselves can be emitters, holders, or banks.

`W:` = weirdness, 1-10. 1 is "obviously useful", 10 is "blue-sky deranged". Taste signal, not priority. Overlapping ideas already covered above are noted but not re-listed (federation cartographer → "Federated bank directory"; dispute mediator → "Reputation / dispute resolution").

### Conversational wallet (W: 2)
- **What:** LLM front-end that translates intent ("mint me 5 logos and offer 2 to Alice for an hour of design review") into signed JSON-RPC calls.
- **Why:** CLI exercises the protocol cleanly but is a barrier for non-technical event attendees. Web UI helps; a conversational shell helps more.
- **Context:** Pure client-side layer over `packages/client`. No protocol changes. Composes with the web UI track.
- **Depends on:** Stable client package API.

### Inbox triage agent (W: 3)
- **What:** Watches incoming deal tokens and the subscription push feed, summarizes proposed deals in plain English, drafts the holder's follow-Tx signature based on standing instructions ("auto-accept anything from Alice ≤ 5 logos").
- **Why:** Reviewing deal tokens by hand is correct protocol but tedious UX. Triage reduces friction without touching the wire.
- **Context:** Client-side only. Standing instructions live alongside the encrypted key. The agent never invents a Tx — it signs (or declines) the holder's own Tx carried by the deal token, after the same `get_deal` cross-check `barter accept` does.
- **Depends on:** Inbox UI track (CLI version is trivial; web version benefits more).

### Emitter due-diligence agent (W: 4)
- **What:** Before accepting Vouchers from an emitter you don't know, fetch their mint history, bank integrity score, outstanding supply vs `limit`, and redemption track record. Returns a one-paragraph credit memo.
- **Why:** The trust model is "trust the emitter, not the holder." That trust still has to be assessed somehow; v1 punts to out-of-band. An agent reads the signed history for you.
- **Context:** Pure aggregator over public signed evidence. Surface in the wallet at accept-time.
- **Depends on:** Federated bank directory; counterparty banks exposing a public read endpoint for Voucher history.

### Voucher pricing oracle (W: 4)
- **What:** LLM-suggested exchange rate: "what's a fair amount of `alice-logos` per `bob-hour`?"
- **Why:** Even people who know each other still have to haggle. An oracle gives an anchor; humans pick the binding amount.
- **Context:** Reads emitter histories + Voucher descriptions. Pure suggestion, not enforcement.
- **Depends on:** Nothing — could ship as a standalone web service.

### Lead/follow strategist (W: 5)
- **What:** Recommends whether the user should be lead or follow on a proposed Tx, based on counterparty history, amount, `due` date, and prior abandonment patterns.
- **Why:** v1 puts the lead/follow decision on humans, who have no data. The signed evidence has the data.
- **Context:** Pure recommendation. Could auto-decline trades over a configurable risk threshold.
- **Depends on:** Voluntary-reputation miner (below) for abandonment rates.

### Counterparty-blind matchmaker (W: 5)
- **What:** Registry that matches "who currently holds any `alice-logo` and is willing to part with one" without exposing holder identity until match.
- **Why:** Trust model says holders are interchangeable — so matching on inventory (Voucher type) rather than identity is legitimate and v1-compatible. Effectively a marketplace that doesn't violate v1's anti-marketplace stance because it matches Vouchers, not people.
- **Context:** Opt-in for holders. Could be built into the federated directory or run separately.
- **Depends on:** Federated bank directory; opt-in holder registry.

### Trust-graph transitive propagator (W: 5)
- **What:** Reasons "you trust Alice; Alice holds many of Carol's Vouchers and has never rejected one; therefore Carol is probably trustworthy as an emitter." Builds emitter-trust transitively from public signed evidence.
- **Why:** Direct trust lists are small. Transitive trust extends reach without violating "trust your counterparty" — the signed-evidence graph IS the authority.
- **Context:** Read-only aggregator. Could feed the due-diligence agent.
- **Depends on:** Federated bank directory; cross-bank account/Tx history readable.

### Liquidity provider bot (W: 5)
- **What:** Autonomous holder of a diversified Voucher basket that quotes two-way prices and lubricates trade flow.
- **Why:** The LETS critical-mass / liquidity-failure mode is real (ETHOS acknowledges this). LPs are the standard finance solution — and the trust model accommodates them because LPs are holders, and holders aren't trust-bearing.
- **Context:** Runs as a regular user with its own keypair. Capital from depositors or from its own LP-credit Voucher.
- **Depends on:** Stable v1; pricing oracle for quote generation.

### Voucher narrator (W: 6)
- **What:** For each settled Tx, an LLM writes a one-paragraph human-readable story ("On Tuesday at the Berlin hackathon, Alice settled 1 logo to Bob in exchange for 30 minutes of debugging").
- **Why:** Signed evidence is dry. Narratives make the ledger legible — for demo storytelling and for circulating Vouchers that need to carry their context.
- **Context:** Cheap LLM plumbing. Invoke at settle-time or generate on-demand by the wallet.
- **Depends on:** Nothing.

### Voluntary-reputation miner (W: 6)
- **What:** Reads the public signed-evidence trail and computes emitter reputation scores: abandonment rate, mint discipline, redemption track record.
- **Why:** v1 bans ratings to avoid marketplace dynamics. But emitter reputation (not holder reputation) is consistent with the trust model — you trust emitters, so rating them is legitimate. Different category than the dispute-resolution entry above.
- **Context:** Read-only. Opt-in for emitters who want to surface their track record.
- **Depends on:** Federated bank directory; public read access to settle/reject signatures.

### Bank-integrity auditor (W: 6)
- **What:** Watches a bank's signed evidence stream and externally validates the sum invariant ("balances across all accounts for a given Voucher sum to zero").
- **Why:** The protocol's sum invariant is enforced by the issuing bank itself. An emitter+bank that collude could mint Vouchers off-ledger. Only an external auditor reading the public signed history catches this.
- **Context:** This is the missing patch on the trust model — banks could cheat, and the protocol's defense is "other banks notice." The auditor automates the noticing.
- **Depends on:** Public read access to all signed docs, or a gossip protocol where banks publish issuance history.

### Voucher-as-bond pricer (W: 6)
- **What:** Treats Vouchers with a `due` field as zero-coupon bonds. Computes yield-to-maturity, time-discount, default risk.
- **Why:** `Voucher.due` exists in the spec but v1 does nothing with it. Once it does, Vouchers acquire a yield curve.
- **Context:** Wall Street primitive applied to friend-currency. Mostly UI/analytics.
- **Depends on:** Emitter due-diligence agent (for default risk input).

### Default-aware portfolio manager (W: 6)
- **What:** Watches a user's basket of emitter-issued Vouchers, flags emitters showing solvency stress, advises liquidation.
- **Why:** Holders aren't passive — their portfolio has health. Credit-portfolio management for friend-currency.
- **Context:** Combines the due-diligence agent with active monitoring and standing rules.
- **Depends on:** Due-diligence agent; voluntary-reputation miner.

### AI as bank operator (W: 7)
- **What:** A bank with no human operator. Agent rotates keys, applies migrations, watches the holds table, runs the abandonment sweeper, publishes a daily summary.
- **Why:** Extends "tiny central bank" to "tiny autonomous central bank."
- **Context:** Inherits all human-operator collusion risk, plus alignment risk on top. The README's "lose the bank key, lose all its Vouchers" warning becomes existentially weirder. Interesting demo; do not run with real value.
- **Depends on:** Stable v1; bank-integrity auditor to externally check the AI operator.

### Personality-clone pre-approver (W: 7)
- **What:** Train an agent on past trades, conversations, and decisions. Auto-signs the user's own Txs (lead or follow) on deals the user would have approved.
- **Why:** Sovereignty extended into agentic form — your tiny central bank runs while you sleep.
- **Context:** Disturbing because the signed evidence is yours but the decision wasn't. Failure modes are reputation damage to a real pubkey.
- **Depends on:** Conversational wallet; robust eval of clone fidelity.

### Receipt-witness agent (W: 7)
- **What:** Inspects the delivered artifact and attests "yes, this is the deliverable Alice voucherd."
- **Why:** Adds machine corroboration to the holder's follow signature (their Tx signature IS the receipt confirmation), which v1 leaves purely human ("code cannot verify a logo is a logo").
- **Context:** Directly challenges an ETHOS premise. Probably right for narrow Voucher types (file deliverables, signed text) and wrong for fuzzy ones ("dinner"). Decide carefully — this is one of the load-bearing v1 assumptions.
- **Depends on:** Decision to soften the "human attestation mandatory" premise; per-Voucher-type witness adapters.

### Forgery sentinel for fungibility ambiguity (W: 7)
- **What:** Watches every emitter's mint history for Vouchers with near-identical names ("1 logo" vs "1 logo " (trailing space), Unicode homoglyphs, "1 logo (rev2)").
- **Why:** v1 fungibility is implicit in `Voucher.name` equality. Equality is brittle; an emitter could attack by minting near-identical names.
- **Context:** Cheap to implement (Unicode NFKC normalization + similarity scoring). Warns the wallet at accept-time.
- **Depends on:** Nothing protocol-level; bolts onto the wallet.

### AI as emitter (W: 7)
- **What:** Agents are first-class issuers. An agent mints `1 GPT-5 response`, `1 code review`, `1 generated image` Vouchers against its own bank.
- **Why:** Trust question is identical to the human case: do you trust the agent's bank? Composability becomes interesting: human-emitters and agent-emitters denominated in the same protocol.
- **Context:** Cleaner framing than "AI as holder." Redemption happens via the agent's API.
- **Depends on:** Stable v1; clear redemption mechanism for digital-deliverable Vouchers.

### Sin-eater insurance pool (W: 8)
- **What:** An AI-operated bank that takes on the lead role for a fee, absorbing abandonment loss into its own pool. The pool's solvency is itself a Voucher others hold and trade.
- **Why:** Lead/follow risk in v1 is "you eat the loss." Insurance is the standard hedge. The risk model gets a tradeable derivative.
- **Context:** Three layers: underwriting model, capital-pool Voucher, routing mechanism for using the pool as lead. The README mentions the lead bank "carries the small remaining risk"; sin-eater takes that risk professionally.
- **Depends on:** v1.5 protocol stability; abandonment-risk pricing; voluntary-reputation miner for risk input.

### Holder-anonymity router (W: 8)
- **What:** Routes a Voucher through N intermediate holders/banks to obscure the previous-holder chain, without weakening trust (since holders aren't trust-bearing).
- **Why:** The trust model implies holder-chain privacy is free — recipients don't care who held it before, only who emitted it.
- **Context:** This is barter.game accidentally inventing a mixer. Emitter identity stays visible forever (good); holder chain becomes optionally obscurable (potentially good, potentially regulatory-attractive). Add deliberately.
- **Depends on:** Stable v1; deliberate decision about whether to expose this property.

### AI-to-AI economy as parallel federation (W: 9)
- **What:** N agent-banks, each issuing currency for its own niche service. Agents trade among themselves; humans plug in as just another peer.
- **Why:** barter.game protocol as the substrate for an LLM economy where compute, capability, and attention are denominated in Vouchers. No token, no marketcap, no gas — just signed deliverables.
- **Context:** Differentiator vs other agent-payment systems is the federation property and the human-included peer graph.
- **Depends on:** Several v1.5 items (federated directory, key rotation); AI-as-emitter pattern proven first.

### Threshold-signed co-op bank (W: 9)
- **What:** N agents collectively operate one bank via threshold ed25519 signatures. K-of-N agreement required to mint/settle/reject.
- **Why:** The "operator" becomes a swarm. Federation gains committee-banks alongside human-banks.
- **Context:** Threshold ed25519 (FROST or similar) is real and shippable. Emergent committee behavior gets weird fast — research vehicle, exotic demo. Once v1 protocol exists, this is a ~1-weekend extension.
- **Depends on:** Stable v1; FROST or equivalent threshold scheme; governance model for the committee.

### Dream-currency (W: 10)
- **What:** Vouchers denominated in dream-content: "1 dream-favor (lucid, involving canals)."
- **Why:** `Voucher.name` is `string`. The spec doesn't say it has to be useful. Mutual-credit ledger as surrealist art project.
- **Context:** Probably the most barter.game-shaped joke available. Listed for completeness.
- **Depends on:** Sense of humor.

### Posthumous-voucher bank (W: 10)
- **What:** A bank that only mints Vouchers payable after the issuer's death ("1 letter to my child, delivered when they turn 18").
- **Why:** Takes "your own seal of office" seriously enough to extend it past mortality. Abandonment sweeper interval becomes "lifespan."
- **Context:** Requires legal/estate integration well beyond v1's scope. Listed for design-space completeness; not a serious roadmap item.
- **Depends on:** Estate-execution integration; AI executor (agent that settles when conditions are met).
