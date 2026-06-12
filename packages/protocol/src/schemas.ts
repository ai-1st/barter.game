// Doc schemas — TS types + runtime validators matching the design doc's
// "Doc Schemas (restated, cite legacy types.ts)" section.
//
// We hand-roll the validators rather than pull in zod/valibot for v1 — a
// handful of doc types, the validators are short and the boundary
// errors are part of the protocol surface (-32000), so explicit shape
// checking lives at the protocol layer.

import { hashDoc } from "./crypto.ts";

// ------- Named types (string aliases for readability) -------

export type Base58PubKey = string;
export type Base58SHA256 = string;
export type Base58Signature = string;
export type ULID = string;
export type DateString = string; // "YYYY-MM-DD"

// ------- Doc shapes -------

export type BaseDoc = {
  type: DocType;
  pubkey: Base58PubKey;
  ulid: ULID;
};

export type DocType =
  | "promise"
  | "pocket"
  | "account"
  | "tx"
  | "credit"
  | "debit"
  | "signature"
  | "order"
  | "subscription";

/** Promise: minted by Promise owner. Bound to an issuing bank pubkey. */
export type Promise = BaseDoc & {
  type: "promise";
  bank: Base58PubKey;
  name: string;
  due?: DateString;
  limit?: number;
  integer?: boolean;
};

/** Pocket: holder's local grouping of Accounts. */
export type Pocket = BaseDoc & {
  type: "pocket";
  name: string;
};

/** Account: issuer-bank-owned record of a holder's balance for a Promise. */
export type Account = BaseDoc & {
  type: "account";
  pocket: Base58SHA256;
  promise: Base58SHA256;
};

/** Record: one half of a paired credit/debit accounting entry.
 *  Records are bank-minted and identified by ULID, not by content hash.
 *  `pair` links the debit and credit halves of a transfer — mandatory, set by
 *  the bank when it creates the pair. Records carry no Tx back-reference: the
 *  binding direction is Tx → records.
 */
export type LedgerRecord = BaseDoc & {
  type: "credit" | "debit";
  amount: number;
  account: Base58SHA256;
  pair: ULID;
};

/** Tx: ONE HOLDER's view of a deal. `pubkey` is the holder; `records` holds
 *  the bank-assigned ULIDs of the ledger records sitting on that holder's
 *  accounts (possibly at several banks), in transfer order. A lead/follow
 *  Signature by the holder over the Tx hash authorizes banks to execute
 *  those records.
 */
export type Tx = BaseDoc & {
  type: "tx";
  order?: Base58SHA256;
  records: ULID[];
};

/** Signature: attestation doc. `sig` populated after signing.
 *  Exactly one target field accompanies an action:
 *  - `hash`   — content-addressed docs: a holder's lead/follow over a Tx
 *               hash, or a bank's approve over a Promise hash (mint).
 *  - `record` — a bank's per-ledger-record approve/reject.
 *  - `deal`   — leg-level hold/settle/reject, keyed by the deal ULID.
 *  `seen` carries hashes of upstream settle Signature docs (the cross-bank
 *  proof chain).
 */
export type Signature = BaseDoc & {
  type: "signature";
  hash?: Base58SHA256;
  record?: ULID;
  deal?: ULID;
  action?:
    | "approve"
    | "hold"
    | "settle"
    | "reject"
    | "lead"
    | "follow"
    | "timeout";
  seen?: Base58SHA256[];
  reason?: string;
  sig?: Base58Signature;
};

/** Order: standing instruction authorizing a bank to process matching Txs. */
export type Order = BaseDoc & {
  type: "order";
  credit: Base58SHA256;      // account to credit (what holder wants to receive)
  debit: Base58SHA256;       // account to debit (what holder is willing to give)
  rate: number;              // debit_amount / credit_amount; must be positive
  min: number;               // minimum credit amount per matched Tx
  limit: number;             // maximum cumulative debit amount
  lead: boolean;             // if true, authorizes lead role for matched Txs
  approvers?: Base58PubKey[]; // pubkeys whose sigs may substitute for the owner's
};

/** Subscription: the initiating party asks a bank to push the Signature docs
 *  it creates concerning the watched items to `url`. `pubkey` is the creator
 *  (who signs the request); `to` is the delivery target behind `url` — a
 *  peer bank or another party — defaulting to the creator. This is how the
 *  initiator chooses the topology: cross-subscribe the banks to each other,
 *  subscribe only herself, or any mix. Fan-out is fire-and-forget; a lost
 *  push is recovered by any party relaying the signatures itself.
 */
export type Subscription = BaseDoc & {
  type: "subscription";
  records?: ULID[];        // watch keys matching Signature.record
  hashes?: Base58SHA256[]; // watch keys matching Signature.hash
  deals?: ULID[];          // watch keys matching Signature.deal
  url: string;             // http(s) endpoint to POST bank-signed notify envelopes to
  to?: Base58PubKey;       // delivery target pubkey (defaults to the creator)
  until?: DateString;      // optional expiry; banks may default one
};

export type AnyDoc =
  | Promise
  | Pocket
  | Account
  | LedgerRecord
  | Tx
  | Signature
  | Order
  | Subscription;

// ------- Hash helpers -------
// LedgerRecords are bank-minted by ULID and are NOT content-addressed.

export const hashPromise = (p: Promise): Base58SHA256 => hashDoc(p);
export const hashPocket = (p: Pocket): Base58SHA256 => hashDoc(p);
export const hashAccount = (a: Account): Base58SHA256 => hashDoc(a);
export const hashTx = (t: Tx): Base58SHA256 => hashDoc(t);
export const hashOrder = (o: Order): Base58SHA256 => hashDoc(o);
export const hashSubscription = (s: Subscription): Base58SHA256 => hashDoc(s);

// ------- Validators -------
//
// Each validator throws a clear error on the first violation. Bank handlers
// catch and translate to JSON-RPC error -32000. The errors name the field
// rather than just "invalid doc" so debugging cross-runtime divergence has a
// fighting chance.

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const BASE58_RE = /^[1-9A-HJ-NP-Za-km-z]+$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function assertBaseDoc(d: unknown, expectedType: DocType): asserts d is BaseDoc {
  if (d === null || typeof d !== "object" || Array.isArray(d)) {
    throw new TypeError(`expected ${expectedType} doc, got ${typeof d}`);
  }
  const doc = d as Record<string, unknown>;
  if (doc.type !== expectedType) {
    throw new TypeError(`expected type=${expectedType}, got ${String(doc.type)}`);
  }
  if (typeof doc.pubkey !== "string" || !BASE58_RE.test(doc.pubkey)) {
    throw new TypeError(`${expectedType}.pubkey must be base58, got ${typeof doc.pubkey}`);
  }
  if (typeof doc.ulid !== "string" || !ULID_RE.test(doc.ulid)) {
    throw new TypeError(`${expectedType}.ulid must be a ULID, got ${String(doc.ulid)}`);
  }
}

export function validatePromise(d: unknown): asserts d is Promise {
  assertBaseDoc(d, "promise");
  const p = d as Record<string, unknown>;
  if (typeof p.bank !== "string" || !BASE58_RE.test(p.bank)) {
    throw new TypeError("promise.bank must be a base58 pubkey");
  }
  if (typeof p.name !== "string" || p.name.length === 0) {
    throw new TypeError("promise.name must be a non-empty string");
  }
  if (p.due !== undefined && (typeof p.due !== "string" || !DATE_RE.test(p.due))) {
    throw new TypeError("promise.due must be a YYYY-MM-DD date if present");
  }
  if (p.limit !== undefined && (typeof p.limit !== "number" || p.limit <= 0)) {
    throw new TypeError("promise.limit must be a positive number if present");
  }
  if (p.integer !== undefined && typeof p.integer !== "boolean") {
    throw new TypeError("promise.integer must be a boolean if present");
  }
}

export function validatePocket(d: unknown): asserts d is Pocket {
  assertBaseDoc(d, "pocket");
  const p = d as Record<string, unknown>;
  if (typeof p.name !== "string") {
    throw new TypeError("pocket.name must be a string");
  }
}

export function validateAccount(d: unknown): asserts d is Account {
  assertBaseDoc(d, "account");
  const a = d as Record<string, unknown>;
  if (typeof a.pocket !== "string" || !BASE58_RE.test(a.pocket)) {
    throw new TypeError("account.pocket must be a base58 hash");
  }
  if (typeof a.promise !== "string" || !BASE58_RE.test(a.promise)) {
    throw new TypeError("account.promise must be a base58 hash");
  }
}

export function validateRecord(d: unknown): asserts d is LedgerRecord {
  if (d === null || typeof d !== "object" || Array.isArray(d)) {
    throw new TypeError("record must be an object");
  }
  const r = d as Record<string, unknown>;
  if (r.type !== "credit" && r.type !== "debit") {
    throw new TypeError(`record.type must be credit or debit, got ${String(r.type)}`);
  }
  // BaseDoc fields
  if (typeof r.pubkey !== "string" || !BASE58_RE.test(r.pubkey)) {
    throw new TypeError("record.pubkey must be a base58 pubkey");
  }
  if (typeof r.ulid !== "string" || !ULID_RE.test(r.ulid)) {
    throw new TypeError("record.ulid must be a ULID");
  }
  if (typeof r.amount !== "number" || !Number.isFinite(r.amount) || r.amount <= 0) {
    throw new TypeError("record.amount must be a positive finite number");
  }
  if (typeof r.account !== "string" || !BASE58_RE.test(r.account)) {
    throw new TypeError("record.account must be a base58 hash");
  }
  // pair is a ULID (bank-assigned), not a content hash. Mandatory.
  if (typeof r.pair !== "string" || !ULID_RE.test(r.pair)) {
    throw new TypeError("record.pair must be a ULID");
  }
  if (r.tx !== undefined) {
    throw new TypeError("record.tx is not part of the doc body (binding is Tx → records)");
  }
}

export function validateTx(d: unknown): asserts d is Tx {
  assertBaseDoc(d, "tx");
  const t = d as Record<string, unknown>;
  if (!Array.isArray(t.records) || t.records.length === 0) {
    throw new TypeError("tx.records must be a non-empty array");
  }
  for (const r of t.records) {
    if (typeof r !== "string" || !ULID_RE.test(r)) {
      throw new TypeError("tx.records[] must be ULIDs");
    }
  }
  if (t.order !== undefined && (typeof t.order !== "string" || !BASE58_RE.test(t.order))) {
    throw new TypeError("tx.order must be a base58 hash if present");
  }
}

export function validateOrder(d: unknown): asserts d is Order {
  assertBaseDoc(d, "order");
  const o = d as Record<string, unknown>;
  for (const field of ["credit", "debit"]) {
    if (typeof o[field] !== "string" || !BASE58_RE.test(o[field] as string)) {
      throw new TypeError(`order.${field} must be a base58 hash`);
    }
  }
  if (typeof o.rate !== "number" || !Number.isFinite(o.rate) || o.rate <= 0) {
    throw new TypeError("order.rate must be a positive finite number");
  }
  if (typeof o.min !== "number" || !Number.isFinite(o.min) || o.min < 0) {
    throw new TypeError("order.min must be a non-negative finite number");
  }
  if (typeof o.limit !== "number" || !Number.isFinite(o.limit) || o.limit <= 0) {
    throw new TypeError("order.limit must be a positive finite number");
  }
  if (typeof o.lead !== "boolean") {
    throw new TypeError("order.lead must be a boolean");
  }
  if (o.approvers !== undefined) {
    if (!Array.isArray(o.approvers)) {
      throw new TypeError("order.approvers must be an array if present");
    }
    for (const a of o.approvers) {
      if (typeof a !== "string" || !BASE58_RE.test(a)) {
        throw new TypeError("order.approvers[] must be base58 pubkeys");
      }
    }
  }
}

export function validateSignature(d: unknown): asserts d is Signature {
  assertBaseDoc(d, "signature");
  const s = d as Record<string, unknown>;
  if (s.hash !== undefined && (typeof s.hash !== "string" || !BASE58_RE.test(s.hash))) {
    throw new TypeError("signature.hash must be a base58 hash if present");
  }
  for (const field of ["record", "deal"]) {
    if (s[field] !== undefined && (typeof s[field] !== "string" || !ULID_RE.test(s[field] as string))) {
      throw new TypeError(`signature.${field} must be a ULID if present`);
    }
  }
  const validActions = new Set([
    "approve", "hold", "settle", "reject", "lead", "follow", "timeout",
  ]);
  if (s.action !== undefined && (typeof s.action !== "string" || !validActions.has(s.action))) {
    throw new TypeError(`signature.action must be one of ${[...validActions].join(",")}`);
  }
  if (s.action !== undefined) {
    const targets = ["hash", "record", "deal"].filter((f) => s[f] !== undefined);
    if (targets.length !== 1) {
      throw new TypeError(
        `signature with action must target exactly one of hash|record|deal, got ${targets.length}`,
      );
    }
  }
  if (s.sig !== undefined && (typeof s.sig !== "string" || !BASE58_RE.test(s.sig))) {
    throw new TypeError("signature.sig must be a base58 string if present");
  }
  if (s.seen !== undefined) {
    if (!Array.isArray(s.seen)) {
      throw new TypeError("signature.seen must be an array if present");
    }
    for (const ref of s.seen) {
      if (typeof ref !== "string" || !BASE58_RE.test(ref)) {
        throw new TypeError("signature.seen[] must be base58 strings");
      }
    }
  }
}

export function validateSubscription(d: unknown): asserts d is Subscription {
  assertBaseDoc(d, "subscription");
  const s = d as Record<string, unknown>;
  for (const field of ["records", "deals"]) {
    if (s[field] !== undefined) {
      if (!Array.isArray(s[field])) {
        throw new TypeError(`subscription.${field} must be an array if present`);
      }
      for (const v of s[field] as unknown[]) {
        if (typeof v !== "string" || !ULID_RE.test(v)) {
          throw new TypeError(`subscription.${field}[] must be ULIDs`);
        }
      }
    }
  }
  if (s.hashes !== undefined) {
    if (!Array.isArray(s.hashes)) {
      throw new TypeError("subscription.hashes must be an array if present");
    }
    for (const v of s.hashes) {
      if (typeof v !== "string" || !BASE58_RE.test(v)) {
        throw new TypeError("subscription.hashes[] must be base58 hashes");
      }
    }
  }
  const watchCount =
    ((s.records as unknown[] | undefined)?.length ?? 0) +
    ((s.hashes as unknown[] | undefined)?.length ?? 0) +
    ((s.deals as unknown[] | undefined)?.length ?? 0);
  if (watchCount === 0) {
    throw new TypeError("subscription must watch at least one record, hash, or deal");
  }
  if (typeof s.url !== "string") {
    throw new TypeError("subscription.url must be a string");
  }
  let parsed: URL;
  try {
    parsed = new URL(s.url);
  } catch {
    throw new TypeError("subscription.url must be a valid URL");
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new TypeError("subscription.url must be http(s)");
  }
  if (s.to !== undefined && (typeof s.to !== "string" || !BASE58_RE.test(s.to))) {
    throw new TypeError("subscription.to must be a base58 pubkey if present");
  }
  if (s.until !== undefined && (typeof s.until !== "string" || !DATE_RE.test(s.until))) {
    throw new TypeError("subscription.until must be a YYYY-MM-DD date if present");
  }
}

/** Validator dispatch by doc.type. Used in RPC envelope validation. */
export function validateDoc(d: unknown): asserts d is AnyDoc {
  if (d === null || typeof d !== "object" || Array.isArray(d)) {
    throw new TypeError("doc must be an object");
  }
  const t = (d as Record<string, unknown>).type;
  switch (t) {
    case "promise": return validatePromise(d);
    case "pocket": return validatePocket(d);
    case "account": return validateAccount(d);
    case "credit":
    case "debit": return validateRecord(d);
    case "tx": return validateTx(d);
    case "signature": return validateSignature(d);
    case "order": return validateOrder(d);
    case "subscription": return validateSubscription(d);
    default: throw new TypeError(`unknown doc.type: ${String(t)}`);
  }
}
