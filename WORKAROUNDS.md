# barter.game Web UI — Workarounds & Known Limitations

This file documents the workarounds and deferrals **currently in effect** in the
web UI + bank implementation against `docs/ui/claude-ui.md` and the `protocol/`
contract. Resolved one-off issues (import wiring, a SPA syntax error, an auth-gated
bootstrap route, the localhost Address URL, the legacy `old/` tree, the cross-bank
Offer-vs-Order resolution, and the initial deployment setup) have been removed —
the git history holds that record.

## Source-of-truth documents

- UI spec: `docs/ui/claude-ui.md`
- Protocol contract: `protocol/README.md`, `protocol/base.md`, `protocol/bank-schema.md`, `protocol/bank-rpc.md`

---

## 1. Keystore uses PBKDF2 + AES-GCM, not Argon2id (deferred)

`docs/ui/claude-ui.md §4` and `§10.1` mandate Argon2id (`m=64 MiB, t=3, p=1`) with
XChaCha20-Poly1305 for the encrypted keystore, plus a PBKDF2 fallback. Shipping a
WASM Argon2id build inside the SPA, with strict CSP/SRI, adds significant build
complexity and bundle size.

**In effect:** the keystore blob uses **PBKDF2-HMAC-SHA-256 + AES-GCM via Web
Crypto**. This satisfies the hard invariant that the plaintext private key and
password never leave the browser, while keeping the frontend a plain HTML/JS app
with no WASM build step. Argon2id is listed as a future upgrade in
`docs/ui/claude-ui.md §12`, and the spec explicitly allows PBKDF2 as a fallback
(`docs/ui/claude-ui.md §4`).

---

## 2. Not all UI screens are built yet (first-pass scope)

`docs/ui/claude-ui.md §8` enumerates dozens of screens (Dashboard, Wallet,
Activity, Vouchers, Orders, Invoices, Cheques, Discover, Network, Settings, Deal
flow, etc.). Building every screen to full spec is beyond the first implementation
pass.

**In effect:** the frontend implements the minimal end-to-end flow —
**Register / Unlock → Create Voucher → Create Invoice/Cheque → Discover →
Accept / Pay → Deal status**. Other screens exist as stub routes or are omitted.
The custom `/ui/*` backend API is shaped so the missing screens can be added later
without protocol changes.

---

## 3. Barter Link inline payloads use native browser compression

`docs/ui/claude-ui.md §5` requires DEFLATE + base64url for inline Barter Link
payloads. A fully self-contained implementation would bundle a deflate library.

**In effect:** reference-mode Barter Links (a short URL resolved by the bank) are
used for QR/link sharing. Inline mode uses the browser's native
`CompressionStream`/`DecompressionStream` where available, falling back to
reference mode otherwise. This preserves the "same link, two readers"
architecture for the common case without bundling a deflate library.

---

## 4. Deno Deploy blocks an isolate from fetching its own URL — co-located banks dispatch in-process

This is a **permanent Deno Deploy platform constraint**, not a transient bug, so
it stays documented even though the workaround is in place.

The coordinator (`/ui/propose_deal`) and the advance engine reach participating
banks over HTTP via [`apps/bank/peer.ts`](apps/bank/peer.ts) (`fetchDiscovery` /
`bankRpcCall`). On Deno Deploy, all four banks (`alice`, `bob`, `carol`, `dave`)
run in **one deployment**, so those become self-requests, and Deno Deploy
hard-blocks an isolate from fetching its own deployment URL:

```
508 Loop Detected — Loop detected: the deployment is fetching itself.
```

(Confirmed empirically.) It works fine locally because localhost self-fetch is
allowed, so it only surfaces on deployment.

**In effect:** [`apps/bank/local.ts`](apps/bank/local.ts) registers the banks
served by this process; when a target bank's pubkey is local, `bankRpcCall`
invokes the registry handler directly and `fetchDiscovery` answers from memory
instead of issuing an HTTP request. Any future change to bank fan-out must keep
this in-process path, or co-located banks will 508.

**Status:** the real HTTP bank-to-bank path is now **verified cross-process**: a
bilateral swap settled between two isolated local bank processes (separate ports
and KV stores — topologically two deployments) via `E2E_BANK_A_URL`/`E2E_BANK_B_URL`
in [`apps/bank/e2e-crossbank.ts`](apps/bank/e2e-crossbank.ts). A repeat across two
real Deno Deploy apps still requires creating the second app in the dashboard.
`BANK_KV_PATH` (in [`apps/bank/main.ts`](apps/bank/main.ts)) pins the KV file so
isolated bank processes can share one machine.

---

## Notes for future work

- Restore/expand the full screen inventory (§2).
- Upgrade keystore encryption to Argon2id + XChaCha20-Poly1305 when a WASM build
  pipeline is added (§1).
- Repeat the (locally proven) cross-process federation test across two real Deno
  Deploy apps once the second app exists in the dashboard (§4).
