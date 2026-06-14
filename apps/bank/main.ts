// Deno Deploy entrypoint for the barter.game bank server.
//
// Serves one or more banks from a single Deno KV database. Each bank is named
// by a short name and its private key is loaded from BANK_<NAME>_PRIV_KEY.
//
// Routes:
//   GET  /                 health check + list of served banks
//   GET  /:name/barter-bank.json   bank discovery document
//   POST /:name/rpc        JSON-RPC envelope endpoint
//   GET  /:name/address/:pubkey    lookup Address doc
//   POST /:name/address            submit/update Address doc

import { loadBanksFromEnv, type BankKey } from "./env.ts";
import { bankDbFromKv } from "./db.ts";
import { handleRpc } from "./rpc.ts";
import { v1Registry } from "./registry.ts";
import { submitAddress } from "./handlers/get.ts";

const banks = loadBanksFromEnv();
const kv = await Deno.openKv();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function canonicalBankUrl(req: Request, name: string): string {
  const u = new URL(req.url);
  return `${u.origin}/${name}`;
}

function bankByName(name: string): BankKey | undefined {
  return banks.get(name);
}

Deno.serve(async (req: Request) => {
  if (banks.size === 0) {
    return json({ error: "no-banks-configured", detail: "set BANK_<NAME>_PRIV_KEY env vars" }, 500);
  }

  const url = new URL(req.url);
  const pathParts = url.pathname.split("/").filter((p) => p.length > 0);

  // GET / — health + bank list.
  if (pathParts.length === 0) {
    return json({
      ok: true,
      banks: [...banks.values()].map((b) => ({ name: b.name, pubkey: b.pubkey })),
    });
  }

  const name = pathParts[0]!;
  const bank = bankByName(name);
  if (!bank) {
    return json({ error: "bank-not-found", name }, 404);
  }

  const db = bankDbFromKv(kv, bank.pubkey);

  // GET /:name/barter-bank.json
  if (pathParts.length === 2 && pathParts[1] === "barter-bank.json" && req.method === "GET") {
    return json({
      pubkey: bank.pubkey,
      url: canonicalBankUrl(req, name),
      name,
      protocol_version: "barter.game/v1",
    });
  }

  // POST /:name/rpc
  if (pathParts.length === 2 && pathParts[1] === "rpc" && req.method === "POST") {
    return handleRpc(req, {
      bankPubkey: bank.pubkey,
      bankPrivateKey: bank.privateKey,
      db,
      registry: v1Registry,
    });
  }

  // GET /:name/address/:pubkey
  if (pathParts.length === 3 && pathParts[1] === "address" && req.method === "GET") {
    const pubkey = pathParts[2]!;
    const row = await db.getDoc(pubkey);
    if (!row || row.type !== "address") {
      return json({ error: "address-not-found", pubkey }, 404);
    }
    return json({ address: row.body });
  }

  // POST /:name/address
  if (pathParts.length === 2 && pathParts[1] === "address" && req.method === "POST") {
    let body: unknown;
    try {
      body = await req.json();
    } catch {
      return json({ error: "invalid-json" }, 400);
    }
    try {
      const stored = await submitAddress(body, {
        db,
        bankPrivateKey: bank.privateKey,
      });
      return json(stored);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return json({ error: msg }, 400);
    }
  }

  return json({ error: "not-found", path: url.pathname }, 404);
});
