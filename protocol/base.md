# barter.game protocol — base layer (v1)

> **Base layer definitions.** This document defines the foundational document types (BaseDoc, Signature, Address), canonicalization rules, content addressing, hash calculation, signature calculation, request signing, and the JSON-RPC envelope. Every barter.game v1 implementation MUST support these primitives. See `bank-schema.md` for banking document types and `bank-rpc.md` for the bank API contract.

## 3. Identity

Every party — user or bank — is an ed25519 keypair. The pubkey is base58-encoded and used as the identity in every doc.

- **User**: a person holding a private key.
- **Bank**: a process holding a private key.

There is no separate "address" or "DID"; the pubkey IS the identity.

> **Invariant:** ed25519 + base58 encoding is mandatory for v1 interoperability.

---


## 4. Canonical JSON (RFC 8785)

Every doc is signed over `SHA-256(canonical(doc))` where `canonical()` is the JCS algorithm:

- Object keys sorted by Unicode code-unit order.
- Numbers serialized via ECMAScript `ToString(Number)` (negative zero → `"0"`).
- Strings escape control chars + `"` + `\`; other UTF-8 passes through.
- `undefined` keys dropped.

When signing a doc, **the top-level `sig` field is removed** before canonicalization. The hash that the signature commits to is therefore content-addressed by the unsigned doc.

> **Invariant:** Two implementations must produce byte-identical canonical JSON for the same document, or every signature becomes unverifiable across implementations. You MUST implement RFC 8785 (or equivalent JCS) and you MUST verify cross-runtime parity before claiming v1 compatibility.

---


## 5. Document types

All docs share the `BaseDoc` shell:

```ts
type BaseDoc = {
  type: "promise" | "pocket" | "tx" | "credit" | "debit" | "signature" | "order" | "offer" | "subscription" | "address";
  pubkey: Base58PubKey;   // owner / signer
  ulid: ULID;              // 26-char Crockford base32, generated at creation
}
```

`Account` is **not** a `BaseDoc`: its identity is purely content-addressed from its semantic fields, so it has no `ulid` and its owner field is named `holder` rather than `pubkey`.

Encoded fields:

- `Base58PubKey`, `Base58Signature`, `Base58SHA256` — base58 strings.
- `ULID` — `01ABC...` 26-char. Used as both identity and time ordering.
- `DateString` — `YYYY-MM-DD`.

The concrete types:


### 5.6 Signature

Attestations are first-class docs. A signature with an `action` anchors to **exactly one** target via its `hash` field:

```ts
Signature: BaseDoc & {
  type: "signature";
  hash?: Base58SHA256;       // content-addressed target (record hash, Tx hash, Offer hash, Address hash)
  action?: "ready" | "hold" | "settle" | "reject"
         | "lead" | "follow";
  seen?: Base58SHA256[];     // hashes of prior Signature docs
  reason?: string;
  sig?: Base58Signature;     // ed25519 sig over canonical(doc minus sig)
}
```

`pubkey` may be a user OR a bank. The action map:

| Action | Signer | Target | Meaning |
|---|---|---|---|
| `lead` | initiating holder | `hash` = their Tx hash | authorizes the Tx's records; accepts moving first |
| `follow` | every other holder | `hash` = their Tx hash | authorizes the Tx's records; doubles as receipt confirmation |
| `ready` | bank | `hash` = a record hash | the bank's per-record limits/validity verdict |
| `hold` | bank | `hash` = a record hash | this bank's debit account is locked for this record |
| `settle` | bank | `hash` = a record hash | this bank applied this record's delta |
| `reject` | bank | `hash` = a record hash | this record is rejected; holds released |

A bank's signature on an Offer or Address (no `action`) is a pure attestation that the bank has stored/derived the doc.

`seen` is the load-bearing field for multi-party settlement: a follower bank's `settle` on a record lists the hashes of the upstream `settle` Signature docs it verified before applying its own record. That turns the lead→follow handoff into a verifiable settle chain — every link proves the prior link committed.

> **Invariant:** `Signature.seen` carries the cascade proof. A follower MUST verify its predecessors' settle signatures before applying balances and MUST cite them in `seen`. The exactly-one-target rule for actioned signatures is protocol.


### 5.11 Address

A bank publishes its current endpoint as a signed **Address** doc. Address docs are indexed by pubkey; a newer Address (by ULID) for the same pubkey replaces the older one.

```ts
Address: BaseDoc & {
  type: "address";
  url: string;            // current endpoint of the bank
}
```

Banks maintain public directories of Address docs. Anyone MAY update an Address for a pubkey by presenting a signed Address doc with a newer ULID. The canonical discovery endpoint is `<bank-url>/barter-bank.json` (§10.1); Address docs allow an entity to announce URL changes in a verifiable, self-signed form.

> **Invariant:** Address docs are signed by the pubkey they describe (a bank or a user). A newer ULID overrides an older one for the same pubkey.

---


## 6. JSON-RPC envelope

All RPCs are `POST` to `<bank-url>/rpc` with this body shape:

```json
{
  "jsonrpc": "2.0",
  "id":       "<ulid>",
  "method":   "<method-name>",
  "params":   { ... },
  "pubkey":   "<sender pubkey>",
  "to":       "<recipient bank pubkey>",
  "sig":      "<base58 sig>"
}
```

- `id` is a ULID claimed in the recipient's replay window.
- `to` binds the request to this specific recipient. A peer bank with a different pubkey rejects the request even if the URL routes correctly.
- `sig` is `ed25519(sha256(canonical(envelope minus sig)))`, signed by the private key corresponding to `pubkey`.
- For holder-facing methods, `pubkey` is the holder's user pubkey. The trade path has no bank-to-bank JSON-RPC calls; Address-directory endpoints are plain HTTP (§7.5).

### 6.1 Replay protection

The recipient maintains a sliding window of seen `(sender_pubkey, id, to)` triples. A duplicate triple is rejected with code `-32002`. The window MUST be large enough to tolerate out-of-order delivery and MUST be pruned to prevent unbounded growth.

> **Invariant:** The envelope shape, the `to` binding, and the replay-protection semantics are protocol. The exact window size, pruning policy, and storage backend are implementation details.

### 6.2 Error codes

| Code | Meaning |
|---|---|
| `-32700` | Parse error (body wasn't JSON) |
| `-32600` | Invalid request (envelope malformed) |
| `-32601` | Method not found |
| `-32602` | Invalid params |
| `-32603` | Internal error |
| `-32000` | Validation (doc shape, business rule) |
| `-32001` | Signature invalid (`to` mismatch, bad sig) |
| `-32002` | Replay (ULID already seen) |
| `-32003` | Lock conflict (concurrent hold on same account) |
| `-32004` | Timeout (reserved; not used in v1) |
| `-32005` | Unknown doc (referenced hash not in this bank's DB) |

> **Invariant:** These error codes and their meanings are part of the v1 contract. Custom codes MUST use the `-32006..-32099` range.

---


## 15. Implementing barter.game

If you are building your own bank or client:

1. Read `base.md` cover to cover. Everything here is the primitive contract.
2. Read `bank-schema.md` — the banking document types.
3. Read `bank-rpc.md` — the settlement model, bank API, and state machine.
4. Read `MASTER-INPUT.md` — the canonical bilateral narrative, doc snippets included.
5. See `IMPLEMENTATION.md` for how the reference team built it: Deno Deploy, Deno KV, the CLI, and the specific file map.
6. See `SCHEMA.md` for the v1 reference database schema — useful as a starting point, but you may use any storage that enforces the invariants in bank-rpc.md §8–§9.
7. See `packages/protocol/src/` for the reference canonicalizer, crypto primitives, and schema validators. You may reuse this code directly (MIT) or reimplement in your language of choice.
