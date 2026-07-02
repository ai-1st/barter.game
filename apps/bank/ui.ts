import {
  base58Encode,
  canonicalize,
  canonicalizeWithoutSig,
  hashDoc,
  isValidBase58,
  isValidUlid,
  newUlid,
  signDoc,
  verifyDoc,
  type Base58PubKey,
} from '@barter.game/protocol';
import {
  emptyUiState,
  getAccountBalance,
  getAddress,
  getHandleByPubkey,
  getHandleInfo,
  getKeystore,
  getOffer,
  getOffersForOrder,
  getOrder,
  getRecord,
  getSignaturesForRecord,
  getUiState,
  listAccounts,
  listOrdersByHolder,
  listRecordsByDeal,
  listVouchers,
  listVouchersByIssuer,
  putUiState,
  registerHandle,
  setKeystore,
  type KeystoreBlob,
  type UiState,
} from './db.ts';
import { claimReplayId } from './db.ts';
import { bankRpcCall, fetchDiscovery } from './peer.ts';
import type { Bank } from './types.ts';
import { RpcError } from './error.ts';

class UiError extends RpcError {
  status: number;
  constructor(status: number, code: number, message: string) {
    super(code, message);
    this.status = status;
    this.name = 'UiError';
  }
}

const HANDLE_RE = /^[a-z0-9_-]{3,32}$/;

export async function handleUiRequest(
  bank: Bank,
  request: Request,
  basePath: string,
): Promise<Response> {
  try {
    const url = new URL(request.url);
    const uiPath = url.pathname.slice(basePath.length);
    if (uiPath === '/' || uiPath === '' || uiPath.startsWith('/app/')) {
      return serveSpa(request, uiPath);
    }

    // Auth-required UI routes
    if (request.method === 'OPTIONS') {
      return cors(new Response(null, { status: 204 }));
    }

    const authPubkey = await requireAuth(bank, request, basePath);

    if (uiPath === '/state') {
      if (request.method === 'GET') {
        const state = await getUiState(bank, authPubkey);
        return json(200, state);
      }
      if (request.method === 'PUT') {
        const body = await request.json() as UiState;
        if (body.pubkey !== authPubkey) throw new UiError(403, -32007, 'pubkey mismatch');
        const rev = await putUiState(bank, body, body.rev);
        return json(200, { rev });
      }
    }

    if (uiPath === '/trusted') {
      if (request.method === 'POST') {
        const body = await request.json() as { pubkey: string };
        if (!isValidBase58(body.pubkey)) throw new UiError(422, -32012, 'invalid pubkey');
        const state = await getUiState(bank, authPubkey);
        if (!state.trusted.includes(body.pubkey)) state.trusted.push(body.pubkey);
        const rev = await putUiState(bank, state);
        return json(200, { trusted: state.trusted, rev });
      }
      if (request.method === 'GET') {
        return json(200, (await getUiState(bank, authPubkey)).trusted);
      }
    }
    const trustedDelete = uiPath.match(/^\/trusted\/([^/]+)$/);
    if (trustedDelete && request.method === 'DELETE') {
      const pk = trustedDelete[1]!;
      const state = await getUiState(bank, authPubkey);
      state.trusted = state.trusted.filter((p) => p !== pk);
      const rev = await putUiState(bank, state);
      return json(200, { trusted: state.trusted, rev });
    }

    if (uiPath === '/contacts') {
      return crudList(bank, authPubkey, 'contacts', request);
    }
    const contactsPath = uiPath.match(/^\/contacts\/([^/]+)$/);
    if (contactsPath) {
      return crudItem(bank, authPubkey, 'contacts', contactsPath[1]!, request, (item) => ({
        pubkey: item.pubkey,
        handle: item.handle,
        note: item.note,
      }));
    }

    if (uiPath === '/banks') {
      return crudList(bank, authPubkey, 'banks', request);
    }
    const banksPath = uiPath.match(/^\/banks\/([^/]+)$/);
    if (banksPath) {
      return crudItem(bank, authPubkey, 'banks', banksPath[1]!, request, (item) => ({
        pubkey: item.pubkey,
        url: item.url,
      }));
    }

    if (uiPath === '/prefs') {
      if (request.method === 'GET') {
        return json(200, (await getUiState(bank, authPubkey)).prefs);
      }
      if (request.method === 'PUT') {
        const body = await request.json() as Record<string, unknown>;
        const state = await getUiState(bank, authPubkey);
        state.prefs = body;
        const rev = await putUiState(bank, state);
        return json(200, { prefs: state.prefs, rev });
      }
    }

    if (uiPath === '/portfolio') {
      return handlePortfolio(bank, authPubkey);
    }
    if (uiPath === '/history') {
      return handleHistory(bank, authPubkey, url);
    }
    if (uiPath === '/orders') {
      return handleOrders(bank, authPubkey);
    }

    if (uiPath === '/discover') {
      return handleDiscover(bank, authPubkey, await request.json() as Record<string, unknown>);
    }

    if (uiPath === '/relay') {
      return handleRelay(bank, await request.json() as Record<string, unknown>);
    }
    if (uiPath === '/relay_signatures') {
      return handleRelaySignatures(bank, await request.json() as Record<string, unknown>);
    }

    if (uiPath === '/propose_deal') {
      return handleProposeDeal(bank, authPubkey, await request.json() as Record<string, unknown>);
    }
    const dealMatch = uiPath.match(/^\/deal\/([^/]+)$/);
    if (dealMatch && request.method === 'GET') {
      return handleDealStatus(bank, authPubkey, dealMatch[1]!);
    }

    // keystore rotation
    if (uiPath === '/keystore' && request.method === 'PUT') {
      const body = await request.json() as { keystore: KeystoreBlob };
      const handle = await getHandleByPubkey(bank, authPubkey);
      if (!handle) throw new UiError(403, -32007, 'pubkey not registered');
      await setKeystore(bank, authPubkey, body.keystore);
      return json(200, { handle, rotated_at: Date.now() });
    }

    return notFound();
  } catch (e) {
    if (e instanceof UiError) {
      return json(e.status, { code: e.code, message: e.message });
    }
    if (e instanceof RpcError) {
      return json(400, { code: e.code, message: e.message });
    }
    console.error('UI error', e);
    return json(500, { code: -32603, message: 'internal error' });
  }
}

// Public auth & keystore routes (no outer auth required)
export async function handlePublicUiRoute(
  bank: Bank,
  request: Request,
  basePath: string,
): Promise<Response | null> {
  const url = new URL(request.url);
  const uiPath = url.pathname.slice(basePath.length);

  const handleMatch = uiPath.match(/^\/handle\/([^/]+)$/);
  if (handleMatch && request.method === 'GET') {
    const handle = handleMatch[1]!;
    if (!HANDLE_RE.test(handle)) {
      return json(400, { code: -32600, message: 'invalid handle' });
    }
    const info = await getHandleInfo(bank, handle);
    if (info.available) {
      return json(200, { handle, available: true });
    }
    return json(200, { handle, available: false, pubkey: info.pubkey });
  }

  if (uiPath === '/register' && request.method === 'POST') {
    return handleRegister(bank, await request.json() as Record<string, unknown>);
  }

  const keystoreMatch = uiPath.match(/^\/keystore\/([^/]+)$/);
  if (keystoreMatch && request.method === 'GET') {
    return handleKeystoreGet(bank, keystoreMatch[1]!);
  }

  if (uiPath === '/challenge' && request.method === 'GET') {
    return json(200, { nonce: newUlid(), exp: Date.now() + 120000 });
  }

  // Public bank config — the SPA fetches this during bootstrap, before any
  // user is unlocked, to learn the bank's pubkey/url. Same data as
  // /barter-bank.json; no auth required.
  if (uiPath === '/config' && request.method === 'GET') {
    return json(200, {
      pubkey: bank.pubkey,
      url: bank.url,
      name: bank.name,
      protocol_version: 'barter.game/v1',
    });
  }

  // Public issuer resolution — everything this bank knows about a pubkey:
  // handle, newest Address doc, vouchers issued. Used by profile landing
  // pages, the Network screen, and webapp QR scans. Read-only public data.
  const resolveMatch = uiPath.match(/^\/resolve\/([^/]+)$/);
  if (resolveMatch && request.method === 'GET') {
    const pk = resolveMatch[1]!;
    if (!isValidBase58(pk)) {
      return json(400, { code: -32600, message: 'invalid pubkey' });
    }
    const [handle, address, vouchers] = await Promise.all([
      getHandleByPubkey(bank, pk),
      getAddress(bank, pk),
      listVouchersByIssuer(bank, pk),
    ]);
    return json(200, {
      pubkey: pk,
      handle: handle ?? null,
      address: address ?? null,
      vouchers,
      bank: bank.pubkey,
      bank_url: bank.url,
    });
  }

  return null;
}

// --- auth ------------------------------------------------------------------

async function requireAuth(
  bank: Bank,
  request: Request,
  basePath: string,
): Promise<Base58PubKey> {
  const header = request.headers.get('X-Barter-Auth');
  if (!header) throw new UiError(401, -32001, 'missing X-Barter-Auth');
  const [docB64, sig] = header.split('.');
  if (!docB64 || !sig) throw new UiError(400, -32600, 'malformed auth header');
  let authdoc: Record<string, unknown>;
  try {
    const bytes = base64urlDecode(docB64);
    authdoc = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new UiError(400, -32600, 'authdoc decode failed');
  }
  if (
    typeof authdoc.pubkey !== 'string' ||
    typeof authdoc.method !== 'string' ||
    typeof authdoc.path !== 'string' ||
    typeof authdoc.id !== 'string' ||
    typeof authdoc.ts !== 'number'
  ) {
    throw new UiError(400, -32600, 'authdoc missing fields');
  }
  if (authdoc.method !== request.method) {
    throw new UiError(400, -32001, 'method mismatch');
  }
  // The client signs pathname + query so query params are tamper-proof too.
  const reqUrl = new URL(request.url);
  const expectedPath = reqUrl.pathname + reqUrl.search;
  if (authdoc.path !== expectedPath) {
    throw new UiError(400, -32001, 'path mismatch');
  }
  if (!verifyDoc(authdoc, sig, authdoc.pubkey)) {
    throw new UiError(401, -32001, 'invalid auth signature');
  }
  if (Math.abs(Date.now() - authdoc.ts) > 120000) {
    throw new UiError(408, -32006, 'timestamp skew');
  }
  const bodyHash = request.body
    ? await sha256Base58(await request.clone().text())
    : undefined;
  if (bodyHash !== undefined && authdoc.body_sha256 !== bodyHash) {
    throw new UiError(400, -32600, 'body hash mismatch');
  }
  if (bodyHash === undefined && authdoc.body_sha256 !== undefined && authdoc.body_sha256 !== null) {
    throw new UiError(400, -32600, 'body hash mismatch');
  }
  const claimed = await claimReplayId(bank, authdoc.pubkey, authdoc.id, bank.pubkey);
  if (!claimed) throw new UiError(409, -32002, 'replay');
  return authdoc.pubkey;
}

// --- registration / keystore ----------------------------------------------

async function handleRegister(
  bank: Bank,
  body: Record<string, unknown>,
): Promise<Response> {
  const handle = body.handle;
  const pubkey = body.pubkey;
  const proof = body.proof;
  const keystore = body.keystore;
  if (
    typeof handle !== 'string' ||
    typeof pubkey !== 'string' ||
    typeof proof !== 'string' ||
    !keystore ||
    typeof keystore !== 'object' ||
    Array.isArray(keystore)
  ) {
    return json(400, { code: -32600, message: 'invalid register body' });
  }
  if (!HANDLE_RE.test(handle)) {
    return json(400, { code: -32600, message: 'invalid handle' });
  }
  if (!isValidBase58(pubkey)) {
    return json(422, { code: -32012, message: 'invalid pubkey' });
  }
  const info = await getHandleInfo(bank, handle);
  if (!info.available) {
    return json(409, { code: -32008, message: 'handle taken' });
  }
  const existingHandle = await getHandleByPubkey(bank, pubkey);
  if (existingHandle) {
    return json(409, { code: -32009, message: 'pubkey already registered' });
  }
  const keystoreHash = hashDoc(keystore);
  const signed = canonicalize({ handle, pubkey, keystore_sha256: keystoreHash });
  if (!verifyDoc(JSON.parse(signed), proof, pubkey)) {
    return json(401, { code: -32001, message: 'proof signature invalid' });
  }
  await registerHandle(bank, handle, pubkey, keystore as KeystoreBlob);
  return json(201, { handle, pubkey });
}

async function handleKeystoreGet(bank: Bank, handle: string): Promise<Response> {
  if (!HANDLE_RE.test(handle)) {
    return json(400, { code: -32600, message: 'invalid handle' });
  }
  // Simple rate limiter keyed by handle (5/min).
  const key: Deno.KvKey = [bank.pubkey, 'rl_keystore', handle];
  const now = Date.now();
  const bucket = await bank.kv.get<{ count: number; window: number }>(key);
  const current = bucket.value ?? { count: 0, window: now };
  if (now - current.window > 60000) {
    current.count = 0;
    current.window = now;
  }
  current.count += 1;
  if (current.count > 5) {
    return json(429, { code: -32010, message: 'rate limited', retry_after: 60 });
  }
  await bank.kv.set(key, current, { expireIn: 120000 });
  const ks = await getKeystore(bank, handle);
  if (!ks) return json(404, { code: -32005, message: 'unknown handle' });
  return json(200, { handle, pubkey: ks.pubkey, keystore: ks.keystore });
}

// --- sub-resource CRUD helpers --------------------------------------------

type SubResource = 'trusted' | 'contacts' | 'banks';

async function crudList(
  bank: Bank,
  pubkey: Base58PubKey,
  field: Exclude<SubResource, 'trusted'>,
  request: Request,
): Promise<Response> {
  const state = await getUiState(bank, pubkey);
  if (request.method === 'GET') {
    return json(200, state[field]);
  }
  if (request.method === 'POST') {
    const body = await request.json() as Record<string, unknown>;
    const arr = state[field] as Array<Record<string, unknown>>;
    const existing = arr.findIndex((x) => x.pubkey === body.pubkey);
    if (existing >= 0) arr[existing] = { ...arr[existing], ...body };
    else arr.push(body);
    const rev = await putUiState(bank, state);
    return json(200, { [field]: arr, rev });
  }
  return json(405, { code: -32600, message: 'method not allowed' });
}

async function crudItem(
  bank: Bank,
  pubkey: Base58PubKey,
  field: Exclude<SubResource, 'trusted'>,
  itemPubkey: string,
  request: Request,
  normalize: (item: Record<string, unknown>) => Record<string, unknown>,
): Promise<Response> {
  if (!isValidBase58(itemPubkey)) {
    return json(422, { code: -32012, message: 'invalid pubkey' });
  }
  const state = await getUiState(bank, pubkey);
  const arr = state[field] as Array<Record<string, unknown>>;
  if (request.method === 'POST' || request.method === 'PUT') {
    const body = await request.json() as Record<string, unknown>;
    const normalized = normalize({ ...body, pubkey: itemPubkey });
    const idx = arr.findIndex((x) => x.pubkey === itemPubkey);
    if (idx >= 0) arr[idx] = normalized;
    else arr.push(normalized);
    const rev = await putUiState(bank, state);
    return json(200, { [field]: arr, rev });
  }
  if (request.method === 'DELETE') {
    (state[field] as unknown[]) = arr.filter((x) => x.pubkey !== itemPubkey);
    const rev = await putUiState(bank, state);
    return json(200, { [field]: state[field], rev });
  }
  return json(405, { code: -32600, message: 'method not allowed' });
}

// --- aggregation ----------------------------------------------------------

async function handlePortfolio(bank: Bank, pubkey: Base58PubKey): Promise<Response> {
  const rows = await listAccounts(bank, pubkey);
  const holdings = rows.map((r) => ({
    bank: bank.pubkey,
    voucher: r.account.voucher,
    name: r.voucher?.name ?? 'Unknown',
    account: hashDoc(r.account),
    current: r.balance,
    pending: 0, // computed per account below
    issuer: r.voucher?.pubkey ?? '',
  }));
  for (const h of holdings) {
    const bal = await getAccountBalance(bank, h.account);
    if (bal) {
      h.current = bal.current;
      h.pending = bal.pending;
    }
  }
  return json(200, { as_of: Date.now(), holdings, unreachable: [] });
}

async function handleHistory(
  bank: Bank,
  pubkey: Base58PubKey,
  url: URL,
): Promise<Response> {
  const rows = await listAccounts(bank, pubkey);
  const events = [];
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '100', 10), 200);
  for (const { account } of rows) {
    const accountHash = hashDoc(account);
    const iter = bank.kv.list<boolean>({ prefix: [bank.pubkey, 'account_record', accountHash] });
    for await (const entry of iter) {
      const hash = entry.key[entry.key.length - 1] as string;
      const rec = await getRecord(bank, hash);
      if (!rec) continue;
      const sigs = await getSignaturesForRecord(bank, hash);
      const state = sigs.some((s) => s.action === 'settle')
        ? 'settled'
        : sigs.some((s) => s.action === 'hold')
        ? 'held'
        : sigs.some((s) => s.action === 'ready')
        ? 'approved'
        : sigs.some((s) => s.action === 'reject')
        ? 'rejected'
        : 'created';
      events.push({
        deal_id: rec.details.deal_id,
        record: hash,
        pair: rec.details.pair,
        voucher: account.voucher,
        amount: rec.doc.amount,
        direction: rec.doc.type,
        state,
        signatures: sigs.map((s) => hashDoc(s)),
      });
      if (events.length >= limit) break;
    }
    if (events.length >= limit) break;
  }
  return json(200, { events, next_cursor: null });
}

async function handleOrders(bank: Bank, pubkey: Base58PubKey): Promise<Response> {
  const orders = await listOrdersByHolder(bank, pubkey);
  const out = [];
  for (const o of orders) {
    const hash = hashDoc(o);
    const kind = o.debit ? (o.credit ? 'two-sided' : 'cheque') : 'invoice';
    const offers = await getOffersForOrder(bank, hash);
    out.push({
      order: hash,
      ulid: o.ulid,
      rate: o.rate,
      lead: o.lead,
      debit: o.debit,
      credit: o.credit,
      kind,
      offers,
      state: 'open',
      matched_deals: [],
    });
  }
  return json(200, { orders: out });
}

// --- discovery ------------------------------------------------------------

async function handleDiscover(
  bank: Bank,
  pubkey: Base58PubKey,
  body: Record<string, unknown>,
): Promise<Response> {
  const state = await getUiState(bank, pubkey);
  const banks = (body.banks as Array<{ pubkey: string; url: string }> | undefined) ??
    state.banks;
  const vouchers = (body.vouchers as string[] | undefined) ??
    state.catalog.map((c: unknown) => (c as { voucher: string }).voucher);
  const intentions = (body.intentions as Array<'sell' | 'buy'> | undefined) ?? ['sell', 'buy'];
  const out: Array<Record<string, unknown>> = [];
  const unreachable = [];
  for (const b of banks) {
    for (const v of vouchers) {
      for (const intention of intentions) {
        try {
          const res = await bankRpcCall(bank, b.url, b.pubkey, 'list_offers', {
            voucher_hash: v,
            intention,
          }) as { result?: unknown[]; error?: { message: string } };
          if (res.error) throw new Error(res.error.message);
          const offers = (res.result ?? []) as Array<Record<string, unknown>>;
          for (const o of offers) {
            out.push({
              offer: hashDoc(o),
              bank: b.pubkey,
              bank_url: b.url,
              intention,
              ...(o as Record<string, unknown>),
              discovered_at: Date.now(),
            });
          }
        } catch (e) {
          unreachable.push({ bank: b.pubkey, error: String(e) });
        }
      }
    }
  }
  return json(200, { as_of: Date.now(), offers: out, polled: banks.map((b) => b.pubkey), unreachable });
}

// --- relay ----------------------------------------------------------------

async function handleRelay(
  bank: Bank,
  body: Record<string, unknown>,
): Promise<Response> {
  const bankUrl = body.bank_url;
  const envelope = body.envelope;
  if (typeof bankUrl !== 'string' || !envelope || typeof envelope !== 'object') {
    return json(400, { code: -32602, message: 'bank_url and envelope required' });
  }
  const env = envelope as Record<string, unknown>;
  const to = env.to;
  if (typeof to !== 'string') {
    return json(400, { code: -32602, message: 'envelope.to required' });
  }
  const disc = await fetchDiscovery(bankUrl, to);
  if (!disc || disc.pubkey !== to) {
    return json(409, { code: -32013, message: 'pubkey pinning mismatch' });
  }
  try {
    const res = await fetch(`${bankUrl.replace(/\/$/, '')}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(envelope),
    });
    const payload = await res.json();
    return json(200, { ok: true, status: res.status, result: payload });
  } catch {
    return json(502, { ok: false, code: -32014, message: 'upstream unreachable' });
  }
}

async function handleRelaySignatures(
  bank: Bank,
  body: Record<string, unknown>,
): Promise<Response> {
  const from = body.from as { pubkey: string; url: string } | undefined;
  const to = body.to as { pubkey: string; url: string } | undefined;
  const hashes = body.record_hashes as string[] | undefined;
  if (!from || !to || !Array.isArray(hashes)) {
    return json(400, { code: -32602, message: 'from, to, record_hashes required' });
  }
  for (const peer of [from, to]) {
    const disc = await fetchDiscovery(peer.url, peer.pubkey);
    if (!disc || disc.pubkey !== peer.pubkey) {
      return json(409, { code: -32013, message: `pinning mismatch for ${peer.pubkey}` });
    }
  }
  const signatures: Array<Record<string, unknown>> = [];
  for (const h of hashes) {
    const res = await bankRpcCall(bank, from.url, from.pubkey, 'get_record_signatures', {
      record_hash: h,
    }) as { result?: { signatures: Array<Record<string, unknown>> } };
    const sigs = res.result?.signatures ?? [];
    signatures.push(...sigs);
  }
  if (signatures.length === 0) {
    return json(200, { ok: true, relayed: 0, advanced: false });
  }
  const pushRes = await bankRpcCall(bank, to.url, to.pubkey, 'notify_signatures', {
    signatures,
  }) as { result?: { advanced: boolean } };
  return json(200, {
    ok: true,
    relayed: signatures.length,
    advanced: pushRes.result?.advanced ?? false,
  });
}

// --- propose_deal ---------------------------------------------------------

async function handleProposeDeal(
  bank: Bank,
  authPubkey: Base58PubKey,
  body: Record<string, unknown>,
): Promise<Response> {
  const offer1Raw = body.offer1;
  const offer2Raw = body.offer2;
  let banksRaw = body.banks;
  if (
    !offer1Raw ||
    typeof offer1Raw !== 'object' ||
    Array.isArray(offer1Raw) ||
    !offer2Raw ||
    typeof offer2Raw !== 'object' ||
    Array.isArray(offer2Raw)
  ) {
    return json(400, { code: -32602, message: 'offer1 and offer2 required' });
  }

  const dealId = newUlid();

  // Resolve participating banks. Explicit body.banks is preferred; otherwise
  // try to derive from the two offers using the authenticated user's known banks.
  let banks: Array<{ pubkey: string; url: string }>;
  if (Array.isArray(banksRaw) && banksRaw.length > 0) {
    banks = banksRaw as Array<{ pubkey: string; url: string }>;
  } else {
    const userState = await getUiState(bank, authPubkey);
    const known = new Map((userState.banks as Array<{ pubkey: string; url: string }>).map((b) => [b.pubkey, b.url]));
    const resolved = new Map<string, string>();
    const offerHashes = [
      (offer1Raw as Record<string, unknown>).hash as string,
      (offer2Raw as Record<string, unknown>).hash as string,
    ];
    for (const h of offerHashes) {
      if (typeof h !== 'string') continue;
      for (const [pubkey, url] of known) {
        try {
          const res = await bankRpcCall(bank, url, pubkey, 'get_offer', { offer_hash: h }) as {
            result?: Record<string, unknown>;
            error?: { message: string };
          };
          if (res.result) {
            resolved.set(pubkey, url);
            break;
          }
        } catch {
          // continue searching
        }
      }
    }
    if (resolved.size < 2) {
      return json(422, {
        code: -32013,
        message: 'could not derive both participating banks from offers; add banks to your UI state or pass banks explicitly',
      });
    }
    banks = Array.from(resolved.entries()).map(([pubkey, url]) => ({ pubkey, url }));
  }

  // Validate bank discovery / pinning.
  for (const b of banks) {
    const disc = await fetchDiscovery(b.url, b.pubkey);
    if (!disc || disc.pubkey !== b.pubkey) {
      return json(409, { code: -32013, message: `pinning mismatch for ${b.pubkey}` });
    }
  }

  // Share Address docs among participating banks.
  const addresses: Array<Record<string, unknown>> = [];
  for (const b of banks) {
    const addr = await bankRpcCall(bank, b.url, b.pubkey, 'get_address', {
      pubkey: b.pubkey,
    }) as { result?: Record<string, unknown> };
    if (addr.result) addresses.push(addr.result);
  }
  for (const target of banks) {
    for (const addr of addresses) {
      const author = addr.pubkey as string;
      if (author === target.pubkey) continue;
      await bankRpcCall(bank, target.url, target.pubkey, 'submit_docs', {
        docs: [addr],
      });
    }
  }

  // Resolve the two holder Orders. `offer1`/`offer2` carry Order hashes plus the
  // amount each order gives (its debit voucher). order1 gives V1 (amount1) and
  // receives V2; order2 gives V2 (amount2) and receives V1.
  const o1 = offer1Raw as Record<string, unknown>;
  const o2 = offer2Raw as Record<string, unknown>;
  const order1Hash = o1.hash;
  const order2Hash = o2.hash;
  const amount1 = o1.debit_amount;
  const amount2 = o2.debit_amount;
  if (
    typeof order1Hash !== 'string' || typeof order2Hash !== 'string' ||
    typeof amount1 !== 'number' || typeof amount2 !== 'number'
  ) {
    return json(400, { code: -32602, message: 'offer1/offer2 need { hash, debit_amount }' });
  }
  const order1 = await getOrder(bank, order1Hash);
  const order2 = await getOrder(bank, order2Hash);
  if (!order1 || !order2) {
    return json(422, { code: -32005, message: 'this bank does not hold both orders' });
  }

  // Per bank: mint the record pair for the voucher it issues, then send one
  // Mandate per Order (the giver's Order clears the debit record, the
  // receiver's Order clears the credit record). All signed by this bank as
  // coordinator.
  const records: Record<string, string[]> = {};
  for (const b of banks) {
    let giver: string, receiver: string, amount: number, counter: number;
    if (order1.debit && order1.debit.bank === b.pubkey) {
      giver = order1Hash; receiver = order2Hash; amount = amount1; counter = amount2;
    } else if (order2.debit && order2.debit.bank === b.pubkey) {
      giver = order2Hash; receiver = order1Hash; amount = amount2; counter = amount1;
    } else {
      return json(422, { code: -32000, message: `bank ${b.pubkey} issues neither voucher` });
    }

    const res = await bankRpcCall(bank, b.url, b.pubkey, 'create_records', {
      giver, receiver, amount, counter_amount: counter, deal_id: dealId,
    }) as { result?: { records: Array<Record<string, unknown>> }; error?: { code: number; message: string } };
    if (res.error) {
      return json(502, { ok: false, code: res.error.code, message: res.error.message, bank: b.pubkey });
    }
    const recs = (res.result?.records ?? []) as Array<Record<string, unknown>>;
    records[b.pubkey] = recs.map((r) => hashDoc(r));

    const debitRec = recs.find((r) => r.type === 'debit');
    const creditRec = recs.find((r) => r.type === 'credit');
    const mandates: Array<{ order: string; recordHash: string }> = [];
    if (debitRec) mandates.push({ order: giver, recordHash: hashDoc(debitRec) });
    if (creditRec) mandates.push({ order: receiver, recordHash: hashDoc(creditRec) });
    for (const m of mandates) {
      const mandate = {
        type: 'mandate',
        pubkey: bank.pubkey,
        ulid: newUlid(),
        deal_id: dealId,
        order: m.order,
        bank: b.pubkey,
        records: [m.recordHash],
        sig: '',
      };
      mandate.sig = signDoc(mandate, bank.privateKey);
      await bankRpcCall(bank, b.url, b.pubkey, 'submit_mandate', { mandate });
    }
  }

  return json(200, {
    deal_id: dealId,
    participating_banks: banks.map((b) => b.pubkey),
    records,
    state: 'mandated',
  });
}

function recordState(sigs: Array<{ action?: string }>): string {
  if (sigs.some((s) => s.action === 'reject')) return 'rejected';
  if (sigs.some((s) => s.action === 'settle')) return 'settled';
  if (sigs.some((s) => s.action === 'hold')) return 'held';
  if (sigs.some((s) => s.action === 'ready')) return 'approved';
  return 'created';
}

async function handleDealStatus(
  bank: Bank,
  _authPubkey: Base58PubKey,
  dealId: string,
): Promise<Response> {
  if (!isValidUlid(dealId)) return json(400, { code: -32602, message: 'invalid deal_id' });
  const records = await listRecordsByDeal(bank, dealId);
  if (records.length === 0) return json(404, { code: -32005, message: 'deal not found' });
  const legs = [];
  let overall = 'mandated';
  for (const r of records) {
    const h = hashDoc(r.doc);
    const sigs = await getSignaturesForRecord(bank, h);
    const state = recordState(sigs);
    legs.push({
      bank: bank.pubkey,
      records: [h],
      state,
      ready: sigs.some((s) => s.action === 'ready'),
      hold: sigs.some((s) => s.action === 'hold'),
      settle: sigs.some((s) => s.action === 'settle'),
      role: 'local',
    });
  }
  if (legs.length > 0) {
    if (legs.every((l) => l.state === 'settled')) overall = 'settled';
    else if (legs.some((l) => l.state === 'rejected')) overall = 'rejected';
    else if (legs.every((l) => l.state === 'held' || l.state === 'settled')) overall = 'held';
    else if (legs.every((l) => ['approved', 'held', 'settled'].includes(l.state))) overall = 'approved';
    else overall = 'created';
  }
  return json(200, { deal_id: dealId, state: overall, legs, updated_at: Date.now() });
}

// --- Barter Link routes ---------------------------------------------------

type BarterMatch = { kind: string; value: string };

function matchBarterRoute(pathname: string, basePath: string): BarterMatch | null {
  const p = pathname.slice(basePath.length);
  const m = p.match(/^\/(i|v|q|o|x)\/([^/]+)$/);
  if (!m) return null;
  return { kind: m[1]!, value: m[2]! };
}

export async function handleBarterLink(
  bank: Bank,
  request: Request,
  match: BarterMatch,
  wantsJson: boolean,
): Promise<Response> {
  const url = new URL(request.url);
  if (wantsJson || url.searchParams.get('format') === 'json' || pathnameJson(url.pathname)) {
    return barterJson(bank, match);
  }
  return barterHtml(bank, match);
}

function pathnameJson(pathname: string): boolean {
  return pathname.endsWith('.json');
}

// Assemble the machine payload for a Barter Link. Every landing kind resolves
// to an envelope { v, kind, pubkey?, bank, bank_url, docs[] } whose docs are
// standard signed protocol documents the receiver verifies locally.
async function barterEnvelope(
  bank: Bank,
  match: BarterMatch,
): Promise<Record<string, unknown> | null> {
  const base = { v: 1, bank: bank.pubkey, bank_url: bank.url };
  if (match.kind === 'i') {
    const [vouchers, address, handle] = await Promise.all([
      listVouchersByIssuer(bank, match.value),
      getAddress(bank, match.value),
      getHandleByPubkey(bank, match.value),
    ]);
    return {
      ...base,
      kind: 'profile',
      pubkey: match.value,
      handle: handle ?? null,
      docs: [...(address ? [address] : []), ...vouchers],
    };
  }
  if (match.kind === 'o') {
    const offer = await getOffer(bank, match.value);
    if (!offer) return null;
    return { ...base, kind: 'offer', docs: [offer] };
  }
  if (match.kind === 'v' || match.kind === 'q') {
    const order = await getOrder(bank, match.value);
    if (!order) return null;
    // Enforce the specialization: /v is an invoice (credit-only), /q a cheque
    // (debit-only). A two-sided Order is not addressable via these routes.
    if (match.kind === 'v' && order.debit) return null;
    if (match.kind === 'q' && order.credit) return null;
    const handle = await getHandleByPubkey(bank, order.pubkey);
    return {
      ...base,
      kind: match.kind === 'v' ? 'invoice' : 'cheque',
      pubkey: order.pubkey,
      handle: handle ?? null,
      docs: [order],
    };
  }
  return { ...base, kind: 'invite', token: match.value, docs: [] };
}

async function barterJson(bank: Bank, match: BarterMatch): Promise<Response> {
  const envelope = await barterEnvelope(bank, match);
  if (!envelope) return notFound();
  return new Response(JSON.stringify(envelope), {
    status: 200,
    headers: { 'Content-Type': 'application/barter+json;v=1' },
  });
}

// Human landing page. Serves a real page for camera-browser visitors (register
// & trust / pay / claim CTAs into the SPA) while remaining a doc carrier: the
// signed payload is embedded via <script type="application/barter+json">,
// <link rel="alternate">, and flat barter:* meta tags, per the extraction
// precedence in docs/ui/claude-ui.md §5.
async function barterHtml(bank: Bank, match: BarterMatch): Promise<Response> {
  const envelope = await barterEnvelope(bank, match);
  if (!envelope) {
    return new Response(landingShell(bank, 'Not found', '<p class="muted">This Barter Link does not resolve at this bank.</p>', '', ''), {
      status: 404,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    });
  }
  const payload = canonicalize(envelope);
  const selfPath = `/${bank.name}/${match.kind}/${match.value}`;
  const jsonHref = `${bank.url.replace(/\/[^/]+$/, '')}${selfPath}?format=json`;
  const appBase = `${bank.url}/ui/app`;

  let title = 'barter.game';
  let body = '';
  let cta = '';
  const kind = envelope.kind as string;

  if (kind === 'profile') {
    const handle = (envelope.handle as string | null) ?? shorten(match.value);
    const docs = envelope.docs as Array<Record<string, unknown>>;
    const vouchers = docs.filter((d) => d.type === 'voucher');
    title = `${handle} on barter.game`;
    body = `
      <h2>${escapeHtml(handle)}</h2>
      <p class="mono muted">${escapeHtml(shorten(match.value))} @ ${escapeHtml(bank.name)}</p>
      <p>invites you to barter. Their vouchers:</p>
      ${vouchers.length === 0 ? '<p class="muted">No vouchers published yet.</p>' : ''}
      ${vouchers.map((v) => `<div class="card"><b>${escapeHtml(String(v.name ?? ''))}</b>${v.description_md ? `<p class="muted">${escapeHtml(String(v.description_md))}</p>` : ''}</div>`).join('')}
    `;
    cta = `
      <a class="btn primary" href="${appBase}#/land/i/${escapeHtml(match.value)}">Register &amp; trust ${escapeHtml(handle)}</a>
      <a class="btn" href="${appBase}#/land/i/${escapeHtml(match.value)}">I already have an account</a>
    `;
  } else if (kind === 'invoice' || kind === 'cheque') {
    const order = (envelope.docs as Array<Record<string, unknown>>)[0]!;
    const side = (kind === 'invoice' ? order.credit : order.debit) as Record<string, unknown>;
    const handle = (envelope.handle as string | null) ?? shorten(String(order.pubkey));
    const verb = kind === 'invoice' ? 'Pay' : 'Claim';
    title = `${verb} ${handle} · barter.game`;
    body = `
      <h2>${kind === 'invoice' ? `Pay ${escapeHtml(handle)}` : `A cheque from ${escapeHtml(handle)}`}</h2>
      <p class="muted">${kind === 'invoice' ? 'This is a request for payment.' : 'You can claim voucher funds from this cheque.'}</p>
      <div class="card">
        <div>Amount: <b>${side.min === side.max ? escapeHtml(String(side.max)) : `${escapeHtml(String(side.min))}–${escapeHtml(String(side.max))}`}</b></div>
        <div class="mono muted">voucher ${escapeHtml(shorten(String(side.voucher)))}</div>
        <div class="mono muted">${kind === 'invoice' ? 'payee' : 'payer'} ${escapeHtml(shorten(String(order.pubkey)))}</div>
      </div>
    `;
    cta = `
      <a class="btn primary" href="${appBase}#/land/${match.kind}/${escapeHtml(match.value)}">${verb} with barter.game</a>
      <a class="btn" href="${appBase}">What is this?</a>
    `;
  } else if (kind === 'offer') {
    title = 'Offer · barter.game';
    body = `<h2>A trade offer</h2><p class="muted">Open it in the app to see terms and accept.</p>`;
    cta = `<a class="btn primary" href="${appBase}#/land/o/${escapeHtml(match.value)}">View offer</a>`;
  } else {
    title = 'Invite · barter.game';
    body = `<h2>You are invited to barter</h2>`;
    cta = `<a class="btn primary" href="${appBase}">Open barter.game</a>`;
  }

  const head = `
  <title>${escapeHtml(title)}</title>
  <link rel="alternate" type="application/barter+json;v=1" href="${escapeHtml(jsonHref)}">
  <meta name="barter:version" content="1">
  <meta name="barter:type" content="${escapeHtml(kind)}">
  <meta name="barter:bank" content="${bank.pubkey}">
  ${envelope.pubkey ? `<meta name="barter:pubkey" content="${escapeHtml(String(envelope.pubkey))}">` : ''}
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="Federated mutual-credit barter — verify, then trade.">
  <meta property="og:type" content="website">
  <script type="application/barter+json" id="barter-payload">${payload.replace(/</g, '\\u003c')}</script>`;

  return new Response(landingShell(bank, title, body, cta, head), {
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
  });
}

function landingShell(bank: Bank, title: string, body: string, cta: string, extraHead: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  ${extraHead || `<title>${escapeHtml(title)}</title>`}
  <style>
    :root { color-scheme: dark; }
    body { margin: 0; background: #131722; color: #e6e9f0; font: 16px/1.5 system-ui, sans-serif; }
    .wrap { max-width: 420px; margin: 0 auto; padding: 32px 20px; }
    .brand { font-weight: 700; letter-spacing: .02em; color: #7cb9f2; margin-bottom: 24px; }
    .card { background: #1b2130; border: 1px solid #2a3245; border-radius: 10px; padding: 12px 14px; margin: 10px 0; }
    .btn { display: block; text-align: center; margin: 10px 0; padding: 12px; border-radius: 10px; background: #232b3d; color: #e6e9f0; text-decoration: none; font-weight: 600; }
    .btn.primary { background: #4da3ff; color: #0b1020; }
    .muted { color: #8b93a7; }
    .mono { font-family: ui-monospace, monospace; font-size: .85em; }
    .foot { margin-top: 28px; font-size: .8em; color: #8b93a7; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="brand">barter.game</div>
    ${body}
    <div class="cta">${cta}</div>
    <p class="foot">Signatures are verified in your browser before anything is trusted. Bank: <span class="mono">${escapeHtml(shorten(bank.pubkey))}</span> · ${escapeHtml(bank.name)}</p>
  </div>
</body>
</html>`;
}

function shorten(s: string): string {
  return s.length > 16 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// --- SPA static ------------------------------------------------------------

async function serveSpa(_request: Request, _uiPath: string): Promise<Response> {
  try {
    const file = await Deno.readTextFile('./apps/web/index.html');
    return new Response(file, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  } catch {
    return new Response(
      '<!doctype html><html><head><meta charset="utf-8"><title>barter</title></head><body><div id="app"></div></body></html>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
    );
  }
}

// --- utilities -------------------------------------------------------------

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });
}

function notFound(): Response {
  return json(404, { code: -32005, message: 'not found' });
}

export function cors(response: Response): Response {
  response.headers.set('Access-Control-Allow-Origin', '*');
  response.headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Barter-Auth');
  return response;
}

function base64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

async function sha256Base58(s: string): Promise<string> {
  const bytes = new TextEncoder().encode(s);
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return base58Encode(new Uint8Array(hash));
}
