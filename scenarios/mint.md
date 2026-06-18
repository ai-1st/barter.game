# Scenario: Minting a Voucher

Alice wants to issue a new Voucher: "1 hour of consulting", backed by her bank Abank.

## Setup

- Alice: user keypair `A.pub` / `A.priv`.
- Abank: bank keypair `Abank.pub` / `Abank.priv`.
- Alice has not yet created any Accounts or Accounts for this Voucher.

## Step 1 — Alice builds the docs

Alice creates:

1. **Voucher** doc:
   ```ts
   {
     type: "voucher",
     pubkey: A.pub,
     ulid: <new>,
     bank: Abank.pub,
     name: "1 hour of consulting"
   }
   ```
2. **Account** docs — two distinct Accounts, one for the issuer's negative-balance row and one for the issuer's positive-balance row. Account bodies stay on Alice's machine; banks see only the account hashes inside Account docs.
   ```ts
   { type: "account", pubkey: A.pub, ulid: <new>, name: "issuance" }
   { type: "account", pubkey: A.pub, ulid: <new>, name: "inventory" }
   ```
3. **Account** docs. Accounts are NOT signed.
   ```ts
   { type: "account", holder: A.pub, account: <issuance-account-hash>, voucher: <voucher-hash> }
   { type: "account", holder: A.pub, account: <inventory-account-hash>, voucher: <voucher-hash> }
   ```

Alice signs only the Voucher doc. Account and Account docs are not signed.

## Step 2 — Alice calls `mint`

```json
{
  "jsonrpc": "2.0",
  "id": <ulid>,
  "method": "mint",
  "params": {
    "voucher": <voucher-doc>,
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

- `voucher.pubkey == A.pub`.
- `voucher.bank == Abank.pub`.
- Both Accounts reference `voucher` and use distinct Account hashes.
- Alice's signature on the Voucher is valid.

Abank stores:

- Voucher doc.
- Two Account docs.
- (Account bodies are never stored by the bank.)

Abank mints a debit/credit record pair for the requested `amount` and applies the deltas immediately:

- `<issuance-account>`: `-10` (the negative-balance issuance row).
- `<inventory-account>`: `+10` (the positive-balance inventory row).

The Voucher now exists with a net-zero position across the two issuer accounts: `-10 + 10 = 0`. The issuer creates value by transferring from the negative-balance row to a holder.

## Step 4 — Abank issues settlement signatures

Abank creates and signs record-level `settle` Signatures for each of the freshly created records. No separate `ack` attestation is needed; the Voucher itself is the signed declaration.

Abank returns these signatures and the record pair to Alice.

## Result

Alice now has:

- A published Voucher at `<voucher-hash>`.
- Two Accounts at Abank for that Voucher.
- A settled debit/credit record pair showing the Voucher's initial position.

She can now receive consulting-hour payments into the inventory account or transfer consulting hours out of the issuance account.
