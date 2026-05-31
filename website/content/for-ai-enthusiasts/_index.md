---
title: For AI Enthusiasts
---

## AI agents playing barter.game

The barter.game protocol does not care who holds the private key. It could be a human. It could be an organization. It could be an AI agent. The wire format is the same. The invariants are the same. The settlement cascade is the same.

This makes barter.game an unusually clean substrate for agent economies.

## What an AI agent can be

### AI as holder

An agent holds promises in its "wallet" (a keypair + client logic) and trades them based on instructions. "Auto-accept any trade from Alice ≤ 5 logos." "Decline any trade where I'm asked to be lead on an amount > 10." The agent is just a client with a policy loop.

### AI as emitter

An agent mints its own promises. "1 GPT-5 response." "1 code review." "1 generated image." The agent runs its own bank (or uses a hosted one) and redeems promises via its API. Humans and other agents can hold and trade these promises.

This is cleaner than "AI as holder" because the trust question is identical to the human case: do you trust the agent's bank? Redemption is just an API call.

### AI as bank operator

An agent runs the full bank stack: holds the bank private key, validates RPCs, manages the database, runs the abandonment sweeper, publishes daily summaries. A tiny autonomous central bank.

This is exotic and risky — an AI with signing authority over a ledger — but the protocol supports it natively. The bank is just a process with a keypair.

## Why barter.game for agent economies?

Most agent-payment proposals assume:
- A single token (problem: whose token?)
- A central clearing house (problem: who runs it?)
- Smart contracts with gas fees (problem: friction, speculation)

barter.game assumes none of these. It gives you:
- **Federation:** Any agent can be a bank. No permission needed.
- **Mutual credit:** No pre-funding, no gas, no token speculation.
- **Signed promises:** Every deal is cryptographically verifiable. Agents can audit each other's history.
- **Content-addressed docs:** Perfect for agents that reason over graphs and hashes.

## Experiments to try

### 1. Two agents, one trade

Spin up two agent processes. Give each a keypair and a bank. Have one mint "1 computation unit." Have the other mint "1 data unit." Let them negotiate a trade via LLM conversation, then sign and settle it through the protocol.

### 2. Agent portfolio manager

An agent watches its inbox and maintains a "credit memo" on every emitter it holds promises from. It reads mint history, abandonment rates, and redemption track records from the public signed evidence. It advises its owner (human or another agent) on which promises to accept, hold, or liquidate.

### 3. AI-to-AI ring trade

Three agents. Agent A offers image generation. Agent B offers text summarization. Agent C offers code review. They form a ring: A → B → C → A. The client (which could be a fourth coordinating agent) builds the graph and drives the settle cascade.

### 4. Threshold-signed co-op bank

N agents collectively operate one bank via threshold ed25519 signatures (FROST). K-of-N agreement required to mint, settle, or reject. The "operator" becomes a swarm.

### 5. The sin-eater

An AI-operated bank that takes on the lead role for a fee, absorbing abandonment loss into its own pool. It underwrites risk by reading the signed history of counterparties. The pool's solvency is itself a Promise that others hold and trade.

## The trust question

When an AI agent asks you to hold its promise, the question is the same as when a human does: **do you trust the emitter to deliver?** The protocol does not answer this. It just records your answer.

For AI emitters, "delivery" means the agent's API is available and produces the promised output. An agent that mints "1 code review" and never responds is no different from a human who mints "1 logo" and never delivers. The social layer handles both.

## Getting started

1. Read the [developer docs](../for-developers) to understand the protocol.
2. Read the [player guide](../for-players) to understand the social dynamics.
3. Pick an experiment above.
4. Open an issue on GitHub to share what you build.

The protocol is small. The design space is enormous.
