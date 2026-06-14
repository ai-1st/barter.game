# Settlement walkthrough

Alice and Bob are users of the system. Abank and Bbank are their respective banks.

# Minting

Alice and Bob each mint promises into some accounts in their banks. As a result of minting they have two accounts for each promise — one with negative amount, one with positive amount. Promise minting is an API request to the bank signed by the issuer key. To have two distinct accounts for the same promise the user needs to provide two distinct Pocket hashes.

There is no separate call to open an account; the user just provides the Pocket hashes and Account and Promise objects.
Banks store the docs and signatures presented to them. The only things they create are ledger records and signatures. Pocket bodies never leave the holder — banks only ever see Pocket hashes.

```
Account: BaseDoc & {
  type: "account";
  pocket: Base58SHA256;   // hash of holder's Pocket doc
  promise: Base58SHA256;  // hash of the Promise this account holds
}

Pocket: BaseDoc & {
  type: "pocket";
  name: string;           // local label, typically not public
}

Promise: BaseDoc & {
  type: "promise";
  bank: Base58PubKey;     // pubkey of the issuing bank
  name: string;           // "1 logo", "1 hour consulting"
  due?: DateString;       // optional maturity date
  limit?: number;         // optional max supply
  integer?: boolean;      // amounts must be integer; default float
}
```

The mint itself is just the first ledger record pair: a debit on the issue account (which goes negative) and a credit on the holding account (which goes positive). There is no special mint balance logic — the same mechanism that moves value in trades creates it at mint. Since the mint has a single signer and a single bank, the bank settles it immediately: the signed mint request is the issuer's authorization.

# Meeting

Alice and Bob meet and Alice becomes interested in Bob's promise. She receives a copy of the Promise object describing the Promise. To own this promise, she needs to have an account in the Bbank. Somehow outside of the protocol she registers with the Bbank. Bbank may have some KYC or none at all — at the discretion of the operator. The easiest is if the bank has an open API and accepts any calls that are related to promises that use the bank.

Alice creates Pocket and Account objects for Bbank. With Bbank she may use the same Pocket hash as with Abank or a different hash.

Bob also creates Pocket and Account objects for Abank.

These Account objects travel with later requests — accounts come into existence at the bank the first time they are presented.

# Direct approval

Alice contacts Abank to create a pair of ledger records to transfer Apromise from Alice to Bob.
Alice contacts Bbank to create a pair of ledger records to transfer Bpromise from Bob to Alice.

```
LedgerRecord: BaseDoc & {
  type: "credit" | "debit";
  amount: number;         // positive
  account: Base58SHA256;  // hash of the Account doc (still content-addressed)
  pair: ULID;             // mandatory ULID of the peer record (set by the bank at creation)
}
```

Once she has the ledger record ULIDs, Alice creates two Tx objects: ATx and BTx.

```
Tx: BaseDoc & {
  type: "tx";
  records: ULID[];           // ordered list of record ULIDs touching this holder
  order?: Base58SHA256;      // optional originating Order doc
  // invoice?: Base58SHA256; // v1.5+ alternative authorization
  // cheque?: Base58SHA256;  // v1.5+ alternative authorization
}
```

ATx binds together the debit of Apromise and the credit of Bpromise in Alice's accounts — this is her view of the deal.
BTx binds together the credit of Apromise and the debit of Bpromise in Bob's accounts — this is his view of the deal.

A signed Tx acts as an authorization for the bank to execute the ledger records.

Alice signs ATx as "lead" and presents the signed ATx to Abank and Bbank.

Abank checks the limits and validity of ledger records and issues an "approve" or "reject" signature on the debit of Apromise.
Bbank checks the limits and validity of ledger records and issues an "approve" or "reject" signature on the credit of Bpromise.

Bob signs BTx as "follow" and presents the signed BTx to Abank and Bbank.

Abank checks the limits and validity of ledger records and issues an "approve" or "reject" signature on the credit of Apromise.
Bbank checks the limits and validity of ledger records and issues an "approve" or "reject" signature on the debit of Bpromise.

Abank and Bbank send each signature they create to the deal's subscribers, per the Subscription objects Alice registered when she set up the deal. This is how each bank learns that the other bank's records are approved, and how Alice and Bob see the deal progress without polling.

# Subscriptions

The party initiating the transactions sends Subscription objects to the banks. Banks use them to fan out the signatures they create. The topology can be different: the initiator can cross-subscribe the banks to each other (banks push directly), subscribe only herself (client relays everything), or any mix.

```
Subscription: BaseDoc & {
  type: "subscription";
  records?: ULID[];        // watch ledger records (matches Signature.record)
  hashes?: Base58SHA256[]; // watch content-addressed docs (matches Signature.hash)
  deals?: ULID[];          // watch a deal grouping (matches Signature.deal)
  url: string;             // endpoint to POST new signatures to
  to?: Base58PubKey;       // delivery target behind url (defaults to the creator)
  until?: DateString;      // optional expiry
}
```

Fan-out is fire-and-forget. If a push is lost, any party can relay the missing signatures itself — banks accept signatures from anyone, because the signatures carry their own authority.

# Hold

Once all of a bank's records under the deal are covered by holder-signed Txs and bank approvals, the bank locks the debit accounts and signs a "hold" for the deal. A held account cannot be debited by another deal until the hold is released by settlement or rejection.

# Settle

Settlement follows the lead/follow order. Abank (the lead bank) settles first: once it has seen "hold" signatures from every bank in the deal, it applies its record pair to the balances, releases its holds, and signs "settle".

Bbank settles after observing Abank's settle signature (delivered by fan-out or relayed by a party), citing its hash in its own settle signature's `seen` field — a verifiable proof chain that the upstream leg settled first.

Final balances for a 1-for-1 swap:

| Account               | Bank  | Balance |
|-----------------------|-------|---------|
| Alice issue Apromise  | Abank | −1      |
| Alice hold Apromise   | Abank | 0       |
| Bob — Apromise        | Abank | +1      |
| Bob issue Bpromise    | Bbank | −1      |
| Bob hold Bpromise     | Bbank | 0       |
| Alice — Bpromise      | Bbank | +1      |

Each promise sums to zero across all accounts — value was created by the issuer's negative account and is now held by the counterparty.

Banks advance through approve → hold → settle on their own, evaluated each time a new signature arrives. No party needs to drive settlement; parties only sign their Txs and, if a push gets lost, relay signatures.

# v0 decisions

- Banks allow minting any promise.
- Banks accept new ledger records for new accounts and new promises; they just need to make sure the promise references the bank.
- Banks accept and store any docs/signatures that are linked to promises that reference this bank.
- All calls to bank APIs are signed by the issuer. Banks may block spammers and abusers based on their issuer key.
- Banks communicate directly or indirectly — the Subscription topology decides. Client relay is the floor; bank-to-bank push is the default the CLI sets up.
