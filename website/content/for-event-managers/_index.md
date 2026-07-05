---
title: For Event Managers
---

## Turn your event into a marketplace of vouchers

The best networking happens when people trade real value, not just business cards. barter.game lets your attendees mint personal currencies — "1 intro to my investor", "1 portfolio review", "1 lunch conversation" — and trade them on the spot.

## Why add a voucher marketplace?

- **Attendees leave with concrete value**, not just LinkedIn connections.
- **Icebreaker built in.** "What can you offer? What do you need?" becomes the opening line.
- **No cash required.** Mutual credit means nobody needs to pre-fund anything. Issuers go negative; holders go positive. The math balances.
- **Federation means no vendor lock-in.** You run a bank for the event; attendees can keep using it afterward, or move to their own.

## How it works at an event

1. **You deploy a bank** (or we do it for you). It takes 10 minutes. See the [self-hoster guide](../for-self-hosters).
2. **Attendees open your bank's web UI** (`<your-bank-url>/ui`) and register with a handle and password. They now have a wallet.
3. **They mint vouchers** — whatever they can deliver. "1 design review." "1 investor intro." "1 yoga class."
4. **They trade.** The protocol handles the cryptography. Attendees just scan a QR code or paste an invite string, then place a signed order — the web app coordinates the rest.
5. **Banks settle on their own.** Once both sides have signed, balances update. The issuer now owes the holder a deliverable.

## What your attendees see

1. **Open the bank's web UI** — `https://your-event.example/event-bank/ui` — and register with a handle and password. The key is generated and encrypted right in the browser.
2. **Mint a voucher** — "1 portfolio review", up to 5 of them.
3. **Share the QR code.** Anyone who scans it sees the voucher and can propose a trade.
4. **Place an order** — give 1 "portfolio review", get 1 of theirs. The app creates the ledger records and clears the orders; the banks settle on their own.
5. **Watch the balances land** in the wallet.

That's the whole flow — the web UI ships with every bank today, and attendees never touch a terminal.

## The day after

Attendees leave holding signed vouchers. They can redeem them later — a coffee meetup next week, a design review over Zoom. The voucher outlives the event. Your event becomes the *origin* of ongoing professional relationships, not just a one-day blur.

## Get started

- [Deploy a bank →](../for-self-hosters)
- [Read the developer docs →](../for-developers)
- [See the full protocol →](https://github.com/ai-1st/barter.game/blob/main/protocol/README.md)

Want help running this at your event? Open an issue on GitHub and we'll figure it out together.
