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
2. **Pocket** docs — two distinct Pockets, one for the issuer's negative-balance row and one for the issuer's positive-balance row. Pocket bodies stay on Alice's machine; banks see only the pocket hashes inside Account docs.
   ```ts
   { type: "pocket", pubkey: A.pub, ulid: <new>, name: "issuance" }
   { type: "pocket", pubkey: A.pub, ulid: <new>, name: "inventory" }
   ```
3. **Account** docs. Accounts are NOT signed.
   ```ts
   { type: "account", holder: A.pub, pocket: <issuance-pocket-hash>, promise: <promise-hash> }
   { type: "account", holder: A.pub, pocket: <inventory-pocket-hash>, promise: <promise-hash> }
   ```

Alice signs only the Promise doc. Account and Pocket docs are not signed.

## Step 2 — Alice calls `mint`

```json
{
  "jsonrpc": "2.0",
  "id": <ulid>,
  "method": "mint",
  "params": {
    "promise": <promise-doc>,
    "accounts": [<account-1>, <account-2>],
    "amount": 10
  },
  "pubkey": A.pub,
  "to": Abank.pub,
  "sig": <alice-sig-over-envelope>
}
```

`mint` is a single-bank, single-signer operation, so the bank settles it immediately. No `ready` or `hold` step is required.

## Step 3 — Abank validates and stores

Abank checks:

- `promise.pubkey == A.pub`.
- `promise.bank == Abank.pub`.
- Both Accounts reference `promise` and use distinct Pocket hashes.
- Alice's signature on the Promise is valid.

Abank stores:

- Promise doc.
- Two Account docs.
- (Pocket bodies are never stored by the bank.)

Abank mints a debit/credit record pair for the requested `amount` and applies the deltas immediately:

- `<issuance-account>`: `-10` (the negative-balance issuance row).
- `<inventory-account>`: `+10` (the positive-balance inventory row).

The Promise now exists with a net-zero position across the two issuer accounts: `-10 + 10 = 0`. The issuer creates value by transferring from the negative-balance row to a holder.

## Step 4 — Abank issues settlement signatures

Abank creates and signs record-level `settle` Signatures for each of the freshly created records. No separate `ack` attestation is needed; the Promise itself is the signed declaration.

Abank returns these signatures and the record pair to Alice.

## Result

Alice now has:

- A published Promise at `<promise-hash>`.
- Two Accounts at Abank for that Promise.
- A settled debit/credit record pair showing the Promise's initial position.

She can now receive consulting-hour payments into the inventory account or transfer consulting hours out of the issuance account.
