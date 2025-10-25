// index.js
// One-time coupon server with multi-client dashboards (Node 18+ / Render)
// Env: PORT, API_KEY, BASE_URL (or COUPON_BASE_URL)
// Client tokens: CLIENT_POPEYES_TOKEN, CLIENT_SONIC_TOKEN, CLIENT_BRAUMS_TOKEN, CLIENT_RUDYS_TOKEN, CLIENT_BABES_TOKEN
// Optional email (used by scripts/send-monthly-report.js): REPORT_<SLUG>_TO (see .env example)
// Persists: ./data/passes.json

const express = require('express');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ---------- CORS ----------
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, x-api-key, x-client-token'
  );
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ---------- ENV ----------
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';
const BASE_URL = (process.env.COUPON_BASE_URL || process.env.BASE_URL || '').replace(/\/$/, '');

// ---------- CLIENT REGISTRY (edit names or add more as needed) ----------
const CLIENTS = {
  'popeyes-mckinney': {
    name: 'Popeyes McKinney',
    token: process.env.CLIENT_POPEYES_TOKEN || '',
    restaurants: ['Popeyes McKinney'],
  },
  'sonic-frisco': {
    name: 'Sonic Frisco',
    token: process.env.CLIENT_SONIC_TOKEN || '',
    restaurants: ['Sonic Frisco'],
  },
  'braums-stacy': {
    name: "Braum's Stacy Rd",
    token: process.env.CLIENT_BRAUMS_TOKEN || '',
    restaurants: ["Braum's Stacy Rd", "Braum’s Stacy Rd"],
  },
  'rudys-mckinney': {
    name: "Rudy's BBQ McKinney",
    token: process.env.CLIENT_RUDYS_TOKEN || '',
    restaurants: ["Rudy's BBQ McKinney", 'Rudy’s BBQ McKinney'],
  },
  'babes-allen': {
    name: "Babe's Chicken — Allen",
    token: process.env.CLIENT_BABES_TOKEN || '',
    restaurants: ["Babe's Chicken Allen", 'Babe’s Chicken Allen', "Babe's Chicken — Allen"],
  },
};

// ---------- PATHS ----------
const DATA_DIR = path.join(__dirname, 'data');
const PUBLIC_DIR = path.join(__dirname, 'public');
const DB_FILE = path.join(DATA_DIR, 'passes.json');

// ---------- Ensure data / public ----------
function ensureDataStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
  const clientDir = path.join(PUBLIC_DIR, 'client');
  if (!fs.existsSync(clientDir)) fs.mkdirSync(clientDir, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ passes: [], redemptions: [] }, null, 2));
  }
}
ensureDataStore();

async function loadDB() {
  const raw = await fsp.readFile(DB_FILE, 'utf8');
  return JSON.parse(raw || '{"passes":[],"redemptions":[]}');
}
async function saveDB(db) {
  await fsp.writeFile(DB_FILE, JSON.stringify(db, null, 2));
}

// ---------- Helpers ----------
function requireApiKey(req, res, next) {
  const k = req.header('x-api-key') || req.query.key || '';
  if (!API_KEY) return res.status(500).json({ error: 'Server API_KEY not set' });
  if (k !== API_KEY) return res.status(401).json({ error: 'Invalid API key' });
  next();
}
function nowISO() { return new Date().toISOString(); }
function randToken() { return crypto.randomBytes(16).toString('hex'); }
function escapeHTML(s = '') {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}
function csvEscape(v) {
  const s = (v ?? '').toString();
  if (/[",\n]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}
function baseCss() {
  return `
    :root { font-family: Inter, system-ui, -apple-system, Segoe UI, Roboto, Arial; }
    body { margin: 0; padding: 24px; background: #0b1220; color: #eef2ff; }
    a { color: #93c5fd; }
    .card { background: #111827; border: 1px solid #1f2937; border-radius: 16px; padding: 20px; max-width: 1100px; margin: 0 auto; }
    h1 { margin: 0 0 12px; font-size: 24px; }
    h2 { margin: 12px 0 8px; font-size: 18px; }
    .grid { display: grid; grid-template-columns: 1fr 280px; gap: 16px; align-items: center; }
    .offer { font-size: 20px; font-weight: 600; }
    .qr img { width: 100%; height: auto; background: #fff; padding: 8px; border-radius: 8px; }
    .btn { display:inline-block; padding: 10px 14px; border-radius: 10px; background:#2563eb; color:white; text-decoration:none; }
    .btn + .btn, .cta button { margin-left: 8px; }
    .cta button { padding: 10px 14px; border-radius: 10px; border: 1px solid #334155; background:#0f172a; color:#e2e8f0; cursor:pointer; }
    .tip { font-size: 12px; color:#94a3b8; margin-top:8px; }
    .muted { color:#94a3b8; font-size: 12px; }
    .toolbar { display:flex; flex-wrap: wrap; gap:10px; margin-bottom: 12px; }
    .table-wrap { overflow:auto; border: 1px solid #1f2937; border-radius: 12px; }
    table { width:100%; border-collapse: collapse; font-size: 14px; }
    th, td { padding: 10px; border-bottom: 1px solid #1f2937; text-align: left; white-space: nowrap; }
    .metrics { display:flex; gap:18px; margin-bottom: 16px; flex-wrap: wrap; }
    details { margin-top: 10px; }
    code { background:#0b1220; padding:2px 6px; border-radius:6px; border:1px solid #1f2937; }
    @media (max-width: 720px) { .grid { grid-template-columns: 1fr; } }
    @media print { body { background:#fff; color:#000; } .card { border:0; } .toolbar { display:none; } }
  `;
}
function htmlPage(title, bodyHtml) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${escapeHTML(title)}</title>
<link rel="icon" href="data:,">
</head>
<body>
${bodyHtml}
</body>
</html>`;
}

// ---------- Client slug resolver ----------
function resolveClientSlug({ client, restaurant, offer }) {
  const c = (client || '').toLowerCase().trim();
  if (c && CLIENTS[c]) return c;

  const r = (restaurant || '').toLowerCase();
  if (r) {
    for (const [slug, cfg] of Object.entries(CLIENTS)) {
      if ((cfg.restaurants || []).some(n => r.includes(n.toLowerCase()))) return slug;
    }
  }

  const o = (offer || '').toLowerCase();
  if (o.startsWith('pop-')) return 'popeyes-mckinney';
  if (o.startsWith('sonic-')) return 'sonic-frisco';
  if (o.startsWith('braums-') || o.startsWith('braum-')) return 'braums-stacy';
  if (o.startsWith('rudys-') || o.startsWith('rudy-')) return 'rudys-mckinney';
  if (o.startsWith('babes-') || o.startsWith('babe-')) return 'babes-allen';

  return 'general';
}

// ---------- Static files ----------
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

// ---------- Health ----------
app.get('/health', (_req, res) => res.json({ ok: true }));

// ---------- Issuance page (/coupon) ----------
app.get('/coupon', async (req, res) => {
  const offer = (req.query.offer || req.query.offer_id || 'generic-offer').toString().trim();
  const restaurant = (req.query.restaurant || 'Unknown Restaurant').toString().trim();
  const client = (req.query.client || '').toString().trim();

  const client_slug = resolveClientSlug({ client, restaurant, offer });
  const client_name = CLIENTS[client_slug]?.name || 'General Client';

  const db = await loadDB();
  const token = randToken();
  const pass = {
    id: crypto.randomUUID(),
    token,
    token_hash: crypto.createHash('sha256').update(token).digest('hex').slice(0, 12),
    offer, offer_id: offer,
    client_slug, client_name,
    restaurant,
    status: 'issued',
    issued_at: nowISO(),
    redeemed_at: null,
    store_id: null,
    redeemed_by_store: '',
    redeemed_by_staff: '',
    user_agent: req.headers['user-agent'] || null,
    ip: (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').toString(),
  };
  db.passes.push(pass);
  await saveDB(db);

  const couponUrl = `${BASE_URL}/coupon/view?token=${encodeURIComponent(token)}`;
  const qrDataUrl = await QRCode.toDataURL(couponUrl);

  const body = `
    <section class="card">
      <h1>${escapeHTML(restaurant)}</h1>
      <p class="offer">${escapeHTML(offer)}</p>
      <div class="grid">
        <div>
          <h2>Your Coupon Is Ready</h2>
          <p><strong>Client:</strong> ${escapeHTML(client_name)} (${client_slug})</p>
          <p><strong>Token (short):</strong> ${pass.token_hash}</p>
          <p><a href="${couponUrl}">${couponUrl}</a></p>
          <div class="cta">
            <a class="btn" href="${couponUrl}">Open Coupon</a>
            <button onclick="navigator.clipboard.writeText('${couponUrl}')">Copy Link</button>
          </div>
          <p class="tip">Tip: Add this page to your phone’s Home Screen for quick access.</p>
        </div>
        <div class="qr">
          <img src="${qrDataUrl}" alt="QR code to open coupon" />
          <p class="muted">Scan to open</p>
        </div>
      </div>
    </section>
    <style>${baseCss()}</style>
  `;
  res.send(htmlPage('Coupon Issued', body));
});

// ---------- View coupon ----------
app.get('/coupon/view', async (req, res) => {
  const token = (req.query.token || '').toString();
  const db = await loadDB();
  const pass = db.passes.find((p) => p.token === token);
  if (!pass) return res.status(404).send('Coupon not found');

  const body = `
    <section class="card">
      <h1>${escapeHTML(pass.restaurant || pass.client_name || 'Coupon')}</h1>
      <p class="offer">${escapeHTML(pass.offer || pass.offer_id || '')}</p>
      <p>Status: <strong>${pass.status.toUpperCase()}</strong>${pass.status === 'redeemed' ? ' ✅' : ''}</p>
      <p>Token (short): <code>${pass.token_hash}</code></p>
      <div class="cta"><a class="btn" href="/redeem.html?token=${encodeURIComponent(pass.token)}">Show Cashier</a></div>
    </section>
    <style>${baseCss()}</style>
  `;
  res.send(htmlPage('Coupon', body));
});

// ---------- Redeem API (POST /api/redeem) ----------
app.post('/api/redeem', requireApiKey, async (req, res) => {
  const { token, store_id, staff } = req.body || {};
  if (!token || !store_id) {
    return res.status(400).json({ error: 'Missing token or store_id' });
  }

  const db = await loadDB();
  const pass = db.passes.find((p) => p.token === token);

  if (!pass) return res.status(404).json({ error: 'Token not found' });
  if (pass.status === 'redeemed') {
    return res.status(409).json({ error: 'Already redeemed', redeemed_at: pass.redeemed_at });
  }
  if (pass.status === 'void') return res.status(410).json({ error: 'Token is void' });

  pass.status = 'redeemed';
  pass.redeemed_at = nowISO();
  pass.store_id = store_id;
  pass.redeemed_by_store = String(store_id);
  pass.redeemed_by_staff = staff || '';

  db.redemptions.push({
    token,
    offer: pass.offer || pass.offer_id,
    client_slug: pass.client_slug,
    store_id,
    staff: pass.redeemed_by_staff,
    redeemed_at: pass.redeemed_at,
  });

  await saveDB(db);
  return res.json({ ok: true, token_hash: pass.token_hash, redeemed_at: pass.redeemed_at });
});

// ---------- Admin Hub ----------
app.get('/hub', requireApiKey, async (req, res) => {
  const db = await loadDB();
  const rows = db.passes
    .slice()
    .reverse()
    .map(
      (p) => `
      <tr>
        <td><code>${p.token_hash}</code></td>
        <td>${escapeHTML(p.offer || p.offer_id || '')}</td>
        <td>${escapeHTML(p.restaurant || '')}</td>
        <td>${escapeHTML(p.client_slug || '')}</td>
        <td>${p.status}</td>
        <td>${p.issued_at || ''}</td>
        <td>${p.redeemed_at || ''}</td>
        <td>${p.store_id || ''}</td>
      </tr>`
    )
    .join('');

  const body = `
    <section class="card">
      <h1>Admin Hub</h1>
      <nav class="toolbar">
        <a class="btn" href="/hub/dashboard?key=${encodeURIComponent(req.query.key || '')}">Analytics Admin</a>
        <a class="btn" href="/hub/dashboard/report-analytics.csv?key=${encodeURIComponent(req.query.key || '')}">Download Analytics CSV</a>
      </nav>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Token</th><th>Offer</th><th>Restaurant</th><th>Client</th><th>Status</th><th>Issued</th><th>Redeemed</th><th>Store</th>
            </tr>
          </thead>
          <tbody>${rows || '<tr><td colspan="8">No passes yet</td></tr>'}</tbody>
        </table>
      </div>
    </section>
    <style>${baseCss()}</style>
  `;
  res.send(htmlPage('Admin Hub', body));
});

// ---------- Analytics Admin ----------
function summarizeAnalytics(db) {
  const passes = db.passes || [];
  const byDay = {};
  const byOffer = {};
  let issued = 0, redeemed = 0;

  for (const p of passes) {
    if (p.issued_at) {
      const d = p.issued_at.slice(0,10);
      byDay[d] = byDay[d] || { issued: 0, redeemed: 0 };
      byDay[d].issued++;
      issued++;
    }
    if (p.redeemed_at) {
      const d2 = p.redeemed_at.slice(0,10);
      byDay[d2] = byDay[d2] || { issued: 0, redeemed: 0 };
      byDay[d2].redeemed++;
      redeemed++;
    }
    const o = p.offer || p.offer_id || 'unknown';
    byOffer[o] = byOffer[o] || { issued: 0, redeemed: 0 };
    byOffer[o].issued += 1;
    if (p.status === 'redeemed') byOffer[o].redeemed += 1;
  }

  const rate = issued ? Math.round((redeemed / issued) * 1000) / 10 : 0;

  return { totalIssued: issued, totalRedeemed: redeemed, redemptionRate: rate, byDay, byOffer };
}

app.get('/hub/dashboard', requireApiKey, async (req, res) => {
  const db = await loadDB();
  const metrics = summarizeAnalytics(db);

  const body = `
    <section class="card">
      <h1>Analytics Admin</h1>
      <nav class="toolbar">
        <a class="btn" href="/hub?key=${encodeURIComponent(req.query.key || '')}">Back to Hub</a>
        <a class="btn" href="/hub/dashboard/report-analytics.csv?key=${encodeURIComponent(req.query.key || '')}">Download CSV</a>
      </nav>
      <div class="metrics">
        <div><strong>Total Issued:</strong> ${metrics.totalIssued}</div>
        <div><strong>Total Redeemed:</strong> ${metrics.totalRedeemed}</div>
        <div><strong>Redemption Rate:</strong> ${metrics.redemptionRate}%</div>
      </div>
      <canvas id="byDay" width="900" height="360"></canvas>
      <canvas id="byOffer" width="900" height="360" style="margin-top:24px;"></canvas>
    </section>
    <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js"></script>
    <script>
      const byDay = ${JSON.stringify(metrics.byDay)};
      const byOffer = ${JSON.stringify(metrics.byOffer)};
      new Chart(document.getElementById('byDay'), {
        type: 'line',
        data: { labels: Object.keys(byDay), datasets: [
          { label: 'Issued', data: Object.values(byDay).map(x => x.issued) },
          { label: 'Redeemed', data: Object.values(byDay).map(x => x.redeemed) }
        ]}
      });
      new Chart(document.getElementById('byOffer'), {
        type: 'bar',
        data: { labels: Object.keys(byOffer), datasets: [
          { label: 'Issued', data: Object.values(byOffer).map(x => x.issued) },
          { label: 'Redeemed', data: Object.values(byOffer).map(x => x.redeemed) }
        ]}
      });
    </script>
    <style>${baseCss()}</style>
  `;
  res.send(htmlPage('Analytics Admin', body));
});

// ---------- Analytics CSV (admin-protected) ----------
app.get('/hub/dashboard/report-analytics.csv', requireApiKey, async (req, res) => {
  const db = await loadDB();
  const rows = [
    ['id','offer','restaurant','client_slug','status','issued_at','redeemed_at','store_id','token_hash'],
    ...db.passes.map((p) => [
      p.id || '',
      p.offer || p.offer_id || '',
      p.restaurant || '',
      p.client_slug || '',
      p.status || '',
      p.issued_at || '',
      p.redeemed_at || '',
      p.store_id || '',
      p.token_hash || '',
    ]),
  ];
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=report-analytics.csv');
  res.send(rows.map((r) => r.map(csvEscape).join(',')).join('\n'));
});

// ---------- Client auth ----------
function authClientForSlug(req, res, next) {
  const slug = (req.params.slug || '').toLowerCase();
  const cfg = CLIENTS[slug];
  if (!cfg) return res.status(404).send('Unknown client');
  const t = (req.query.token || req.headers['x-client-token'] || '').toString();
  if (!cfg.token) return res.status(500).send('Client access not configured');
  if (t !== cfg.token) return res.status(401).send('Unauthorized');
  req.clientCfg = cfg;
  req.clientSlug = slug;
  next();
}

// ---------- Client page (shared HTML for all slugs) ----------
app.get('/client/:slug', authClientForSlug, async (req, res) => {
  const pagePath = path.join(PUBLIC_DIR, 'client', 'dashboard.html');
  if (fs.existsSync(pagePath)) return res.sendFile(pagePath);
  // Minimal fallback if the dashboard file is missing
  res.send(htmlPage('Client Dashboard', `
    <section class="card">
      <h1>${escapeHTML(req.clientCfg.name)} — Client Dashboard</h1>
      <p>Add <code>/public/client/dashboard.html</code> for full UI.</p>
      <ul>
        <li><a href="/api/client/${req.clientSlug}/report">JSON</a></li>
        <li><a href="/api/client/${req.clientSlug}/report.csv">CSV</a></li>
      </ul>
    </section>
    <style>${baseCss()}</style>
  `));
});

// ---------- Client JSON/CSV (namespaced) ----------
function shapeClientRows(passes) {
  return passes.map(r => ({
    id: r.id || r.token || '',
    offer_id: r.offer || r.offer_id || '',
    restaurant: r.restaurant || '',
    client_slug: r.client_slug || '',
    status: r.status || (r.redeemed_at ? 'redeemed' : 'issued'),
    issued_at: r.issued_at || '',
    expires_at: r.expires_at || '',
    redeemed_at: r.redeemed_at || '',
    redeemed_by_store: r.redeemed_by_store || r.store_id || '',
    redeemed_by_staff: r.redeemed_by_staff || '',
    token_hash: r.token_hash || (r.token ? crypto.createHash('sha256').update(r.token).digest('hex').slice(0,12) : '')
  }));
}

// GET /api/client/:slug/report?from=...&to=...&offer=...&status=issued,redeemed
app.get('/api/client/:slug/report', authClientForSlug, async (req, res) => {
  const db = await loadDB();
  let rows = shapeClientRows(db.passes).filter(r => r.client_slug === req.clientSlug);

  const { from, to, offer, status } = req.query;
  if (offer) rows = rows.filter(r => (r.offer_id||'').toLowerCase().includes(String(offer).toLowerCase()));
  if (status) {
    const allowed = new Set(String(status).split(',').map(s => s.trim().toLowerCase()));
    rows = rows.filter(r => allowed.has((r.status||'').toLowerCase()));
  }
  if (from) rows = rows.filter(r => r.issued_at && new Date(r.issued_at) >= new Date(from));
  if (to) rows = rows.filter(r => r.issued_at && new Date(r.issued_at) <= new Date(to));

  res.json({ count: rows.length, rows });
});

// GET /api/client/:slug/report.csv (same filters)
app.get('/api/client/:slug/report.csv', authClientForSlug, async (req, res) => {
  const db = await loadDB();
  let rows = shapeClientRows(db.passes).filter(r => r.client_slug === req.clientSlug);

  const { from, to, offer, status } = req.query;
  if (offer) rows = rows.filter(r => (r.offer_id||'').toLowerCase().includes(String(offer).toLowerCase()));
  if (status) {
    const allowed = new Set(String(status).split(',').map(s => s.trim().toLowerCase()));
    rows = rows.filter(r => allowed.has((r.status||'').toLowerCase()));
  }
  if (from) rows = rows.filter(r => r.issued_at && new Date(r.issued_at) >= new Date(from));
  if (to) rows = rows.filter(r => r.issued_at && new Date(r.issued_at) <= new Date(to));

  const headers = ['id','offer_id','restaurant','status','issued_at','expires_at','redeemed_at','redeemed_by_store','redeemed_by_staff','token_hash'];
  const csv = [headers.join(',')].concat(rows.map(r => headers.map(h => (r[h] ?? '').toString().replace(/,/g,' ')).join(','))).join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${req.clientSlug}_report.csv"`);
  res.send(csv);
});

// ---------- Home ----------
app.get('/', (_req, res) => {
  const body = `
    <section class="card">
      <h1>ACP One-Time Coupon Server — Multi-Client</h1>
      <ul>
        <li>Issue: <code>/coupon?offer=pop-bogo&restaurant=Popeyes%20McKinney&client=popeyes-mckinney</code></li>
        <li>Cashier: <code>/redeem.html</code></li>
        <li>Admin Hub: <code>/hub?key=YOUR_API_KEY</code></li>
        <li>Analytics: <code>/hub/dashboard?key=YOUR_API_KEY</code></li>
        <li>Client (Popeyes): <code>/client/popeyes-mckinney?token=...</code></li>
        <li>Client (Sonic): <code>/client/sonic-frisco?token=...</code></li>
        <li>Client (Braum’s): <code>/client/braums-stacy?token=...</code></li>
        <li>Client (Rudy’s): <code>/client/rudys-mckinney?token=...</code></li>
        <li>Client (Babe’s): <code>/client/babes-allen?token=...</code></li>
      </ul>
    </section>
    <style>${baseCss()}</style>
  `;
  res.send(htmlPage('Welcome', body));
});

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`Server listening on :${PORT}`);
});
