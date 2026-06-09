Alice and Bob are users of the system. Abank and Bbank are their respective banks.

Alice and Bob each mint promises into some accounts in their banks. As a result of minting they have two accounts for each promise - one with negative amount, one with positive amount. Promise minting is an API request to the bank signed by the issuer key. To have two distinct accounts for the same promise the user needs to provide two distinct Pocket hashes.

There is no separate call to open an account; the user just provides the Pocket hashes and Account and Promise objects.
Banks store the docs and sigatures presented to them. The only thing they create is signatures.

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

Alice and Bob meet and Alice becomes interested in Bob's promise. She receives a copy of the Promise object describing the Promise. To own this promise, she needs to have an account in the Bbank. Somehow outside of the protocol she registers with the Bbank. Bbank may have some KYC or none at all - at the discrepancy of the operator. The easiest is if the bank has open API and accepts any calls that are related to promises that use the bank.

Alice creates Pocket and Account objects for Bbank. With Bbank she may use the same Pocket hash as with Abank or a different hash.

Bob also creates Pocket and Account objects for Abank.

# Direct approval

Alice contacts Abank to create a pair of ledger records to transfer Apromise from Alice to Bob
Alice contacts Bbank to create a pair of ledger records to transfer Bpromise from Bob to Alice

LedgerRecord: BaseDoc & {
  type: "credit" | "debit";
  amount: number;         // positive
  account: Base58SHA256;  // hash of the Account doc (still content-addressed)
  pair: ULID;             // mandatory ULID of the peer record (set by the bank at creation)
}

One having the ledger record hashes, Alice creates two Tx objects: ATx and BTx

Tx: BaseDoc & {
  type: "tx";
  records: ULID[];           // ordered list of record ULIDs touching this holder
  order?: Base58SHA256;      // optional originating Order doc
  // invoice?: Base58SHA256; // v1.5+ alternative authorization
  // cheque?: Base58SHA256;  // v1.5+ alternative authorization
}

ATx binds together the credit of Apromise and debit of Bpromise in Alice's accounts - this is her view of the deal.
BTx binds together the debit of Apromise in credit of Bpromise in Bob's accounts - this is his view of the deal.

A signed Tx acts as an authorization for the bank to execute the ledger records.

Alice signs ATx as "lead" and presents the signed ATx to Abank and Bbank together with 

Abank checks the limits and validity of ledger records and issues "approve" or "reject" signature on the credit of Apromise.
Bbank checks the limits and validity of ledger records and issues "approve" or "reject" signature on the debit of Bpromise.

Bob signs BTx as "follow" and presents the signed ATx to Abank.
Abank checks the limits and validity of ledger records and issues "approve" or "reject" signature on the debit of Apromise.
Bbank checks the limits and validity of ledger records and issues "approve" or "reject" signature on the credit of Bpromise.

Anabk sends 
# Discussion points

Do banks allow minting any promise? v0 - yes
Do banks accept new ledger records for new accounts and new promises? v0 - yes, they just need to make sure the pomise references the bank
v0: Banks accept and store any docs/signatures that are linked to promises uthat are referencing this bank.
All calls to bank APIs are signed by the issuer. Banks may block spammers and abusers based on their issuer key.

Do banks communicate directly or indirectly?