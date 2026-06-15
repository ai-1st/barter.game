#!/usr/bin/env bash
# N-party demo against deployed Deno Deploy banks.
#
# Set the bank URLs before running:
#   export BARTER_BANK_ALICE_URL=https://your-project.deno.dev/alice
#   export BARTER_BANK_BOB_URL=https://your-project.deno.dev/bob
#   export BARTER_BANK_CAROL_URL=https://your-project.deno.dev/carol
#   export BARTER_BANK_DAVE_URL=https://your-project.deno.dev/dave
#   ./scripts/demo-deploy.sh
#
# This script is identical to demo-local.sh except it does not start a server.

set -euo pipefail
export PATH="$HOME/.bun/bin:$PATH"

cd "$(dirname "$0")/.."

ALICE_BANK="${BARTER_BANK_ALICE_URL:?set BARTER_BANK_ALICE_URL}"
BOB_BANK="${BARTER_BANK_BOB_URL:?set BARTER_BANK_BOB_URL}"
CAROL_BANK="${BARTER_BANK_CAROL_URL:?set BARTER_BANK_CAROL_URL}"
DAVE_BANK="${BARTER_BANK_DAVE_URL:?set BARTER_BANK_DAVE_URL}"

A=/tmp/barter-demo-alice.json
B=/tmp/barter-demo-bob.json
C=/tmp/barter-demo-carol.json
D=/tmp/barter-demo-dave.json
DEAL_FILE=/tmp/barter-demo-deal.json

step()   { printf "\n\033[1;36m═══ %s ═══\033[0m\n" "$*"; }
detail() { printf "  %s\n" "$*"; }
cli()    { bun run apps/cli/src/index.ts "$@"; }
pubof()  { curl -fsS "$1/barter-bank.json" | jq -r .pubkey; }

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

step "2. Each user mints their coin"
OUT=$(BARTER_PROFILE=$A cli mint "A-coin demo" --amount 1 --integer)
ACOIN=$(echo "$OUT" | awk '/voucher hash:/{print $3}');  AHOLD=$(echo "$OUT" | awk '/holding account:/{print $3}')
OUT=$(BARTER_PROFILE=$B cli mint "B-coin demo" --amount 1 --integer)
BCOIN=$(echo "$OUT" | awk '/voucher hash:/{print $3}');  BHOLD=$(echo "$OUT" | awk '/holding account:/{print $3}')
OUT=$(BARTER_PROFILE=$C cli mint "C-coin demo" --amount 2 --integer)
CCOIN=$(echo "$OUT" | awk '/voucher hash:/{print $3}');  CHOLD=$(echo "$OUT" | awk '/holding account:/{print $3}')
OUT=$(BARTER_PROFILE=$D cli mint "D-coin demo" --amount 2 --integer)
DCOIN=$(echo "$OUT" | awk '/voucher hash:/{print $3}');  DHOLD=$(echo "$OUT" | awk '/holding account:/{print $3}')
detail "minted A/B/C/D coins"

step "3. Receivers author accounts locally"
CACC_A=$(BARTER_PROFILE=$C cli account "$ACOIN" | awk '/account hash:/{print $3}')
CACC_B=$(BARTER_PROFILE=$C cli account "$BCOIN" | awk '/account hash:/{print $3}')
DACC_C=$(BARTER_PROFILE=$D cli account "$CCOIN" | awk '/account hash:/{print $3}')
AACC_D=$(BARTER_PROFILE=$A cli account "$DCOIN" | awk '/account hash:/{print $3}')
BACC_D=$(BARTER_PROFILE=$B cli account "$DCOIN" | awk '/account hash:/{print $3}')
detail "5 receiving accounts authored"

step "4. A initiates the deal"
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

step "5. B, C, D accept their deal tokens"
BARTER_PROFILE=$B cli accept "$TOKEN_B" >/dev/null && detail "B accepted"
BARTER_PROFILE=$C cli accept "$TOKEN_C" >/dev/null && detail "C accepted"
BARTER_PROFILE=$D cli accept "$TOKEN_D" >/dev/null && detail "D accepted"

step "6. Banks self-advance; nudge relays any lost pushes"
BARTER_PROFILE=$A cli nudge "$DEAL" >/dev/null
BARTER_PROFILE=$A cli status "$DEAL" | sed 's/^/  /'

step "7. Post-trade balances"
detail "A-coin @ alice:";  BARTER_PROFILE=$A cli inbox --bank "$ALICE_BANK" | sed 's/^/    /'
detail "B-coin @ bob:";    BARTER_PROFILE=$B cli inbox --bank "$BOB_BANK"   | sed 's/^/    /'
detail "C-coin @ carol:";  BARTER_PROFILE=$C cli inbox --bank "$CAROL_BANK" | sed 's/^/    /'
detail "D-coin @ dave:";   BARTER_PROFILE=$D cli inbox --bank "$DAVE_BANK"  | sed 's/^/    /'

printf "\n\033[1;32mMulti-party deal complete.\033[0m\n"
printf "  deal: %s\n" "$DEAL"
