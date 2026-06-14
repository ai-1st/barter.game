# Scenario: Minting a Promise

Alice wants to issue a new Promise: "1 hour of consulting", backed by her bank Abank.

## Setup

- Alice: user keypair `A.pub` / `A.priv`.
- Abank: bank keypair `Abank.pub` / `Abank.priv`.
- Alice has not yet created any Pockets or Accounts for this Promise.

## Step 1 — Alice builds the docs

Alice creates:

1. **Promise** doc:
   ```ts
   {
     type: "promise",
     pubkey: A.pub,
     ulid: <new>,
     bank: Abank.pub,
     name: "1 hour of consulting"
   }
   ```
2. **Pocket** docs — two distinct Pockets, one for the issuer's negative-balance row and one for the issuer's positive-balance row:
   ```ts
   { type: "pocket", pubkey: A.pub, ulid: <new>, name: "issuance" }
   { type: "pocket", pubkey: A.pub, ulid: <new>, name: "inventory" }
   ```
3. **Account** docs:
   ```ts
   { type: "account", pubkey: A.pub, ulid: <new>, pocket: <issuance-pocket-hash>, promise: <promise-hash> }
   { type: "account", pubkey: A.pub, ulid: <new>, pocket: <inventory-pocket-hash>, promise: <promise-hash> }
   ```

Alice signs the Promise and both Accounts (Pockets are typically presented alongside but not always signed separately; the bank stores them as supporting docs).

## Step 2 — Alice calls `mint`

```json
{
  "jsonrpc": "2.0",
  "id": <ulid>,
  "method": "mint",
  "params": {
    "promise": <promise-doc>,
    "pockets": [<pocket-1>, <pocket-2>],
    "accounts": [<account-1>, <account-2>]
  },
  "pubkey": A.pub,
  "to": Abank.pub,
  "sig": <alice-sig-over-envelope>
}
```

## Step 3 — Abank validates and stores

Abank checks:

- `promise.pubkey == A.pub`.
- `promise.bank == Abank.pub`.
- Both Accounts reference `promise` and the two distinct Pockets.
- Alice's signatures on Promise and Accounts are valid.

Abank stores:

- Promise doc.
- Two Pocket docs.
- Two Account docs.

Abank initializes balances:

- `<issuance-account>`: `0` (will go negative when Alice transfers consulting hours out).
- `<inventory-account>`: `0` (will go positive when Alice receives consulting hours back, or can be pre-credited by the bank as the initial positive-balance row).

In the typical minting semantics, the Promise comes into existence with a net-zero position across the two issuer accounts: one negative-balance row and one positive-balance row, both starting at `0`. The issuer creates value by transferring from the negative-balance row to a holder.

## Step 4 — Abank issues attestation signatures

Abank creates and signs:

- A `Signature` over the Promise hash with `action="ack"` (or equivalent attestation).
- A `Signature` over each Account hash with `action="ack"`.

Abank returns these signatures to Alice.

## Result

Alice now has:

- A published Promise at `<promise-hash>`.
- Two Accounts at Abank for that Promise.
- Abank attestations she can show to counterparties as proof that Abank recognizes the Promise and Accounts.

She can now receive consulting-hour payments into the inventory account or transfer consulting hours out of the issuance account.
