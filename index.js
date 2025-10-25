// index.js
// One-time coupon server with Admin + Client dashboards (Node 18+)

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ---------- CORS (allow local redeem.html and other origins) ----------
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, x-client-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ---------- ENV ----------
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || process.env.X_API_KEY || 'dev-key';
const BASE_URL = process.env.COUPON_BASE_URL || process.env.BASE_URL || `http://localhost:${PORT}`;

const CLIENT_POPEYES_SLUG = process.env.CLIENT_POPEYES_SLUG || 'popeyes-mckinney';
const CLIENT_POPEYES_TOKEN = process.env.CLIENT_POPEYES_TOKEN || 'change-me-long-random';

// ---------- FILE PATHS ----------
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const PASSES_PATH = path.join(DATA_DIR, 'passes.json');

// ---------- FS HELPERS ----------
function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  // seed a tiny cashier page if not present
  const clientDir = path.join(PUBLIC_DIR, 'client');
  if (!fs.existsSync(clientDir)) fs.mkdirSync(clientDir, { recursive: true });
  const redeemHtml = path.join(PUBLIC_DIR, 'redeem.html');
  if (!fs.existsSync(redeemHtml)) {
    fs.writeFileSync(
      redeemHtml,
      `<!doctype html><meta charset="utf-8"><title>Redeem</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:24px;max-width:520px;margin:0 auto}input,button{padding:10px;border:1px solid #ddd;border-radius:8px}label{display:block;margin:.5rem 0 .25rem}button{cursor:pointer}</style>
<h1>Coupon Redeem</h1>
<p>Paste or scan the <b>token</b> below and submit with your store/staff IDs.</p>
<label>Token</label><input id="token" autofocus>
<label>Store ID</label><input id="store" placeholder="Store #2331">
<label>Staff</label><input id="staff" placeholder="John S.">
<label>API Key</label><input id="key" placeholder="Required">
<p><button onclick="redeem()">Redeem</button></p>
<pre id="out"></pre>
<script>
async function redeem(){
  const token=document.getElementById('token').value.trim();
  const store=document.getElementById('store').value.trim();
  const staff=document.getElementById('staff').value.trim();
  const key=document.getElementById('key').value.trim();
  const res=await fetch('/api/redeem',{method:'POST',headers:{'Content-Type':'application/json','x-api-key':key},body:JSON.stringify({token,store_id:store,staff})});
  document.getElementById('out').textContent = await res.text();
}
</script>`
    );
  }
}
ensureDirs();

function loadPasses() {
  if (!fs.existsSync(PASSES_PATH)) return [];
  try {
    return JSON.parse(fs.readFileSync(PASSES_PATH, 'utf8'));
  } catch {
    return [];
  }
}
function savePasses(arr) {
  fs.writeFileSync(PASSES_PATH, JSON.stringify(arr, null, 2));
}

function nowISO() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function hashToken(s) {
  return crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
}

// ---------- STATIC ----------
app.use(express.static(PUBLIC_DIR));

// ---------- HEALTH ----------
app.get('/healthz', (_, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---------- ISSUE: GET /coupon?offer=...&restaurant=... ----------
app.get('/coupon', async (req, res) => {
  const offer_id = String(req.query.offer || req.query.offer_id || 'generic-offer').trim();
  const restaurant = String(req.query.restaurant || 'Unknown Restaurant').trim();
  const expires_at = req.query.expires || ''; // optional
  const id = crypto.randomUUID();
  const token = `${offer_id}.${id}.${Date.now()}`;
  const token_hash = hashToken(token);

  const passes = loadPasses();
  passes.push({
    id,
    offer_id,
    restaurant,
    token,
    token_hash,
    status: 'issued',
    issued_at: nowISO(),
    expires_at: expires_at || '',
    redeemed_at: '',
    redeemed_by_store: '',
    redeemed_by_staff: ''
  });
  savePasses(passes);

  const couponUrl = `${BASE_URL}/coupon/view?token=${encodeURIComponent(token)}`;
  const qrDataUrl = await QRCode.toDataURL(couponUrl);

  res.send(`<!doctype html>
<meta charset="utf-8"><title>Coupon Issued</title>
<style>
 body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:24px;max-width:720px;margin:0 auto}
 .card{border:1px solid #eee;border-radius:12px;padding:16px}
 .row{display:flex;gap:20px;align-items:center}
 img{width:180px;height:180px}
 .muted{color:#777}
 .badge{display:inline-block;padding:4px 8px;border-radius:999px;background:#eef;border:1px solid #dde}
</style>
<h1>${restaurant}</h1>
<p class="badge">${offer_id}</p>
<div class="card">
  <div class="row">
   <img src="${qrDataUrl}" alt="QR">
   <div>
     <h2>Show this at checkout</h2>
     <p class="muted">Scan QR to view & save coupon on your phone.</p>
     <p><b>Token (short):</b> ${token_hash}</p>
     <p><a href="${couponUrl}">${couponUrl}</a></p>
   </div>
  </div>
</div>
<p class="muted">Cashier page: <a href="/redeem.html">/redeem.html</a></p>`);
});

// ---------- VIEW COUPON ----------
app.get('/coupon/view', (req, res) => {
  const token = String(req.query.token || '');
  const passes = loadPasses();
  const pass = passes.find(p => p.token === token);
  if (!pass) return res.status(404).send('Coupon not found');
  const isRedeemed = pass.status === 'redeemed';
  res.send(`<!doctype html>
<meta charset="utf-8"><title>Coupon</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:24px;max-width:620px;margin:0 auto}
.badge{display:inline-block;padding:4px 8px;border-radius:999px;background:#eef;border:1px solid #dde}</style>
<h1>${pass.restaurant}</h1>
<p class="badge">${pass.offer_id}</p>
<p>Status: <b>${pass.status.toUpperCase()}</b>${isRedeemed ? ' ✅' : ''}</p>
<p>Token (short): ${pass.token_hash}</p>
<p>Show this screen to the cashier.</p>`);
});

// ---------- REDEEM API (POST /api/redeem) ----------
app.post('/api/redeem', (req, res) => {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(401).send('Unauthorized: invalid API key');

  const token = String(req.body.token || '').trim();
  const store_id = String(req.body.store_id || req.body.store || '').trim();
  const staff = String(req.body.staff || req.body.employee || '').trim();

  if (!token) return res.status(400).send('Missing token');

  const passes = loadPasses();
  const pass = passes.find(p => p.token === token);
  if (!pass) return res.status(404).send('Token not found');
  if (pass.status === 'redeemed') return res.status(409).send('Already redeemed');

  pass.status = 'redeemed';
  pass.redeemed_at = nowISO();
  pass.redeemed_by_store = store_id;
  pass.redeemed_by_staff = staff;
  savePasses(passes);

  res.json({ ok: true, token_hash: pass.token_hash, redeemed_at: pass.redeemed_at });
});

// ---------- ADMIN: HUB + DASHBOARD ----------
app.get('/hub', (req, res) => {
  const rows = loadPasses();
  const items = rows.slice(-100).reverse().map(r =>
    `<tr><td>${r.token_hash}</td><td>${r.offer_id}</td><td>${r.restaurant}</td><td>${r.status}</td><td>${r.issued_at}</td><td>${r.redeemed_at||''}</td></tr>`
  ).join('');
  res.send(`<!doctype html><meta charset="utf-8"><title>Hub</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:24px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #eee;padding:8px;text-align:left}</style>
<h1>Admin Hub</h1>
<p><a href="/hub/dashboard">Analytics Admin</a></p>
<table><thead><tr><th>Token</th><th>Offer</th><th>Restaurant</th><th>Status</th><th>Issued</th><th>Redeemed</th></tr></thead><tbody>${items}</tbody></table>`);
});

app.get('/hub/dashboard', (req, res) => {
  res.send(`<!doctype html><meta charset="utf-8"><title>Analytics Admin</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:24px;max-width:760px;margin:0 auto}</style>
<h1>Analytics Admin</h1>
<p>Enter your API key to download the full redemption CSV.</p>
<p><input id="k" placeholder="API key" style="padding:10px;border:1px solid #ddd;border-radius:8px;width:260px">
<button onclick="dl()" style="padding:10px 14px;border:1px solid #ddd;border-radius:8px;cursor:pointer">Download CSV</button></p>
<script>
function dl(){
  const k=document.getElementById('k').value.trim();
  const u='/hub/dashboard/report-analytics.csv';
  const a=document.createElement('a');
  a.href=u; a.download='redeem_report.csv';
  fetch(u,{headers:{'x-api-key':k}})
    .then(r=>{ if(!r.ok) throw new Error('bad'); return r.blob(); })
    .then(b=>{ const url=URL.createObjectURL(b); a.href=url; a.click(); setTimeout(()=>URL.revokeObjectURL(url), 5000); })
    .catch(()=>alert('Invalid API key or server error'));
}
</script>`);
});

// Admin CSV (protected)
app.get('/hub/dashboard/report-analytics.csv', (req, res) => {
  const key = req.headers['x-api-key'];
  if (key !== API_KEY) return res.status(401).send('Unauthorized');

  const rows = loadPasses();
  const headers = [
    'id','offer_id','restaurant','status','issued_at','expires_at',
    'redeemed_at','redeemed_by_store','redeemed_by_staff','token_hash'
  ];
  const csv = [headers.join(',')].concat(rows.map(r => headers.map(h => (r[h] ?? '').toString().replace(/,/g, ' ')).join(','))).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="redeem_report.csv"');
  res.send(csv);
});

// ---------- CLIENT-FACING DASHBOARD (Popeyes) ----------

// Load rows for client API from passes.json
function loadRedemptionRows() {
  const passes = loadPasses();
  // Normalize to the public shape
  return passes.map(r => ({
    id: r.id || r.token || '',
    offer_id: r.offer_id || '',
    restaurant: r.restaurant || '',
    status: r.status || (r.redeemed_at ? 'redeemed' : 'issued'),
    issued_at: r.issued_at || '',
    expires_at: r.expires_at || '',
    redeemed_at: r.redeemed_at || '',
    redeemed_by_store: r.redeemed_by_store || '',
    redeemed_by_staff: r.redeemed_by_staff || '',
    token_hash: r.token_hash || (r.token ? hashToken(r.token) : '')
  }));
}

function authClient(req, res, next) {
  const token = req.query.token || req.headers['x-client-token'];
  if (!CLIENT_POPEYES_TOKEN) return res.status(500).send('Client access not configured');
  if (token !== CLIENT_POPEYES_TOKEN) return res.status(401).send('Unauthorized');
  next();
}

// Serve the client dashboard page file if present; otherwise serve a minimal one
app.get(`/client/${CLIENT_POPEYES_SLUG}`, authClient, (req, res) => {
  const htmlPath = path.join(PUBLIC_DIR, 'client', 'popeyes.html');
  if (fs.existsSync(htmlPath)) return res.sendFile(htmlPath);
  // Minimal fallback (so the route always works)
  res.send(`<!doctype html><meta charset="utf-8"><title>Popeyes Dashboard</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:24px}table{border-collapse:collapse;width:100%}td,th{border-bottom:1px solid #eee;padding:8px;text-align:left}</style>
<h1>🍗 Popeyes McKinney — Coupon Performance</h1>
<p>This is a minimal placeholder. For the full UI, add <code>/public/client/popeyes.html</code> as provided.</p>
<p><a id="csv">Download CSV</a></p>
<table id="t"><thead><tr><th>ID</th><th>Offer</th><th>Status</th><th>Issued</th><th>Redeemed</th><th>Store</th><th>Staff</th></tr></thead><tbody></tbody></table>
<script>
const token=new URLSearchParams(location.search).get('token');
fetch('/api/client-report?restaurant=' + encodeURIComponent('Popeyes McKinney') + '&token=' + encodeURIComponent(token), {headers:{'x-client-token':token}})
.then(r=>r.json()).then(j=>{
  const tb=document.querySelector('tbody');
  tb.innerHTML=(j.rows||[]).map(r=>\`<tr><td>\${r.id||''}</td><td>\${r.offer_id||''}</td><td>\${r.status||''}</td><td>\${r.issued_at||''}</td><td>\${r.redeemed_at||''}</td><td>\${r.redeemed_by_store||''}</td><td>\${r.redeemed_by_staff||''}</td></tr>\`).join('');
  document.getElementById('csv').href='/api/client-report.csv?restaurant=' + encodeURIComponent('Popeyes McKinney') + '&token=' + encodeURIComponent(token);
  document.getElementById('csv').download='popeyes_report.csv';
});
</script>`);
});

// Client JSON API (filters: restaurant, from, to, offer, status)
app.get('/api/client-report', authClient, (req, res) => {
  const { restaurant, from, to, offer, status } = req.query;
  let rows = loadRedemptionRows();

  if (restaurant) {
    const needle = restaurant.toLowerCase();
    rows = rows.filter(r => (r.restaurant || '').toLowerCase().includes(needle));
  }
  if (offer) {
    const needle = offer.toLowerCase();
    rows = rows.filter(r => (r.offer_id || '').toLowerCase().includes(needle));
  }
  if (status) {
    const allowed = new Set(String(status).split(',').map(s => s.trim().toLowerCase()));
    rows = rows.filter(r => allowed.has((r.status || '').toLowerCase()));
  }
  if (from) {
    const t = new Date(from).getTime();
    rows = rows.filter(r => r.issued_at && new Date(r.issued_at).getTime() >= t);
  }
  if (to) {
    const t = new Date(to).getTime();
    rows = rows.filter(r => r.issued_at && new Date(r.issued_at).getTime() <= t);
  }

  res.json({ rows });
});

// Client CSV export
app.get('/api/client-report.csv', authClient, (req, res) => {
  const { restaurant, from, to, offer, status } = req.query;
  let rows = loadRedemptionRows();

  if (restaurant) rows = rows.filter(r => (r.restaurant || '').toLowerCase().includes(restaurant.toLowerCase()));
  if (offer) rows = rows.filter(r => (r.offer_id || '').toLowerCase().includes(offer.toLowerCase()));
  if (status) {
    const allowed = new Set(String(status).split(',').map(s => s.trim().toLowerCase()));
    rows = rows.filter(r => allowed.has((r.status || '').toLowerCase()));
  }
  if (from) rows = rows.filter(r => r.issued_at && new Date(r.issued_at) >= new Date(from));
  if (to) rows = rows.filter(r => r.issued_at && new Date(r.issued_at) <= new Date(to));

  const headers = [
    'id','offer_id','restaurant','status','issued_at','expires_at',
    'redeemed_at','redeemed_by_store','redeemed_by_staff','token_hash'
  ];
  const csv = [headers.join(',')].concat(rows.map(r => headers.map(h => (r[h] ?? '').toString().replace(/,/g, ' ')).join(','))).join('\n');
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="popeyes_report.csv"');
  res.send(csv);
});

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`Coupon server running on ${PORT}`);
  console.log(`Admin Hub: ${BASE_URL}/hub`);
  console.log(`Cashier Redeem page: ${BASE_URL}/redeem.html`);
  console.log(`Client (Popeyes): ${BASE_URL}/client/${CLIENT_POPEYES_SLUG}?token=${CLIENT_POPEYES_TOKEN}`);
});
