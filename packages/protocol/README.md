# @barter.game/protocol

The shared protocol-primitives library of the reference implementation: canonical JSON, ed25519 signing, content hashing, TypeScript types, and runtime validators for every barter.game v1 document.

> **Do not confuse this package with the spec.** The repo-root [`protocol/`](../../protocol/README.md) directory is the normative contract — [`base.md`](../../protocol/base.md) (identity, canonical JSON, `BaseDoc`, request signing), [`bank-schema.md`](../../protocol/bank-schema.md) (document schemas and ledger semantics), [`bank-rpc.md`](../../protocol/bank-rpc.md) (the RPC API). This package is TypeScript *code implementing* that contract. When the two disagree, the spec wins.

The entire library is one source file, [`src/index.ts`](./src/index.ts), with **no build step**: `main`, `types`, and `exports` all point at the `.ts` source, and the `build` script is an echo no-op. Consumers import the TypeScript directly. Dependencies are pure JS and run identically under Bun, Deno, and browsers: `@noble/ed25519`, `@noble/hashes`, `@scure/base`, `ulid`.

## API surface

### Canonical JSON (RFC 8785 / JCS)

Hand-rolled serializer — object keys sorted by UTF-16 code units, ECMAScript number-to-string formatting, `-0` collapses to `0`, throws `TypeError` on `NaN`/`Infinity`, `undefined`-valued keys dropped, arrays keep order, minimal escapes (`\" \\ \b \t \n \f \r`, `\uXXXX` for other control chars).

| Export | What it does |
| --- | --- |
| `canonicalize(value)` | Canonical JSON string of any JSON value |
| `canonicalBytes(value)` | UTF-8 bytes of the canonical form; a string input is encoded as-is, not re-serialized |
| `canonicalizeWithoutSig(doc)` | Canonical form with the **top-level** `sig` field removed (nested `sig` fields are kept) |

### Crypto & hashing

| Export | What it does |
| --- | --- |
| `genKeyPair()` / `publicKeyOf(priv)` | ed25519 keypair generation / public-key derivation, with base58 pubkey |
| `signBytes(msg, priv)` / `verifyBytes(msg, sig, pub)` | Raw ed25519 over bytes; base58 signatures; verify returns `false` (never throws) on malformed input |
| `signDoc(doc, priv)` / `verifyDoc(doc, sig, pub)` | ed25519 over `sha256(canonicalizeWithoutSig(doc))` |
| `hashDoc(doc)` | Content address: `base58(sha256(canonicalBytes(doc)))` — includes `sig` if present |
| `sha256Base58(s)` | `base58(sha256(utf8(s)))` |
| `base58Encode` / `base58Decode` | Bitcoin-alphabet base58 |
| `newUlid()` | Fresh ULID |

### Types

| Export | What it covers |
| --- | --- |
| `BaseDoc`, `DocType`, `AnyDoc` | Common envelope (`type`, `pubkey`, `ulid`, optional `sig`); `DocType` is the 10-value union `voucher \| account \| credit \| debit \| signature \| order \| offer \| mandate \| subscription \| address` |
| `Voucher`, `Account` | Issued voucher (incl. optional `due`, `expires`, `limit`, `integer`) and holder account |
| `BankRecord`, `RecordDetails` | On-ledger `credit`/`debit` record and the hashed-away details (`pair`, `deal_id`, `coordinator`, `holder`, `account`) |
| `Order`, `OrderSide`, `Offer` | Holder trade authorization and its published projection |
| `Mandate`, `Signature` | Deal settlement mandate; status/ack signature doc (`ready \| hold \| settle \| reject`) |
| `Subscription`, `Address` | Webhook subscription and bank address record |
| `Base58PubKey`, `Base58Signature`, `Base58SHA256`, `ULID` | String aliases used throughout |

### Validators

All validators throw `ValidationError` on failure and return the narrowed type on success. They check structure and encodings per [`bank-schema.md`](../../protocol/bank-schema.md) — not business state (balances, deal progress), which is the bank's job.

| Export | Notes |
| --- | --- |
| `validateBaseDoc(d)` | Shape + base58 `pubkey` + ULID |
| `validateVoucher(d, bankPubkey)` | Also enforces `voucher.bank === bankPubkey` |
| `validateAccount` / `validateOrder` / `validateOffer` / `validateRecord` / `validateMandate` / `validateSignature` / `validateSubscription` / `validateAddress` | Per-type required fields, `min <= max`, positive `rate`/`amount`, http(s) URLs, non-empty `records`, etc. |
| `isValidBase58(s)` / `isValidUlid(s)` | Boolean predicates |
| `offerSideFromOrderSide(side)` | Helper: project an `OrderSide` to an `Offer` side (drops the private `account` hash) |

## How it is consumed

- **`apps/bank` (Deno):** the repo-root [`deno.json`](../../deno.json) import map aliases `@barter.game/protocol` to `./packages/protocol/src/index.ts` (and the noble/scure/ulid deps to `npm:` specifiers). The bank imports the TypeScript source directly — no build or sync step.
- **`apps/web` (browser):** does **not** import this package. It ships a hand-compiled vendored copy, [`apps/web/protocol.js`](../../apps/web/protocol.js), whose bare imports resolve through the import map in `apps/web/index.html` (esm.sh). To regenerate after changing `src/index.ts`: run `tsc -p tsconfig.web.json` (emits `apps/web/index.js` per [`tsconfig.web.json`](./tsconfig.web.json)), then manually rename the output to `protocol.js`. No script automates this — if you change the source and skip this step, the web app silently keeps the old logic.

## Tests & the parity invariant

| Command (from this directory) | What it runs |
| --- | --- |
| `bun test` | [`test/protocol.test.ts`](./test/protocol.test.ts) under Bun: golden canonicalization vectors, `canonicalizeWithoutSig` semantics, non-finite number rejection, ed25519 roundtrips + tamper/wrong-key/malformed-input cases, `signDoc`/`hashDoc` determinism, ULID/base58 helpers, and accept/reject cases for every validator |
| `bun run test:deno` | [`test-deno/protocol.deno-test.ts`](./test-deno/protocol.deno-test.ts) under Deno: re-runs the **same** [`test/fixtures/canonical/vectors.json`](./test/fixtures/canonical/vectors.json) golden vectors plus the `canonicalizeWithoutSig` checks |

From the repo root: `bun run test`, `bun run test:deno`, or `bun run test:all` for both. Repo-root `deno test` also picks up the Deno suite via the `test.include` list in `deno.json`.

The Deno twin suite is not a formality — **cross-runtime canonicalization parity is the load-bearing invariant of the whole system.** Every hash and every signature is computed over canonical bytes. The bank canonicalizes under Deno, the web client under a browser engine, the tests under Bun. If any two runtimes ever disagree on a single canonical byte, hashes stop matching and signature verification fails across implementations. The golden vectors are the fence that catches this.

## Porting to another language

Treat [`src/index.ts`](./src/index.ts) as the executable reference for the canonicalization rules in [`base.md`](../../protocol/base.md):

1. **Port the canonicalizer exactly** — UTF-16 code-unit key sort (not locale, not byte-wise UTF-8), the escape table above, `-0 → 0`, reject non-finite numbers, drop absent/undefined fields. The subtle part is number formatting: RFC 8785 requires ECMAScript `Number::toString` (shortest round-trip) — a naive `printf`-style formatter will not match.
2. **Validate against the golden vectors** in [`test/fixtures/canonical/vectors.json`](./test/fixtures/canonical/vectors.json) — byte-for-byte equality on every `canonical` string.
3. **Keep the primitives equivalent:** ed25519 (RFC 8032) over the SHA-256 of the sig-less canonical form for doc signatures; SHA-256 of the full canonical form for content hashes; Bitcoin-alphabet base58 for all encodings; ULIDs for ids.

## Constraints for contributors

- **No runtime-specific APIs** in this package: no Node `fs`/`path`/`Buffer`/`process.env`, no `Deno.*`, no DOM. `src/index.ts` must run unchanged under Bun, Deno, and browsers.
- Dependencies must stay pure-JS and cross-runtime (the current four are; keep it that way).
- **Any change to the canonicalizer requires new golden vectors** in `vectors.json` and a green `bun run test:all` — the Deno twin test must pass, not just the Bun suite.
- After changing `src/index.ts`, regenerate the vendored `apps/web/protocol.js` (see above).
- Keep it a single source file with no build step; consumers import the `.ts` directly.
