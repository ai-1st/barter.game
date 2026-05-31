#!/usr/bin/env bash
# N-party demo: four users on four banks complete a branching/merging deal.
#
#     A → C     B → C     C → D     D → A     D → B
#
# Leads are A's and B's banks (they settle first, bearing the risk). The deal
# closes A→C→D→A and B→C→D→B. Crucially, each bank only ever sees its OWN
# promise's transfers — never the whole deal (PROTOCOL.md §2 Visibility).
#
# Run: ./scripts/demo.sh
# Requires: bun + jq on PATH; a Supabase project with bank-alice, bank-bob,
# bank-carol, bank-dave deployed (and BANK_<NAME>_PRIV_KEY secrets set).

set -euo pipefail
export PATH="$HOME/.bun/bin:$PATH"

PROJ="${BARTER_PROJECT_URL:-https://tcoadwhcqwdnlobxrxod.supabase.co}"
ALICE_BANK="${ALICE_BANK:-$PROJ/functions/v1/bank-alice}"
BOB_BANK="${BOB_BANK:-$PROJ/functions/v1/bank-bob}"
CAROL_BANK="${CAROL_BANK:-$PROJ/functions/v1/bank-carol}"
DAVE_BANK="${DAVE_BANK:-$PROJ/functions/v1/bank-dave}"

A=/tmp/barter-demo-alice.json
B=/tmp/barter-demo-bob.json
C=/tmp/barter-demo-carol.json
D=/tmp/barter-demo-dave.json
DEAL=/tmp/barter-demo-deal.json

step()   { printf "\n\033[1;36m═══ %s ═══\033[0m\n" "$*"; }
detail() { printf "  %s\n" "$*"; }
cli()    { bun run apps/cli/src/index.ts "$@"; }
pubof()  { curl -fsS "$1/.well-known/barter-bank.json" | jq -r .pubkey; }

cd "$(dirname "$0")/.."

step "1. Four fresh profiles (A, B, C, D) on four banks"
rm -f "$A" "$B" "$C" "$D"; rm -rf /tmp/deals
BARTER_PROFILE=$A cli init --bank "$ALICE_BANK" >/dev/null
BARTER_PROFILE=$B cli init --bank "$BOB_BANK"   >/dev/null
BARTER_PROFILE=$C cli init --bank "$CAROL_BANK" >/dev/null
BARTER_PROFILE=$D cli init --bank "$DAVE_BANK"  >/dev/null
APUB=$(jq -r .pubkey "$A"); BPUB=$(jq -r .pubkey "$B")
CPUB=$(jq -r .pubkey "$C"); DPUB=$(jq -r .pubkey "$D")
ABANK=$(pubof "$ALICE_BANK"); BBANK=$(pubof "$BOB_BANK")
CBANK=$(pubof "$CAROL_BANK"); DBANK=$(pubof "$DAVE_BANK")
detail "A=$APUB  B=$BPUB  C=$CPUB  D=$DPUB"

step "2. Each user mints their own coin on their home bank"
OUT=$(BARTER_PROFILE=$A cli mint "A-coin demo" --integer); ACOIN=$(echo "$OUT" | awk '/promise hash:/{print $3}'); AACC_A=$(echo "$OUT" | awk '/account hash:/{print $3}')
OUT=$(BARTER_PROFILE=$B cli mint "B-coin demo" --integer); BCOIN=$(echo "$OUT" | awk '/promise hash:/{print $3}'); BACC_B=$(echo "$OUT" | awk '/account hash:/{print $3}')
OUT=$(BARTER_PROFILE=$C cli mint "C-coin demo" --integer); CCOIN=$(echo "$OUT" | awk '/promise hash:/{print $3}'); CACC_C=$(echo "$OUT" | awk '/account hash:/{print $3}')
OUT=$(BARTER_PROFILE=$D cli mint "D-coin demo" --integer); DCOIN=$(echo "$OUT" | awk '/promise hash:/{print $3}'); DACC_D=$(echo "$OUT" | awk '/account hash:/{print $3}')
detail "minted A/B/C/D coins"

step "3. Receivers open accounts for the coins they'll get"
CACC_A=$(BARTER_PROFILE=$C cli open "$ACOIN" --bank "$ALICE_BANK" | awk '/account hash:/{print $3}')  # C gets A-coin
CACC_B=$(BARTER_PROFILE=$C cli open "$BCOIN" --bank "$BOB_BANK"   | awk '/account hash:/{print $3}')  # C gets B-coin
DACC_C=$(BARTER_PROFILE=$D cli open "$CCOIN" --bank "$CAROL_BANK" | awk '/account hash:/{print $3}')  # D gets C-coin
AACC_D=$(BARTER_PROFILE=$A cli open "$DCOIN" --bank "$DAVE_BANK"  | awk '/account hash:/{print $3}')  # A gets D-coin
BACC_D=$(BARTER_PROFILE=$B cli open "$DCOIN" --bank "$DAVE_BANK"  | awk '/account hash:/{print $3}')  # B gets D-coin
detail "opened 5 receiving accounts"

step "4. Build the deal (A is the proposer / coordinator)"
cat > "$DEAL" <<JSON
{
  "leadBanks": ["$ABANK", "$BBANK"],
  "banks": {
    "$ABANK": "$ALICE_BANK",
    "$BBANK": "$BOB_BANK",
    "$CBANK": "$CAROL_BANK",
    "$DBANK": "$DAVE_BANK"
  },
  "transfers": [
    { "promise": "$ACOIN", "issuerBank": "$ABANK", "amount": 1, "from": { "holder": "$APUB", "account": "$AACC_A" }, "to": { "holder": "$CPUB", "account": "$CACC_A" } },
    { "promise": "$BCOIN", "issuerBank": "$BBANK", "amount": 1, "from": { "holder": "$BPUB", "account": "$BACC_B" }, "to": { "holder": "$CPUB", "account": "$CACC_B" } },
    { "promise": "$CCOIN", "issuerBank": "$CBANK", "amount": 2, "from": { "holder": "$CPUB", "account": "$CACC_C" }, "to": { "holder": "$DPUB", "account": "$DACC_C" } },
    { "promise": "$DCOIN", "issuerBank": "$DBANK", "amount": 1, "from": { "holder": "$DPUB", "account": "$DACC_D" }, "to": { "holder": "$APUB", "account": "$AACC_D" } },
    { "promise": "$DCOIN", "issuerBank": "$DBANK", "amount": 1, "from": { "holder": "$DPUB", "account": "$DACC_D" }, "to": { "holder": "$BPUB", "account": "$BACC_D" } }
  ]
}
JSON
OUT=$(BARTER_PROFILE=$A cli deal "$DEAL"); echo "$OUT" | sed 's/^/  /'
TX=$(echo "$OUT" | awk '/tx hash:/{print $3}')

step "5. Every holder confirms receipt at each bank they touch"
detail "A confirms (bank-alice gives, bank-dave gets):"
BARTER_PROFILE=$A cli confirm "$TX" --bank "$ALICE_BANK" --bank "$DAVE_BANK" >/dev/null && detail "  ok"
detail "B confirms (bank-bob gives, bank-dave gets):"
BARTER_PROFILE=$B cli confirm "$TX" --bank "$BOB_BANK" --bank "$DAVE_BANK" >/dev/null && detail "  ok"
detail "C confirms (bank-alice + bank-bob get, bank-carol gives):"
BARTER_PROFILE=$C cli confirm "$TX" --bank "$ALICE_BANK" --bank "$BOB_BANK" --bank "$CAROL_BANK" >/dev/null && detail "  ok"
detail "D confirms (bank-carol gets, bank-dave gives):"
BARTER_PROFILE=$D cli confirm "$TX" --bank "$CAROL_BANK" --bank "$DAVE_BANK" >/dev/null && detail "  ok"

step "6. Proposer settles — cascade: {alice, bob} → carol → dave"
BARTER_PROFILE=$A cli settle "$TX" | sed 's/^/  /'

step "7. Post-trade balances (sum per coin = 0)"
detail "A-coin @ bank-alice:";  BARTER_PROFILE=$A cli inbox --bank "$ALICE_BANK" | sed 's/^/    /'
detail "B-coin @ bank-bob:";    BARTER_PROFILE=$B cli inbox --bank "$BOB_BANK"   | sed 's/^/    /'
detail "C-coin @ bank-carol:";  BARTER_PROFILE=$C cli inbox --bank "$CAROL_BANK" | sed 's/^/    /'
detail "D-coin @ bank-dave:";   BARTER_PROFILE=$D cli inbox --bank "$DAVE_BANK"  | sed 's/^/    /'

printf "\n\033[1;32mMulti-party deal complete.\033[0m Each bank saw only its own coin's legs.\n"
printf "  tx hash: %s\n" "$TX"
