#!/usr/bin/env bash
# N-party demo: four users on four banks complete a branching/merging deal
# under the direct-approval model.
#
#     A → C     B → C     C → D     D → A     D → B
#
# Leads are A's and B's banks (they settle first, bearing the risk). The deal
# closes A→C→D→A and B→C→D→B. Each bank only ever sees its OWN voucher's
# transfers — never the whole deal (PROTOCOL.md §2 Visibility).
#
# Flow: mint (the first record pair) → local receiving accounts (implicit,
# no bank call) → A initiates the deal (records + lead Tx + cross-bank
# subscriptions) → B, C, D accept their deal tokens (follow Txs) → the BANKS
# self-advance through hold and settle → nudge relays any lost pushes.
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
DEAL_FILE=/tmp/barter-demo-deal.json

step()   { printf "\n\033[1;36m═══ %s ═══\033[0m\n" "$*"; }
detail() { printf "  %s\n" "$*"; }
cli()    { bun run apps/cli/src/index.ts "$@"; }
pubof()  { curl -fsS "$1/barter-bank.json" | jq -r .pubkey; }

cd "$(dirname "$0")/.."

step "1. Four fresh profiles (A, B, C, D) on four banks"
rm -f "$A" "$B" "$C" "$D"; rm -rf /tmp/deals /tmp/docs
BARTER_PROFILE=$A cli init --bank "$ALICE_BANK" >/dev/null
BARTER_PROFILE=$B cli init --bank "$BOB_BANK"   >/dev/null
BARTER_PROFILE=$C cli init --bank "$CAROL_BANK" >/dev/null
BARTER_PROFILE=$D cli init --bank "$DAVE_BANK"  >/dev/null
APUB=$(jq -r .pubkey "$A"); BPUB=$(jq -r .pubkey "$B")
CPUB=$(jq -r .pubkey "$C"); DPUB=$(jq -r .pubkey "$D")
ABANK=$(pubof "$ALICE_BANK"); BBANK=$(pubof "$BOB_BANK")
CBANK=$(pubof "$CAROL_BANK"); DBANK=$(pubof "$DAVE_BANK")
detail "A=$APUB  B=$BPUB  C=$CPUB  D=$DPUB"

step "2. Each user mints their coin — the mint IS the first record pair"
OUT=$(BARTER_PROFILE=$A cli mint "A-coin demo" --amount 1 --integer)
ACOIN=$(echo "$OUT" | awk '/voucher hash:/{print $3}');  AHOLD=$(echo "$OUT" | awk '/holding account:/{print $3}')
OUT=$(BARTER_PROFILE=$B cli mint "B-coin demo" --amount 1 --integer)
BCOIN=$(echo "$OUT" | awk '/voucher hash:/{print $3}');  BHOLD=$(echo "$OUT" | awk '/holding account:/{print $3}')
OUT=$(BARTER_PROFILE=$C cli mint "C-coin demo" --amount 2 --integer)
CCOIN=$(echo "$OUT" | awk '/voucher hash:/{print $3}');  CHOLD=$(echo "$OUT" | awk '/holding account:/{print $3}')
OUT=$(BARTER_PROFILE=$D cli mint "D-coin demo" --amount 2 --integer)
DCOIN=$(echo "$OUT" | awk '/voucher hash:/{print $3}');  DHOLD=$(echo "$OUT" | awk '/holding account:/{print $3}')
detail "minted A/B/C/D coins (issue −N, holding +N)"

step "3. Receivers author accounts locally — implicit, no bank call"
CACC_A=$(BARTER_PROFILE=$C cli account "$ACOIN" | awk '/account hash:/{print $3}')  # C gets A-coin
CACC_B=$(BARTER_PROFILE=$C cli account "$BCOIN" | awk '/account hash:/{print $3}')  # C gets B-coin
DACC_C=$(BARTER_PROFILE=$D cli account "$CCOIN" | awk '/account hash:/{print $3}')  # D gets C-coin
AACC_D=$(BARTER_PROFILE=$A cli account "$DCOIN" | awk '/account hash:/{print $3}')  # A gets D-coin
BACC_D=$(BARTER_PROFILE=$B cli account "$DCOIN" | awk '/account hash:/{print $3}')  # B gets D-coin
detail "5 receiving accounts authored (bodies travel with the deal)"

step "4. A initiates the deal — records, subscriptions, lead Tx"
cat > "$DEAL_FILE" <<JSON
{
  "leadBanks": ["$ABANK", "$BBANK"],
  "banks": {
    "$ABANK": "$ALICE_BANK",
    "$BBANK": "$BOB_BANK",
    "$CBANK": "$CAROL_BANK",
    "$DBANK": "$DAVE_BANK"
  },
  "transfers": [
    { "voucher": "$ACOIN", "issuerBank": "$ABANK", "amount": 1, "from": { "holder": "$APUB", "account": "$AHOLD" }, "to": { "holder": "$CPUB", "account": "$CACC_A" } },
    { "voucher": "$BCOIN", "issuerBank": "$BBANK", "amount": 1, "from": { "holder": "$BPUB", "account": "$BHOLD" }, "to": { "holder": "$CPUB", "account": "$CACC_B" } },
    { "voucher": "$CCOIN", "issuerBank": "$CBANK", "amount": 2, "from": { "holder": "$CPUB", "account": "$CHOLD" }, "to": { "holder": "$DPUB", "account": "$DACC_C" } },
    { "voucher": "$DCOIN", "issuerBank": "$DBANK", "amount": 1, "from": { "holder": "$DPUB", "account": "$DHOLD" }, "to": { "holder": "$APUB", "account": "$AACC_D" } },
    { "voucher": "$DCOIN", "issuerBank": "$DBANK", "amount": 1, "from": { "holder": "$DPUB", "account": "$DHOLD" }, "to": { "holder": "$BPUB", "account": "$BACC_D" } }
  ]
}
JSON
OUT=$(BARTER_PROFILE=$A cli deal "$DEAL_FILE"); echo "$OUT" | grep -v '^token ' | sed 's/^/  /'
DEAL=$(echo "$OUT" | awk '/deal:/{print $2; exit}')
TOKEN_B=$(echo "$OUT" | awk -v p="$BPUB" '$1=="token" && $2==p {print $3}')
TOKEN_C=$(echo "$OUT" | awk -v p="$CPUB" '$1=="token" && $2==p {print $3}')
TOKEN_D=$(echo "$OUT" | awk -v p="$DPUB" '$1=="token" && $2==p {print $3}')

step "5. B, C, D accept their deal tokens (follow-sign their own Txs)"
BARTER_PROFILE=$B cli accept "$TOKEN_B" >/dev/null && detail "B accepted"
BARTER_PROFILE=$C cli accept "$TOKEN_C" >/dev/null && detail "C accepted"
BARTER_PROFILE=$D cli accept "$TOKEN_D" >/dev/null && detail "D accepted"

step "6. Banks self-advance: approve → hold → settle (no client settle call)"
BARTER_PROFILE=$A cli nudge "$DEAL" >/dev/null   # relay any lost pushes
BARTER_PROFILE=$A cli status "$DEAL" | sed 's/^/  /'

step "7. Post-trade balances (sum per coin = 0)"
detail "A-coin @ bank-alice:";  BARTER_PROFILE=$A cli inbox --bank "$ALICE_BANK" | sed 's/^/    /'
detail "B-coin @ bank-bob:";    BARTER_PROFILE=$B cli inbox --bank "$BOB_BANK"   | sed 's/^/    /'
detail "C-coin @ bank-carol:";  BARTER_PROFILE=$C cli inbox --bank "$CAROL_BANK" | sed 's/^/    /'
detail "D-coin @ bank-dave:";   BARTER_PROFILE=$D cli inbox --bank "$DAVE_BANK"  | sed 's/^/    /'

printf "\n\033[1;32mMulti-party deal complete.\033[0m Each bank saw only its own coin's legs.\n"
printf "  deal: %s\n" "$DEAL"
