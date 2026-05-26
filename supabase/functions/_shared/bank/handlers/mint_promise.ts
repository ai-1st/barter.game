// mint_promise — user → issuer bank.
//
// Caller is the user issuing the Promise. The bank:
//   1. validates the params (name, optional integer/due/limit)
//   2. constructs the Promise doc using THIS bank as the issuer
//   3. constructs a Pocket doc (the issuer's "issuance pocket") and an
//      Account doc tying the issuer to their own Promise
//   4. signs the Promise + Account from the BANK's key (the bank's stamp
//      of issuance; the user separately signs the Promise to claim
//      authorship in W3+; for W2 the bank acts on the user's behalf since
//      the request envelope itself is user-signed)
//   5. stores both docs in `docs`, opens the issuer's negative-balance Account
//   6. returns Promise hash + Account hash so the user can reference them
//
// Why two signatures (user envelope + bank stamp): the design has the user
// sign their own Promise (claims authorship); the bank signs as an attestation
// of issuance. W2 does the bank attestation; the user signs the Promise doc
// at the client side and includes it in params for the bank to store
// verbatim (so the on-disk Promise.sigs[] has the user's claim).

import { hashDoc, signDoc, newUlid } from "../../protocol/crypto.ts";
import { validatePromise } from "../../protocol/schemas.ts";
import { RpcError, RpcErrors, type Handler } from "../rpc.ts";

type MintPromiseParams = {
  // The user-signed Promise doc, ready to store. The bank validates it,
  // stamps a bank-signed Signature attesting issuance, persists both.
  promise: Record<string, unknown>;
  // Optional user-supplied pocket hash. If absent, a default-named
  // "issuance" pocket is created for this issuer.
  pocket?: Record<string, unknown>;
};

export const mintPromise: Handler = async (params, ctx) => {
  const p = params as MintPromiseParams;
  if (!p.promise) {
    throw new RpcError(RpcErrors.INVALID_PARAMS, "params.promise required");
  }
  try {
    validatePromise(p.promise);
  } catch (err) {
    throw new RpcError(
      RpcErrors.VALIDATION,
      err instanceof Error ? err.message : "promise validation failed",
    );
  }

  const promise = p.promise as Record<string, unknown>;
  if (promise.bank !== ctx.bankPubkey) {
    throw new RpcError(
      RpcErrors.VALIDATION,
      `promise.bank must equal this bank's pubkey (${ctx.bankPubkey})`,
    );
  }
  if (promise.pubkey !== ctx.senderPubkey) {
    throw new RpcError(
      RpcErrors.VALIDATION,
      "promise.pubkey must equal the request sender (issuer issues their own promises)",
    );
  }

  // Pocket: use supplied or auto-create.
  let pocketDoc: Record<string, unknown>;
  if (p.pocket) {
    pocketDoc = p.pocket;
  } else {
    pocketDoc = {
      type: "pocket",
      pubkey: ctx.senderPubkey,
      ulid: newUlid(),
      name: "issuance",
    };
  }
  const promiseHash = hashDoc(promise);
  const pocketHash = hashDoc(pocketDoc);

  // Account: issuer's own account on their own promise.
  const accountDoc: Record<string, unknown> = {
    type: "account",
    pubkey: ctx.senderPubkey,
    ulid: newUlid(),
    pocket: pocketHash,
    promise: promiseHash,
  };
  const accountHash = hashDoc(accountDoc);

  // Persist everything. Hash-keyed upserts are idempotent under retry.
  await ctx.db.insertDoc({
    hash: promiseHash,
    type: "promise",
    pubkey: ctx.senderPubkey,
    body: promise,
  });
  await ctx.db.insertDoc({
    hash: pocketHash,
    type: "pocket",
    pubkey: ctx.senderPubkey,
    body: pocketDoc,
  });
  await ctx.db.insertDoc({
    hash: accountHash,
    type: "account",
    pubkey: ctx.senderPubkey,
    body: accountDoc,
  });
  await ctx.db.upsertAccount({
    accountHash,
    promiseHash,
    pocketHash,
    holderPubkey: ctx.senderPubkey,
    initialBalance: 0,            // issuer's balance starts at 0; goes negative on first transfer
    acknowledged: true,           // issuer's own account is auto-acknowledged
  });

  // Bank's attestation — a Signature doc with action="approve" against the
  // Promise hash. Optional but recommended; lets future readers verify
  // "the bank knows about this Promise."
  const attestation: Record<string, unknown> = {
    type: "signature",
    pubkey: ctx.bankPubkey,
    ulid: newUlid(),
    hash: promiseHash,
    action: "approve",
  };
  const attestationSig = signDoc(attestation, ctx.bankPrivateKey);
  attestation.sig = attestationSig;
  const attestationHash = hashDoc(attestation);
  await ctx.db.insertDoc({
    hash: attestationHash,
    type: "signature",
    pubkey: ctx.bankPubkey,
    body: attestation,
  });

  return {
    promise_hash: promiseHash,
    pocket_hash: pocketHash,
    account_hash: accountHash,
    bank_attestation: attestation,
  };
};
