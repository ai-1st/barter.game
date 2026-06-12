// GENERATED — do not edit. Source: packages/protocol/src/invite.ts
// Re-sync with: bun run scripts/sync-protocol.ts

// Invite string format — the OOB trust channel.
//
// Format (per design doc, "Invite String Format" section):
//
//   barter://<inviter-pubkey>@<inviter-bank-url>?give=<promise-hash>:<amount>
//          &get=<promise-hash>:<amount>&exp=<unix-seconds>&sig=<inviter-sig>
//
// - `inviter-pubkey` (base58): user proposing the trade. Verifier checks `sig`
//   against this pubkey.
// - `inviter-bank-url`: full bank RPC URL. Pinned to inviter-pubkey by the
//   receiver's pubkey-pinning logic.
// - `give`: what inviter offers — `<promise-hash>:<amount>`.
// - `get`: what inviter wants — `<promise-hash>:<amount>`.
// - `exp`: Unix seconds; receiver rejects if past.
// - `sig`: ed25519 sig over canonical JSON of the invite minus `sig`, by
//   inviter-pubkey.
//
// Self-validating: receiver verifies sig before any network call.

import { base64urlnopad } from "npm:@scure/base@^2.2.0";
import { signDoc, verifyDoc, type Base58PubKey, type Base58Signature } from "./crypto.ts";
import type { LedgerRecord, Tx, ULID } from "./schemas.ts";

export type InviteLeg = {
  promise: string; // base58 promise hash
  amount: number;
  /** Hash of the inviter's Account doc for this promise — the account the
   *  initiator points the ledger records at. The inviter creates the Account
   *  doc locally (accounts are implicit; no open_account call). */
  account: string;
};

export type Invite = {
  pubkey: Base58PubKey;
  bankUrl: string;
  give: InviteLeg;
  get: InviteLeg;
  /** Bodies of the inviter's Account docs referenced by the legs, so the
   *  initiator can present them to the banks (accounts are implicit — they
   *  come into existence when the doc is shown). */
  accounts?: Array<Record<string, unknown>>;
  exp: number;
};

export type SignedInvite = Invite & { sig: Base58Signature };

const SCHEME = "barter://";

/** Build the canonical doc form used for signing the invite. */
function inviteDoc(inv: Invite | SignedInvite, withSig = false): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    pubkey: inv.pubkey,
    bankUrl: inv.bankUrl,
    give: { promise: inv.give.promise, amount: inv.give.amount, account: inv.give.account },
    get: { promise: inv.get.promise, amount: inv.get.amount, account: inv.get.account },
    exp: inv.exp,
  };
  if (inv.accounts && inv.accounts.length > 0) {
    doc.accounts = inv.accounts;
  }
  if (withSig && "sig" in inv && inv.sig) {
    doc.sig = inv.sig;
  }
  return doc;
}

/** Sign an Invite, returning a SignedInvite. */
export function signInvite(
  invite: Invite,
  privateKey: Uint8Array,
): SignedInvite {
  const sig = signDoc(inviteDoc(invite), privateKey);
  return { ...invite, sig };
}

/** Verify a SignedInvite's signature is by its claimed pubkey. */
export function verifyInvite(signed: SignedInvite): boolean {
  return verifyDoc(inviteDoc(signed), signed.sig, signed.pubkey);
}

/** Build an invite URL string from a SignedInvite. */
export function encodeInvite(signed: SignedInvite): string {
  const params = new URLSearchParams();
  params.set("give", `${signed.give.promise}:${signed.give.amount}:${signed.give.account}`);
  params.set("get", `${signed.get.promise}:${signed.get.amount}:${signed.get.account}`);
  if (signed.accounts && signed.accounts.length > 0) {
    params.set("accs", base64urlnopad.encode(new TextEncoder().encode(JSON.stringify(signed.accounts))));
  }
  params.set("exp", String(signed.exp));
  params.set("sig", signed.sig);
  // bankUrl can contain its own query / path; embed it as a JSON-safe param.
  // Authority is `<pubkey>@<bank-host-or-path>` per design doc.
  const u = new URL(signed.bankUrl);
  const authority = `${signed.pubkey}@${u.host}${u.pathname}${u.search}`;
  return `${SCHEME}${authority}?${params.toString()}`;
}

/** Parse an invite URL string into a SignedInvite (does NOT verify the sig). */
export function parseInvite(raw: string): SignedInvite {
  if (!raw.startsWith(SCHEME)) {
    throw new Error(`invite must start with ${SCHEME}`);
  }
  const rest = raw.slice(SCHEME.length);
  const qIdx = rest.indexOf("?");
  if (qIdx < 0) throw new Error("invite missing query string");
  const authority = rest.slice(0, qIdx);
  const query = rest.slice(qIdx + 1);

  const atIdx = authority.indexOf("@");
  if (atIdx < 0) throw new Error("invite missing pubkey@host authority");
  const pubkey = authority.slice(0, atIdx);
  const hostPath = authority.slice(atIdx + 1);

  // Reconstruct the bank URL. The host/path was embedded after `pubkey@`.
  // We add https:// since v1 banks are always TLS-fronted by Supabase.
  const bankUrl = `https://${hostPath}`;

  const params = new URLSearchParams(query);
  const give = parseLeg(params.get("give"), "give");
  const get = parseLeg(params.get("get"), "get");
  const expStr = params.get("exp");
  const sig = params.get("sig");
  if (!expStr) throw new Error("invite missing exp");
  if (!sig) throw new Error("invite missing sig");
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= 0) throw new Error("invite exp invalid");

  const out: SignedInvite = { pubkey, bankUrl, give, get, exp, sig };
  const accs = params.get("accs");
  if (accs) {
    out.accounts = JSON.parse(new TextDecoder().decode(base64urlnopad.decode(accs))) as Array<Record<string, unknown>>;
  }
  return out;
}

function parseLeg(raw: string | null, label: string): InviteLeg {
  if (!raw) throw new Error(`invite missing ${label}`);
  const parts = raw.split(":");
  if (parts.length !== 3) {
    throw new Error(`invite ${label} must be <promise>:<amount>:<account>`);
  }
  const [promise, amountStr, account] = parts;
  const amount = Number(amountStr);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`invite ${label}.amount must be positive`);
  }
  if (!promise) throw new Error(`invite ${label}.promise empty`);
  if (!account) throw new Error(`invite ${label}.account empty`);
  return { promise, amount, account };
}

/** Check whether an invite has expired (relative to caller's clock). */
export function isInviteExpired(invite: { exp: number }, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  return invite.exp <= nowSeconds;
}

// ------- Deal token — the initiator → follow-holder handoff -------
//
// After the initiator has created the records and lead-signed their own Tx,
// each remaining holder receives a deal token: a signed string carrying the
// holder's UNSIGNED Tx body, the bodies of the records it references, and
// the banks (pubkey + url) to submit the follow-signed Tx to. The recipient
// verifies the token's signature, cross-checks the record bodies against
// the banks (`get_deal`), then signs their Tx with action "follow" and
// submits it.
//
// Format: `barterdeal:` + base64url(canonical JSON of SignedDealToken).

export type DealTokenBank = {
  pubkey: Base58PubKey;
  url: string;
};

export type DealToken = {
  /** The initiator — verifier checks `sig` against this pubkey. */
  pubkey: Base58PubKey;
  /** The deal grouping ULID (matches the records' deal at each bank). */
  deal: ULID;
  /** The recipient holder's unsigned Tx body (tx.pubkey = the recipient). */
  tx: Tx;
  /** Bodies of the records referenced by tx.records, for offline review. */
  records: LedgerRecord[];
  /** Banks owning those records — where to submit the follow-signed Tx. */
  banks: DealTokenBank[];
  exp: number;
};

export type SignedDealToken = DealToken & { sig: Base58Signature };

const DEAL_SCHEME = "barterdeal:";

function dealTokenDoc(t: DealToken | SignedDealToken, withSig = false): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    pubkey: t.pubkey,
    deal: t.deal,
    tx: t.tx,
    records: t.records,
    banks: t.banks,
    exp: t.exp,
  };
  if (withSig && "sig" in t && t.sig) {
    doc.sig = t.sig;
  }
  return doc;
}

export function signDealToken(token: DealToken, privateKey: Uint8Array): SignedDealToken {
  const sig = signDoc(dealTokenDoc(token), privateKey);
  return { ...token, sig };
}

export function verifyDealToken(signed: SignedDealToken): boolean {
  return verifyDoc(dealTokenDoc(signed), signed.sig, signed.pubkey);
}

export function encodeDealToken(signed: SignedDealToken): string {
  const json = JSON.stringify(dealTokenDoc(signed, true));
  return DEAL_SCHEME + base64urlnopad.encode(new TextEncoder().encode(json));
}

/** Parse a deal token string (does NOT verify the sig — call verifyDealToken). */
export function parseDealToken(raw: string): SignedDealToken {
  if (!raw.startsWith(DEAL_SCHEME)) {
    throw new Error(`deal token must start with ${DEAL_SCHEME}`);
  }
  const json = new TextDecoder().decode(base64urlnopad.decode(raw.slice(DEAL_SCHEME.length)));
  const t = JSON.parse(json) as Partial<SignedDealToken>;
  if (typeof t.pubkey !== "string" || typeof t.deal !== "string" || !t.tx ||
      !Array.isArray(t.records) || !Array.isArray(t.banks) ||
      typeof t.exp !== "number" || typeof t.sig !== "string") {
    throw new Error("deal token missing required fields");
  }
  return t as SignedDealToken;
}
