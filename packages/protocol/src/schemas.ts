// Doc schemas — TS types + runtime validators matching PROTOCOL.md §5.
//
// We hand-roll the validators rather than pull in zod/valibot for v1 — a
// handful of doc types, the validators are short and the boundary
// errors are part of the protocol surface (-32000), so explicit shape
// checking lives at the protocol layer.

import { hashDoc } from "./crypto.ts";
import type { Base58PubKey, Base58SHA256, Base58Signature } from "./crypto.ts";
export type { Base58PubKey, Base58SHA256, Base58Signature } from "./crypto.ts";

// ------- Named types (string aliases for readability) -------

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
  | "offer"
  | "subscription"
  | "address";

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

/** Account: issuer-bank-owned record of a holder's balance for a Promise.
 *  Account is NOT a BaseDoc: its identity is purely content-addressed from
 *  its semantic fields, so it has no `ulid` and its owner field is `holder`.
 */
export type Account = {
  type: "account";
  holder: Base58PubKey;
  pocket: Base58SHA256;
  promise: Base58SHA256;
};

/** Record: one half of a paired credit/debit accounting entry.
 *  Records are bank-minted and are now content-addressed by hash. `pair`
 *  links the debit and credit halves of a transfer — mandatory, set by the
 *  bank when it creates the pair. Records carry no Tx back-reference: the
 *  binding direction is Tx → records.
 */
export type RecordDoc = BaseDoc & {
  type: "credit" | "debit";
  amount: number;
  account: Base58SHA256;
  pair: ULID;
};

/** Tx: ONE HOLDER's view of a deal. `pubkey` is the holder; `records` holds
 *  the content-addressed hashes of the records on that holder's accounts
 *  (possibly at several banks), in transfer order. A lead/follow Signature
 *  by the holder over the Tx hash authorizes banks to execute those records.
 *  Txs are per-party and carry no shared deal/session id.
 */
export type Tx = BaseDoc & {
  type: "tx";
  order?: Base58SHA256;
  offer?: Base58SHA256;
  records: Base58SHA256[];
};

/** Signature: attestation doc. `sig` populated after signing.
 *  Targets use ONLY content addressing (`hash`).
 *  - holder `lead`/`follow` signatures target a Tx hash.
 *  - bank `ready`/`hold`/`settle`/`reject` signatures target a record hash.
 *  - Promise / Address / Offer signatures omit `action` and target the doc hash.
 *  `seen` carries hashes of upstream settle Signature docs (the cross-bank
 *  proof chain).
 */
export type Signature = BaseDoc & {
  type: "signature";
  hash?: Base58SHA256;
  action?:
    | "ready"
    | "hold"
    | "settle"
    | "reject"
    | "lead"
    | "follow";
  seen?: Base58SHA256[];
  reason?: string;
  sig?: Base58Signature;
};

/** Order: standing instruction authorizing a bank to process matching records. */
export type Order = BaseDoc & {
  type: "order";
  rate: number; // debit_amount / credit_amount; must be positive
  debit?: {
    account: Base58SHA256; // account to debit
    promise: Base58SHA256; // promise being given
    min: number; // minimum amount to debit per match
    max: number; // maximum amount to debit per match
  };
  credit?: {
    account: Base58SHA256; // account to credit
    promise: Base58SHA256; // promise being received
    min: number; // minimum amount to credit per match
    max: number; // maximum amount to credit per match
  };
  credit_account_limit?: number; // maximum amount allowed in the credit account
  credit_order_limit?: number; // maximum cumulative amount processed through this order
  lead: boolean; // if true, authorizes lead role for matched records
};

/** Offer: bank-issued derivation of an Order. The bank exposes the Order's
 *  trading terms while hiding the holder's identity and account hashes.
 */
export type Offer = BaseDoc & {
  type: "offer";
  order: Base58SHA256; // hash of the original order
  rate: number; // debit_amount / credit_amount; must be positive
  debit?: {
    promise: Base58SHA256; // promise being given
    min: number; // minimum amount to debit per match
    max: number; // maximum amount to debit per match
  };
  credit?: {
    promise: Base58SHA256; // promise being received
    min: number; // minimum amount to credit per match
    max: number; // maximum amount to credit per match
  };
  lead: boolean; // if true, the order can be executed without explicit credit-holder confirmation
};

/** Subscription: the initiating party asks a bank to push the Signature docs
 *  it creates concerning the watched hashes to `url`. `pubkey` is the creator
 *  (who signs the request); `to` is the delivery target behind `url` — a
 *  peer bank or another party — defaulting to the creator. Fan-out is
 *  fire-and-forget; a lost push is recovered by any party relaying the
 *  signatures itself.
 */
export type Subscription = BaseDoc & {
  type: "subscription";
  hashes?: Base58SHA256[]; // watch keys matching Signature.hash
  url: string; // http(s) endpoint to POST bank-signed notify envelopes to
  to?: Base58PubKey; // delivery target pubkey (defaults to the creator)
  until?: DateString; // optional expiry; banks may default one
};

/** RecordSubscription: lightweight routing hint passed to create_records.
 *  Not a BaseDoc; not signed.
 */
export type RecordSubscription = {
  record: Base58SHA256;
  url: string;
};

/** OfferSubscription: lightweight routing hint for offer streams.
 *  Not a BaseDoc; not signed.
 */
export type OfferSubscription = {
  promise: Base58SHA256;
  intention: "sell" | "buy";
  url: string;
};

/** Address: self-certified endpoint directory entry for a pubkey. */
export type Address = BaseDoc & {
  type: "address";
  url: string; // canonical endpoint URL for this pubkey
};

export type AnyDoc =
  | Promise
  | Pocket
  | Account
  | RecordDoc
  | Tx
  | Signature
  | Order
  | Offer
  | Subscription
  | Address;

// ------- Hash helpers -------
// Records are now content-addressed.

export const hashPromise = (p: Promise): Base58SHA256 => hashDoc(p);
export const hashPocket = (p: Pocket): Base58SHA256 => hashDoc(p);
export const hashAccount = (a: Account): Base58SHA256 => hashDoc(a);
export const hashRecord = (r: RecordDoc): Base58SHA256 => hashDoc(r);
export const hashTx = (t: Tx): Base58SHA256 => hashDoc(t);
export const hashOrder = (o: Order): Base58SHA256 => hashDoc(o);
export const hashOffer = (o: Offer): Base58SHA256 => hashDoc(o);
export const hashSubscription = (s: Subscription): Base58SHA256 => hashDoc(s);
export const hashAddress = (a: Address): Base58SHA256 => hashDoc(a);

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
  if (p.sig !== undefined) {
    throw new TypeError("pocket.sig is not part of the doc body (pockets are unsigned)");
  }
}

export function validateAccount(d: unknown): asserts d is Account {
  if (d === null || typeof d !== "object" || Array.isArray(d)) {
    throw new TypeError("account must be an object");
  }
  const a = d as Record<string, unknown>;
  if (a.type !== "account") {
    throw new TypeError(`expected type=account, got ${String(a.type)}`);
  }
  if (typeof a.holder !== "string" || !BASE58_RE.test(a.holder)) {
    throw new TypeError("account.holder must be a base58 pubkey");
  }
  if (typeof a.pocket !== "string" || !BASE58_RE.test(a.pocket)) {
    throw new TypeError("account.pocket must be a base58 hash");
  }
  if (typeof a.promise !== "string" || !BASE58_RE.test(a.promise)) {
    throw new TypeError("account.promise must be a base58 hash");
  }
  if (a.pubkey !== undefined) {
    throw new TypeError("account.pubkey is not part of the doc body (use holder)");
  }
  if (a.ulid !== undefined) {
    throw new TypeError("account.ulid is not part of the doc body");
  }
  if (a.sig !== undefined) {
    throw new TypeError("account.sig is not part of the doc body (accounts are unsigned)");
  }
}

export function validateRecord(d: unknown): asserts d is RecordDoc {
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
    if (typeof r !== "string" || !BASE58_RE.test(r)) {
      throw new TypeError("tx.records[] must be base58 record hashes");
    }
  }
  if (t.order !== undefined && (typeof t.order !== "string" || !BASE58_RE.test(t.order))) {
    throw new TypeError("tx.order must be a base58 hash if present");
  }
  if (t.offer !== undefined && (typeof t.offer !== "string" || !BASE58_RE.test(t.offer))) {
    throw new TypeError("tx.offer must be a base58 hash if present");
  }
  if (t.order !== undefined && t.offer !== undefined) {
    throw new TypeError("tx may carry at most one of order or offer");
  }
}

function validateOrderSide(
  s: unknown,
  side: "debit" | "credit",
): asserts s is { account: string; promise: string; min: number; max: number } {
  if (s === undefined) return;
  if (s === null || typeof s !== "object" || Array.isArray(s)) {
    throw new TypeError(`order.${side} must be an object if present`);
  }
  const o = s as Record<string, unknown>;
  for (const f of ["account", "promise"] as const) {
    if (typeof o[f] !== "string" || !BASE58_RE.test(o[f] as string)) {
      throw new TypeError(`order.${side}.${f} must be a base58 hash`);
    }
  }
  for (const f of ["min", "max"] as const) {
    if (typeof o[f] !== "number" || !Number.isFinite(o[f]) || (o[f] as number) < 0) {
      throw new TypeError(`order.${side}.${f} must be a non-negative finite number`);
    }
  }
  if (o.min! > o.max!) {
    throw new TypeError(`order.${side}.min must not exceed max`);
  }
}

export function validateOrder(d: unknown): asserts d is Order {
  assertBaseDoc(d, "order");
  const o = d as Record<string, unknown>;
  validateOrderSide(o.debit, "debit");
  validateOrderSide(o.credit, "credit");
  if (typeof o.rate !== "number" || !Number.isFinite(o.rate) || o.rate <= 0) {
    throw new TypeError("order.rate must be a positive finite number");
  }
  if (typeof o.lead !== "boolean") {
    throw new TypeError("order.lead must be a boolean");
  }
  for (const f of ["credit_account_limit", "credit_order_limit"] as const) {
    if (o[f] !== undefined && (typeof o[f] !== "number" || !Number.isFinite(o[f]) || (o[f] as number) < 0)) {
      throw new TypeError(`order.${f} must be a non-negative finite number if present`);
    }
  }
}

function validateOfferSide(
  s: unknown,
  side: "debit" | "credit",
): asserts s is { promise: string; min: number; max: number } {
  if (s === undefined) return;
  if (s === null || typeof s !== "object" || Array.isArray(s)) {
    throw new TypeError(`offer.${side} must be an object if present`);
  }
  const o = s as Record<string, unknown>;
  if (typeof o.promise !== "string" || !BASE58_RE.test(o.promise)) {
    throw new TypeError(`offer.${side}.promise must be a base58 hash`);
  }
  if (typeof o.min !== "number" || !Number.isFinite(o.min) || o.min < 0) {
    throw new TypeError(`offer.${side}.min must be a non-negative finite number`);
  }
  if (typeof o.max !== "number" || !Number.isFinite(o.max) || o.max <= 0) {
    throw new TypeError(`offer.${side}.max must be a positive finite number`);
  }
  if (o.min > o.max) {
    throw new TypeError(`offer.${side}.min must not exceed max`);
  }
}

export function validateOffer(d: unknown): asserts d is Offer {
  assertBaseDoc(d, "offer");
  const o = d as Record<string, unknown>;
  if (typeof o.order !== "string" || !BASE58_RE.test(o.order)) {
    throw new TypeError("offer.order must be a base58 hash");
  }
  if (typeof o.rate !== "number" || !Number.isFinite(o.rate) || o.rate <= 0) {
    throw new TypeError("offer.rate must be a positive finite number");
  }
  if (typeof o.lead !== "boolean") {
    throw new TypeError("offer.lead must be a boolean");
  }
  validateOfferSide(o.debit, "debit");
  validateOfferSide(o.credit, "credit");
}

export function validateSignature(d: unknown): asserts d is Signature {
  assertBaseDoc(d, "signature");
  const s = d as Record<string, unknown>;
  if (s.hash !== undefined && (typeof s.hash !== "string" || !BASE58_RE.test(s.hash))) {
    throw new TypeError("signature.hash must be a base58 hash if present");
  }
  const validActions = new Set([
    "ready", "hold", "settle", "reject", "lead", "follow",
  ]);
  if (s.action !== undefined && (typeof s.action !== "string" || !validActions.has(s.action))) {
    throw new TypeError(`signature.action must be one of ${[...validActions].join(",")}`);
  }
  // With action, hash must be present (all actioned signatures are content-addressed now).
  if (s.action !== undefined && typeof s.hash !== "string") {
    throw new TypeError("signature with action must have a hash target");
  }
  // Promise / Address / Offer signatures omit action but still require a hash target.
  if (s.hash === undefined) {
    throw new TypeError("signature must have a hash target");
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
  if (!Array.isArray(s.hashes) || s.hashes.length === 0) {
    throw new TypeError("subscription.hashes must be a non-empty array");
  }
  for (const v of s.hashes) {
    if (typeof v !== "string" || !BASE58_RE.test(v)) {
      throw new TypeError("subscription.hashes[] must be base58 hashes");
    }
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

export function validateAddress(d: unknown): asserts d is Address {
  assertBaseDoc(d, "address");
  const a = d as Record<string, unknown>;
  if (typeof a.url !== "string") {
    throw new TypeError("address.url must be a string");
  }
  try {
    const parsed = new URL(a.url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new TypeError("address.url must be http(s)");
    }
  } catch {
    throw new TypeError("address.url must be a valid http(s) URL");
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
    case "offer": return validateOffer(d);
    case "subscription": return validateSubscription(d);
    case "address": return validateAddress(d);
    default: throw new TypeError(`unknown doc.type: ${String(t)}`);
  }
}
