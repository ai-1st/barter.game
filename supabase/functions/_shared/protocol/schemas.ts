// GENERATED — do not edit. Source: packages/protocol/src/schemas.ts
// Re-sync with: bun run scripts/sync-protocol.ts

// Doc schemas — TS types + runtime validators matching the design doc's
// "Doc Schemas (restated, cite legacy types.ts)" section.
//
// We hand-roll the validators rather than pull in zod/valibot for v1 — six
// doc types, ~20 fields total, the validators are short and the boundary
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
  | "signature";

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
 *  v1 relaxes `pair` and `tx` to optional because populating them would
 *  require a circular hash dance (Tx hashes records that hash the Tx).
 *  The Tx → record binding lives in Tx.records[] ordering; the bank's
 *  `txs` table joins state by tx_hash.
 */
export type LedgerRecord = BaseDoc & {
  type: "credit" | "debit";
  amount: number;
  account: Base58SHA256;
  pair?: Base58SHA256;
  tx?: Base58SHA256;
};

/** Tx: groups a set of Records into a barter deal. */
export type Tx = BaseDoc & {
  type: "tx";
  order?: Base58SHA256;
  records: Base58SHA256[];
};

/** Signature: attestation doc. `sig` populated after signing. */
export type Signature = BaseDoc & {
  type: "signature";
  hash?: Base58SHA256;
  action?:
    | "ack"
    | "approve"
    | "hold"
    | "settle"
    | "reject"
    | "lead"
    | "follow"
    | "timeout";
  seen?: Base58Signature[];
  reason?: string;
  sig?: Base58Signature;
};

export type AnyDoc = Promise | Pocket | Account | LedgerRecord | Tx | Signature;

// ------- Hash helpers -------

export const hashPromise = (p: Promise): Base58SHA256 => hashDoc(p);
export const hashPocket = (p: Pocket): Base58SHA256 => hashDoc(p);
export const hashAccount = (a: Account): Base58SHA256 => hashDoc(a);
export const hashRecord = (r: LedgerRecord): Base58SHA256 => hashDoc(r);
export const hashTx = (t: Tx): Base58SHA256 => hashDoc(t);

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
  // v1 relaxation: pair and tx are optional (see schema comment).
  for (const field of ["pair", "tx"]) {
    if (r[field] !== undefined && (typeof r[field] !== "string" || !BASE58_RE.test(r[field] as string))) {
      throw new TypeError(`record.${field} must be a base58 hash if present`);
    }
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
      throw new TypeError("tx.records[] must be base58 hashes");
    }
  }
  if (t.order !== undefined && (typeof t.order !== "string" || !BASE58_RE.test(t.order))) {
    throw new TypeError("tx.order must be a base58 hash if present");
  }
}

export function validateSignature(d: unknown): asserts d is Signature {
  assertBaseDoc(d, "signature");
  const s = d as Record<string, unknown>;
  if (s.hash !== undefined && (typeof s.hash !== "string" || !BASE58_RE.test(s.hash))) {
    throw new TypeError("signature.hash must be a base58 hash if present");
  }
  const validActions = new Set([
    "ack", "approve", "hold", "settle", "reject", "lead", "follow", "timeout",
  ]);
  if (s.action !== undefined && (typeof s.action !== "string" || !validActions.has(s.action))) {
    throw new TypeError(`signature.action must be one of ${[...validActions].join(",")}`);
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
    default: throw new TypeError(`unknown doc.type: ${String(t)}`);
  }
}
