---
title: For Event Managers
---

## Turn your event into a marketplace of promises

The best networking happens when people trade real value, not just business cards. barter.game lets your attendees mint personal currencies — "1 intro to my investor", "1 portfolio review", "1 lunch conversation" — and trade them on the spot.

## Why add a promise marketplace?

- **Attendees leave with concrete value**, not just LinkedIn connections.
- **Icebreaker built in.** "What can you offer? What do you need?" becomes the opening line.
- **No cash required.** Mutual credit means nobody needs to pre-fund anything. Issuers go negative; holders go positive. The math balances.
- **Federation means no vendor lock-in.** You run a bank for the event; attendees can keep using it afterward, or move to their own.

## How it works at an event

1. **You deploy a bank** (or we do it for you). It takes 10 minutes. See the [self-hoster guide](../for-self-hosters).
2. **Attendees `barter init`** against your bank URL. They now have a wallet.
3. **They mint promises** — whatever they can deliver. "1 design review." "1 investor intro." "1 yoga class."
4. **They trade.** The protocol handles the cryptography. Attendees just scan a QR code or paste an invite string.
5. **They settle.** Balances update. The issuer now owes the holder a deliverable.

## What your attendees see

```bash
# At the event
barter init --bank https://your-event.barter.game/functions/v1/event-bank
barter mint "1 portfolio review"
barter trade --give ... --get ...
barter confirm <tx-hash>
barter settle <tx-hash>
```

Or, wrap this in a simple web UI (v1.5) and attendees never touch the terminal.

## The day after

Attendees leave holding signed promises. They can redeem them later — a coffee meetup next week, a design review over Zoom. The promise outlives the event. Your event becomes the *origin* of ongoing professional relationships, not just a one-day blur.

## Get started

- [Deploy a bank →](../for-self-hosters)
- [Read the developer docs →](../for-developers)
- [See the full protocol →](https://github.com/ai-1st/barter.game/blob/main/PROTOCOL.md)

Want help running this at your event? Open an issue on GitHub and we'll figure it out together.
