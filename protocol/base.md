# barter.game protocol — Base layer

This file defines the parts of the v1 contract that are not specific to banking entities or RPC methods:

- Identity (ed25519 + base58)
- Canonical JSON (RFC 8785 / JCS)
- The `BaseDoc` shell, `Signature`, and `Address` document types
- The JSON-RPC request envelope
- Replay protection and error codes
- Request signing
- Bank discovery and pubkey pinning
- Standard vs custom API surface

For Promise/Account/Record/Tx/Order/Offer/Subscription schemas and ledger semantics, see [`bank-schema.md`](./bank-schema.md). For the bank RPC method definitions, see [`bank-rpc.md`](./bank-rpc.md).

---

## 1. Identity

Every party — user or bank — is an ed25519 keypair. The pubkey is base58-encoded and used as the identity in every doc.

- **User**: a person holding a private key.
- **Bank**: a process holding a private key.

There is no separate "address" or "DID"; the pubkey IS the identity.

> **Invariant:** ed25519 + base58 encoding is mandatory for v1 interoperability.

---

## 2. Canonical JSON (RFC 8785)

Every doc is signed over `SHA-256(canonical(doc))` where `canonical()` is the JCS algorithm:

- Object keys sorted by Unicode code-unit order.
- Numbers serialized via ECMAScript `ToString(Number)` (negative zero → `"0"`).
- Strings escape control chars + `"` + `\`; other UTF-8 passes through.
- `undefined` keys dropped.

When signing a doc, **the top-level `sig` field is removed** before canonicalization. The hash that the signature commits to is therefore content-addressed by the unsigned doc.

> **Invariant:** Two implementations must produce byte-identical canonical JSON for the same document, or every signature becomes unverifiable across implementations. You MUST implement RFC 8785 (or equivalent JCS) and you MUST verify cross-runtime parity before claiming v1 compatibility.

---

## 3. Document types

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

The concrete types defined in this file are `Signature` and `Address`. Promise, Pocket, Account, Record, Tx, Order, Offer, and Subscription are defined in [`bank-schema.md`](./bank-schema.md).

### 3.1 Signature

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

### 3.2 Address

A bank publishes its current endpoint as a signed **Address** doc. Address docs are indexed by pubkey; a newer Address (by ULID) for the same pubkey replaces the older one.

```ts
Address: BaseDoc & {
  type: "address";
  url: string;            // current endpoint of the bank
}
```

Banks maintain public directories of Address docs. Anyone MAY update an Address for a pubkey by presenting a signed Address doc with a newer ULID. The canonical discovery endpoint is `<bank-url>/barter-bank.json` (see §5.1); Address docs allow an entity to announce URL changes in a verifiable, self-signed form.

> **Invariant:** Address docs are signed by the pubkey they describe (a bank or a user). A newer ULID overrides an older one for the same pubkey.

---

## 4. JSON-RPC envelope

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
- For holder-facing methods, `pubkey` is the holder's user pubkey. The trade path has no bank-to-bank JSON-RPC calls; Address-directory endpoints are plain HTTP (see `bank-rpc.md`).

### 4.1 Replay protection

The recipient maintains a sliding window of seen `(sender_pubkey, id, to)` triples. A duplicate triple is rejected with code `-32002`. The window MUST be large enough to tolerate out-of-order delivery and MUST be pruned to prevent unbounded growth.

> **Invariant:** The envelope shape, the `to` binding, and the replay-protection semantics are protocol. The exact window size, pruning policy, and storage backend are implementation details.

### 4.2 Error codes

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

## 5. Bank discovery + pubkey pinning

### 5.1 Discovery

A bank's **canonical URL** is the base path clients use for that bank. Different banks MAY live at different paths on the same domain — for example `https://example.com/banks/alice` and `https://example.com/banks/bob`. The bank exposes its identity document at:

```
GET <bank-url>/barter-bank.json

→ {
    "pubkey": "<base58>",
    "url":    "<canonical bank URL>",
    "name":   "bank-alice",
    "protocol_version": "barter.game/v1"
  }
```

The `url` field is the canonical RPC URL — the location clients should use. It MUST be a prefix of the URL from which `barter-bank.json` was fetched.

Banks MAY maintain a cache of `(peer_pubkey, peer_url)` for banks they have heard from, sourced from discovery documents and from explicitly presented **Address** docs (§3.2). Under the client-orchestrated trade path banks do not call each other, so peer caching is vestigial on the hot path in v1 — kept for discovery and future bank-to-bank features.

### 5.2 Pubkey pinning (security)

The discovery document is **not a trust anchor**. A compromised DNS / hosting provider could serve a different pubkey, and TOFU clients would be fooled. v1 pins pubkey alongside URL everywhere trust is established:

- The client config map stores `{pubkey, url}` per bank.
- Invite strings carry `<pubkey>@<bank-url>` syntax (see `README.md`).
- `barter-bank.json` is fetched and *compared* against the pinned pubkey; if divergent, the operation fails closed.

In the v1 trust model the OOB channel that establishes the relationship already conveys the pubkey, so pinning is cheap.

> **Invariant:** The `barter-bank.json` format and the pinning semantics are protocol. How the client stores its config is an implementation detail.

---

## 6. Standard vs custom API

The open bank API that ensures interoperability and cross-bank transactions is standardized in this directory: document schemas, JSON-RPC envelope, method semantics, invite strings, and discovery formats.

Banks MAY also expose custom API endpoints and UI beyond the standard surface. For example, a bank may choose its own KYC flow, fee model, admin tooling, or web dashboard. Such customizations MUST NOT alter the standard document schemas or the semantics of the methods defined in `bank-rpc.md`. Different banks may implement the custom layer differently; clients that speak only the standard protocol can still trade across them.

> **Invariant:** Anything required for two independent implementations to interoperate belongs in this protocol directory. Anything that is operator-specific or UX-specific belongs in a custom or implementation layer.
