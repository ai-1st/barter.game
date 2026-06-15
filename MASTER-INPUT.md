Alice and Bob are users of the system. Abank and Bbank are their respective banks.

Alice and Bob each mint vouchers into some accounts in their banks. As a result of minting they have two accounts for each voucher - one with negative amount, one with positive amount. Voucher minting is an API request to the bank signed by the issuer key. To have two distinct accounts for the same voucher the user needs to provide two distinct Pocket hashes.

There is no separate call to open an account; the user just provides the Pocket hashes and Account and Voucher objects.
Banks store the docs and signatures presented to them. The only thing they create is records and signatures.

Account: {
  holder: Base58PubKey;   // pubkey of the holder
  pocket: Base58SHA256;   // hash of holder's Pocket doc
  voucher: Base58SHA256;  // hash of the Voucher this account holds
}

Pocket: BaseDoc & {
  type: "pocket";
  name: string;           // a local label, typically not public
}

Voucher: BaseDoc & {
  type: "voucher";
  bank: Base58PubKey;     // pubkey of the issuing bank
  name: string;           // "1 logo", "1 hour consulting"
  image_svn?: string;     // inlined square image
  description_md?: string;   // markdown
  due?: DateString;       // optional maturity date
  limit?: number;         // optional max supply
  integer?: boolean;      // amounts must be integer; default float
}

Alice and Bob meet and Alice becomes interested in Bob's voucher. She receives a copy of the Voucher object describing the Voucher. To own this voucher, she needs to have an account in the Bbank. Somehow outside of the protocol she registers with the Bbank. Bbank may have some KYC or none at all - at the discrepancy of the operator. The easiest is if the bank has open API and accepts any calls that are related to vouchers that use the bank.

Alice creates Pocket and Account objects for Bbank. With Bbank she may use the same Pocket hash as with Abank or a different hash.

Bob also creates Pocket and Account objects for Abank.

# Direct approval

Alice contacts Abank to create a pair of records to transfer Avoucher from Alice to Bob
Alice contacts Bbank to create a pair of records to transfer Bvoucher from Bob to Alice

Record: BaseDoc & {
  type: "credit" | "debit";
  amount: number;         // positive
  account: Base58SHA256;  // hash of the Account doc (still content-addressed)
  pair: ULID;             // mandatory ULID of the peer record (set by the bank at creation)
}

Once having the record hashes, Alice creates two Tx objects: ATx and BTx

Tx: BaseDoc & {
  type: "tx";
  records: Base58SHA256[];           // ordered list of record hashes touching this holder
  order?: Base58SHA256;      // holder-issued authorization document (see below)
  offer?: Base58SHA256;    // bank-issued derived authorization document (See below)
}

ATx binds together the debit of Avoucher and credit of Bvoucher in Alice's accounts - this is her view of the deal.
BTx binds together the credit of Avoucher and debit of Bvoucher in Bob's accounts - this is his view of the deal.

A signed Tx acts as an authorization for the bank to execute the records. Tx can also be authorized by an order, an invoice, or a cheque.

Holders sign only Tx, Orders, Invoices and Cheques. Banks sign records and Address. Users sign Address (both banks and users can have URL with an API, users API aggregates all their vouchers across banks and other things - TBD.

Alice signs ATx as "lead" and presents the signed ATx to Abank and Bbank together with Subscription objects that instruct the banks to inform each other about signatures issued.

When creating records, Alice makes each bank notify each other about new signatures by passing a list of subscription objects to the banks:
RecordSubscription: {
  record: Base58SHA256;
  url: string; // url where new signatures on the record get published to
}

The banks issue these signatures on the records. The 2 signatures are issued on each of the paired records simultaneously and then fanned out through subscriptions. Each signature includes other prior signatures of the Tx in "seen" field. The bank MUST include signatures in the "seen" field that were required to sign/advance the record.
- "ready" meaning the bank is seeing a valid authorization, there are enough funds, no limits are exeeded and the bank is generally ready to proceed. this signature does not depend on other banks, it is bank's own validation and a heartbeat signal to others
- "hold" meaning the funds are being held in the debit account and expected in the credit account, lead bank does this only when all other records in Tx are "ready", follow bank does this only when all other records in Tx are "hold". "hold" may apply to the funds that are expected to arrive. This enables pass-through accounts in a single deal. Q - any potential issues with this?
- "settle" meaning the funds are being settled. Again the lead settles when others hold; followers settles after others settle.
- "reject" meaning the bank rejected the record due to some reason specified in the rejection message in the signature. "reject" may be issued any time even after "settle" - eg. if the bank is rolling back some fraudulent transfer. Each bank implements it own policies. Built-in non-repudiation: the protocol allows parties to collect cryptographic evidence of the sequence of events (based on "seen" in signatures) and use it to dispute stuck, aborted or rolled back transactions.

Abank checks the limits and validity of records and issues "ready" or "reject" signature on the debit of Avoucher.
Bbank checks the limits and validity of records and issues "ready" or "reject" signature on the credit of Bvoucher.

Bob signs BTx as "follow" and presents the signed BTx to Abank.
Abank checks the limits and validity of records and issues "ready" or "reject" signature on the credit of Avoucher.
Bbank checks the limits and validity of records and issues "ready" or "reject" signature on the debit of Bvoucher.

Abank and Bbank send the signatures to subscribers. Depending on circumstances they can be sending to each other directly, or through a proxy - the party driving the deal decides on how much privacy is required when setting subscriptions.

Banks send signatures back in response to API call with docs. So a holder sends docs and subscription, the bank generates signatures, sends them to subscribers and returns them to the caller in response payload.

Bank API allows any party to query signatures given the record hash. Record hash thus acts as an access key and enables polling for signatures if subscriber push wasn't set up or failed. Alice's client app may poll the banks for signatures to track the progress of the deal.

Once Abank sees the "ready" for all records in Tx and sees "lead" signature from Alice on Tx, it knows it has to advance, and issues "hold" signatures on own records. Sends them over to Bbank. Bbank holds too. If Bbank rejects, Abank rejects too, using Bbank rejection as the reason.

Same round for settlement.

One weird bank behavior of a bank is to neither reject nor advance. While this is out of scope for v1, a reputation service may independently check Tx, records, existing signatures, then present these documents to the bank once again, and then poll for signatures - if the bank is not processing it may be blacklisted. The bank may re-issue the same type of signature with an updated "reason" field to explain its position.

# Standing Order

If Alice doesn't have a ready deal with Bob and just wants to swap Avoucher to Bvoucher with whoever can fullfil her requirements, she may create a standing order:

/**
 * Order represents a standing instruction for the Bank to process certain transactions. 
 * Orders have no expiration and are valid for as long as there is enough remaining balance in the debit account.
 * and we are below the limits in the credit account.
 * To deactive an order the issuer should empty the debit account.
 * - 
*/
export type Order = BaseDoc & {
    pubkey: Base58PubKey; // should be the same as the owner of the credit and debit accounts
    type: "order";
    rate: number; // = debit_amount / credit_amount
    debit?: {
      account: Base58SHA256; // debit account
      voucher: Base58SHA256; // debit voucher
      min: number; // minimum amount to debit, prevents fragmentation
      max: number; // maximum amount to debit
    },
    credit?: {
      account: Base58SHA256; // credit account
      voucher: Base58SHA256; // credit voucher
      min: number; // minimum amount to credit, prevents fragmentation
      max: number; // maximum amount to credit
    },
    credit_account_limit?: number; // maximum amount in the credit account - prevents overstocking
    credit_order_limit?: number; // maximum amount processed through this order
    lead: boolean; // if the order can be executed without confirmation from the credit account holder
}

Order contains some information that Alice may not want to disclose, such as her pubkey, account hashes, limits, but she needs other parties to know about the remaining properties of the Order.

When the Bank receives Order and Account objects it creates a derived Offer object on behalf of the bank with reduced set of properties hiding the holder and holder account hashes:
export type Offer = BaseDoc & {
    pubkey: Base58PubKey; // bank's pubkey
    type: "offer";
    rate: number; // = debit_amount / credit_amount
    order: Base58SHA256, // link to original order
    debit?: {
      voucher: Base58SHA256; // debit voucher
      min: number; // minimum amount to debit, prevents fragmentation
      max: number; // maximum amount to debit
    },
    credit?: {
      voucher: Base58SHA256; // credit voucher
      min: number; // minimum amount to credit, prevents fragmentation
      max: number; // maximum amount to credit
    },
    lead: boolean; // if the order can be executed without confirmation from the credit account holder
}

These offers are being published by the bank through API. Parties may subscribe to new offer notifications for particular vouchers. 

OfferSubscription: {
  voucher: Base58SHA256;
  my_intention: "sell" | "buy"; // parties receive offers that match their intention - TODO better property naming
  url: string; // url where new offers for the voucher get published to
}

So Alice sends her Order and Accounts to both banks with publish_offer = TRUE parameter to the call, they both generate Offers and make them discoverable through the API. Banks lazily unpublish Offers for Orders that are exceeding limits. Alice is offering up to 100 Avouchers for 90 Bvouchers.

Bob happens to also publish an Offer for exchange up to 100 Bvouchers for 90 Avouchers.

A matchmaker discovers this arbritrage opportunity by listening to new offer streams from the banks and creates a Transaction - 
Alice trades 100 Avouchers for 90 Bvouchers; Bob trades 100 BVouchers for 90 Avouchers, and matchmaker pockets 10 Avouchers and 10 Bvouchers. Matchmaker creates records, Tx docs linked to the Order hashes (it can't see full Order docs, just the Order hash from the Offer). 

If any of the Orders has lead: TRUE - banks perform the operation without the need for explicit approval from Alice or Bob.
If matchmaker happens to have 90 Avoucher or 90 Bvoucher it may inject itself as a lead party into the deal initiate the transaction without Alice or Bob approval.
If neither is the case, the banks let Alice and Bob about a new Tx proposed by a third party - this is not covered by v1 protocol, but there will be some kind of inbox and review process + spam protection. If Alice or Bob sign "lead" on the Tx it gets through. There is a place for matchmakers because 
- not all offers are published (matchmaker may have access to private offers)
- some transactions require matchmaker holding vouchers (upfront investment) to break the chain and assume a lead role (risk)
- identifying complex multiparty transactions requires compute/data collection effort

The bank doesn't allow negative balance on Tx authorized by the holder or by holder Order. Negative balance is only allowed when minting by the issuer - the Tx MUST be signed directly by the voucher issuer.

# Cheques and Invoices

Cheque is an Order/Offer without credit field - it authorizes unconditional debit. Whoever has its hash may attach it to Tx and get the funds transferred bhy the bank.

And invoice is an Order/offer without debit field - it authrizes unconditional credit. Whoever wants to transfer somethingto the holder may used an invoice as the permission to do so.

Public offers for cheques make sense in air-drop scenarios.
Public offers for invoices make sense in fundraising/charity scenarios.

# Bank Discovery
Banks maintain a registry of addresses and fan out own address changes when ever they happen.

/**
 * Address document contains the endpoints used to communicate with the bank
 * - url is the current endpoint of the bank
 * 
 * The bank may issue a signed address with a newer ulid to update the url/ledger.
 * 
 * Banks maintain public directories of address docs, indexed by pubkey. The address doc for a pubkey
 * can be updated by any anonymnous user on the internet, provided they have a signed address doc with a newer ulid.
 * 
 * API to manage the address directory:
 * - GET /address/<pubkey> - get the address doc for the pubkey, or a 404 if none is found
 * - POST /address - create or update the address doc for the pubkey
 * 
 */
export type Address = BaseDoc & {
    type: "address";
    url: string;
}

# Bank public API summary
- record signatures, to whoever has the hash
- vouchers by hash, only the ones that issuers marked as "public" - bank custom API
- list of vouchers, only the ones that issuers marked as "discoverable" and hosted by this bank
- list of all vouchers known to this bank, including the ones hosted in other banks
- offers per voucher hash and intention
- signature, voucher and offer subscriptions
- get address by pubkey (addresses are auto-updated when a new ulid for the same pubkey is presented)
- anything else missing?

# Link sharing
User share deep links into bank webapps. The links are short and shared typically as a QR code
If another user scans it with smartphone camera they open a bank webapp in the browser than suggests they create a new key
or login into their app and scan the link using the app
In the app they just add things into address book and catalog of vouchers/issuers they trust and want to own.

# Standard vs Custom
The bank open API that ensures interoperability and cross-bank transactions is standardized in PROTOCOL.md
The link conventions that allow users share vouchers, addresses, offers are standardized in PROTOCOL.md
The custom bank API and UI of the reference implementation is covered in IMPLEMENTATION.md
Different banks may get it differently.

# Discussion points

Do banks allow minting any voucher? v1 - yes
Do banks accept new records for new accounts and new vouchers? v1 - yes, they just need to make sure the pomise references the bank
v1: Banks accept and store any docs/signatures that are linked to vouchers that are referencing this bank.
All calls to bank APIs are signed by the caller. Banks may block spammers and abusers based on their key.

Do banks communicate directly or indirectly? - v1 - depends on how subscriptions are set up. could you an anonimizing proxy 
so that banks even don't know what is the counterparty bank

# Notes in no particular order:
- signatures can only use content addressing (hash field)
```ts
Signature: BaseDoc & {
  type: "signature";
  hash?: Base58SHA256;       // content-addressed target (Tx hash, Voucher hash, Offer hash)
  action?: "ready" | "hold" | "settle" | "reject" // bank signatures
         | "lead" | "follow"; // holder signatures, action is not required when signing Voucher or Address
  seen?: Base58SHA256[];     // hashes of prior Signature docs
  reason?: string;
  sig?: Base58Signature;     // ed25519 sig over canonical(doc minus sig)
}
```
- do not use .well-known notation; there could be many banks using different paths on a common domain
- users do not sign Account, Pocket
- users sign Voucher, Order, Tx, Address
- banks sign Record, Offer (instead of "LedgerRecord" just use "Record"), Address
- all bank requests are signed by the caller and are idempotent, so we are not worried about 3-rd party replay of the requests (or do we? are there any cases when request replay could hurt us?)
- mint call does not need to pass "pocket" docs - banks do not need to know the properties of pockets, they only need to get account objects to check the voucher hash
- mint call should take "amount" and the bank should immediately create records with the given amount and issue "settle" sig (no need for "ready" and "hold" since this is the same bank)
- account balances start showing -X and X in the respective accounts
- there is no "shared `deal` ULID". Every party has their own view of the deal as a Tx object which describes what this party gets and what it gives. Only the matchmaker sees the whole deal structure, but they use internal identification and don't need to share it externally
- create_records call should take only amount and 2 account objects and return 2 record objects; these records are created as "draft" records - the bank stores them using a separate primary key with "draft" prefix so that they don't slow down account balance calculation. once the records get signed - the bank copies them into another PK starting with "ready", "hold" or "settle"
- Tx MUST reference records by hash
- RecordSubscription and OfferSubscription are not derived from BaseDoc, do not have ulid/pubkey and do not need to be signed
- 
