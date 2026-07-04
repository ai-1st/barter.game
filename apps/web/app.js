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

// ---------------- router ----------------

function route() {
  const hash = location.hash.slice(1) || '/';
  const [p, ...rest] = hash.split('/').filter(Boolean);
  const app = document.getElementById('app');
  app.innerHTML = '';
  stopActiveScanner();

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

window.addEventListener('hashchange', route);

// ---------------- UI components ----------------

function header(title) {
  return `<div class="header">
    <div><strong>${escapeHtml(state.bankName)}</strong> <span class="mono small">${escapeHtml(state.user?.pubkey.slice(0, 12) || '')}…</span></div>
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

function escapeHtml(s) {
  if (typeof s !== 'string') return String(s ?? '');
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function toast(msg, type = 'success') {
  const t = document.createElement('div');
  t.className = `small ${type}`;
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
  app.innerHTML = `<div class="container" style="text-align:center;padding-top:15vh">
    <h1>barter.game</h1>
    <p class="small">Federated mutual-credit ledger</p>
    ${cfg ? `<p class="mono small">${escapeHtml(cfg.pubkey.slice(0,16))}… @ ${escapeHtml(cfg.name)}</p>` : ''}
    <div style="margin-top:2rem;display:flex;gap:1rem;justify-content:center">
      <a class="btn" href="#/unlock">Log in</a>
      <a class="btn secondary" href="#/register">Create account</a>
    </div>
    <p class="small" style="margin-top:1rem"><a href="#/connect">I have a raw key instead</a></p>
    <p class="small" style="margin-top:2rem">Log in with your handle and password. Your key is encrypted in the browser before it ever touches the server.</p>
  </div>`;
}

function renderRegister(app) {
  app.innerHTML = `<div class="container" style="max-width:420px;padding-top:8vh">
    ${card('Create account', `
      <label>Handle <span class="small">(2–32 chars: a–z, 0–9, _ or -)</span></label><input id="r-handle" placeholder="alice">
      <label>Password</label><input id="r-pass" type="password" placeholder="••••••••">
      <label>Confirm password</label><input id="r-pass2" type="password" placeholder="••••••••" onkeydown="if(event.key==='Enter')doRegister()">
      <label><input type="checkbox" id="r-ack"> I understand there is no password recovery</label>
      <button class="btn" style="width:100%;margin-top:1rem" onclick="doRegister()">Create</button>
      <p class="small error" id="r-err"></p>
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
  if (!handle || !pass || pass !== pass2 || !ack) {
    err.textContent = 'Check fields and acknowledgement';
    return;
  }
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
      <label>Handle</label><input id="u-handle" placeholder="alice" autocomplete="username" value="${escapeHtml(last)}">
      <label>Password</label><input id="u-pass" type="password" placeholder="••••••••" autocomplete="current-password" onkeydown="if(event.key==='Enter')doUnlock()">
      <button class="btn" style="width:100%;margin-top:1rem" onclick="doUnlock()">Log in</button>
      <p class="small error" id="u-err"></p>
      <p class="small">No password recovery. Lost password = lost account.</p>
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
      err.textContent = res.status === 404 ? 'No account with that handle at this bank' : 'Could not log in — try again';
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
  const portfolio = await uiGet('/portfolio').catch(() => ({ holdings: [] }));
  const history = await uiGet('/history?limit=5').catch(() => ({ events: [] }));
  let body = header('Dashboard');
  body += `<div class="container">`;
  body += card('Balances', `<div class="grid">${portfolio.holdings.map(h => `
    <div>
      <div class="small">${escapeHtml(h.name)}</div>
      <div><strong>${h.current}</strong> <span class="small">pending ${h.pending}</span></div>
      <div class="mono small">${escapeHtml(h.account.slice(0,12))}…</div>
    </div>
  `).join('') || '<p class="small">No balances yet</p>'}</div>`);
  body += card('Quick actions', `<div class="flex">
    <a class="btn" href="#/vouchers/new">Create voucher</a>
    <a class="btn" href="#/invoices/new">New invoice</a>
    <a class="btn" href="#/cheques/new">New cheque</a>
    <a class="btn secondary" href="#/discover">Discover</a>
  </div>`);
  body += card('Recent activity', history.events.map(e => `
    <div class="flex" style="justify-content:space-between;margin:0.4rem 0">
      <span class="mono small">${escapeHtml(e.deal_id.slice(0,12))}…</span>
      <span>${e.direction} ${e.amount} ${escapeHtml(e.voucher_name || e.voucher.slice(0,8))}</span>
      <span class="chip state-${e.state}">${e.state}</span>
    </div>
  `).join('') || '<p class="small">No activity</p>');
  body += `</div>`;
  app.innerHTML = body;
}

async function renderVouchers(app) {
  const vouchers = await rpcCall('list_vouchers', { filter: 'mine' }).catch(() => []);
  let body = header('Vouchers');
  body += `<div class="container">`;
  body += `<div class="flex" style="margin-bottom:1rem">
    <a class="btn" href="#/vouchers/new">Create voucher</a>
    <button class="btn secondary" onclick="showShare('i', '${escapeHtml(state.user.pubkey)}', 'My issuer profile')">Share my profile QR</button>
  </div>`;
  body += `<div class="grid">${vouchers.map(v => `
    <div class="card">
      <div><strong>${escapeHtml(v.name)}</strong></div>
      <div class="mono small">${escapeHtml(hashDoc(v).slice(0,16))}…</div>
      <div class="small">${v.limit !== undefined ? `limit ${v.limit}` : 'unlimited'} ${v.integer ? '· integer' : ''}</div>
      <button class="btn secondary" onclick="showShare('i', '${escapeHtml(v.pubkey)}', '${escapeHtml(v.name)}')">Share QR</button>
    </div>
  `).join('') || '<p class="small">No vouchers</p>'}</div>`;
  body += `</div>`;
  app.innerHTML = body;
}

function renderCreateVoucher(app) {
  app.innerHTML = header('Create voucher') + `<div class="container">
    ${card('New voucher', `
      <label>Name</label><input id="v-name" placeholder="1 hour consulting">
      <label>Description (markdown)</label><textarea id="v-desc" rows="3"></textarea>
      <label>Supply limit</label><input id="v-limit" type="number" placeholder="optional">
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
  const orders = await uiGet('/orders?kind=invoice').catch(() => ({ orders: [] }));
  let body = header('Invoices');
  body += `<div class="container">`;
  body += `<div class="flex" style="margin-bottom:1rem"><a class="btn" href="#/invoices/new">New invoice</a></div>`;
  body += orders.orders.map(o => `
    <div class="card">
      <div>Receive ${o.credit.max} of ${escapeHtml(o.credit.voucher.slice(0,12))}…</div>
      <div class="mono small">${escapeHtml(o.order.slice(0,16))}…</div>
      <div class="small">state: ${o.state}</div>
      <button class="btn secondary" onclick="showShare('v', '${escapeHtml(o.order)}', 'Invoice — scan to pay')">Share QR</button>
    </div>
  `).join('') || '<p class="small">No invoices</p>';
  body += `</div>`;
  app.innerHTML = body;
}

function renderCreateInvoice(app) {
  app.innerHTML = header('New invoice') + `<div class="container">
    ${card('Invoice (credit-only order)', `
      <label>Voucher hash</label><input id="i-voucher" placeholder="paste voucher hash">
      <label>Account name</label><input id="i-acct" value="receiving">
      <label>Amount</label><input id="i-amount" type="number" value="10">
      <button class="btn" style="width:100%;margin-top:1rem" onclick="doCreateInvoice()">Create invoice</button>
      <p class="small error" id="i-err"></p>
    `)}
  </div>`;
}

window.doCreateInvoice = async function() {
  const voucherHash = document.getElementById('i-voucher').value.trim();
  const acctName = document.getElementById('i-acct').value.trim();
  const amount = Number(document.getElementById('i-amount').value);
  const err = document.getElementById('i-err');
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

function renderCheques(app) {
  app.innerHTML = header('Cheques') + `<div class="container"><p class="small">Cheques are debit-only orders. Use the Orders tab to view.</p></div>`;
}

function renderCreateCheque(app) {
  app.innerHTML = header('New cheque') + `<div class="container">
    ${card('Cheque (debit-only order)', `
      <label>Voucher hash</label><input id="q-voucher" placeholder="paste voucher hash">
      <label>Account name</label><input id="q-acct" value="spending">
      <label>Amount</label><input id="q-amount" type="number" value="10">
      <button class="btn" style="width:100%;margin-top:1rem" onclick="doCreateCheque()">Create cheque</button>
      <p class="small error" id="q-err"></p>
    `)}
  </div>`;
}

window.doCreateCheque = async function() {
  const voucherHash = document.getElementById('q-voucher').value.trim();
  const acctName = document.getElementById('q-acct').value.trim();
  const amount = Number(document.getElementById('q-amount').value);
  const err = document.getElementById('q-err');
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
    toast('Cheque created');
  } catch (e) {
    err.textContent = e.message;
  }
};

async function renderOrders(app) {
  const orders = await uiGet('/orders').catch(() => ({ orders: [] }));
  app.innerHTML = header('Orders') + `<div class="container">
    <div class="flex" style="margin-bottom:1rem"><a class="btn" href="#/orders/new">New order</a></div>
    ${orders.orders.map(o => `
      <div class="card">
        <div>${o.kind === 'two-sided' ? 'Swap' : o.kind} · rate ${o.rate} · lead ${o.lead}</div>
        <div class="mono small">${escapeHtml(o.order.slice(0,16))}…</div>
        <div class="small">${o.debit ? `give ${o.debit.min}-${o.debit.max}` : ''} ${o.credit ? `· get ${o.credit.min}-${o.credit.max}` : ''}</div>
        ${o.kind === 'invoice' ? `<button class="btn secondary" onclick="showShare('v', '${escapeHtml(o.order)}', 'Invoice — scan to pay')">Share QR</button>` : ''}
        ${o.kind === 'cheque' ? `<button class="btn secondary" onclick="showShare('q', '${escapeHtml(o.order)}', 'Cheque — scan to claim')">Share QR</button>` : ''}
      </div>
    `).join('') || '<p class="small">No orders</p>'}
  </div>`;
}

function renderCreateOrder(app) {
  app.innerHTML = header('New order') + `<div class="container">
    ${card('Two-sided swap order', `
      <label>Debit voucher hash</label><input id="o-dv" placeholder="voucher you give">
      <label>Debit account name</label><input id="o-da" value="selling">
      <label>Debit max</label><input id="o-dmax" type="number" value="100">
      <label>Credit voucher hash</label><input id="o-cv" placeholder="voucher you receive">
      <label>Credit account name</label><input id="o-ca" value="buying">
      <label>Credit max</label><input id="o-cmax" type="number" value="90">
      <label>Rate (debit/credit max)</label><input id="o-rate" type="number" value="1.111">
      <label><input type="checkbox" id="o-lead"> Lead (settle first)</label>
      <label><input type="checkbox" id="o-pub" checked> Publish as offer</label>
      <button class="btn" style="width:100%;margin-top:1rem" onclick="doCreateOrder()">Create order</button>
      <p class="small error" id="o-err"></p>
    `)}
  </div>`;
}

window.doCreateOrder = async function() {
  const dv = document.getElementById('o-dv').value.trim();
  const da = document.getElementById('o-da').value.trim();
  const dmax = Number(document.getElementById('o-dmax').value);
  const cv = document.getElementById('o-cv').value.trim();
  const ca = document.getElementById('o-ca').value.trim();
  const cmax = Number(document.getElementById('o-cmax').value);
  const rate = Number(document.getElementById('o-rate').value);
  const lead = document.getElementById('o-lead').checked;
  const pub = document.getElementById('o-pub').checked;
  const err = document.getElementById('o-err');
  try {
    const dAccount = { type: 'account', pubkey: state.user.pubkey, ulid: newUlid(), name: da, voucher: dv };
    dAccount.sig = signDoc(dAccount, state.user.privateKey);
    const cAccount = { type: 'account', pubkey: state.user.pubkey, ulid: newUlid(), name: ca, voucher: cv };
    cAccount.sig = signDoc(cAccount, state.user.privateKey);
    const dHash = hashDoc(dAccount), cHash = hashDoc(cAccount);
    const order = { type: 'order', pubkey: state.user.pubkey, ulid: newUlid(), rate,
      debit: { account: dHash, voucher: dv, bank: state.bankPubkey, min: 0, max: dmax },
      credit: { account: cHash, voucher: cv, bank: state.bankPubkey, min: 0, max: cmax },
      lead };
    order.sig = signDoc(order, state.user.privateKey);
    const oHash = hashDoc(order);
    const docs = [order, dAccount, cAccount];
    // Cross-bank: also submit to credit voucher's bank if different.
    await rpcCall('submit_docs', { docs, publish_offers: pub ? [oHash] : [] });
    if (cv !== dv) {
      // Need credit bank pubkey. For now assume same bank; UI lets user add banks later.
    }
    location.hash = '#/orders';
    route();
    toast('Order created');
  } catch (e) {
    err.textContent = e.message;
  }
};

async function renderDiscover(app) {
  const offers = await uiPost('/discover', { vouchers: [], intentions: ['sell','buy'] }).catch(e => ({ offers: [], error: e.message }));
  app.innerHTML = header('Discover') + `<div class="container">
    ${card('Offers', (offers.offers || []).map(o => `
      <div class="card">
        <div>${o.debit ? `give ${o.debit.min}-${o.debit.max}` : ''} ${o.credit ? `· get ${o.credit.min}-${o.credit.max}` : ''}</div>
        <div class="small">rate ${o.rate} · lead ${o.lead} · bank ${escapeHtml(o.bank.slice(0,12))}…</div>
        <div class="mono small">${escapeHtml(o.offer.slice(0,16))}…</div>
        <button class="btn" onclick="acceptOffer('${o.order}', ${o.debit?.max||0}, ${o.credit?.max||0}, '${o.bank}', '${o.bank_url}')">Accept</button>
      </div>
    `).join('') || '<p class="small">No offers discovered</p>')}
    ${offers.error ? `<p class="error small">${offers.error}</p>` : ''}
  </div>`;
}

window.acceptOffer = async function(theirOrderHash, debitMax, creditMax, theirBankPubkey, theirBankUrl) {
  try {
    const mine = await uiGet('/orders');
    const myOffer = mine.orders[0];
    if (!myOffer) { toast('Create your own order first', 'error'); return; }
    // Reference Orders by their canonical hash so every participating bank can
    // resolve the same doc — Offers are per-bank derivations with bank-local
    // hashes and would not resolve at a counterparty bank.
    const myOrderHash = myOffer.order || myOffer.offers[0];
    const banks = [{ pubkey: state.bankPubkey, url: state.bankUrl }];
    if (theirBankPubkey && theirBankUrl && !banks.some(b => b.pubkey === theirBankPubkey)) {
      banks.push({ pubkey: theirBankPubkey, url: theirBankUrl });
    }
    const res = await uiPost('/propose_deal', {
      offer1: { hash: myOrderHash, debit_amount: debitMax || creditMax, credit_amount: creditMax || debitMax },
      offer2: { hash: theirOrderHash, debit_amount: creditMax || debitMax, credit_amount: debitMax || creditMax },
      banks
    });
    location.hash = `#/deal/${res.deal_id}`;
    route();
  } catch (e) {
    toast(e.message, 'error');
  }
};

async function renderDeal(app, dealId) {
  const status = await uiGet(`/deal/${dealId}`).catch(() => null);
  let body = header('Deal') + `<div class="container">`;
  if (!status) {
    body += card('Deal', '<p class="small">Not found</p>');
  } else {
    body += card(`Deal ${escapeHtml(dealId.slice(0,12))}…`, `
      <p>state: <span class="chip">${status.state}</span></p>
      ${status.legs.map(l => `
        <div class="card">
          <div>bank ${escapeHtml(l.bank.slice(0,16))}… · role ${l.role}</div>
          <div class="small">ready ${l.ready} · hold ${l.hold} · settle ${l.settle}</div>
        </div>
      `).join('')}
      <button class="btn secondary" onclick="location.reload()">Refresh</button>
      <button class="btn" onclick="relayDeal('${dealId}')">Relay signatures</button>
    `);
  }
  body += `</div>`;
  app.innerHTML = body;
  if (status && status.state !== 'settled' && status.state !== 'rejected') {
    setTimeout(() => { if (location.hash === `#/deal/${dealId}`) route(); }, 3000);
  }
}

window.relayDeal = async function(dealId) {
  try {
    const res = await uiPost('/relay_signatures', { from: {pubkey: state.bankPubkey, url: state.bankUrl}, to: {pubkey: state.bankPubkey, url: state.bankUrl}, record_hashes: [] });
    toast('Relay attempted');
  } catch (e) {
    toast(e.message, 'error');
  }
};

async function renderSettings(app) {
  app.innerHTML = header('Settings') + `<div class="container">
    ${card('Identity', `
      <p>Handle: ${escapeHtml(state.user.handle || '')}</p>
      <p class="mono small">${escapeHtml(state.user.pubkey)}</p>
      <button class="btn secondary" onclick="showShare('i', '${escapeHtml(state.user.pubkey)}', 'My issuer profile')">My profile QR</button>
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
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.innerHTML = `
    <div class="modal">
      <h3>${escapeHtml(title || 'Share')}</h3>
      <img class="qr" src="${dataUrl}" alt="QR code">
      <div class="mono small" style="word-break:break-all;margin:0.5rem 0">${escapeHtml(link)}</div>
      <div class="flex">
        <button class="btn" id="share-copy">Copy link</button>
        <button class="btn secondary" id="share-close">Close</button>
      </div>
    </div>`;
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#share-close').onclick = () => overlay.remove();
  overlay.querySelector('#share-copy').onclick = async () => {
    try { await navigator.clipboard.writeText(link); toast('Link copied'); }
    catch { toast('Copy failed — select the text manually', 'error'); }
  };
  document.body.appendChild(overlay);
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
      <label>…or paste a Barter Link</label>
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
      sessionStorage.setItem('barter_pending', JSON.stringify({ action: 'trust', pubkey: env.pubkey || value, handle: env.handle, bank: env.bank, bank_url: env.bank_url }));
      app.innerHTML = `<div class="container" style="max-width:420px;padding-top:4vh">${card('Issuer profile', body + `
        <p class="small">Registering will add <b>${escapeHtml(handle)}</b> to your trusted issuers.</p>
        <a class="btn" style="display:block;text-align:center" href="#/register">Register &amp; trust ${escapeHtml(handle)}</a>
        <a class="btn secondary" style="display:block;text-align:center;margin-top:0.5rem" href="#/unlock">Log in &amp; trust</a>
      `)}</div>`;
    } else {
      app.innerHTML = header('Profile') + `<div class="container" style="max-width:480px">${card('Issuer profile', body + `
        <button class="btn" style="width:100%" onclick="applyTrust('${escapeHtml(env.pubkey || value)}', '${escapeHtml(env.handle || '')}')">Trust ${escapeHtml(handle)}</button>
      `)}</div>`;
    }
    return;
  }

  if (env.kind === 'invoice' || env.kind === 'cheque') {
    const order = env.docs.find(d => d.type === 'order');
    const side = env.kind === 'invoice' ? order.credit : order.debit;
    const who = env.handle || order.pubkey.slice(0, 12) + '…';
    const amount = side.min === side.max ? String(side.max) : `${side.min}–${side.max}`;
    const verb = env.kind === 'invoice' ? 'Pay' : 'Claim';
    const body = `
      <h2>${env.kind === 'invoice' ? `Pay ${escapeHtml(who)}` : `Cheque from ${escapeHtml(who)}`}</h2>
      ${verified}
      <div class="card">
        <div>Amount: <strong>${escapeHtml(amount)}</strong></div>
        <div class="mono small">voucher ${escapeHtml(side.voucher.slice(0, 16))}…</div>
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
        <button class="btn" style="width:100%;margin-top:0.5rem" onclick="actOnOrder('${env.kind}')">${verb} now</button>
        <p class="small error" id="act-err"></p>
      `)}</div>`;
    }
    return;
  }

  app.innerHTML = `<div class="container" style="max-width:420px;padding-top:8vh">
    ${card('Barter Link', `<p>Kind: ${escapeHtml(env.kind)}</p>${verified}<p><a href="#/">Home</a></p>`)}</div>`;
}

// Add an issuer to the trusted list (+ their bank to known banks) with Undo.
window.applyTrust = async function(pubkey, handle) {
  try {
    await uiPost('/trusted', { pubkey });
    const pending = JSON.parse(sessionStorage.getItem('barter_pending') || '{}');
    if (pending.bank && pending.bank_url && pending.bank !== state.bankPubkey) {
      await uiPost('/banks', { pubkey: pending.bank, url: pending.bank_url }).catch(() => {});
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
  try {
    const pending = JSON.parse(sessionStorage.getItem('barter_pending') || '{}');
    const { env } = await fetchBarterEnvelope(pending.kind, pending.value);
    verifyEnvelope(env);
    const theirOrder = env.docs.find(d => d.type === 'order');
    const theirHash = hashDoc(theirOrder);
    const side = kind === 'invoice' ? theirOrder.credit : theirOrder.debit;
    const amount = Number(document.getElementById('act-amount').value) || side.max;

    // My side mirrors theirs: pay an invoice with a debit-only (cheque) Order;
    // claim a cheque with a credit-only (receiving) Order.
    // Reuse an existing account on this voucher when possible — paying MUST
    // debit a funded account, and scattering balance across per-deal accounts
    // would strand it.
    let accountHash = null;
    const docs = [];
    try {
      const pf = await uiGet('/portfolio');
      const candidates = (pf.holdings || []).filter(h => h.voucher === side.voucher);
      if (kind === 'invoice') {
        const funded = candidates.find(h => (h.current - h.pending) >= amount);
        if (!funded) throw new Error(`insufficient balance: you need ${amount} of this voucher to pay`);
        accountHash = funded.account;
      } else if (candidates.length > 0) {
        accountHash = candidates[0].account;
      }
    } catch (e) {
      if (String(e.message).includes('insufficient balance')) throw e;
      /* portfolio unavailable — fall through to a fresh account */
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
    await rpcCall('submit_docs', { docs });

    // giver = the debit-only order, receiver = the credit-only order.
    const giver = kind === 'invoice' ? myHash : theirHash;
    const receiver = kind === 'invoice' ? theirHash : myHash;
    const res = await uiPost('/propose_deal', {
      offer1: { hash: giver, debit_amount: amount, credit_amount: amount },
      offer2: { hash: receiver, debit_amount: amount, credit_amount: amount },
      banks: [{ pubkey: state.bankPubkey, url: state.bankUrl }],
    });
    sessionStorage.removeItem('barter_pending');
    location.hash = `#/deal/${res.deal_id}`;
    route();
  } catch (e) {
    if (err) err.textContent = e.message; else toast(e.message, 'error');
  }
};

// After register/unlock, resume whatever the landing page wanted to do.
function resumePendingAction() {
  const raw = sessionStorage.getItem('barter_pending');
  if (!raw) return false;
  try {
    const pending = JSON.parse(raw);
    if (pending.action === 'trust') {
      window.applyTrust(pending.pubkey, pending.handle);
      return true;
    }
    if (pending.action === 'invoice' || pending.action === 'cheque') {
      location.hash = `#/land/${pending.kind}/${pending.value}`;
      route();
      return true;
    }
  } catch { sessionStorage.removeItem('barter_pending'); }
  return false;
}

// ---------------- activity ----------------

async function renderActivity(app) {
  const history = await uiGet('/history?limit=100').catch(() => ({ events: [] }));
  app.innerHTML = header('Activity') + `<div class="container">
    ${card('Transaction history', history.events.map(e => `
      <div class="flex" style="justify-content:space-between;margin:0.4rem 0;align-items:center">
        <a class="mono small" href="#/deal/${escapeHtml(e.deal_id)}">${escapeHtml(e.deal_id.slice(0, 12))}…</a>
        <span>${e.direction === 'in' ? '↓' : '↑'} ${e.amount} ${escapeHtml(e.voucher_name || e.voucher.slice(0, 8))}</span>
        <span class="chip state-${escapeHtml(e.state)}">${escapeHtml(e.state)}</span>
      </div>
    `).join('') || '<p class="small">No activity yet</p>')}
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
  const resolved = await Promise.all(trusted.map(pk =>
    fetch(`${state.basePath}/ui/resolve/${pk}`).then(r => r.json()).catch(() => ({ pubkey: pk }))));

  app.innerHTML = header('Network') + `<div class="container">
    ${card('Trusted issuers', resolved.map(r => `
      <div class="flex" style="justify-content:space-between;align-items:center;margin:0.4rem 0">
        <span>${escapeHtml(r.handle || '')} <span class="mono small">${escapeHtml(r.pubkey.slice(0, 16))}…</span>
          <span class="small">${(r.vouchers || []).length} voucher(s)</span></span>
        <span>
          <button class="btn secondary" onclick="showShare('i', '${escapeHtml(r.pubkey)}', 'Issuer profile')">QR</button>
          <button class="btn danger" onclick="untrust('${escapeHtml(r.pubkey)}')">Remove</button>
        </span>
      </div>
    `).join('') || '<p class="small">Nobody trusted yet. Scan a friend&#39;s profile QR to start.</p>')}
    ${card('Add trusted issuer', `
      <label>Issuer pubkey</label><input id="n-trust-pk" placeholder="base58 pubkey">
      <button class="btn" onclick="addTrusted()">Trust</button>
    `)}
    ${card('Known banks', `
      <div class="small" style="margin-bottom:0.5rem">This bank: <span class="mono">${escapeHtml(state.bankPubkey.slice(0, 16))}…</span> ${escapeHtml(state.bankUrl)}</div>
      ${banks.map(b => `
        <div class="flex" style="justify-content:space-between;align-items:center;margin:0.4rem 0">
          <span class="mono small">${escapeHtml(b.pubkey.slice(0, 16))}… · ${escapeHtml(b.url)}</span>
          <button class="btn danger" onclick="removeBank('${escapeHtml(b.pubkey)}')">Remove</button>
        </div>
      `).join('') || '<p class="small">No peer banks pinned</p>'}
      <label>Bank URL</label><input id="n-bank-url" placeholder="https://…/bankname">
      <button class="btn" onclick="addBank()">Pin bank</button>
      <p class="small error" id="n-bank-err"></p>
    `)}
    ${card('Contacts', contacts.map(c => `
      <div class="flex" style="justify-content:space-between;margin:0.4rem 0">
        <span>${escapeHtml(c.handle || '')} <span class="mono small">${escapeHtml((c.pubkey || '').slice(0, 16))}…</span></span>
        <button class="btn danger" onclick="removeContact('${escapeHtml(c.pubkey)}')">Remove</button>
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
  if (!pk) return;
  try { await uiPost('/trusted', { pubkey: pk }); toast('Trusted'); route(); }
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
