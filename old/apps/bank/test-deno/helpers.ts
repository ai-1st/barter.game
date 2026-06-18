// Shared Deno KV harness for handler-level integration tests.
//
// Each test opens a fresh Deno KV database in a temp file and cleans it up
// after. Handlers receive a real BankDB backed by that KV, so concurrency
// paths (replay, holds, settlement) exercise the actual atomic operations.
// Bank-to-bank push is simulated by stubbing global fetch: subscription URLs
// are `https://<bank-name>.test/rpc`, and the stub routes a
// notify_signatures envelope straight into the target bank's handler.

import { genKeyPair, newUlid } from "../../../packages/protocol/src/index.ts";
import { notifySignatures } from "../handlers/notify_signatures.ts";
import { bankDbFromKv, type BankDB } from "../db.ts";
import type { RpcContext } from "../rpc.ts";

// ── tiny asserts (no std import → no network) ───────────────────────────────
export function eq(actual: unknown, expected: unknown, msg: string) {
  if (actual !== expected) throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
}
export function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error(msg);
}

// ── keys ───────────────────────────────────────────────────────────────────
export type Key = { priv: Uint8Array; pub: string };
export const key = (): Key => {
  const g = genKeyPair();
  return { priv: g.privateKey, pub: g.pubkeyBase58 };
};

// ── temp KV ────────────────────────────────────────────────────────────────
export type TestKv = { kv: Deno.Kv; path: string };

export async function openTestKv(): Promise<TestKv> {
  const path = await Deno.makeTempFile({ suffix: "-bank-test.kv" });
  const kv = await Deno.openKv(path);
  return { kv, path };
}

export async function closeTestKv(tk: TestKv): Promise<void> {
  tk.kv.close();
  try {
    await Deno.remove(tk.path);
  } catch {
    // ignore cleanup failures
  }
}

// ── ctx builder ─────────────────────────────────────────────────────────────
export function ctx(kv: Deno.Kv, bank: Key, sender: string): RpcContext {
  return {
    db: bankDbFromKv(kv, bank.pub),
    bankPubkey: bank.pub,
    bankPrivateKey: bank.priv,
    senderPubkey: sender,
    requestId: newUlid(),
  };
}

// ── fetch stub: routes notify envelopes into target banks ───────────────────
//
// install with `using` semantics: const restore = installFetchRouter(...);
// try { ... } finally { restore(); }
export function installFetchRouter(
  kv: Deno.Kv,
  banksByUrl: Map<string, Key>,
  pushLog?: Array<{ url: string; envelope: Record<string, unknown> }>,
): () => void {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: URL | Request | string, init?: RequestInit) => {
    const url = String(input);
    const envelope = JSON.parse(String(init?.body)) as Record<string, unknown>;
    pushLog?.push({ url, envelope });
    const bank = banksByUrl.get(url);
    if (!bank) return new Response("no such bank", { status: 404 });
    // Route into the bank's notify handler as in production (sender = pushing bank).
    await notifySignatures(
      envelope.params as Record<string, unknown>,
      ctx(kv, bank, envelope.pubkey as string),
    );
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: envelope.id, result: {} }), { status: 200 });
  }) as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

export const bankUrl = (name: string) => `https://${name}.test/rpc`;
