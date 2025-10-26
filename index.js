// index.js
// ACP Coupons — Gallery + Wallet + Geo + Multi-Client Dashboards (Node 18+ / Render)
//
// Env (Render):
//  - API_KEY (admin)
//  - COUPON_BASE_URL (or BASE_URL) e.g. https://acp-coupons.onrender.com
//  - CLIENT_*_TOKEN for each client slug (see CLIENTS below)
//  - (Optional) SMTP_* + REPORT_* for monthly report script
//
// Data files auto-created in ./data:
//  - db.json { passes:[], redemptions:[] }
//  - events.json { events:[] }  // gallery views, saves, clicks, tent attribution
//
// Static:
//  - ./public  (offers.html, wallet.html, client dashboard, assets, sw, manifest)
//  - /static/* -> ./public/*   (for legacy assets in offers.json)

const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ---- CORS (simple) ----
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, x-api-key, x-client-token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ---- ENV ----
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';
const BASE_URL = (process.env.COUPON_BASE_URL || process.env.BASE_URL || '').replace(/\/$/, '');

// ---- CLIENTS registry (extend as needed) ----
const CLIENTS = {
  'popeyes-mckinney': {
    name: 'Popeyes McKinney',
    token: process.env.CLIENT_POPEYES_TOKEN || '',
    restaurants: ['Popeyes McKinney']
  },
  'sonic-frisco': {
    name: 'Sonic Frisco',
    token: process.env.CLIENT_SONIC_TOKEN || '',
    restaurants: ['Sonic Frisco']
  },
  'braums-stacy': {
    name: "Braum's Stacy Rd",
    token: process.env.CLIENT_BRAUMS_TOKEN || '',
    restaurants: ["Braum's Stacy Rd", "Braum’s Stacy Rd"]
  },
  'rudys-mckinney': {
    name: "Rudy's BBQ McKinney",
    token: process.env.CLIENT_RUDYS_TOKEN || '',
    restaurants: ["Rudy's BBQ McKinney", 'Rudy’s BBQ McKinney']
  },
  'babes-allen': {
    name: "Babe's Chicken — Allen",
    token: process.env.CLIENT_BABES_TOKEN || '',
    restaurants: ["Babe's Chicken Allen", 'Babe’s Chicken Allen', "Babe's Chicken — Allen"]
  },
  // Example extra client:
  'wendys-allen': {
    name: "Wendy's Allen",
    token: process.env.CLIENT_WENDYS_TOKEN || '',
    restaurants: ["Wendy's Allen", 'Wendy’s Allen']
  }
};

// ---- PATHS ----
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');
const OFFERS_FILE = path.join(__dirname, 'offers.json');  // your brand catalog with images
const STORES_FILE = path.join(__dirname, 'stores.json');  // now with lat/lng per store

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ passes: [], redemptions: [] }, null, 2));
  if (!fs.existsSync(EVENTS_FILE)) fs.writeFileSync(EVENTS_FILE, JSON.stringify({ events: [] }, null, 2));
}
ensureDirs();

// ---- helpers ----
async function loadJSON(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch { return fallback; }
}
async function saveJSON(file, obj) {
  await fsp.writeFile(file, JSON.stringify(obj, null, 2));
}
function randToken(len=32) { return crypto.randomBytes(len).toString('hex'); }
function sha12(s) { return crypto.createHash('sha256').update(s).digest('hex').slice(0, 12); }
function nowISO() { return new Date().toISOString(); }
function csvEscape(v) {
  const s = (v ?? '').toString();
  if (/[",\n]/.test(s)) return `"${s.replaceAll('"','""')}"`;
  return s;
}
function baseCss() {
  return `
    :root { font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial; }
    body { margin:0; padding:24px; background:#0b1220; color:#eef2ff; }
    .card { background:#111827; border:1px solid #1f2937; border-radius:16px; padding:20px; max-width:1100px; margin:0 auto; }
    .btn { display:inline-block; padding:10px 14px; border-radius:12px; background:#2563eb; color:#fff; text-decoration:none; }
    a { color:#93c5fd; }
  `;
}
function htmlPage(title, inner) {
  return `<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${title}</title></head><body>${inner}<style>${baseCss()}</style></body></html>`;
}
function requireApiKey(req,res,next){
  const k = req.header('x-api-key') || req.query.key || '';
  if (!API_KEY) return res.status(500).json({error:'Server missing API_KEY'});
  if (k !== API_KEY) return res.status(401).json({error:'Invalid API key'});
  next();
}

// ---- static (root) and legacy /static path ----
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));
app.use('/static', express.static(PUBLIC_DIR));

// ---- health ----
app.get('/health', (_req,res)=>res.json({ok:true,time:nowISO()}));

// ---- LOAD CATALOG (offers + stores) ----
async function loadCatalog() {
  const offers = await loadJSON(OFFERS_FILE, {});
  const stores = await loadJSON(STORES_FILE, {});
  return { offers, stores };
}

// ---- DEVICE ID cookie for wallet sync ----
function ensureDeviceId(req,res,next){
  let did = req.cookies?.did;
  if (!did) {
    did = 'dev_' + randToken(12);
    res.cookie?.('did', did, { httpOnly: false, sameSite: 'Lax', maxAge: 3600*24*365*2*1000 });
  }
  req.deviceId = did;
  next();
}
// lightweight cookie parser (no external dep)
app.use((req, _res, next) => {
  const raw = req.headers.cookie || '';
  req.cookies = raw.split(';').map(s=>s.trim()).filter(Boolean).reduce((acc,p)=>{ const i=p.indexOf('='); if(i>0) acc[p.slice(0,i)]=decodeURIComponent(p.slice(i+1)); return acc; },{});
  next();
});

// ---------- ISSUANCE + VIEW + REDEEM (same as earlier with small tweaks) ----------

app.get('/coupon', async (req, res) => {
  const { offers } = await loadCatalog();
  const offerId = (req.query.offer || '').toString();
  const offer = offers[offerId];
  if (!offer) return res.status(400).send('Invalid offer id');

  const db = await loadJSON(DB_FILE, { passes: [], redemptions: [] });
  const token = randToken(16);
  const pass = {
    id: crypto.randomUUID(),
    token,
    token_hash: sha12(token),
    offer: offerId,
    client_slug: offer.client_slug || 'general',
    restaurant: offer.restaurant || '',
    status: 'issued',
    issued_at: nowISO(),
    redeemed_at: null,
    redeemed_by_store: '',
    redeemed_by_staff: ''
  };
  db.passes.push(pass);
  await saveJSON(DB_FILE, db);

  const couponUrl = `${BASE_URL}/coupon/view?token=${encodeURIComponent(token)}`;
  const qr = await QRCode.toDataURL(couponUrl);

  res.send(htmlPage('Coupon Issued', `
  <section class="card">
    <h1>${offer.title || 'Your Coupon'}</h1>
    <p style="color:#94a3b8">${offer.restaurant || ''}</p>
    ${offer.hero_image ? `<img src="${offer.hero_image}" alt="" style="width:100%;border-radius:12px;margin:8px 0 12px">` : ''}
    <div style="display:grid;grid-template-columns:1fr 220px;gap:16px;align-items:center">
      <div>
        <p><b>Status:</b> ${pass.status}</p>
        <p><b>Token (short):</b> ${pass.token_hash}</p>
        <p><a class="btn" href="${couponUrl}">Open Coupon</a></p>
        <p><a href="/offers.html">Back to Offer Gallery</a></p>
      </div>
      <div><img src="${qr}" alt="QR" style="width:100%;background:#fff;border-radius:8px;padding:8px"></div>
    </div>
  </section>`));
});

app.get('/coupon/view', async (req, res) => {
  const token = (req.query.token || '').toString();
  const db = await loadJSON(DB_FILE, { passes:[] });
  const pass = db.passes.find(p => p.token === token);
  if (!pass) return res.status(404).send('Not found');

  const { offers } = await loadCatalog();
  const offer = offers[pass.offer] || {};
  res.send(htmlPage('Coupon', `
  <section class="card">
    <h1>${offer.title || 'Coupon'}</h1>
    <p style="color:#94a3b8">${offer.restaurant || ''}</p>
    ${offer.hero_image ? `<img src="${offer.hero_image}" alt="" style="width:100%;border-radius:12px;margin:8px 0 12px">` : ''}
    <p>Status: <b>${pass.status.toUpperCase()}</b>${pass.status==='redeemed'?' ✅':''}</p>
    <p>Token (short): <code>${pass.token_hash}</code></p>
    <p><a class="btn" href="/redeem.html?token=${encodeURIComponent(token)}">Show Cashier</a></p>
  </section>`));
});

// simple redeem API (admin key)
app.post('/api/redeem', async (req, res) => {
  if ((req.header('x-api-key') || '') !== API_KEY) return res.status(401).json({ error: 'Invalid API key' });
  const { token, store_id, staff } = req.body || {};
  if (!token || !store_id) return res.status(400).json({ error: 'Missing token/store_id' });

  const db = await loadJSON(DB_FILE, { passes:[], redemptions:[] });
  const pass = db.passes.find(p => p.token === token);
  if (!pass) return res.status(404).json({ error: 'Token not found' });
  if (pass.status === 'redeemed') return res.status(409).json({ error: 'Already redeemed', redeemed_at: pass.redeemed_at });

  pass.status = 'redeemed';
  pass.redeemed_at = nowISO();
  pass.redeemed_by_store = store_id;
  pass.redeemed_by_staff = staff || '';
  db.redemptions.push({ token, offer: pass.offer, client_slug: pass.client_slug, store_id, staff: pass.redeemed_by_staff, redeemed_at: pass.redeemed_at });
  await saveJSON(DB_FILE, db);

  res.json({ ok: true, token_hash: pass.token_hash, redeemed_at: pass.redeemed_at });
});

// ---------- ADMIN: Hub + CSV (unchanged semantics) ----------
app.get('/hub', requireApiKey, async (req,res)=>{
  const db = await loadJSON(DB_FILE, {passes:[]});
  const rows = db.passes.slice().reverse().map(p => `
    <tr><td><code>${p.token_hash}</code></td><td>${p.offer}</td><td>${p.restaurant}</td>
    <td>${p.client_slug}</td><td>${p.status}</td><td>${p.issued_at}</td><td>${p.redeemed_at||''}</td></tr>`).join('');
  res.send(htmlPage('Admin Hub', `
  <section class="card">
    <h1>Admin Hub</h1>
    <p><a class="btn" href="/hub/dashboard?key=${encodeURIComponent(req.query.key||'')}">Analytics</a></p>
    <div style="overflow:auto"><table style="width:100%;border-collapse:collapse">
      <thead><tr><th>Token</th><th>Offer</th><th>Restaurant</th><th>Client</th><th>Status</th><th>Issued</th><th>Redeemed</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7">No passes</td></tr>'}</tbody>
    </table></div>
  </section>`));
});

app.get('/hub/dashboard', requireApiKey, async (req, res) => {
  const db = await loadJSON(DB_FILE, { passes: [] });
  const issued = db.passes.length;
  const redeemed = db.passes.filter(p => p.status==='redeemed').length;
  const rate = issued ? Math.round(redeemed/issued*1000)/10 : 0;
  res.send(htmlPage('Analytics', `
  <section class="card">
    <h1>Analytics Admin</h1>
    <div style="display:flex;gap:18px;margin:10px 0">
      <div><b>Issued:</b> ${issued}</div>
      <div><b>Redeemed:</b> ${redeemed}</div>
      <div><b>Rate:</b> ${rate}%</div>
      <a class="btn" href="/hub/dashboard/report-analytics.csv?key=${encodeURIComponent(req.query.key||'')}">Download CSV</a>
    </div>
    <p><a href="/events.csv?key=${encodeURIComponent(req.query.key||'')}">Download Event Log (CSV)</a></p>
  </section>`));
});

app.get('/hub/dashboard/report-analytics.csv', requireApiKey, async (req,res)=>{
  const db = await loadJSON(DB_FILE, {passes:[]});
  const headers = ['id','offer','restaurant','client_slug','status','issued_at','redeemed_at','redeemed_by_store','redeemed_by_staff','token_hash'];
  const lines = [headers.join(',')].concat(db.passes.map(p => headers.map(h => csvEscape(p[h]||'')).join(',')));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="redeem_report.csv"');
  res.send(lines.join('\n'));
});

// ---------- OFFER GALLERY + WALLET APIs ----------

// Offers API (gallery loads this)
app.get('/api/offers', async (_req,res)=>{
  const { offers } = await loadCatalog();
  // normalize into array
  const rows = Object.entries(offers).map(([id,o]) => ({
    id,
    title: o.title || id,
    restaurant: o.restaurant || '',
    hero_image: o.hero_image || o.logo || '',
    brand_color: o.brand_color || '#111827',
    accent_color: o.accent_color || '#2563eb',
    client_slug: o.client_slug || 'general'
  }));
  res.json({ offers: rows });
});

// Save to wallet (server-sync; also stored client-side via localStorage)
app.post('/api/save', ensureDeviceId, async (req,res)=>{
  const { offer_id } = req.body || {};
  if (!offer_id) return res.status(400).json({ error:'offer_id required' });
  const evlog = await loadJSON(EVENTS_FILE, { events:[] });
  evlog.events.push({ t: nowISO(), type:'save', offer_id, device: req.deviceId, ua: req.headers['user-agent']||'', ip: req.headers['x-forwarded-for']||req.socket.remoteAddress||'' });
  await saveJSON(EVENTS_FILE, evlog);
  res.json({ ok:true, device: req.deviceId });
});

// Generic event logger (views, clicks, tents, geo)
app.post('/api/event', async (req,res)=>{
  const { type, offer_id, restaurant, client_slug, meta } = req.body || {};
  const evlog = await loadJSON(EVENTS_FILE, { events:[] });
  evlog.events.push({
    t: nowISO(),
    type: type || 'unknown',
    offer_id: offer_id || '',
    restaurant: restaurant || '',
    client_slug: client_slug || '',
    meta: meta || {},
    ua: req.headers['user-agent']||'',
    ip: req.headers['x-forwarded-for']||req.socket.remoteAddress||''
  });
  await saveJSON(EVENTS_FILE, evlog);
  res.json({ ok:true });
});

// Event CSV for analysis
app.get('/events.csv', requireApiKey, async (_req,res)=>{
  const ev = await loadJSON(EVENTS_FILE, {events:[]});
  const headers = ['t','type','offer_id','restaurant','client_slug','meta','ua','ip'];
  const lines = [headers.join(',')].concat(ev.events.map(e => [
    e.t, e.type, e.offer_id||'', e.restaurant||'', e.client_slug||'', JSON.stringify(e.meta||{}), (e.ua||'').slice(0,80), (e.ip||'')
  ].map(csvEscape).join(',')));
  res.setHeader('Content-Type','text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="events.csv"');
  res.send(lines.join('\n'));
});

// Table-tent short links -> redirect to gallery filtered and attributed
// Example: /r/popeyes-mckinney   (adds ?src=table_tent&rest=Popeyes%20McKinney)
app.get('/r/:slug', async (req,res)=>{
  const slug = (req.params.slug||'').toLowerCase();
  const cfg = CLIENTS[slug];
  const restaurant = cfg?.restaurants?.[0] || '';
  // log view
  const evlog = await loadJSON(EVENTS_FILE, { events:[] });
  evlog.events.push({ t: nowISO(), type:'tent_click', client_slug: slug, restaurant, meta:{ slug } });
  await saveJSON(EVENTS_FILE, evlog);

  const qs = new URLSearchParams({ src:'table_tent', rest: restaurant });
  res.redirect(`/offers.html?${qs.toString()}`);
});

// ---- Home → Offer Gallery ----
app.get('/', (_req,res)=> res.redirect('/offers.html'));

// --- API: list stores for the cashier dropdown ---
const fs = require('fs');
const path = require('path');

app.get('/api/stores', (req, res) => {
  try {
    const STORES_FILE = path.join(__dirname, 'stores.json');
    const raw = fs.readFileSync(STORES_FILE, 'utf8');
    const obj = JSON.parse(raw); // { "TB-001": {brand:"Taco Bell", ...}, "POPE-001":"Popeyes", ... }

    const list = Object.entries(obj).map(([code, meta]) => {
      if (typeof meta === 'string') {
        return { code, brand: meta, label: meta };
      }
      return { code, brand: meta.brand || '', label: meta.brand || code };
    }).sort((a,b) => a.code.localeCompare(b.code));

    res.json({ stores: list });
  } catch (e) {
    console.error('stores api error:', e.message);
    res.status(500).json({ stores: [] });
  }
});

// ---- Start ----
app.listen(PORT, () => {
  console.log(`ACP Coupons listening on :${PORT}`);
});

function listEndpoints(app) {
  const routes = [];
  app._router.stack.forEach(layer => {
    if (layer.route && layer.route.path) {
      const methods = Object.keys(layer.route.methods)
        .map(m => m.toUpperCase()).join(',');
      routes.push(`${methods} ${layer.route.path}`);
    } else if (layer.name === 'router' && layer.handle && layer.handle.stack) {
      layer.handle.stack.forEach(r => {
        if (r.route && r.route.path) {
          const methods = Object.keys(r.route.methods)
            .map(m => m.toUpperCase()).join(',');
          routes.push(`${methods} ${r.route.path}`);
        }
      });
    }
  });
  console.log('\n--- Registered Routes ---\n' + routes.sort().join('\n') + '\n-------------------------\n');
}

app.listen(PORT, () => {
  console.log(`Coupon server running on ${PORT}`);
  listEndpoints(app);  // <— add this line
});
