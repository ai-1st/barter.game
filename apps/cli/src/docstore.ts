// Local doc store — client-held docs, presented to banks on demand.
//
// Accounts are implicit (no open_account call): the holder authors Pocket
// and Account docs locally and the Account bodies travel with later requests
// (create_records / submit_tx docs[], invites, deal tokens). Pocket bodies
// NEVER leave this machine — banks only ever see pocket hashes.
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

/** Author a fresh Pocket + Account pair for a voucher. The Pocket stays
 *  local forever; the Account body is stored for later presentation. */
export function createLocalAccount(
  profile: Profile,
  voucherHash: string,
  pocketName: string,
): { account: Record<string, unknown>; accountHash: string; pocketHash: string } {
  const pocket: Record<string, unknown> = {
    type: "pocket",
    pubkey: profile.pubkey,
    ulid: newUlid(),
    name: pocketName,
  };
  const pocketHash = saveLocalDoc(pocket);
  const account: Record<string, unknown> = {
    type: "account",
    holder: profile.pubkey,
    pocket: pocketHash,
    voucher: voucherHash,
  };
  const accountHash = saveLocalDoc(account);
  return { account, accountHash, pocketHash };
}
