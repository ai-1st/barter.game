// Local doc store — client-held docs, presented to banks on demand.
//
// Accounts are implicit (no open_account call): the holder authors Account
// and Account docs locally and the Account bodies travel with later requests
// (create_records / submit_tx docs[], invites, deal tokens). Account bodies
// NEVER leave this machine — banks only ever see account hashes.
//
// Stored next to the profile, keyed by content hash.

import { mkdirSync, readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

import { hashDoc, newUlid } from "../../../packages/protocol/src/index.ts";
import { profilePath, type Profile } from "./profile.ts";

function docsDir(): string {
  return join(dirname(profilePath()), "docs");
}

export function saveLocalDoc(doc: Record<string, unknown>): string {
  const dir = docsDir();
  mkdirSync(dir, { recursive: true });
  const hash = hashDoc(doc);
  writeFileSync(join(dir, `${hash}.json`), JSON.stringify(doc, null, 2), { mode: 0o600 });
  return hash;
}

export function loadLocalDoc(hash: string): Record<string, unknown> | null {
  const path = join(docsDir(), `${hash}.json`);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
}

export function listLocalDocs(type?: string): Array<{ hash: string; body: Record<string, unknown> }> {
  const dir = docsDir();
  if (!existsSync(dir)) return [];
  const out: Array<{ hash: string; body: Record<string, unknown> }> = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    const body = JSON.parse(readFileSync(join(dir, f), "utf8")) as Record<string, unknown>;
    if (type && body.type !== type) continue;
    out.push({ hash: f.slice(0, -5), body });
  }
  return out;
}

/** Author a fresh Account + Account pair for a voucher. The Account stays
 *  local forever; the Account body is stored for later presentation. */
export function createLocalAccount(
  profile: Profile,
  voucherHash: string,
  accountName: string,
): { account: Record<string, unknown>; accountHash: string; accountHash: string } {
  const account: Record<string, unknown> = {
    type: "account",
    pubkey: profile.pubkey,
    ulid: newUlid(),
    name: accountName,
  };
  const accountHash = saveLocalDoc(account);
  const account: Record<string, unknown> = {
    type: "account",
    holder: profile.pubkey,
    account: accountHash,
    voucher: voucherHash,
  };
  const accountHash = saveLocalDoc(account);
  return { account, accountHash, accountHash };
}
