// index.js — ACP Coupons (Node 20.x)
// Light marketplace UI + Wallet + Geo alerts + Analytics + CSV/PDF + SW cache control

const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const QRCode = require('qrcode');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ---------- CORS ----------
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, x-api-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------- ENV ----------
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';
const RAW_BASE = (process.env.COUPON_BASE_URL || process.env.BASE_URL || '').replace(/\/$/, '');
const BASE_URL = RAW_BASE || ''; // falls back to relative links

// ---------- PATHS ----------
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');
const DB_FILE = path.join(DATA_DIR, 'db.json');          // { passes:[], redemptions:[] }
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');  // { events:[] }
const OFFERS_FILE = path.join(ROOT, 'offers.json');      // offer catalog (root)
const STORES_FILE = path.join(ROOT, 'stores.json');      // optional store list

// Ensure dirs/files
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ passes:[], redemptions:[] }, null, 2));
if (!fs.existsSync(EVENTS_FILE)) fs.writeFileSync(EVENTS_FILE, JSON.stringify({ events:[] }, null, 2));

// ---------- Helpers ----------
const nowISO   = () => new Date().toISOString();
const randHex  = (n=16) => crypto.randomBytes(n).toString('hex');
const sha12    = s => crypto.createHash('sha256').update(s).digest('hex').slice(0,12);
const jread    = async (f, fb) => { try { return JSON.parse(await fsp.readFile(f, 'utf8')); } catch { return fb; } };
const jwrite   = (f, o) => fsp.writeFile(f, JSON.stringify(o, null, 2));
const csvEsc   = v => {
  const s = (v ?? '').toString();
  return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s;
};
function sendCsv(res, filename, csvString) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.status(200).send('\uFEFF' + csvString);
}

// ---------- Static with proper cache headers ----------
app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache'); res.setHeader('Expires', '0');
    } else if (/\.(css|js|mjs|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));
app.use('/static', express.static(PUBLIC_DIR));

// Serve SW with no-cache and correct MIME so it updates immediately
app.get('/service-worker.js', (req, res) => {
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.type('application/javascript; charset=utf-8');
  res.sendFile(path.join(PUBLIC_DIR, 'service-worker.js'));
});

// Health
app.get('/health', (_req, res) => res.json({ ok:true, time:nowISO() }));

// Explicit MIME-correct catalog/PWA routes
app.get('/offers.json', (_req, res) => {
  res.type('application/json; charset=utf-8');
  res.sendFile(OFFERS_FILE);
});
app.get('/manifest.json', (_req, res) => {
  res.type('application/manifest+json; charset=utf-8');
  res.sendFile(path.join(PUBLIC_DIR, 'manifest.json'));
});
app.get('/redeem.html', (_req, res) => {
  res.type('text/html; charset=utf-8');
  res.sendFile(path.join(PUBLIC_DIR, 'redeem.html'));
});

// Load catalogs
async function loadCatalog() {
  const offers = await jread(OFFERS_FILE, {});
  const stores = await jread(STORES_FILE, {});
  return { offers, stores };
}

// ---------- Coupon Issuance / View ----------
app.get('/coupon', async (req, res) => {
  const { offers } = await loadCatalog();
  const id = (req.query.offer || '').toString();
  const offer = offers[id];
  if (!offer) return res.status(400).send('Invalid offer id');

  const db = await jread(DB_FILE, { passes:[], redemptions:[] });
  const token = randHex(16);
  const pass = {
    id: crypto.randomUUID(),
    token,
    token_hash: sha12(token),
    offer: id,
    client_slug: offer.client_slug || 'general',
    restaurant: offer.restaurant || '',
    status: 'issued',
    issued_at: nowISO(),
    redeemed_at: null,
    redeemed_by_store: '',
    redeemed_by_staff: ''
  };
  db.passes.push(pass);
  await jwrite(DB_FILE, db);

  const origin = BASE_URL || `${req.protocol}://${req.get('host')}`;
  const url = `${origin}/coupon/view?token=${encodeURIComponent(token)}`;
  const qr = await QRCode.toDataURL(url);

  res.send(`<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Coupon Issued</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css">
<style>body{padding:18px;max-width:900px;margin:auto}</style>
</head><body>
<h2>${offer.title || 'Your Coupon'}</h2>
<p>${offer.restaurant || ''}</p>
${offer.hero_image ? `<img src="${offer.hero_image}" style="max-width:100%;border-radius:12px">` : ''}
<article style="display:grid;grid-template-columns:1fr 260px;gap:16px;align-items:center">
  <div>
    <p><b>Status:</b> ${pass.status}</p>
    <p><b>Token (short):</b> <code>${pass.token_hash}</code></p>
    <a class="contrast" href="${url}">Open Coupon</a>
    <a href="/offers.html">Back to Offers</a>
  </div>
  <div><img src="${qr}" style="width:100%;background:#fff;border-radius:8px;padding:8px" alt="QR"></div>
</article>
</body></html>`);
});

app.get('/coupon/view', async (req, res) => {
  const token = (req.query.token || '').toString();
  const db = await jread(DB_FILE, { passes:[] });
  const pass = db.passes.find(p => p.token === token);
  if (!pass) return res.status(404).send('Not found');

  const { offers } = await loadCatalog();
  const offer = offers[pass.offer] || {};
  res.send(`<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${offer.title || 'Coupon'}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css">
<style>body{padding:18px;max-width:900px;margin:auto}</style>
</head><body>
<h2>${offer.title || 'Coupon'}</h2>
<p>${offer.restaurant || ''}</p>
${offer.hero_image ? `<img src="${offer.hero_image}" style="max-width:100%;border-radius:12px">` : ''}
<p>Status: <b>${pass.status.toUpperCase()}</b>${pass.status==='redeemed'?' ✅':''}</p>
<p>Token (short): <code>${pass.token_hash}</code></p>
<a class="contrast" href="/redeem.html?token=${encodeURIComponent(token)}">Show Cashier</a>
</body></html>`);
});

// ---------- Cashier redeem API ----------
app.post('/api/redeem', async (req, res) => {
  if ((req.header('x-api-key') || '') !== API_KEY) return res.status(401).json({ error: 'Invalid API key' });
  const { token, store_id, staff } = req.body || {};
  if (!token || !store_id) return res.status(400).json({ error:'Missing token/store_id' });

  const db = await jread(DB_FILE, { passes:[], redemptions:[] });
  const pass = db.passes.find(p => p.token === token);
  if (!pass) return res.status(404).json({ error:'Token not found' });
  if (pass.status === 'redeemed') return res.status(409).json({ error:'Already redeemed', redeemed_at: pass.redeemed_at });

  pass.status = 'redeemed';
  pass.redeemed_at = nowISO();
  pass.redeemed_by_store = store_id;
  pass.redeemed_by_staff = staff || '';
  db.redemptions.push({
    token, offer: pass.offer, client_slug: pass.client_slug, store_id,
    staff: pass.redeemed_by_staff, redeemed_at: pass.redeemed_at
  });
  await jwrite(DB_FILE, db);

  res.json({ ok:true, token_hash: pass.token_hash, redeemed_at: pass.redeemed_at });
});

// ---------- Public Offers API ----------
app.get('/api/offers', async (_req, res) => {
  const { offers } = await loadCatalog();
  const rows = Object.entries(offers).map(([id, o]) => ({
    id,
    title: o.title || id,
    restaurant: o.restaurant || '',
    description: o.description || '',
    category: o.category || '',
    hero_image: o.hero_image || o.logo || '',
    brand_color: o.brand_color || '#111827',
    accent_color: o.accent_color || '#2563eb',
    expires_days: o.expires_days || 90,
    client_slug: o.client_slug || 'general'
  }));
  res.json({ offers: rows });
});

// ---------- Events ----------
app.post('/api/save', async (req, res) => {
  const { offer_id } = req.body || {};
  const ev = await jread(EVENTS_FILE, { events:[] });
  ev.events.push({ t: nowISO(), type:'save', offer_id, meta:{} });
  await jwrite(EVENTS_FILE, ev);
  res.json({ ok:true });
});

app.post('/api/event', async (req, res) => {
  const { type, offer_id, restaurant, client_slug, meta } = req.body || {};
  const ev = await jread(EVENTS_FILE, { events:[] });
  ev.events.push({ t: nowISO(), type:type||'unknown', offer_id:offer_id||'', restaurant:restaurant||'', client_slug:client_slug||'', meta:meta||{} });
  await jwrite(EVENTS_FILE, ev);
  res.json({ ok:true });
});

// ---------- Stores / Nearby ----------
app.get('/api/stores', async (_req, res) => {
  try {
    const obj = await jread(STORES_FILE, {});
    const list = Object.entries(obj).map(([code, meta]) => {
      if (typeof meta === 'string') return { code, brand: meta, label: meta };
      return { code, brand: meta.brand || '', label: meta.brand || code, lat: meta.lat || null, lng: meta.lng || null };
    }).sort((a,b) => a.code.localeCompare(b.code));
    res.json({ stores: list });
  } catch {
    res.status(500).json({ stores: [] });
  }
});

app.get('/api/nearby', async (req, res) => {
  const { lat, lng, radiusKm = '2' } = req.query;
  const R = Number(radiusKm) || 2;
  const me = { lat: Number(lat), lng: Number(lng) };
  if (!isFinite(me.lat) || !isFinite(me.lng)) return res.json({ stores: [] });

  const { stores } = await loadCatalog();
  const list = Object.entries(stores).map(([code, meta]) => {
    const s = (typeof meta === 'string') ? { brand: meta } : meta;
    const d = (isFinite(s.lat) && isFinite(s.lng)) ? haversine(me.lat, me.lng, s.lat, s.lng) : Infinity;
    return { code, brand: s.brand || '', distanceKm: d };
  }).filter(s => s.distanceKm <= R).sort((a,b)=>a.distanceKm-b.distanceKm);

  res.json({ stores: list });
});
function haversine(lat1, lon1, lat2, lon2){
  const toRad = v => v * Math.PI / 180, R = 6371;
  const dLat = toRad(lat2-lat1), dLon = toRad(lon2-lon1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(a));
}

// ---------- Admin (Hub, CSV, PDF) ----------
function requireKey(req, res, next){
  const k = req.header('x-api-key') || req.query.key || '';
  if (!API_KEY) return res.status(500).send('Server missing API_KEY');
  if (k !== API_KEY) return res.status(401).send('Invalid API key');
  next();
}

app.get('/hub', requireKey, async (req, res) => {
  const db = await jread(DB_FILE, { passes:[] });
  const rows = db.passes.slice().reverse().map(p => `
    <tr><td><code>${p.token_hash}</code></td><td>${p.offer}</td><td>${p.restaurant}</td>
    <td>${p.client_slug}</td><td>${p.status}</td><td>${p.issued_at}</td><td>${p.redeemed_at||''}</td></tr>`).join('');
  res.send(`<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Admin Hub</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css">
<style>body{padding:18px;max-width:1100px;margin:auto} table{font-size:13px}</style>
</head><body>
<h2>Admin Hub</h2>
<p>
  <a href="/hub/dashboard?key=${encodeURIComponent(req.query.key||'')}">Analytics</a> ·
  <a href="/hub/dashboard/report-analytics.csv?key=${encodeURIComponent(req.query.key||'')}">Download CSV</a> ·
  <a href="/hub/dashboard.pdf?key=${encodeURIComponent(req.query.key||'')}">Download PDF</a>
</p>
<div style="overflow:auto">
<table>
  <thead><tr><th>Token</th><th>Offer</th><th>Restaurant</th><th>Client</th><th>Status</th><th>Issued</th><th>Redeemed</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="7">No passes</td></tr>'}</tbody>
</table>
</div>
</body></html>`);
});

app.get('/hub/dashboard', requireKey, async (req, res) => {
  const db = await jread(DB_FILE, { passes:[] });
  const all = db.passes;

  const from = req.query.from ? new Date(req.query.from) : null;
  const to   = req.query.to   ? new Date(req.query.to)   : null;
  const brand = (req.query.brand || '').toLowerCase();
  const status = (req.query.status || '').toLowerCase();

  const filtered = all.filter(p => {
    const t = new Date(p.issued_at);
    if (from && t < from) return false;
    if (to && t > to) return false;
    if (brand && (p.restaurant||'').toLowerCase() !== brand) return false;
    if (status && (p.status||'').toLowerCase() !== status) return false;
    return true;
  });

  const issued = filtered.length;
  const redeemed = filtered.filter(p => p.status === 'redeemed').length;
  const rate = issued ? Math.round(redeemed/issued*1000)/10 : 0;

  const byBrand = {};
  filtered.forEach(p => { byBrand[p.restaurant] = (byBrand[p.restaurant]||0) + 1; });
  const pieLabels = Object.keys(byBrand);
  const pieData = pieLabels.map(k => byBrand[k]);

  const byDay = {};
  filtered.forEach(p => {
    const day = (p.redeemed_at || p.issued_at || '').slice(0,10);
    if (!day) return;
    byDay[day] = (byDay[day]||0) + (p.status==='redeemed'?1:0);
  });
  const lineLabels = Object.keys(byDay).sort();
  const lineData = lineLabels.map(k => byDay[k]);

  const hm = Array.from({length:7}, ()=>Array(24).fill(0));
  filtered.forEach(p => {
    if (p.status !== 'redeemed' || !p.redeemed_at) return;
    const d = new Date(p.redeemed_at);
    hm[d.getDay()][d.getHours()]++;
  });

  res.send(`<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Analytics Dashboard</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css">
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>
  body{padding:18px;max-width:1200px;margin:auto}
  .grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}
  .badge{display:inline-block;padding:.25rem .5rem;border-radius:.5rem;background:#0ea5e9;color:#fff;font-size:.8rem}
  .heat{border-collapse:collapse}
  .heat td{width:22px;height:20px;text-align:center;font-size:10px;color:#fff}
  .legend{font-size:12px;color:#64748b}
</style>
</head><body>
<h2>Analytics</h2>
<p>
  <span class="badge">Issued: ${issued}</span>
  <span class="badge">Redeemed: ${redeemed}</span>
  <span class="badge">Rate: ${rate}%</span>
  &nbsp; <a href="/hub/dashboard/report-analytics.csv?key=${encodeURIComponent(req.query.key||'')}">CSV</a> ·
  <a href="/hub/dashboard.pdf?key=${encodeURIComponent(req.query.key||'')}">PDF</a>
</p>

<article class="grid">
  <div>
    <h4>Daily redemptions</h4>
    <canvas id="line"></canvas>
  </div>
  <div>
    <h4>Offer distribution (pie)</h4>
    <canvas id="pie"></canvas>
  </div>
</article>

<article style="margin-top:16px">
  <h4>Heatmap — best day/time windows</h4>
  <div class="legend">Rows = Sunday→Saturday, Cols = 0→23h. Darker = more redemptions.</div>
  <div id="heat"></div>
</article>

<script>
const lineLabels = ${JSON.stringify(lineLabels)};
const lineData   = ${JSON.stringify(lineData)};
const pieLabels  = ${JSON.stringify(pieLabels)};
const pieData    = ${JSON.stringify(pieData)};
const heat       = ${JSON.stringify(hm)}; // [7][24]

new Chart(document.getElementById('line'), {
  type:'line',
  data:{ labels: lineLabels, datasets:[{ data: lineData, label:'Redemptions', tension:.3 }] },
  options:{ responsive:true, scales:{ y:{ beginAtZero:true } } }
});

new Chart(document.getElementById('pie'), {
  type:'pie',
  data:{ labels: pieLabels, datasets:[{ data: pieData }] },
  options:{ responsive:true }
});

(function renderHeat() {
  const host = document.getElementById('heat');
  const max = Math.max(1, ...heat.flat());
  const tbl = document.createElement('table'); tbl.className='heat';
  for(let r=0;r<7;r++){
    const tr = document.createElement('tr');
    for(let c=0;c<24;c++){
      const v = heat[r][c];
      const cell = document.createElement('td');
      const k = v/max;
      cell.style.background = \`hsl(24, 95%, \${Math.round(48 - 28*k)}%)\`;
      cell.title = \`\${v} at \${c}:00\`;
      tr.appendChild(cell);
    }
    tbl.appendChild(tr);
  }
  host.appendChild(tbl);
})();
</script>
</body></html>`);
});

// ---------- CSV ----------
app.get('/hub/dashboard/report-analytics.csv', requireKey, async (_req, res) => {
  const db = await jread(DB_FILE, { passes:[] });
  const headers = ['id','offer','restaurant','client_slug','status','issued_at','redeemed_at','redeemed_by_store','redeemed_by_staff','token_hash'];
  const csv = [headers.join(',')]
    .concat(db.passes.map(p => headers.map(h => csvEsc(p[h]||'')).join(',')))
    .join('\n') + '\n';
  return sendCsv(res, 'redeem_report.csv', csv);
});

app.get('/events.csv', requireKey, async (_req, res) => {
  const ev = await jread(EVENTS_FILE, { events:[] });
  const headers = ['t','type','offer_id','restaurant','client_slug','meta','ua','ip'];
  const csv = [headers.join(',')].concat(
    ev.events.map(e => [
      e.t,
      e.type,
      e.offer_id || '',
      e.restaurant || '',
      e.client_slug || '',
      JSON.stringify(e.meta || {}),
      '', '', // ua / ip omitted
    ].map(csvEsc).join(','))
  ).join('\n') + '\n';
  return sendCsv(res, 'events.csv', csv);
});

// ---------- PDF ----------
app.get('/hub/dashboard.pdf', requireKey, async (req, res) => {
  const origin = BASE_URL || `${req.protocol}://${req.get('host')}`;
  const url = `${origin}/hub/dashboard?key=${encodeURIComponent(req.query.key||'')}`;
  const browser = await puppeteer.launch({ args: ['--no-sandbox','--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 120000 });
    const pdf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top:'0.5in', right:'0.5in', bottom:'0.5in', left:'0.5in' }
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="analytics.pdf"');
    res.send(pdf);
  } finally { await browser.close(); }
});

// ---------- Home ----------
app.get('/', (_req,res)=> res.redirect('/offers.html'));

// ---------- Public aggregate stats (issued & redeemed) ----------
app.get('/api/offer-stats', async (_req, res) => {
  const db = await jread(DB_FILE, { passes:[], redemptions:[] });
  const stats = {};
  for (const p of db.passes) {
    const id = p.offer || 'unknown';
    if (!stats[id]) stats[id] = { issued: 0, redeemed: 0 };
    stats[id].issued++;
    if (p.status === 'redeemed') stats[id].redeemed++;
  }
  res.json({ stats });
});

// === Printable coupon support ===============================

// Full metadata for printing
app.get('/api/offer/:id', async (req, res) => {
  const { offers } = await loadCatalog();
  const id = req.params.id;
  const o = offers[id];
  if (!o) return res.status(404).json({ error: 'Offer not found' });
  res.json({ id, ...o });
});

// High-res QR that issues a fresh one-time pass
// === Print-friendly coupons + attribution ===============================

// Full offer for print pages (already added earlier, keep if present)
app.get('/api/offer/:id', async (req, res) => {
  const { offers } = await loadCatalog();
  const id = req.params.id;
  const o = offers[id];
  if (!o) return res.status(404).json({ error: 'Offer not found' });
  res.json({ id, ...o });
});

// High-res QR that issues a fresh token; supports source attribution
// Usage: /qr?offer=ID&src=print4|print1|flyer|<custom>
app.get('/qr', async (req, res) => {
  const id = (req.query.offer || '').toString();
  const src = (req.query.src || '').toString(); // attribution
  if (!id) return res.status(400).send('Missing offer');

  const origin = BASE_URL || `${req.protocol}://${req.get('host')}`;
  const issueURL = new URL(`${origin}/coupon`);
  issueURL.searchParams.set('offer', id);
  if (src) issueURL.searchParams.set('src', src);

  try {
    const png = await QRCode.toBuffer(issueURL.toString(), { width: 560, margin: 1 });
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store');
    res.send(png);
  } catch (e) {
    res.status(500).send('QR error');
  }
});

// Server-side PDF for single or 4-up (client-branded via your offer theme)
// /coupon-print.pdf?offer=ID          => single
// /coupon-print.pdf?offer=ID&per=4    => 4-up sheet
// Optional: &src=print1|print4 (default auto-set by page)
app.get('/coupon-print.pdf', async (req, res) => {
  const offer = (req.query.offer || '').toString();
  const per = (req.query.per || '').toString();
  const src = (req.query.src || '').toString();

  if (!offer) return res.status(400).send('Missing offer');

  const origin = BASE_URL || `${req.protocol}://${req.get('host')}`;
  const pagePath = per === '4' ? '/coupon-print-multi.html' : '/coupon-print.html';
  const url = new URL(`${origin}${pagePath}`);
  url.searchParams.set('offer', offer);
  if (per === '4') url.searchParams.set('per', '4');
  if (src) url.searchParams.set('src', src);

  const browser = await puppeteer.launch({ args: ['--no-sandbox','--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(url.toString(), { waitUntil: 'networkidle0', timeout: 120000 });
    const pdf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top:'0.5in', right:'0.5in', bottom:'0.5in', left:'0.5in' }
    });
    res.setHeader('Content-Type', 'application/pdf');
    const name = per === '4' ? `${offer}-4up.pdf` : `${offer}.pdf`;
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(pdf);
  } finally {
    await browser.close();
  }
});

// === Track attribution on issuance & expose per-source stats ============

// NOTE: this replaces your existing /coupon handler (logic identical + source)
app.get('/coupon', async (req, res) => {
  const { offers } = await loadCatalog();
  const id = (req.query.offer || '').toString();
  const offer = offers[id];
  if (!offer) return res.status(400).send('Invalid offer id');

  const src = (req.query.src || 'direct').toString(); // attribution

  const db = await jread(DB_FILE, { passes:[], redemptions:[] });
  const token = randHex(16);
  const pass = {
    id: crypto.randomUUID(),
    token,
    token_hash: sha12(token),
    offer: id,
    client_slug: offer.client_slug || 'general',
    restaurant: offer.restaurant || '',
    status: 'issued',
    issued_at: nowISO(),
    redeemed_at: null,
    redeemed_by_store: '',
    redeemed_by_staff: '',
    source: src
  };
  db.passes.push(pass);
  await jwrite(DB_FILE, db);

  const origin = BASE_URL || `${req.protocol}://${req.get('host')}`;
  const url = `${origin}/coupon/view?token=${encodeURIComponent(token)}`;
  const qr = await QRCode.toDataURL(url);

  res.send(`<!doctype html><html><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Coupon Issued</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css">
<style>body{padding:18px;max-width:900px;margin:auto}</style>
</head><body>
<h2>${offer.title || 'Your Coupon'}</h2>
<p>${offer.restaurant || ''}</p>
${offer.hero_image ? `<img src="${offer.hero_image}" style="max-width:100%;border-radius:12px">` : ''}
<article style="display:grid;grid-template-columns:1fr 260px;gap:16px;align-items:center">
  <div>
    <p><b>Status:</b> ${pass.status}</p>
    <p><b>Token (short):</b> <code>${pass.token_hash}</code></p>
    <p><b>Source:</b> <code>${pass.source}</code></p>
    <a class="contrast" href="${url}">Open Coupon</a>
    <a href="/offers.html">Back to Offers</a>
  </div>
  <div><img src="${qr}" style="width:100%;background:#fff;border-radius:8px;padding:8px" alt="QR"></div>
</article>
</body></html>`);
});

// Extend public stats to include per-source breakdown (keeps old shape)
app.get('/api/offer-stats', async (_req, res) => {
  const db = await jread(DB_FILE, { passes:[], redemptions:[] });
  const stats = {};           // existing: { [offer]: {issued, redeemed} }
  const sources = {};         // new:     { [offer]: { bySource: {src: {issued, redeemed}} } }

  for (const p of db.passes) {
    const id = p.offer || 'unknown';
    const src = p.source || 'direct';
    if (!stats[id]) stats[id] = { issued: 0, redeemed: 0 };
    stats[id].issued++;
    if (p.status === 'redeemed') stats[id].redeemed++;

    if (!sources[id]) sources[id] = { bySource: {} };
    if (!sources[id].bySource[src]) sources[id].bySource[src] = { issued: 0, redeemed: 0 };
    sources[id].bySource[src].issued++;
    if (p.status === 'redeemed') sources[id].bySource[src].redeemed++;
  }

  res.json({ stats, sources });
});


// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`ACP Coupons listening on :${PORT}`);
});
