import {
  base58Encode,
  base58Decode,
  canonicalizeWithoutSig,
  genKeyPair,
  hashDoc,
  newUlid,
  publicKeyOf,
  sha256Base58,
  signDoc,
  verifyDoc,
} from './protocol.js';
import { qrDataUrl, startScanner } from './qr.js';

// ---------------- key encryption (PBKDF2 + AES-GCM) ----------------

// ---------------- key encryption (PBKDF2 + AES-GCM) ----------------

async function deriveKey(password, salt, iterations = 250000) {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function encryptSeed(seed, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, seed));
  return {
    kdf: 'pbkdf2-sha256',
    iterations: 250000,
    salt: arrayBufferToBase64url(salt),
    nonce: arrayBufferToBase64url(iv),
    ciphertext: arrayBufferToBase64url(ciphertext),
    aead: 'aes-256-gcm'
  };
}

async function decryptSeed(blob, password) {
  const salt = base64urlToArrayBuffer(blob.salt);
  const iv = base64urlToArrayBuffer(blob.nonce);
  const ciphertext = base64urlToArrayBuffer(blob.ciphertext);
  const key = await deriveKey(password, salt, blob.iterations);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
  return new Uint8Array(plain);
}

function arrayBufferToBase64url(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function base64urlToArrayBuffer(s) {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// ---------------- state ----------------

const state = {
  bankName: '',
  bankPubkey: '',
  bankUrl: '',
  basePath: '',
  user: null, // { handle, pubkey, privateKey }
  uiState: null,
};

function parsePath() {
  const parts = location.pathname.split('/').filter(Boolean);
  state.bankName = parts[0] || 'bank';
  state.basePath = `/${state.bankName}`;
}
parsePath();

// ---------------- API ----------------

async function fetchConfig() {
  const res = await fetch(`${state.basePath}/ui/config`);
  const cfg = await res.json();
  state.bankPubkey = cfg.pubkey;
  state.bankUrl = cfg.url;
  return cfg;
}

async function rpcCall(method, params, toPubkey) {
  const id = newUlid();
  const envelope = {
    jsonrpc: '2.0', id, method, params,
    pubkey: state.user.pubkey,
    to: toPubkey || state.bankPubkey,
    sig: ''
  };
  envelope.sig = signDoc(envelope, state.user.privateKey);
  const res = await fetch(`${state.basePath}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope)
  });
  const data = await res.json();
  if (data.error) throw new Error(`${data.error.code}: ${data.error.message}`);
  return data.result;
}

async function signedRequest(method, path, body) {
  const authdoc = {
    pubkey: state.user.pubkey,
    method,
    path: `${state.basePath}/ui${path}`,
    id: newUlid(),
    ts: Date.now(),
    body_sha256: body ? sha256Base58(JSON.stringify(body)) : null
  };
  const sig = signDoc(authdoc, state.user.privateKey);
  const token = `${arrayBufferToBase64url(new TextEncoder().encode(canonicalizeWithoutSig(authdoc)))}.${sig}`;
  const res = await fetch(`${state.basePath}/ui${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Barter-Auth': token },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  if (data.code && data.code < 0) throw new Error(`${data.code}: ${data.message}`);
  return data;
}

async function uiGet(path) { return signedRequest('GET', path, null); }
async function uiPost(path, body) { return signedRequest('POST', path, body); }
async function uiPut(path, body) { return signedRequest('PUT', path, body); }
async function uiDelete(path) { return signedRequest('DELETE', path, null); }

// ---------------- cross-bank calls ----------------
// A scanned invoice/cheque may live at another bank (the voucher's issuing
// bank). These variants address an explicit bank base URL + pubkey instead of
// the bank the SPA is served from.

async function rpcCallAt(base, toPubkey, method, params) {
  const envelope = {
    jsonrpc: '2.0', id: newUlid(), method, params,
    pubkey: state.user.pubkey, to: toPubkey, sig: ''
  };
  envelope.sig = signDoc(envelope, state.user.privateKey);
  const res = await fetch(`${base.replace(/\/$/, '')}/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(envelope)
  });
  const data = await res.json();
  if (data.error) throw new Error(`${data.error.code}: ${data.error.message}`);
  return data.result;
}

async function signedRequestAt(base, method, path, body) {
  const clean = base.replace(/\/$/, '');
  // The auth doc signs the request's real pathname (+ query) at the target bank.
  const u = new URL(`${clean}/ui${path}`, location.origin);
  const authdoc = {
    pubkey: state.user.pubkey, method, path: u.pathname + u.search,
    id: newUlid(), ts: Date.now(),
    body_sha256: body ? sha256Base58(JSON.stringify(body)) : null
  };
  const sig = signDoc(authdoc, state.user.privateKey);
  const token = `${arrayBufferToBase64url(new TextEncoder().encode(canonicalizeWithoutSig(authdoc)))}.${sig}`;
  const res = await fetch(`${clean}/ui${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Barter-Auth': token },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json();
  if (data.code && data.code < 0) throw new Error(`${data.code}: ${data.message}`);
  return data;
}

// Where to reach the bank that issues a voucher (order side.bank — pinned in
// the holder's signed Order). Tries: this bank, the envelope's serving bank,
// the user's pinned banks, then the Address directory at this bank.
async function resolveVoucherBank(side, env) {
  if (side.bank === state.bankPubkey) return { pubkey: state.bankPubkey, url: state.bankUrl };
  if (env && env.bank === side.bank && env.bank_url) return { pubkey: side.bank, url: env.bank_url };
  try {
    const pinned = await uiGet('/banks');
    const hit = (pinned || []).find(b => b.pubkey === side.bank);
    if (hit) return { pubkey: side.bank, url: hit.url };
  } catch { /* fall through */ }
  try {
    const addr = await rpcCall('get_address', { pubkey: side.bank });
    if (addr && addr.url) return { pubkey: side.bank, url: addr.url };
  } catch { /* fall through */ }
  throw new Error('this voucher is issued at a bank this app cannot reach — scan the QR from the issuer\'s bank or pin their bank under Network');
}

// ---------------- holdings across banks ----------------
// A voucher lives at its issuing bank, so claiming a foreign cheque puts the
// balance THERE, not at the bank this SPA is served from. The protocol already
// exposes this to the holder: `list_accounts` and `get_account_balance` are
// signed RPCs any bank will answer. Aggregate over this bank + pinned banks.

async function remoteHoldings(bankRef) {
  const res = await rpcCallAt(bankRef.url, bankRef.pubkey, 'list_accounts', {});
  const byHash = {};
  (res.vouchers || []).forEach(v => { byHash[hashDoc(v)] = v; });
  const out = [];
  for (const a of (res.accounts || [])) {
    const account = hashDoc(a);
    const bal = await rpcCallAt(bankRef.url, bankRef.pubkey, 'get_account_balance', { account_hash: account }).catch(() => null);
    out.push({
      bank: bankRef.pubkey,
      bank_url: bankRef.url,
      remote: true,
      voucher: a.voucher,
      name: (byHash[a.voucher] || {}).name || 'Unknown',
      account,
      // null (not 0) when the balance RPC failed — the dashboard renders '—' so
      // a transient error is never shown as a real zero balance.
      current: bal ? bal.current : null,
      pending: bal ? bal.pending : null,
    });
  }
  return out;
}

async function allHoldings() {
  const local = await uiGet('/portfolio').catch(() => ({ holdings: [] }));
  const out = (local.holdings || []).map(h => ({ ...h, remote: false }));
  const banks = await uiGet('/banks').catch(() => []);
  const remotes = (banks || []).filter(b => b.pubkey && b.pubkey !== state.bankPubkey);
  const fetched = await Promise.all(remotes.map(b => remoteHoldings(b).catch(() => [])));
  fetched.forEach(list => out.push(...list));
  return out;
}

// Remember which bank coordinates a deal so the deal screen polls the right
// place (a claimed cheque's deal lives at the voucher's bank, not ours).
function rememberDealBank(dealId, bankRef) {
  try { localStorage.setItem(`barter.dealbank.${dealId}`, JSON.stringify(bankRef)); } catch { /* ignore */ }
}
function dealBankFor(dealId) {
  try {
    const raw = localStorage.getItem(`barter.dealbank.${dealId}`);
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return null;
}

// ---------------- router ----------------

// Route segment → screen title, so the loading shell can highlight the right
// nav tab while the async screen fetches.
const ROUTE_TITLES = {
  '': 'Dashboard', vouchers: 'Vouchers', orders: 'Orders', invoices: 'Invoices',
  cheques: 'Cheques', discover: 'Discover', activity: 'Activity',
  network: 'Network', scan: 'Scan', settings: 'Settings', deal: 'Deal',
};

function route() {
  const hash = location.hash.slice(1) || '/';
  const [p, ...rest] = hash.split('/').filter(Boolean);
  const app = document.getElementById('app');
  stopActiveScanner();
  // Paint an immediate shell (nav + spinner) so a logged-in screen never blanks
  // while it fetches; the async render replaces it when the data arrives.
  // Screens that render synchronously just overwrite this with no visible flash.
  if (state.user && p !== 'land') {
    app.innerHTML = header(ROUTE_TITLES[p || ''] || '') +
      `<div class="container"><div class="skeleton" aria-live="polite"><span class="spinner"></span> Loading…</div></div>`;
  } else {
    app.innerHTML = '';
  }

  // After the (possibly async) screen renders, move focus to its heading so
  // keyboard/screen-reader users land on the new content — not stuck at <body>
  // — and the screen title is announced.
  Promise.resolve(dispatch(app, p, rest)).then(moveFocusToMain).catch(() => {});
}

function dispatch(app, p, rest) {
  // Landing routes work logged-out (they carry the register CTA themselves).
  if (p === 'land' && rest[0] && rest[1]) return renderLanding(app, rest[0], rest[1]);

  if (!state.user) {
    if (p === 'register') return renderRegister(app);
    if (p === 'connect') return renderConnect(app);
    if (p === 'unlock') return renderUnlock(app);
    return renderWelcome(app);
  }

  if (p === 'unlock') return renderUnlock(app);
  if (p === 'vouchers' && rest[0] === 'new') return renderCreateVoucher(app);
  if (p === 'vouchers') return renderVouchers(app);
  if (p === 'orders' && rest[0] === 'new') return renderCreateOrder(app);
  if (p === 'orders') return renderOrders(app);
  if (p === 'invoices' && rest[0] === 'new') return renderCreateInvoice(app);
  if (p === 'invoices') return renderInvoices(app);
  if (p === 'cheques' && rest[0] === 'new') return renderCreateCheque(app);
  if (p === 'cheques') return renderCheques(app);
  if (p === 'discover') return renderDiscover(app);
  if (p === 'deal' && rest[0]) return renderDeal(app, rest[0]);
  if (p === 'activity') return renderActivity(app);
  if (p === 'network') return renderNetwork(app);
  if (p === 'scan') return renderScan(app);
  if (p === 'settings') return renderSettings(app);
  return renderDashboard(app);
}

// Move focus to the first heading of the freshly rendered screen (skipping the
// loading skeleton), making it programmatically focusable first.
function moveFocusToMain() {
  const app = document.getElementById('app');
  if (!app || app.querySelector('.skeleton')) return; // still loading; render will re-focus
  const h = app.querySelector('h1, h2, h3');
  if (!h) return;
  h.setAttribute('tabindex', '-1');
  try { h.focus({ preventScroll: true }); } catch { h.focus(); }
}
window.skipToContent = function() { moveFocusToMain(); };

window.addEventListener('hashchange', route);
// Exposed so inline "Retry"/"Refresh" controls can re-render the current screen
// in place (no full page reload, which would wipe the in-memory key).
window.route = route;

// ---------------- UI components ----------------

function header(title) {
  return `<a href="#" class="skip-link" onclick="skipToContent();return false">Skip to content</a>
  <div class="header">
    <div class="brand">
      <div class="logo-mark"><span></span></div>
      <div><strong>${escapeHtml(state.bankName)}</strong> <span class="mono small">${escapeHtml(state.user?.pubkey.slice(0, 12) || '')}…</span></div>
    </div>
    <nav class="nav">
      <a href="#/" ${title==='Dashboard'?'class="active"':''}>Home</a>
      <a href="#/vouchers" ${title==='Vouchers'?'class="active"':''}>Vouchers</a>
      <a href="#/orders" ${title==='Orders'?'class="active"':''}>Orders</a>
      <a href="#/invoices" ${title==='Invoices'?'class="active"':''}>Invoices</a>
      <a href="#/cheques" ${title==='Cheques'?'class="active"':''}>Cheques</a>
      <a href="#/discover" ${title==='Discover'?'class="active"':''}>Discover</a>
      <a href="#/activity" ${title==='Activity'?'class="active"':''}>Activity</a>
      <a href="#/network" ${title==='Network'?'class="active"':''}>Network</a>
      <a href="#/scan" ${title==='Scan'?'class="active"':''}>Scan</a>
      <a href="#/settings">Settings</a>
    </nav>
    <button class="btn secondary" onclick="lock()">Lock</button>
  </div>`;
}

function card(title, body) { return `<div class="card"><h3>${escapeHtml(title)}</h3>${body}</div>`; }

// A "couldn't load" state, distinct from a genuine empty state — a bank outage,
// timeout, or clock-skew auth failure must never read as "you have nothing".
function loadError(what) {
  return `<div class="small error">Couldn't load ${escapeHtml(what)} — the bank may be unreachable. <button class="btn secondary" onclick="route()">Retry</button></div>`;
}

function escapeHtml(s) {
  if (typeof s !== 'string') return String(s ?? '');
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Escape a value for embedding as a single-quoted JS string literal INSIDE a
// double-quoted HTML attribute (e.g. onclick="fn('${jsStr(x)}')"). The browser
// HTML-decodes the attribute first, then the JS engine parses it, so we must
// survive both passes: backslash-escape for JS (so quotes/newlines can't break
// out of the string after decoding) and HTML-encode the attribute delimiters.
// Prefer data-* attributes + addEventListener for new code; this guards the
// remaining inline handlers that carry attacker-influenced strings.
function jsStr(s) {
  return String(s ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\r?\n/g, '\\n')
    .replace(/</g, '\\x3C')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;');
}

function toast(msg, type = 'success') {
  const t = document.createElement('div');
  t.className = `small ${type}`;
  t.setAttribute('role', type === 'error' ? 'alert' : 'status');
  t.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
  t.style.cssText = 'position:fixed;bottom:1rem;right:1rem;background:var(--card);padding:0.75rem 1rem;border:1px solid var(--border);border-radius:0.5rem;z-index:100';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 4000);
}

window.lock = function() {
  state.user = null;
  state.uiState = null;
  location.hash = '#/unlock';
  route();
};

// ---------------- screens ----------------

async function renderWelcome(app) {
  const cfg = await fetchConfig().catch(() => null);
  app.innerHTML = `<div class="container welcome">
    <div class="logo-mark large"><span></span></div>
    <h1>Be your own<br>bank.</h1>
    <p class="lede">Mint a currency only you can issue — <b>1 logo</b>, <b>1 hour of consulting</b>, <b>1 home-cooked dinner</b> — and settle it with people who already trust you.</p>
    ${cfg ? `<div class="bank-pill">
      <div class="ic">◈</div>
      <div>
        <div style="font-size:0.87rem;font-weight:600">Connected to ${escapeHtml(cfg.name)}</div>
        <div class="mono" style="font-size:0.7rem;color:var(--faint)">${escapeHtml(cfg.pubkey.slice(0,16))}… · protocol v1</div>
      </div>
    </div>` : ''}
    <div class="stack">
      <a class="btn" href="#/register">Create an identity</a>
      <a class="btn secondary" href="#/unlock">Log in</a>
      <a href="#/connect" style="text-align:center;font-size:0.87rem;color:var(--muted);padding:0.3rem">I have a raw key instead</a>
    </div>
    <p class="footnote" style="margin-top:1.6rem">handle + password login · key encrypted in this browser · never sent to the bank</p>
  </div>`;
}

const MIN_PASSWORD = 8;

function renderRegister(app) {
  app.innerHTML = `<div class="container" style="max-width:420px;padding-top:8vh">
    ${card('Create account', `
      <form id="r-form" onsubmit="doRegister();return false">
      <label for="r-handle">Handle <span class="small">(2–32 chars: a–z, 0–9, _ or -)</span></label>
      <input id="r-handle" name="username" autocomplete="username" placeholder="alice">
      <label for="r-pass">Password <span class="small">(${MIN_PASSWORD}+ characters — there is no recovery, so make it strong and save it)</span></label>
      <input id="r-pass" name="new-password" type="password" autocomplete="new-password" placeholder="••••••••">
      <label for="r-pass2">Confirm password</label>
      <input id="r-pass2" name="confirm-password" type="password" autocomplete="new-password" placeholder="••••••••">
      <label><input type="checkbox" id="r-ack"> I understand there is no password recovery</label>
      <button class="btn" type="submit" style="width:100%;margin-top:1rem">Create</button>
      <p class="small error" id="r-err"></p>
      </form>
    `)}
    <p style="text-align:center"><a href="#/">Back</a></p>
  </div>`;
}

window.doRegister = async function() {
  const handle = document.getElementById('r-handle').value.trim();
  const pass = document.getElementById('r-pass').value;
  const pass2 = document.getElementById('r-pass2').value;
  const ack = document.getElementById('r-ack').checked;
  const err = document.getElementById('r-err');
  if (!handle) { err.textContent = 'Choose a handle'; return; }
  if (pass.length < MIN_PASSWORD) { err.textContent = `Password must be at least ${MIN_PASSWORD} characters`; return; }
  if (pass !== pass2) { err.textContent = 'Passwords do not match'; return; }
  if (!ack) { err.textContent = 'Please acknowledge there is no password recovery'; return; }
  try {
    const { privateKey, pubkeyBase58 } = genKeyPair();
    const keystore = await encryptSeed(privateKey, pass);
    const proof = signDoc({ handle, pubkey: pubkeyBase58, keystore_sha256: hashDoc(keystore) }, privateKey);
    const res = await fetch(`${state.basePath}/ui/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle, pubkey: pubkeyBase58, keystore, proof })
    });
    const data = await res.json();
    if (data.code) throw new Error(`${data.code}: ${data.message}`);
    rememberHandle(handle);
    state.user = { handle, pubkey: pubkeyBase58, privateKey };
    state.uiState = await uiGet('/state');
    toast(`Welcome, ${handle}`);
    if (resumePendingAction()) return;
    location.hash = '#/';
    route();
  } catch (e) {
    err.textContent = e.message;
  }
};

function renderConnect(app) {
  app.innerHTML = `<div class="container" style="max-width:420px;padding-top:8vh">
    ${card('Connect existing key', `
      <label>Base58 private key / seed</label>
      <textarea id="c-key" rows="3" placeholder="paste 32-byte base58 seed"></textarea>
      <p class="small">Or load encrypted backup by handle below after importing.</p>
      <button class="btn" style="width:100%;margin-top:1rem" onclick="doConnect()">Connect</button>
      <p class="small error" id="c-err"></p>
    `)}
    <p style="text-align:center"><a href="#/">Back</a></p>
  </div>`;
}

window.doConnect = async function() {
  const keyStr = document.getElementById('c-key').value.trim();
  const err = document.getElementById('c-err');
  try {
    const privateKey = base58Decode(keyStr);
    if (privateKey.length !== 32) throw new Error('seed must be 32 bytes');
    const { pubkeyBase58 } = publicKeyOf(privateKey);
    state.user = { pubkey: pubkeyBase58, privateKey, handle: pubkeyBase58.slice(0, 8) };
    state.uiState = await uiGet('/state').catch(() => null);
    const handle = await uiGet('/state').then(s => null).catch(() => null);
    location.hash = '#/';
    route();
  } catch (e) {
    err.textContent = e.message;
  }
};

function renderUnlock(app) {
  const last = rememberedHandle();
  app.innerHTML = `<div class="container" style="max-width:420px;padding-top:8vh">
    ${card('Log in', `
      <form id="u-form" onsubmit="doUnlock();return false">
      <label for="u-handle">Handle</label><input id="u-handle" name="username" placeholder="alice" autocomplete="username" value="${escapeHtml(last)}">
      <label for="u-pass">Password</label><input id="u-pass" name="password" type="password" placeholder="••••••••" autocomplete="current-password">
      <button class="btn" type="submit" style="width:100%;margin-top:1rem">Log in</button>
      <p class="small error" id="u-err"></p>
      <p class="small">No password recovery. Lost password = lost account.</p>
      </form>
    `)}
    <p style="text-align:center" class="small">New here? <a href="#/register">Create account</a> · <a href="#/">Back</a></p>
  </div>`;
  const h = document.getElementById('u-handle');
  if (last) document.getElementById('u-pass').focus(); else h.focus();
}

window.doUnlock = async function() {
  const handle = document.getElementById('u-handle').value.trim();
  const pass = document.getElementById('u-pass').value;
  const err = document.getElementById('u-err');
  if (!handle || !pass) { err.textContent = 'Enter your handle and password'; return; }
  try {
    const res = await fetch(`${state.basePath}/ui/keystore/${encodeURIComponent(handle)}`);
    const data = await res.json();
    if (data.code || !data.keystore) {
      if (res.status === 404) err.textContent = 'No account with that handle at this bank';
      else if (res.status === 429) {
        const wait = data.retry_after ? ` Try again in ${data.retry_after}s.` : ' Wait a minute and try again.';
        err.textContent = `Too many attempts.${wait}`;
      } else err.textContent = 'Could not log in — please try again';
      return;
    }
    let seed;
    try {
      seed = await decryptSeed(data.keystore, pass);
    } catch { err.textContent = 'Wrong password'; return; }
    const { pubkeyBase58 } = publicKeyOf(seed);
    if (pubkeyBase58 !== data.pubkey) { err.textContent = 'Wrong password'; return; }
    rememberHandle(handle);
    state.user = { handle, pubkey: pubkeyBase58, privateKey: seed };
    state.uiState = await uiGet('/state').catch(() => ({ pubkey: pubkeyBase58, trusted: [], contacts: [], banks: [], catalog: [], drafts: [], prefs: {}, rev: 0 }));
    if (resumePendingAction()) return;
    location.hash = '#/';
    route();
  } catch (e) {
    err.textContent = 'Could not log in — network error';
  }
};

// Remember the last handle used at this bank (handle only — never the key or
// password) so the login form can prefill it for returning users.
function rememberHandle(handle) {
  try { localStorage.setItem(`barter.handle.${state.bankName}`, handle); } catch { /* ignore */ }
}
function rememberedHandle() {
  try { return localStorage.getItem(`barter.handle.${state.bankName}`) || ''; } catch { return ''; }
}

async function renderDashboard(app) {
  let holdings = [], holdingsFailed = false;
  try { holdings = await allHoldings(); } catch { holdingsFailed = true; }
  let history = { events: [] }, historyFailed = false;
  try { history = await uiGet('/history?limit=5'); } catch { historyFailed = true; }
  const amt = (n) => n === null || n === undefined ? '—' : n;
  let body = header('Dashboard');
  body += `<div class="container">`;
  body += card('Balances', holdingsFailed ? loadError('balances') : `<div class="grid">${holdings.map(h => `
    <div>
      <div class="small">${escapeHtml(h.name)}${h.remote ? ` <span class="chip" title="${escapeHtml(h.bank_url || '')}">@ ${escapeHtml((h.bank || '').slice(0, 8))}…</span>` : ''}</div>
      <div><strong>${amt(h.current)}</strong> <span class="small">pending ${amt(h.pending)}</span></div>
      <div class="mono small">${escapeHtml(h.account.slice(0,12))}…</div>
    </div>
  `).join('') || '<p class="small">No balances yet</p>'}</div>`);
  body += card('Quick actions', `<div class="flex" style="flex-wrap:wrap;gap:0.6rem">
    <a class="btn" href="#/vouchers/new">Create voucher</a>
    <a class="btn secondary" href="#/invoices/new">New invoice</a>
    <a class="btn secondary" href="#/cheques/new">New cheque</a>
    <a class="btn secondary" href="#/discover">Discover</a>
  </div>`);
  body += card('Recent activity', historyFailed ? loadError('activity') : (history.events.map(e => `
    <div class="flex" style="justify-content:space-between;margin:0.4rem 0">
      <span class="mono small">${escapeHtml(e.deal_id.slice(0,12))}…</span>
      <span>${e.direction === 'credit' ? '↓ received' : '↑ sent'} ${escapeHtml(String(e.amount))} ${escapeHtml(e.voucher_name || e.voucher.slice(0,8))}</span>
      <span class="chip state-${escapeHtml(e.state)}">${escapeHtml(e.state)}</span>
    </div>
  `).join('') || '<p class="small">No activity</p>'));
  body += `</div>`;
  app.innerHTML = body;
}

async function renderVouchers(app) {
  let vouchers = [], failed = false;
  try { vouchers = await rpcCall('list_vouchers', { filter: 'mine' }); } catch { failed = true; }
  let body = header('Vouchers');
  body += `<div class="container">`;
  body += `<div class="flex" style="margin-bottom:1rem">
    <a class="btn" href="#/vouchers/new">Create voucher</a>
    <button class="btn secondary" onclick="showShare('i', '${jsStr(state.user.pubkey)}', 'My issuer profile')">Share my profile QR</button>
  </div>`;
  body += failed ? loadError('your vouchers') : `<div class="grid">${vouchers.map(v => `
    <div class="card">
      <div><strong>${escapeHtml(v.name)}</strong></div>
      <div class="mono small">${escapeHtml(hashDoc(v).slice(0,16))}…</div>
      <div class="small">${v.limit !== undefined ? `limit ${v.limit}` : 'unlimited'} ${v.integer ? '· integer' : ''}</div>
      <button class="btn secondary" onclick="showShare('i', '${jsStr(v.pubkey)}', 'Issuer profile — ${jsStr(v.name)}')">Share issuer QR</button>
    </div>
  `).join('') || '<p class="small">No vouchers yet. <a href="#/vouchers/new">Create one.</a></p>'}</div>`;
  body += `</div>`;
  app.innerHTML = body;
}

function renderCreateVoucher(app) {
  app.innerHTML = header('Create voucher') + `<div class="container">
    ${card('New voucher', `
      <label for="v-name">Name</label><input id="v-name" placeholder="1 hour consulting">
      <label for="v-desc">Description (markdown)</label><textarea id="v-desc" rows="3"></textarea>
      <label for="v-limit">Supply limit <span class="small">(optional — max you will ever issue)</span></label><input id="v-limit" type="number" min="0" step="any" placeholder="unlimited">
      <label><input type="checkbox" id="v-int"> Integer amounts only</label>
      <button class="btn" style="width:100%;margin-top:1rem" onclick="doCreateVoucher()">Create & sign</button>
      <p class="small error" id="v-err"></p>
    `)}
  </div>`;
}

window.doCreateVoucher = async function() {
  const name = document.getElementById('v-name').value.trim();
  const desc = document.getElementById('v-desc').value.trim();
  const limit = document.getElementById('v-limit').value;
  const integer = document.getElementById('v-int').checked;
  const err = document.getElementById('v-err');
  if (!name) { err.textContent = 'Name required'; return; }
  if (limit && (!Number.isFinite(Number(limit)) || Number(limit) <= 0)) { err.textContent = 'Supply limit must be a positive number, or left blank'; return; }
  try {
    const voucher = { type: 'voucher', pubkey: state.user.pubkey, ulid: newUlid(), bank: state.bankPubkey, name };
    if (desc) voucher.description_md = desc;
    if (limit) voucher.limit = Number(limit);
    if (integer) voucher.integer = true;
    voucher.sig = signDoc(voucher, state.user.privateKey);

    const voucherHash = hashDoc(voucher);
    const account = { type: 'account', pubkey: state.user.pubkey, ulid: newUlid(), name: `${name} (issuer)`, voucher: voucherHash };
    account.sig = signDoc(account, state.user.privateKey);

    await rpcCall('submit_docs', { docs: [voucher, account] });
    location.hash = '#/vouchers';
    route();
    toast('Voucher created');
  } catch (e) {
    err.textContent = e.message;
  }
};

async function renderInvoices(app) {
  let orders = { orders: [] }, failed = false;
  try { orders = await uiGet('/orders?kind=invoice'); } catch { failed = true; }
  // Guard against non-invoice rows: a bank that ignores ?kind= (or older data)
  // could return cheques/two-sided orders, which have no credit side.
  const invoices = (orders.orders || []).filter(o => o.credit);
  let body = header('Invoices');
  body += `<div class="container">`;
  body += `<div class="flex" style="margin-bottom:1rem"><a class="btn" href="#/invoices/new">New invoice</a></div>`;
  body += failed ? loadError('your invoices') : (invoices.map(o => `
    <div class="card">
      <div>Receive ${escapeHtml(String(o.credit.max))} of ${escapeHtml(o.credit.voucher.slice(0,12))}…</div>
      <div class="mono small">${escapeHtml(o.order.slice(0,16))}…</div>
      <div class="small">state: ${escapeHtml(String(o.state))}</div>
      <button class="btn secondary" onclick="showShare('v', '${jsStr(o.order)}', 'Invoice — scan to pay')">Share QR</button>
    </div>
  `).join('') || '<p class="small">No invoices yet.</p>');
  body += `</div>`;
  app.innerHTML = body;
}

// Vouchers the user can pick when authoring orders/invoices/cheques: their own
// issued vouchers plus those of issuers they trust (resolved at this bank). This
// replaces pasting raw voucher hashes.
async function knownVouchers() {
  const out = [];
  const seen = new Set();
  const add = (v, issuer) => {
    if (!v || typeof v.name !== 'string') return;
    const hash = hashDoc(v);
    if (seen.has(hash)) return;
    seen.add(hash);
    out.push({ hash, name: v.name, issuer });
  };
  const [mine, trusted] = await Promise.all([
    rpcCall('list_vouchers', { filter: 'mine' }).catch(() => []),
    uiGet('/trusted').catch(() => []),
  ]);
  (mine || []).forEach(v => add(v, 'you'));
  const resolved = await Promise.all((trusted || []).map(t => {
    const pk = typeof t === 'string' ? t : t.pubkey;
    return fetch(`${state.basePath}/ui/resolve/${pk}`).then(r => r.json()).catch(() => null);
  }));
  resolved.forEach(r => {
    if (!r || !Array.isArray(r.vouchers)) return;
    const who = r.handle || (r.pubkey || '').slice(0, 8) + '…';
    r.vouchers.forEach(v => add(v, who));
  });
  return out;
}
function voucherChooser(id, vouchers, selected) {
  return `<select id="${id}">${vouchers.map(v =>
    `<option value="${escapeHtml(v.hash)}"${v.hash === selected ? ' selected' : ''}>${escapeHtml(v.name)} — ${escapeHtml(v.issuer)}</option>`
  ).join('')}</select>`;
}
function noVouchersNotice() {
  return `<p class="small">No vouchers to choose from yet. <a href="#/vouchers/new">Create one</a> or <a href="#/network">trust an issuer</a> first.</p>`;
}
// A usable amount is a finite number greater than zero.
function badAmount(n) { return !Number.isFinite(n) || n <= 0; }

async function renderCreateInvoice(app) {
  const vouchers = await knownVouchers();
  app.innerHTML = header('New invoice') + `<div class="container">
    ${card('Request a payment (invoice)', vouchers.length ? `
      <p class="small">Creates a shareable request: whoever opens it pays you the amount below, in the chosen voucher.</p>
      <label for="i-voucher">Voucher to receive</label>${voucherChooser('i-voucher', vouchers)}
      <label for="i-acct">Account name <span class="small">(where the payment lands)</span></label><input id="i-acct" value="receiving">
      <label for="i-amount">Amount to receive</label><input id="i-amount" type="number" min="0" step="any" value="10">
      <button class="btn" style="width:100%;margin-top:1rem" onclick="doCreateInvoice()">Create invoice</button>
      <p class="small error" id="i-err"></p>
    ` : noVouchersNotice())}
  </div>`;
}

window.doCreateInvoice = async function() {
  const voucherHash = document.getElementById('i-voucher').value.trim();
  const acctName = document.getElementById('i-acct').value.trim();
  const amount = Number(document.getElementById('i-amount').value);
  const err = document.getElementById('i-err');
  if (badAmount(amount)) { err.textContent = 'Enter an amount greater than zero'; return; }
  try {
    const account = { type: 'account', pubkey: state.user.pubkey, ulid: newUlid(), name: acctName, voucher: voucherHash };
    account.sig = signDoc(account, state.user.privateKey);
    const accountHash = hashDoc(account);
    const order = { type: 'order', pubkey: state.user.pubkey, ulid: newUlid(), rate: 1,
      credit: { account: accountHash, voucher: voucherHash, bank: state.bankPubkey, min: amount, max: amount },
      lead: false };
    order.sig = signDoc(order, state.user.privateKey);
    const orderHash = hashDoc(order);
    const res = await rpcCall('submit_docs', { docs: [order, account], publish_offers: [orderHash] });
    location.hash = '#/invoices';
    route();
    toast('Invoice created. Offer: ' + (res.offers[0] || '').slice(0,12));
  } catch (e) {
    err.textContent = e.message;
  }
};

async function renderCheques(app) {
  let orders = { orders: [] }, failed = false;
  try { orders = await uiGet('/orders?kind=cheque'); } catch { failed = true; }
  const cheques = (orders.orders || []).filter(o => o.debit && !o.credit);
  let body = header('Cheques') + `<div class="container">`;
  body += `<div class="flex" style="margin-bottom:1rem"><a class="btn" href="#/cheques/new">New cheque</a></div>`;
  body += `<p class="small">A cheque lets someone claim a fixed amount of your voucher. Share its QR with the recipient.</p>`;
  body += failed ? loadError('your cheques') : (cheques.map(o => `
    <div class="card">
      <div>Pay out ${escapeHtml(String(o.debit.max))} of ${escapeHtml(o.debit.voucher.slice(0,12))}…</div>
      <div class="mono small">${escapeHtml(o.order.slice(0,16))}…</div>
      <div class="small">state: ${escapeHtml(String(o.state))}</div>
      <button class="btn secondary" onclick="showShare('q', '${jsStr(o.order)}', 'Cheque — scan to claim')">Share QR</button>
    </div>
  `).join('') || '<p class="small">No cheques yet.</p>');
  body += `</div>`;
  app.innerHTML = body;
}

async function renderCreateCheque(app) {
  const vouchers = await knownVouchers();
  app.innerHTML = header('New cheque') + `<div class="container">
    ${card('Write a cheque', vouchers.length ? `
      <p class="small">Creates a shareable link: whoever opens it claims the amount below from you, in the chosen voucher.</p>
      <label for="q-voucher">Voucher to pay out</label>${voucherChooser('q-voucher', vouchers)}
      <label for="q-acct">Account name <span class="small">(paid from)</span></label><input id="q-acct" value="spending">
      <label for="q-amount">Amount to pay</label><input id="q-amount" type="number" min="0" step="any" value="10">
      <button class="btn" style="width:100%;margin-top:1rem" onclick="doCreateCheque()">Create cheque</button>
      <p class="small error" id="q-err"></p>
    ` : noVouchersNotice())}
  </div>`;
}

window.doCreateCheque = async function() {
  const voucherHash = document.getElementById('q-voucher').value.trim();
  const acctName = document.getElementById('q-acct').value.trim();
  const amount = Number(document.getElementById('q-amount').value);
  const err = document.getElementById('q-err');
  if (badAmount(amount)) { err.textContent = 'Enter an amount greater than zero'; return; }
  try {
    const account = { type: 'account', pubkey: state.user.pubkey, ulid: newUlid(), name: acctName, voucher: voucherHash };
    account.sig = signDoc(account, state.user.privateKey);
    const accountHash = hashDoc(account);
    const order = { type: 'order', pubkey: state.user.pubkey, ulid: newUlid(), rate: 1,
      debit: { account: accountHash, voucher: voucherHash, bank: state.bankPubkey, min: amount, max: amount },
      lead: true };
    order.sig = signDoc(order, state.user.privateKey);
    const orderHash = hashDoc(order);
    await rpcCall('submit_docs', { docs: [order, account], publish_offers: [orderHash] });
    location.hash = '#/cheques';
    route();
    toast('Cheque created — share its QR to let someone claim it');
    // Pop the shareable QR straight away — the point of a cheque is to send it.
    showShare('q', orderHash, 'Cheque — scan to claim');
  } catch (e) {
    err.textContent = e.message;
  }
};

async function renderOrders(app) {
  let orders = { orders: [] }, failed = false;
  try { orders = await uiGet('/orders'); } catch { failed = true; }
  app.innerHTML = header('Orders') + `<div class="container">
    <div class="flex" style="margin-bottom:1rem"><a class="btn" href="#/orders/new">New order</a></div>
    ${failed ? loadError('your orders') : (orders.orders.map(o => `
      <div class="card">
        <div>${o.kind === 'two-sided' ? 'Swap' : escapeHtml(String(o.kind))}${o.lead ? ' · settles first' : ''}</div>
        <div class="mono small">${escapeHtml(o.order.slice(0,16))}…</div>
        <div class="small">${o.debit ? `give up to ${escapeHtml(String(o.debit.max))}` : ''} ${o.credit ? `· receive up to ${escapeHtml(String(o.credit.max))}` : ''}</div>
        ${o.kind === 'invoice' ? `<button class="btn secondary" onclick="showShare('v', '${jsStr(o.order)}', 'Invoice — scan to pay')">Share QR</button>` : ''}
        ${o.kind === 'cheque' ? `<button class="btn secondary" onclick="showShare('q', '${jsStr(o.order)}', 'Cheque — scan to claim')">Share QR</button>` : ''}
      </div>
    `).join('') || '<p class="small">No orders yet.</p>')}
  </div>`;
}

async function renderCreateOrder(app) {
  const vouchers = await knownVouchers();
  app.innerHTML = header('New order') + `<div class="container">
    ${card('Offer a swap', vouchers.length ? `
      <p class="small">Offer to trade one voucher for another. The exchange rate is set by the two amounts you enter.</p>
      <label for="o-dv">You give (voucher)</label>${voucherChooser('o-dv', vouchers)}
      <label for="o-dmax">Amount you give (up to)</label><input id="o-dmax" type="number" min="0" step="any" value="100">
      <label for="o-cv">You receive (voucher)</label>${voucherChooser('o-cv', vouchers)}
      <label for="o-cmax">Amount you receive (up to)</label><input id="o-cmax" type="number" min="0" step="any" value="90">
      <label><input type="checkbox" id="o-lead"> Settle my side first <span class="small">(the counterparty may not reciprocate)</span></label>
      <label><input type="checkbox" id="o-pub" checked> List publicly so others can discover this</label>
      <button class="btn" style="width:100%;margin-top:1rem" onclick="doCreateOrder()">Create order</button>
      <p class="small error" id="o-err"></p>
    ` : noVouchersNotice())}
  </div>`;
}

window.doCreateOrder = async function() {
  const dv = document.getElementById('o-dv').value.trim();
  const dmax = Number(document.getElementById('o-dmax').value);
  const cv = document.getElementById('o-cv').value.trim();
  const cmax = Number(document.getElementById('o-cmax').value);
  const lead = document.getElementById('o-lead').checked;
  const pub = document.getElementById('o-pub').checked;
  const err = document.getElementById('o-err');
  if (dv === cv) { err.textContent = 'Pick two different vouchers — you cannot swap a voucher for itself'; return; }
  if (badAmount(dmax) || badAmount(cmax)) { err.textContent = 'Both amounts must be greater than zero'; return; }
  // Rate is derived from the two amounts, not hand-typed — they can never disagree.
  const rate = dmax / cmax;
  try {
    const dAccount = { type: 'account', pubkey: state.user.pubkey, ulid: newUlid(), name: 'giving', voucher: dv };
    dAccount.sig = signDoc(dAccount, state.user.privateKey);
    const cAccount = { type: 'account', pubkey: state.user.pubkey, ulid: newUlid(), name: 'receiving', voucher: cv };
    cAccount.sig = signDoc(cAccount, state.user.privateKey);
    const dHash = hashDoc(dAccount), cHash = hashDoc(cAccount);
    const order = { type: 'order', pubkey: state.user.pubkey, ulid: newUlid(), rate,
      debit: { account: dHash, voucher: dv, bank: state.bankPubkey, min: 0, max: dmax },
      credit: { account: cHash, voucher: cv, bank: state.bankPubkey, min: 0, max: cmax },
      lead };
    order.sig = signDoc(order, state.user.privateKey);
    const oHash = hashDoc(order);
    const docs = [order, dAccount, cAccount];
    await rpcCall('submit_docs', { docs, publish_offers: pub ? [oHash] : [] });
    location.hash = '#/orders';
    route();
    toast(pub ? 'Order created and listed publicly' : 'Order created');
  } catch (e) {
    err.textContent = e.message;
  }
};

async function renderDiscover(app) {
  const known = await knownVouchers().catch(() => []);
  const nameByHash = {};
  known.forEach(v => { nameByHash[v.hash] = v.name; });
  let body = header('Discover') + `<div class="container">`;
  if (!known.length) {
    body += card('Discover trades', `<p class="small">To discover trades you first need a voucher you issue, or an issuer you trust. <a href="#/vouchers/new">Create a voucher</a> or <a href="#/network">trust an issuer</a>, then come back.</p>`);
    app.innerHTML = body + `</div>`;
    return;
  }
  // Poll our own bank AND every pinned bank for offers on the vouchers we know.
  // (The bank defaults `vouchers` to an empty catalog and `banks` to pinned-only,
  // so both must be sent explicitly or nothing is ever discovered.)
  const pinned = await uiGet('/banks').catch(() => []);
  const banks = [{ pubkey: state.bankPubkey, url: state.bankUrl }];
  (pinned || []).forEach(b => { if (b.pubkey && b.pubkey !== state.bankPubkey) banks.push({ pubkey: b.pubkey, url: b.url }); });
  const vouchers = known.map(v => v.hash);
  let res;
  try { res = await uiPost('/discover', { banks, vouchers, intentions: ['sell', 'buy'] }); }
  catch (e) { res = { offers: [], error: e.message, unreachable: [] }; }
  // The same order can surface from several (bank × voucher × intention) polls.
  const seen = new Set();
  const uniq = (res.offers || []).filter(o => { const k = o.order || o.offer; if (!k || seen.has(k)) return false; seen.add(k); return true; });
  // Attacker-influenced strings (from a polled bank) never enter inline JS — the
  // click handler reads the full offer object back from this stash by index.
  window.__discoverOffers = uniq;
  const name = (h) => h ? (nameByHash[h] || (h.slice(0, 8) + '…')) : '';
  body += card('Offers', uniq.map((o, i) => {
    const give = o.debit ? `give ${escapeHtml(String(o.debit.max))} ${escapeHtml(name(o.debit.voucher))}` : '';
    const get = o.credit ? `get ${escapeHtml(String(o.credit.max))} ${escapeHtml(name(o.credit.voucher))}` : '';
    const summary = [give, get].filter(Boolean).join(' · ') || 'offer';
    const twoSided = o.debit && o.credit;
    return `<div class="card">
      <div><strong>${summary}</strong></div>
      <div class="small">at bank ${escapeHtml((o.bank || '').slice(0, 12))}…</div>
      ${twoSided
        ? `<button class="btn" data-idx="${i}" onclick="acceptOfferByIdx(this)">Accept swap</button>`
        : `<p class="small">One-sided offer — open its link to pay or claim.</p>`}
    </div>`;
  }).join('') || '<p class="small">No offers found at your bank or pinned banks yet. Publish an order, or pin more banks under Network.</p>');
  const unreachable = res.unreachable || [];
  if (unreachable.length) {
    body += card('Couldn\'t reach', unreachable.map(u => `<div class="small">bank ${escapeHtml((u.bank || '').slice(0, 12))}…</div>`).join(''));
  }
  if (res.error) body += `<p class="error small">${escapeHtml(res.error)}</p>`;
  app.innerHTML = body + `</div>`;
}

// Accept a discovered two-sided swap: build the mirror order (I give what they
// want, receive what they give), submit it, then propose the deal pairing it
// with theirs. The offer object is read from the stash so nothing attacker-
// controlled is interpolated into markup.
window.acceptOfferByIdx = async function(btn) {
  const o = (window.__discoverOffers || [])[Number(btn.dataset.idx)];
  if (!o) { toast('Offer no longer available — refresh Discover', 'error'); return; }
  if (!o.debit || !o.credit) { toast('One-sided offer — open its link to pay or claim', 'error'); return; }
  if (btn.disabled) return;
  // Cross-bank swaps need the mirror order submitted to two banks; not yet
  // supported here. Single-bank (both vouchers at one bank) is the common case.
  if (o.debit.bank !== o.credit.bank) {
    toast('This swap spans two banks — not supported from Discover yet', 'error');
    return;
  }
  const theyGive = o.debit;   // voucher A they give (I receive)
  const theyWant = o.credit;  // voucher B they want (I give)
  const known = await knownVouchers().catch(() => []);
  const nm = {}; known.forEach(v => { nm[v.hash] = v.name; });
  const nameOf = (h) => nm[h] || (h.slice(0, 8) + '…');
  if (!window.confirm(`Accept this swap?\n\nYou give ${theyWant.max} ${nameOf(theyWant.voucher)}\nYou receive ${theyGive.max} ${nameOf(theyGive.voucher)}`)) return;
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = 'Working…';
  try {
    const vbank = await resolveVoucherBank(theyGive, { bank: o.bank, bank_url: o.bank_url });
    if (vbank.pubkey !== state.bankPubkey) {
      await uiPost('/banks', { pubkey: vbank.pubkey, url: vbank.url }).catch(() => {});
    }
    // I must hold voucher B (what they want) to give it. Reuse a funded account.
    const mine = await rpcCallAt(vbank.url, vbank.pubkey, 'list_accounts', {}).catch(() => ({ accounts: [] }));
    const docs = [];
    let giveAccount = null;
    for (const a of (mine.accounts || []).filter(a => a.voucher === theyWant.voucher).map(a => hashDoc(a))) {
      const bal = await rpcCallAt(vbank.url, vbank.pubkey, 'get_account_balance', { account_hash: a }).catch(() => null);
      if (bal && (bal.current - bal.pending) >= theyWant.max) { giveAccount = a; break; }
    }
    if (!giveAccount) throw new Error(`you need ${theyWant.max} ${nameOf(theyWant.voucher)} at this bank to accept`);
    // Receiving account for voucher A — reuse or create fresh.
    let recvAccount = (mine.accounts || []).filter(a => a.voucher === theyGive.voucher).map(a => hashDoc(a))[0] || null;
    if (!recvAccount) {
      const acct = { type: 'account', pubkey: state.user.pubkey, ulid: newUlid(), name: 'receiving', voucher: theyGive.voucher };
      acct.sig = signDoc(acct, state.user.privateKey);
      recvAccount = hashDoc(acct);
      docs.push(acct);
    }
    const myOrder = {
      type: 'order', pubkey: state.user.pubkey, ulid: newUlid(), rate: theyWant.max / theyGive.max,
      debit: { account: giveAccount, voucher: theyWant.voucher, bank: theyWant.bank, min: 0, max: theyWant.max },
      credit: { account: recvAccount, voucher: theyGive.voucher, bank: theyGive.bank, min: 0, max: theyGive.max },
      lead: false,
    };
    myOrder.sig = signDoc(myOrder, state.user.privateKey);
    const myHash = hashDoc(myOrder);
    docs.push(myOrder);
    await rpcCallAt(vbank.url, vbank.pubkey, 'submit_docs', { docs });
    const res = await signedRequestAt(vbank.url, 'POST', '/propose_deal', {
      offer1: { hash: o.order, debit_amount: theyGive.max, credit_amount: theyWant.max },
      offer2: { hash: myHash, debit_amount: theyWant.max, credit_amount: theyGive.max },
      banks: [{ pubkey: vbank.pubkey, url: vbank.url }],
    });
    rememberDealBank(res.deal_id, vbank);
    location.hash = `#/deal/${res.deal_id}`;
    route();
  } catch (e) {
    btn.disabled = false; btn.textContent = label;
    toast(e.message, 'error');
  }
};

async function renderDeal(app, dealId) {
  // A deal proposed at another bank (e.g. a claimed cheque at the voucher's
  // issuing bank) is polled there, not at the SPA's own bank.
  const remote = dealBankFor(dealId);
  let status = null, errored = false;
  try {
    status = await (remote && remote.pubkey !== state.bankPubkey
      ? signedRequestAt(remote.url, 'GET', `/deal/${dealId}`, null)
      : uiGet(`/deal/${dealId}`));
  } catch { errored = true; }
  let body = header('Deal') + `<div class="container">`;
  if (errored || !status) {
    // A blank/failed read right after propose is almost always transient
    // (replication lag, a network blip, clock skew). Keep polling instead of
    // dead-ending on "Not found", and never blank the screen permanently.
    body += card(`Deal ${escapeHtml(dealId.slice(0, 12))}…`, `
      <p class="small">Connecting to the bank… this can take a moment right after a deal is proposed. This page keeps retrying.</p>
      <button class="btn secondary" onclick="route()">Retry now</button>`);
    app.innerHTML = body + `</div>`;
    setTimeout(() => { if (location.hash === `#/deal/${dealId}`) route(); }, 3000);
    return;
  }
  {
    const done = status.state === 'settled' || status.state === 'rejected';
    const tick = (b) => b ? '✓' : '·';
    // Every leg below is minted by the SAME bank (the one we polled), so the
    // bank is named once, not repeated per leg. Each leg says what it MOVES.
    const legHtml = status.legs.map(l => {
      const who = l.mine ? 'You' : 'Counterparty';
      const verb = l.direction === 'credit'
        ? (l.mine ? 'receive' : 'receives')
        : (l.mine ? 'give' : 'gives');
      const what = l.voucher_name || (l.voucher ? l.voucher.slice(0, 10) + '…' : '');
      const headline = l.direction
        ? `${who} ${verb} <strong>${l.amount}</strong> ${escapeHtml(what)}`
        : escapeHtml((l.records && l.records[0] || '').slice(0, 16) + '…');
      return `<div class="card">
        <div>${headline}</div>
        <div class="small">ready ${tick(l.ready)} → hold ${tick(l.hold)} → settle ${tick(l.settle)}</div>
      </div>`;
    }).join('');
    const bankPk = status.legs[0] && status.legs[0].bank ? status.legs[0].bank : '';
    body += card(`Deal ${escapeHtml(dealId.slice(0,12))}…`, `
      <p>state: <span class="chip state-${escapeHtml(status.state)}">${escapeHtml(status.state)}</span></p>
      ${status.state === 'settled' ? '<p class="small success">✓ Settled — every leg signed ready → hold → settle. Balances are updated.</p>' : ''}
      ${status.state === 'rejected' ? '<p class="small error">This deal was rejected; no balances moved.</p>' : ''}
      ${legHtml}
      ${bankPk ? `<p class="small">Legs settled at bank <span class="mono">${escapeHtml(bankPk.slice(0,16))}…</span></p>` : ''}
      ${done
        ? `<a class="btn" href="#/">Back to balances</a>`
        : `<p class="small">Waiting for the banks to sign… this page refreshes itself.</p>
           <button class="btn secondary" onclick="route()">Refresh now</button>`}
    `);
  }
  body += `</div>`;
  app.innerHTML = body;
  if (status && status.state !== 'settled' && status.state !== 'rejected') {
    setTimeout(() => { if (location.hash === `#/deal/${dealId}`) route(); }, 3000);
  }
}

async function renderSettings(app) {
  app.innerHTML = header('Settings') + `<div class="container">
    ${card('Identity', `
      <p>Handle: ${escapeHtml(state.user.handle || '')}</p>
      <p class="mono small">${escapeHtml(state.user.pubkey)}</p>
      <button class="btn secondary" onclick="showShare('i', '${jsStr(state.user.pubkey)}', 'My issuer profile')">My profile QR</button>
    `)}
    ${card('Bank', `
      <p>${escapeHtml(state.bankName)}</p>
      <p class="mono small">${escapeHtml(state.bankPubkey)}</p>
      <p class="small">${escapeHtml(state.bankUrl)}</p>
    `)}
    ${card('Recovery kit', `
      <p class="small">Download your encrypted keystore. Together with your password it restores this account anywhere; without the password it is useless — and there is no password recovery.</p>
      <button class="btn secondary" onclick="downloadBackup()">Download encrypted backup</button>
    `)}
    ${card('Actions', `
      <button class="btn danger" onclick="lock()">Lock</button>
    `)}
  </div>`;
}

window.downloadBackup = async function() {
  try {
    const res = await fetch(`${state.basePath}/ui/keystore/${state.user.handle}`);
    const data = await res.json();
    if (data.code) throw new Error(data.message || 'no server keystore for this handle');
    const kit = {
      barter_recovery_kit: 1,
      handle: state.user.handle,
      pubkey: state.user.pubkey,
      bank: { name: state.bankName, pubkey: state.bankPubkey, url: state.bankUrl },
      keystore: data.keystore,
      exported_at: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(kit, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `barter-recovery-${state.user.handle}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  } catch (e) {
    toast(e.message, 'error');
  }
};

// ---------------- share modal (QR) ----------------

// Build the public Barter Link for a kind/value at this bank and show it as a
// QR + copyable link. REFERENCE mode links per the spec's QR byte budget.
window.showShare = function(kind, value, title) {
  const link = `${state.bankUrl}/${kind}/${value}`;
  let dataUrl = '';
  try { dataUrl = qrDataUrl(link); } catch (e) { toast(e.message, 'error'); return; }
  const opener = document.activeElement; // return focus here on close
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true" aria-labelledby="share-title">
      <h3 id="share-title">${escapeHtml(title || 'Share')}</h3>
      <img class="qr" src="${dataUrl}" alt="QR code for ${escapeHtml(title || 'this link')}">
      <div class="mono small" style="word-break:break-all;margin:0.5rem 0">${escapeHtml(link)}</div>
      <div class="flex">
        <button class="btn" id="share-copy">Copy link</button>
        <button class="btn secondary" id="share-close">Close</button>
      </div>
    </div>`;
  const close = () => {
    overlay.remove();
    document.removeEventListener('keydown', onKey, true);
    if (opener && typeof opener.focus === 'function') opener.focus();
  };
  // Escape closes; Tab is trapped inside the dialog.
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); return; }
    if (e.key !== 'Tab') return;
    const focusable = overlay.querySelectorAll('button, [href], input, [tabindex]:not([tabindex="-1"])');
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  overlay.querySelector('#share-close').onclick = close;
  overlay.querySelector('#share-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(link); toast('Link copied'); }
    catch { toast('Copy failed — select the text manually', 'error'); }
  };
  document.body.appendChild(overlay);
  document.addEventListener('keydown', onKey, true);
  overlay.querySelector('#share-copy').focus();
};

// ---------------- scanning + Barter Link handling ----------------

let activeScannerStop = null;
function stopActiveScanner() {
  if (activeScannerStop) { try { activeScannerStop(); } catch {} activeScannerStop = null; }
}

async function renderScan(app) {
  app.innerHTML = header('Scan') + `<div class="container" style="max-width:480px">
    ${card('Scan a Barter QR', `
      <video id="scan-video" style="width:100%;border-radius:0.5rem;background:#000"></video>
      <p class="small" id="scan-status">Requesting camera…</p>
      <label for="scan-manual">…or paste a Barter Link</label>
      <input id="scan-manual" placeholder="https://…/alice/i/PUBKEY">
      <button class="btn" style="width:100%;margin-top:0.5rem" onclick="handleScanned(document.getElementById('scan-manual').value.trim())">Open link</button>
    `)}
  </div>`;
  const video = document.getElementById('scan-video');
  const status = document.getElementById('scan-status');
  try {
    activeScannerStop = await startScanner(video, (text) => {
      activeScannerStop = null;
      window.handleScanned(text);
    });
    status.textContent = 'Point the camera at a barter QR code.';
  } catch (e) {
    status.textContent = `Camera unavailable (${e.message}). Paste a link below instead.`;
  }
}

// Parse a scanned/pasted Barter Link and dispatch to the landing handler.
window.handleScanned = function(text) {
  if (!text) return;
  try {
    const u = new URL(text);
    const m = u.pathname.match(/\/(i|v|q|o|x)\/([^/]+?)(?:\.json)?$/);
    if (!m) { toast('Not a Barter Link', 'error'); return; }
    // Same bank origin → in-app landing; foreign bank → carry the origin+path.
    sessionStorage.setItem('barter_scan_origin', `${u.origin}${u.pathname.replace(/\/(i|v|q|o|x)\/.*$/, '')}`);
    location.hash = `#/land/${m[1]}/${m[2]}`;
    route();
  } catch {
    toast('Not a valid URL', 'error');
  }
};

// Fetch the machine payload for a landing target. Prefers the scanned bank
// base (may be a foreign bank), falls back to this SPA's own bank.
async function fetchBarterEnvelope(kind, value) {
  const scanBase = sessionStorage.getItem('barter_scan_origin');
  const bases = [];
  if (scanBase) bases.push(scanBase);
  bases.push(state.bankUrl || state.basePath);
  for (const base of bases) {
    try {
      const res = await fetch(`${base}/${kind}/${value}?format=json`);
      if (!res.ok) continue;
      const env = await res.json();
      if (env && Array.isArray(env.docs)) return { env, base };
    } catch { /* try next base */ }
  }
  throw new Error('could not fetch the signed documents');
}

// Verify every doc in the envelope client-side before trusting anything.
function verifyEnvelope(env) {
  for (const doc of env.docs) {
    if (!doc.sig || !verifyDoc(doc, doc.sig, doc.pubkey)) {
      throw new Error(`signature check failed on a ${doc.type} document`);
    }
  }
  return true;
}

// ---------------- landing journeys ----------------

async function renderLanding(app, kind, value) {
  let env, base;
  try {
    ({ env, base } = await fetchBarterEnvelope(kind, value));
    verifyEnvelope(env);
  } catch (e) {
    app.innerHTML = `<div class="container" style="max-width:420px;padding-top:8vh">
      ${card('Barter Link', `<p class="error">${escapeHtml(e.message)}</p><p><a href="#/">Home</a></p>`)}</div>`;
    return;
  }

  const verified = `<p class="small success">✓ Signatures verified in this browser</p>`;

  if (env.kind === 'profile') {
    const handle = env.handle || (env.pubkey || value).slice(0, 12) + '…';
    const vouchers = env.docs.filter(d => d.type === 'voucher');
    const body = `
      <h2>${escapeHtml(handle)}</h2>
      <p class="mono small">${escapeHtml(env.pubkey || value)}</p>
      ${verified}
      ${vouchers.map(v => `<div class="card"><strong>${escapeHtml(v.name)}</strong>${v.description_md ? `<p class="small">${escapeHtml(v.description_md)}</p>` : ''}</div>`).join('') || '<p class="small">No vouchers published yet.</p>'}
    `;
    if (!state.user) {
      // Remember only to RETURN to this profile after auth — never arm a silent
      // auto-trust just because the profile was viewed. The explicit Trust
      // button below (logged-in branch) is the only thing that adds trust.
      sessionStorage.setItem('barter_pending', JSON.stringify({ action: 'view', kind: 'i', value }));
      app.innerHTML = `<div class="container" style="max-width:420px;padding-top:4vh">${card('Issuer profile', body + `
        <p class="small">After you sign in you can choose to trust <b>${escapeHtml(handle)}</b>.</p>
        <a class="btn" style="display:block;text-align:center" href="#/register">Register to continue</a>
        <a class="btn secondary" style="display:block;text-align:center;margin-top:0.5rem" href="#/unlock">Log in to continue</a>
      `)}</div>`;
    } else {
      app.innerHTML = header('Profile') + `<div class="container" style="max-width:480px">${card('Issuer profile', body + `
        <label for="trust-note">Note <span class="small">(optional)</span></label>
        <textarea id="trust-note" rows="2" placeholder="e.g. met at the train station, seemed OK"></textarea>
        <button class="btn" style="width:100%" data-pk="${escapeHtml(env.pubkey || value)}" data-handle="${escapeHtml(env.handle || '')}" data-bank="${escapeHtml(env.bank || '')}" data-bankurl="${escapeHtml(env.bank_url || '')}" onclick="applyTrust(this)">Trust ${escapeHtml(handle)}</button>
      `)}</div>`;
    }
    return;
  }

  if (env.kind === 'invoice' || env.kind === 'cheque') {
    const order = env.docs.find(d => d.type === 'order');
    const side = env.kind === 'invoice' ? order.credit : order.debit;
    // The bank now bundles the referenced Voucher doc (verified above), so the
    // recipient sees WHAT they pay/claim by name — not a bare hash.
    const voucherDoc = env.docs.find(d => d.type === 'voucher' && hashDoc(d) === side.voucher);
    const voucherName = voucherDoc ? voucherDoc.name : null;
    const who = env.handle || order.pubkey.slice(0, 12) + '…';
    const amount = side.min === side.max ? String(side.max) : `${side.min}–${side.max}`;
    const verb = env.kind === 'invoice' ? 'Pay' : 'Claim';
    const body = `
      <h2>${env.kind === 'invoice' ? `Pay ${escapeHtml(who)}` : `Cheque from ${escapeHtml(who)}`}</h2>
      ${verified}
      <div class="card">
        <div>Amount: <strong>${escapeHtml(amount)}${voucherName ? ` ${escapeHtml(voucherName)}` : ''}</strong></div>
        ${voucherName && voucherDoc.description_md ? `<div class="small">${escapeHtml(voucherDoc.description_md)}</div>` : ''}
        <div class="mono small">voucher ${voucherName ? `${escapeHtml(voucherName)} · ` : ''}${escapeHtml(side.voucher.slice(0, 16))}…</div>
      </div>`;
    sessionStorage.setItem('barter_pending', JSON.stringify({ action: env.kind, orderHash: hashDoc(order), kind, value, base }));
    if (!state.user) {
      app.innerHTML = `<div class="container" style="max-width:420px;padding-top:4vh">${card(env.kind, body + `
        <a class="btn" style="display:block;text-align:center" href="#/register">Register &amp; ${verb.toLowerCase()}</a>
        <a class="btn secondary" style="display:block;text-align:center;margin-top:0.5rem" href="#/unlock">Log in &amp; ${verb.toLowerCase()}</a>
      `)}</div>`;
    } else {
      app.innerHTML = header(verb) + `<div class="container" style="max-width:480px">${card(env.kind, body + `
        <label>Amount</label><input id="act-amount" type="number" value="${escapeHtml(String(side.max))}" min="${escapeHtml(String(side.min))}" max="${escapeHtml(String(side.max))}">
        <button class="btn" id="act-btn" style="width:100%;margin-top:0.5rem" onclick="actOnOrder('${env.kind}')">${verb} now</button>
        <p class="small" id="act-status"></p>
        <p class="small error" id="act-err"></p>
      `)}</div>`;
    }
    return;
  }

  app.innerHTML = `<div class="container" style="max-width:420px;padding-top:8vh">
    ${card('Barter Link', `<p>Kind: ${escapeHtml(env.kind)}</p>${verified}<p><a href="#/">Home</a></p>`)}</div>`;
}

// Add an issuer to the trusted list (+ their bank to known banks). The pubkey,
// handle and bank ride on the button's data-* attributes so nothing scanned is
// interpolated into inline JS.
window.applyTrust = async function(btn) {
  const pubkey = btn.dataset.pk;
  const handle = btn.dataset.handle || '';
  const bank = btn.dataset.bank || '';
  const bankUrl = btn.dataset.bankurl || '';
  try {
    const noteEl = document.getElementById('trust-note');
    const note = noteEl ? noteEl.value.trim() : '';
    await uiPost('/trusted', { pubkey, note });
    if (bank && bankUrl && bank !== state.bankPubkey) {
      await uiPost('/banks', { pubkey: bank, url: bankUrl }).catch(() => {});
    }
    sessionStorage.removeItem('barter_pending');
    toast(`You now trust ${handle || pubkey.slice(0, 12)}`);
    location.hash = '#/network';
    route();
  } catch (e) {
    toast(e.message, 'error');
  }
};

// Execute a scanned invoice (pay it) or cheque (claim it): build the matching
// one-sided Order, submit it, and propose the deal at this bank.
window.actOnOrder = async function(kind) {
  const err = document.getElementById('act-err');
  const btn = document.getElementById('act-btn');
  const statusEl = document.getElementById('act-status');
  const original = btn ? btn.textContent : '';
  const step = (t) => { if (statusEl) statusEl.textContent = t; };
  if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
  if (err) err.textContent = '';
  try {
    step('Verifying the signed documents…');
    const pending = JSON.parse(sessionStorage.getItem('barter_pending') || '{}');
    const { env } = await fetchBarterEnvelope(pending.kind, pending.value);
    verifyEnvelope(env);
    const theirOrder = env.docs.find(d => d.type === 'order');
    const theirHash = hashDoc(theirOrder);
    const side = kind === 'invoice' ? theirOrder.credit : theirOrder.debit;
    const amount = Number(document.getElementById('act-amount').value) || side.max;

    // Everything about this action lives at the VOUCHER'S issuing bank (the
    // `bank` the signed Order pins for this side): the voucher doc, the
    // counterparty's Order, my account, the records. That bank may not be the
    // bank this SPA is logged into — resolve it and address it directly.
    step('Locating the voucher’s bank…');
    const vbank = await resolveVoucherBank(side, env);
    // Pin a foreign bank so its balances show up on the dashboard afterwards.
    if (vbank.pubkey !== state.bankPubkey) {
      await uiPost('/banks', { pubkey: vbank.pubkey, url: vbank.url }).catch(() => {});
    }
    step('Preparing your account…');

    // My side mirrors theirs: pay an invoice with a debit-only (cheque) Order;
    // claim a cheque with a credit-only (receiving) Order.
    // Reuse an existing account on this voucher AT THAT BANK when possible —
    // paying MUST debit a funded account, and scattering balance across
    // per-deal accounts would strand it.
    let accountHash = null;
    const docs = [];
    try {
      const mine = await rpcCallAt(vbank.url, vbank.pubkey, 'list_accounts', {});
      const candidates = (mine.accounts || []).filter(a => a.voucher === side.voucher).map(a => hashDoc(a));
      if (kind === 'invoice') {
        for (const h of candidates) {
          const bal = await rpcCallAt(vbank.url, vbank.pubkey, 'get_account_balance', { account_hash: h }).catch(() => null);
          if (bal && (bal.current - bal.pending) >= amount) { accountHash = h; break; }
        }
        if (!accountHash) throw new Error(`insufficient balance: you need ${amount} of this voucher at its bank to pay`);
      } else if (candidates.length > 0) {
        accountHash = candidates[0];
      }
    } catch (e) {
      if (String(e.message).includes('insufficient balance')) throw e;
      /* account listing unavailable — fall through to a fresh account */
    }
    if (!accountHash) {
      const account = { type: 'account', pubkey: state.user.pubkey, ulid: newUlid(), name: kind === 'invoice' ? 'paying' : 'receiving', voucher: side.voucher };
      account.sig = signDoc(account, state.user.privateKey);
      accountHash = hashDoc(account);
      docs.push(account);
    }
    const mySide = { account: accountHash, voucher: side.voucher, bank: side.bank, min: amount, max: amount };
    const order = kind === 'invoice'
      ? { type: 'order', pubkey: state.user.pubkey, ulid: newUlid(), rate: 1, debit: mySide, lead: true }
      : { type: 'order', pubkey: state.user.pubkey, ulid: newUlid(), rate: 1, credit: mySide, lead: false };
    order.sig = signDoc(order, state.user.privateKey);
    const myHash = hashDoc(order);
    docs.push(order);
    step('Submitting your signed order…');
    await rpcCallAt(vbank.url, vbank.pubkey, 'submit_docs', { docs });

    // giver = the debit-only order, receiver = the credit-only order. The deal
    // is proposed AT the voucher's bank, which holds both orders.
    const giver = kind === 'invoice' ? myHash : theirHash;
    const receiver = kind === 'invoice' ? theirHash : myHash;
    step('Proposing the deal — banks will settle it…');
    const res = await signedRequestAt(vbank.url, 'POST', '/propose_deal', {
      offer1: { hash: giver, debit_amount: amount, credit_amount: amount },
      offer2: { hash: receiver, debit_amount: amount, credit_amount: amount },
      banks: [{ pubkey: vbank.pubkey, url: vbank.url }],
    });
    sessionStorage.removeItem('barter_pending');
    rememberDealBank(res.deal_id, vbank);
    step('');
    location.hash = `#/deal/${res.deal_id}`;
    route();
  } catch (e) {
    step('');
    if (btn) { btn.disabled = false; btn.textContent = original; }
    if (err) err.textContent = e.message; else toast(e.message, 'error');
  }
};

// After register/unlock, resume whatever the landing page wanted to do.
function resumePendingAction() {
  const raw = sessionStorage.getItem('barter_pending');
  if (!raw) return false;
  try {
    const pending = JSON.parse(raw);
    // 'view' (a profile) and invoice/cheque all resume by RETURNING to the
    // landing — where the explicit Trust / Pay / Claim button is shown. Nothing
    // executes automatically just because the user signed in.
    if (pending.action === 'view' || pending.action === 'invoice' || pending.action === 'cheque') {
      sessionStorage.removeItem('barter_pending');
      location.hash = `#/land/${pending.kind}/${pending.value}`;
      route();
      return true;
    }
  } catch { sessionStorage.removeItem('barter_pending'); }
  return false;
}

// ---------------- activity ----------------

async function renderActivity(app) {
  let history = { events: [] }, failed = false;
  try { history = await uiGet('/history?limit=100'); } catch { failed = true; }
  app.innerHTML = header('Activity') + `<div class="container">
    ${card('Transaction history', failed ? loadError('your activity') : (history.events.map(e => `
      <div class="flex" style="justify-content:space-between;margin:0.4rem 0;align-items:center">
        <a class="mono small" href="#/deal/${escapeHtml(e.deal_id)}">${escapeHtml(e.deal_id.slice(0, 12))}…</a>
        <span>${e.direction === 'credit' ? '↓ received' : '↑ sent'} ${escapeHtml(String(e.amount))} ${escapeHtml(e.voucher_name || e.voucher.slice(0, 8))}</span>
        <span class="chip state-${escapeHtml(e.state)}">${escapeHtml(e.state)}</span>
      </div>
    `).join('') || '<p class="small">No activity yet</p>'))}
  </div>`;
}

// ---------------- network (banks + trusted issuers + contacts) --------------

async function renderNetwork(app) {
  const [banks, trusted, contacts] = await Promise.all([
    uiGet('/banks').catch(() => []),
    uiGet('/trusted').catch(() => []),
    uiGet('/contacts').catch(() => []),
  ]);
  // Resolve handles for trusted issuers (public endpoint, no auth needed).
  // Entries are {pubkey, note} (legacy bare strings still tolerated).
  const resolved = await Promise.all(trusted.map(t => {
    const pk = typeof t === 'string' ? t : t.pubkey;
    const note = typeof t === 'string' ? '' : (t.note || '');
    return fetch(`${state.basePath}/ui/resolve/${pk}`).then(r => r.json())
      .then(r => ({ ...r, pubkey: pk, note }))
      .catch(() => ({ pubkey: pk, note }));
  }));

  app.innerHTML = header('Network') + `<div class="container">
    ${card('Trusted issuers', resolved.map(r => `
      <div style="margin:0.5rem 0;padding-bottom:0.5rem;border-bottom:1px solid var(--border)">
        <div class="flex" style="justify-content:space-between;align-items:center">
          <span>${escapeHtml(r.handle || '')} <span class="mono small">${escapeHtml(r.pubkey.slice(0, 16))}…</span>
            <span class="small">${(r.vouchers || []).length} voucher(s)</span></span>
          <span>
            <button class="btn secondary" data-pk="${escapeHtml(r.pubkey)}" data-note="${escapeHtml(r.note || '')}" onclick="editTrustNote(this)">Note</button>
            <button class="btn secondary" onclick="showShare('i', '${jsStr(r.pubkey)}', 'Issuer profile')">QR</button>
            <button class="btn danger" onclick="untrust('${jsStr(r.pubkey)}')">Remove</button>
          </span>
        </div>
        ${r.note ? `<p class="small" style="margin:0.3rem 0 0;font-style:italic">&ldquo;${escapeHtml(r.note)}&rdquo;</p>` : ''}
      </div>
    `).join('') || '<p class="small">Nobody trusted yet. Scan a friend&#39;s profile QR to start.</p>')}
    ${card('Add trusted issuer', `
      <label for="n-trust-pk">Issuer pubkey</label><input id="n-trust-pk" placeholder="base58 pubkey">
      <label for="n-trust-note">Note <span class="small">(optional)</span></label>
      <textarea id="n-trust-note" rows="2" placeholder="e.g. met at the train station, seemed OK"></textarea>
      <button class="btn" onclick="addTrusted()">Trust</button>
    `)}
    ${card('Known banks', `
      <div class="small" style="margin-bottom:0.5rem">This bank: <span class="mono">${escapeHtml(state.bankPubkey.slice(0, 16))}…</span> ${escapeHtml(state.bankUrl)}</div>
      ${banks.map(b => `
        <div class="flex" style="justify-content:space-between;align-items:center;margin:0.4rem 0">
          <span class="mono small">${escapeHtml(b.pubkey.slice(0, 16))}… · ${escapeHtml(b.url)}</span>
          <button class="btn danger" onclick="removeBank('${jsStr(b.pubkey)}')">Remove</button>
        </div>
      `).join('') || '<p class="small">No peer banks pinned</p>'}
      <label for="n-bank-url">Bank URL</label><input id="n-bank-url" placeholder="https://…/bankname">
      <button class="btn" onclick="addBank()">Pin bank</button>
      <p class="small error" id="n-bank-err"></p>
    `)}
    ${card('Contacts', contacts.map(c => `
      <div class="flex" style="justify-content:space-between;margin:0.4rem 0">
        <span>${escapeHtml(c.handle || '')} <span class="mono small">${escapeHtml((c.pubkey || '').slice(0, 16))}…</span></span>
        <button class="btn danger" onclick="removeContact('${jsStr(c.pubkey)}')">Remove</button>
      </div>
    `).join('') || '<p class="small">No contacts</p>')}
  </div>`;
}

window.untrust = async function(pk) {
  try { await uiDelete(`/trusted/${pk}`); toast('Removed'); route(); }
  catch (e) { toast(e.message, 'error'); }
};
window.addTrusted = async function() {
  const pk = document.getElementById('n-trust-pk').value.trim();
  const noteEl = document.getElementById('n-trust-note');
  const note = noteEl ? noteEl.value.trim() : '';
  if (!pk) return;
  try { await uiPost('/trusted', { pubkey: pk, note }); toast('Trusted'); route(); }
  catch (e) { toast(e.message, 'error'); }
};
// Edit (or clear) the note on an already-trusted issuer. The pubkey and current
// note ride on the button's data-* attributes (safely escaped at render time).
window.editTrustNote = async function(btn) {
  const pubkey = btn.dataset.pk;
  const cur = btn.dataset.note || '';
  const next = window.prompt('Note about this issuer (why do you trust them?)', cur);
  if (next === null) return; // cancelled
  try { await uiPost('/trusted', { pubkey, note: next }); toast('Note saved'); route(); }
  catch (e) { toast(e.message, 'error'); }
};
window.removeBank = async function(pk) {
  try { await uiDelete(`/banks/${pk}`); toast('Removed'); route(); }
  catch (e) { toast(e.message, 'error'); }
};
window.addBank = async function() {
  const url = document.getElementById('n-bank-url').value.trim().replace(/\/$/, '');
  const err = document.getElementById('n-bank-err');
  try {
    // Pin pubkey+url together: fetch the bank's discovery doc first.
    const disc = await fetch(`${url}/barter-bank.json`).then(r => r.json());
    if (!disc.pubkey) throw new Error('not a barter bank');
    await uiPost('/banks', { pubkey: disc.pubkey, url });
    toast(`Pinned ${disc.name || 'bank'}`);
    route();
  } catch (e) { err.textContent = e.message; }
};
window.removeContact = async function(pk) {
  try { await uiDelete(`/contacts/${pk}`); toast('Removed'); route(); }
  catch (e) { toast(e.message, 'error'); }
};

// ---------------- auto-lock ----------------

let lastActivity = Date.now();
const AUTOLOCK_MS = 10 * 60 * 1000;
['pointerdown', 'keydown', 'touchstart'].forEach(ev =>
  document.addEventListener(ev, () => { lastActivity = Date.now(); }, { passive: true }));
setInterval(() => {
  if (state.user && Date.now() - lastActivity > AUTOLOCK_MS) {
    toast('Locked after inactivity');
    window.lock();
  }
}, 30000);

// ---------------- boot ----------------

fetchConfig().then(() => route()).catch(e => {
  document.getElementById('app').innerHTML = `<div class="container"><p class="error">Failed to load bank config: ${e.message}</p></div>`;
});
