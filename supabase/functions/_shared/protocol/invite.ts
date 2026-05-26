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

import { signDoc, verifyDoc, type Base58PubKey, type Base58Signature } from "./crypto.ts";

export type InviteLeg = {
  promise: string; // base58 promise hash
  amount: number;
};

export type Invite = {
  pubkey: Base58PubKey;
  bankUrl: string;
  give: InviteLeg;
  get: InviteLeg;
  exp: number;
};

export type SignedInvite = Invite & { sig: Base58Signature };

const SCHEME = "barter://";

/** Build the canonical doc form used for signing the invite. */
function inviteDoc(inv: Invite | SignedInvite, withSig = false): Record<string, unknown> {
  const doc: Record<string, unknown> = {
    pubkey: inv.pubkey,
    bankUrl: inv.bankUrl,
    give: { promise: inv.give.promise, amount: inv.give.amount },
    get: { promise: inv.get.promise, amount: inv.get.amount },
    exp: inv.exp,
  };
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
  params.set("give", `${signed.give.promise}:${signed.give.amount}`);
  params.set("get", `${signed.get.promise}:${signed.get.amount}`);
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

  return { pubkey, bankUrl, give, get, exp, sig };
}

function parseLeg(raw: string | null, label: string): InviteLeg {
  if (!raw) throw new Error(`invite missing ${label}`);
  const colon = raw.lastIndexOf(":");
  if (colon < 0) throw new Error(`invite ${label} must be <promise>:<amount>`);
  const promise = raw.slice(0, colon);
  const amount = Number(raw.slice(colon + 1));
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error(`invite ${label}.amount must be positive`);
  }
  if (!promise) throw new Error(`invite ${label}.promise empty`);
  return { promise, amount };
}

/** Check whether an invite has expired (relative to caller's clock). */
export function isInviteExpired(invite: { exp: number }, nowSeconds = Math.floor(Date.now() / 1000)): boolean {
  return invite.exp <= nowSeconds;
}
