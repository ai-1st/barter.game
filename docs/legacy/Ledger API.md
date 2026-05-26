Ledger API

Ledger Inputs:
- OrderDoc
- TxDoc
- RecordDoc
- Signature
- Address

Ledger Outputs:
- Send Signatures to other ledger
- Signature by hash
- Address

Ledger Process:
- Clients send input docs and the ledger passively stores them
- For every record, Ledger makes a series of checks and possibly issues signatures
- Ledger sends docs and signatures to other Ledgers when something happens


Ledger signs "Hold" on a pair of records when 
- These records don't yet have Hold signature AND
    - There's an "Approve" sign from the credit account owner on Tx OR
    - There's an "autoapprove" Order from the credit account owner

Ledger signs "Settle" on a pair of records when
- These records don't yet have "Settle" signature AND
- All records in Tx have a valid "Hold" signature AND
    - There's an "Approve" sign from the credit account owner on Tx OR
    - There's an "autoapprove" Order from the credit account owner


"Hold" records if:
- Tx is approved by the 


Q: Do we need to maintain blocks? Or is mentioning other signatures enough?
A: We can add Blocks later

Q: Do we need to maintain balance?
A: No, it is a caching strategy. We can add up RecordDoc to get balance for any given account

Q: Do we need a Tx element?
A: Yes, we need it, because it binds together the exchanges of tokens

Q: How can an offline Ledger query other ledgers?
A: Generate ulid, sign it, and send the request

Q: How does Ledger provide answers to queries
A: Streams of docs/signatures using ledger's own ulids (like Kafka). Two streams per pubkey (signatures/docs)
 
