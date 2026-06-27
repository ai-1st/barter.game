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

  if (!state.user) {
    if (p === 'register') return renderRegister(app);
    if (p === 'connect') return renderConnect(app);
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
      <a class="btn" href="#/register">Create account</a>
      <a class="btn secondary" href="#/connect">I have a key</a>
    </div>
    <p class="small" style="margin-top:2rem">Your private key is encrypted in the browser before touching the server.</p>
  </div>`;
}

function renderRegister(app) {
  app.innerHTML = `<div class="container" style="max-width:420px;padding-top:8vh">
    ${card('Create account', `
      <label>Handle</label><input id="r-handle" placeholder="alice">
      <label>Password</label><input id="r-pass" type="password" placeholder="••••••••">
      <label>Confirm password</label><input id="r-pass2" type="password" placeholder="••••••••">
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
    state.user = { handle, pubkey: pubkeyBase58, privateKey };
    state.uiState = await uiGet('/state');
    location.hash = '#/';
    route();
    toast(`Welcome, ${handle}`);
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
  app.innerHTML = `<div class="container" style="max-width:420px;padding-top:8vh">
    ${card('Unlock', `
      <label>Handle</label><input id="u-handle" placeholder="alice">
      <label>Password</label><input id="u-pass" type="password" placeholder="••••••••">
      <button class="btn" style="width:100%;margin-top:1rem" onclick="doUnlock()">Unlock</button>
      <p class="small error" id="u-err"></p>
      <p class="small">No password recovery. Lost password = lost account.</p>
    `)}
  </div>`;
}

window.doUnlock = async function() {
  const handle = document.getElementById('u-handle').value.trim();
  const pass = document.getElementById('u-pass').value;
  const err = document.getElementById('u-err');
  try {
    const res = await fetch(`${state.basePath}/ui/keystore/${handle}`);
    const data = await res.json();
    if (data.code) throw new Error('could not unlock');
    const seed = await decryptSeed(data.keystore, pass);
    const { pubkeyBase58 } = publicKeyOf(seed);
    if (pubkeyBase58 !== data.pubkey) throw new Error('wrong password');
    state.user = { handle, pubkey: pubkeyBase58, privateKey: seed };
    state.uiState = await uiGet('/state').catch(() => ({ pubkey: pubkeyBase58, trusted: [], contacts: [], banks: [], catalog: [], drafts: [], prefs: {}, rev: 0 }));
    location.hash = '#/';
    route();
  } catch (e) {
    err.textContent = 'Could not unlock. Wrong password or missing backup.';
  }
};

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
  body += `<div class="flex" style="margin-bottom:1rem"><a class="btn" href="#/vouchers/new">Create voucher</a></div>`;
  body += `<div class="grid">${vouchers.map(v => `
    <div class="card">
      <div><strong>${escapeHtml(v.name)}</strong></div>
      <div class="mono small">${escapeHtml(hashDoc(v).slice(0,16))}…</div>
      <div class="small">${v.limit !== undefined ? `limit ${v.limit}` : 'unlimited'} ${v.integer ? '· integer' : ''}</div>
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
    `)}
    ${card('Bank', `
      <p>${escapeHtml(state.bankName)}</p>
      <p class="mono small">${escapeHtml(state.bankPubkey)}</p>
      <p class="small">${escapeHtml(state.bankUrl)}</p>
    `)}
    ${card('Actions', `
      <button class="btn danger" onclick="lock()">Lock</button>
    `)}
  </div>`;
}

// ---------------- boot ----------------

fetchConfig().then(() => route()).catch(e => {
  document.getElementById('app').innerHTML = `<div class="container"><p class="error">Failed to load bank config: ${e.message}</p></div>`;
});
