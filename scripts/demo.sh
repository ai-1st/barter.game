#!/usr/bin/env bash
# Full v1 demo: two users on two banks complete a cross-bank trade.
#
# Run: ./scripts/demo.sh
# Requires: bun on PATH, Supabase project with bank-alice and bank-bob deployed.

set -euo pipefail

export PATH="$HOME/.bun/bin:$PATH"

ALICE_BANK="${ALICE_BANK:-https://tcoadwhcqwdnlobxrxod.supabase.co/functions/v1/bank-alice}"
BOB_BANK="${BOB_BANK:-https://tcoadwhcqwdnlobxrxod.supabase.co/functions/v1/bank-bob}"
A=/tmp/barter-demo-alice.json
B=/tmp/barter-demo-bob.json

step() { printf "\n\033[1;36m═══ %s ═══\033[0m\n" "$*"; }
detail() { printf "  %s\n" "$*"; }

cd "$(dirname "$0")/.."

step "1. Two fresh profiles"
rm -f "$A" "$B"
BARTER_PROFILE=$A bun run apps/cli/src/index.ts init --bank "$ALICE_BANK" | sed 's/^/  /'
BARTER_PROFILE=$B bun run apps/cli/src/index.ts init --bank "$BOB_BANK" | sed 's/^/  /'
APUB=$(jq -r .pubkey "$A")
BPUB=$(jq -r .pubkey "$B")

step "2. Alice mints '1 logo' on bank-alice"
OUT=$(BARTER_PROFILE=$A bun run apps/cli/src/index.ts mint "1 logo demo" --integer)
echo "$OUT" | sed 's/^/  /'
LOGO=$(echo "$OUT" | awk '/promise hash:/ {print $3}')
ALOGO=$(echo "$OUT" | awk '/account hash:/ {print $3}')

step "3. Bob mints '1 hour consulting' on bank-bob"
OUT=$(BARTER_PROFILE=$B bun run apps/cli/src/index.ts mint "1 hour demo" --integer)
echo "$OUT" | sed 's/^/  /'
HOUR=$(echo "$OUT" | awk '/promise hash:/ {print $3}')
BHOUR=$(echo "$OUT" | awk '/account hash:/ {print $3}')

step "4. Bob opens an account for Alice's logo on bank-alice"
OUT=$(BARTER_PROFILE=$B bun run apps/cli/src/index.ts open "$LOGO" --bank "$ALICE_BANK")
echo "$OUT" | sed 's/^/  /'
BLOGO=$(echo "$OUT" | awk '/account hash:/ {print $3}')

step "5. Alice opens an account for Bob's hour on bank-bob"
OUT=$(BARTER_PROFILE=$A bun run apps/cli/src/index.ts open "$HOUR" --bank "$BOB_BANK")
echo "$OUT" | sed 's/^/  /'
AHOUR=$(echo "$OUT" | awk '/account hash:/ {print $3}')

step "6. Pre-trade balances"
detail "Alice on bank-alice:"
BARTER_PROFILE=$A bun run apps/cli/src/index.ts inbox --bank "$ALICE_BANK" | sed 's/^/    /'
detail "Bob on bank-bob:"
BARTER_PROFILE=$B bun run apps/cli/src/index.ts inbox --bank "$BOB_BANK" | sed 's/^/    /'

step "7. Alice proposes the trade (lead = bank-alice, follow = bank-bob)"
OUT=$(BARTER_PROFILE=$A bun run apps/cli/src/index.ts trade \
  --give "$LOGO:1" --get "$HOUR:1" \
  --my-give-account "$ALOGO" --peer-give-account "$BLOGO" \
  --peer-get-account "$BHOUR" --my-get-account "$AHOUR" \
  --peer-pubkey "$BPUB" --peer-bank "$BOB_BANK")
echo "$OUT" | sed 's/^/  /'
TX=$(echo "$OUT" | awk '/tx hash:/ {print $3}')

step "8. Both users sign confirm_receipt"
detail "Alice confirms:"
BARTER_PROFILE=$A bun run apps/cli/src/index.ts confirm "$TX" | sed 's/^/    /'
detail "Bob confirms:"
BARTER_PROFILE=$B bun run apps/cli/src/index.ts confirm "$TX" | sed 's/^/    /'

step "9. Alice (lead user) triggers settle on lead bank"
BARTER_PROFILE=$A bun run apps/cli/src/index.ts settle "$TX" | sed 's/^/  /'

step "10. Post-trade balances"
detail "Alice on bank-alice (issuer of 1 logo):"
BARTER_PROFILE=$A bun run apps/cli/src/index.ts inbox --bank "$ALICE_BANK" | sed 's/^/    /'
detail "Alice on bank-bob (holding 1 hour):"
BARTER_PROFILE=$A bun run apps/cli/src/index.ts inbox --bank "$BOB_BANK" | sed 's/^/    /'
detail "Bob on bank-alice (holding 1 logo):"
BARTER_PROFILE=$B bun run apps/cli/src/index.ts inbox --bank "$ALICE_BANK" | sed 's/^/    /'
detail "Bob on bank-bob (issuer of 1 hour):"
BARTER_PROFILE=$B bun run apps/cli/src/index.ts inbox --bank "$BOB_BANK" | sed 's/^/    /'

printf "\n\033[1;32mTrade complete.\033[0m Both banks settled; sum per promise = 0.\n"
printf "  tx hash: %s\n" "$TX"
