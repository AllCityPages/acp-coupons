// index.js
// One-time coupon server (Node 18+)
// Features:
// - Coupon issuance page (/coupon?offer=...)
// - Cashier redeem API (POST /api/redeem) with API-key protection
// - Simple cashier page (/redeem.html) served from /public (with dynamic fallback)
// - Admin hub (/hub) + Analytics Admin page (/hub/dashboard)
// - Admin CSV download (/hub/dashboard/report-analytics.csv) with API-key protection
// - Client-facing dashboard for Popeyes McKinney (/client/popeyes?token=...)
// - Client JSON + CSV endpoints with filters (/api/client-report, /api/client-report.csv)
// - Data persisted to ./data/passes.json (auto-creates)
// - Works on Render/Node 18+
// Env vars required: PORT, API_KEY, BASE_URL (or COUPON_BASE_URL)
// Client token/slug: CLIENT_POPEYES_TOKEN, CLIENT_POPEYES_SLUG

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ---------- CORS (loose: allow local tools & designers) ----------
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ---------- ENV ----------
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';
const BASE_URL = (process.env.BASE_URL || process.env.COUPON_BASE_URL || '').replace(/\/+$/, '');
const CLIENT_POPEYES_TOKEN = process.env.CLIENT_POPEYES_TOKEN || '';
const CLIENT_POPEYES_SLUG = (process.env.CLIENT_POPEYES_SLUG || 'popeyes-mckinney').toLowerCase();

// ---------- STORAGE ----------
const DATA_DIR = path.join(__dirname, 'data');
const PASSES_PATH = path.join(DATA_DIR, 'passes.json');

function ensureStorage() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(PASSES_PATH)) fs.writeFileSync(PASSES_PATH, JSON.stringify({ passes: [] }, null, 2));
}
function loadPasses() {
  ensureStorage();
  try {
    const raw = fs.readFileSync(PASSES_PATH, 'utf8');
    const parsed = JSON.parse(raw || '{}');
    return Array.isArray(parsed.passes) ? parsed.passes : [];
  } catch {
    return [];
  }
}
function savePasses(passes) {
  ensureStorage();
  fs.writeFileSync(PASSES_PATH, JSON.stringify({ passes }, null, 2));
}
function nowISO() {
  return new Date().toISOString();
}
function safeStr(v) {
  return (v || '').toString().trim();
}
function csvEscape(val) {
  if (val == null) return '';
  const s = String(val);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function toCSV(rows) {
  if (!rows.length) return 'token,offer,status,created_at,redeemed,redeemed_at,store_id,slug,source_ip\n';
  const headers = Object.keys(rows[0]);
  const out = [headers.join(',')].concat(
    rows.map(r => headers.map(h => csvEscape(r[h])).join(','))
  );
  return out.join('\n') + '\n';
}

// ---------- SECURITY MIDDLEWARE ----------
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.api_key;
  if (!API_KEY) return res.status(500).json({ error: 'Server missing API_KEY' });
  if (key !== API_KEY) return res.status(401).json({ error: 'Invalid or missing x-api-key' });
  next();
}
function requireClientToken(req, res, next) {
  const token = req.query.token || req.headers['x-client-token'];
  if (!CLIENT_POPEYES_TOKEN) return res.status(500).json({ error: 'Server missing CLIENT_POPEYES_TOKEN' });
  if (token !== CLIENT_POPEYES_TOKEN) return res.status(401).json({ error: 'Invalid or missing client token' });
  next();
}

// ---------- STATIC (public) ----------
const PUBLIC_DIR = path.join(__dirname, 'public');
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(express.static(PUBLIC_DIR, { index: false }));
}

// ---------- HTML HELPERS ----------
function htmlPage(title, body, opts = {}) {
  const styles = `
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;margin:24px;line-height:1.45;}
    .wrap{max-width:980px;margin:0 auto}
    h1,h2,h3{margin:0 0 12px}
    .card{border:1px solid #e5e7eb;border-radius:12px;padding:16px;margin:12px 0;box-shadow:0 1px 2px rgba(0,0,0,.04)}
    .muted{color:#6b7280}
    .row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
    .btn{display:inline-block;padding:10px 14px;border-radius:10px;border:1px solid #e5e7eb;text-decoration:none}
    .btn.primary{border-color:#111827}
    table{border-collapse:collapse;width:100%}
    th,td{border:1px solid #e5e7eb;padding:8px;text-align:left}
    .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}
    .badge{display:inline-block;padding:2px 8px;border-radius:999px;background:#eef2ff}
    input,select{padding:8px;border:1px solid #e5e7eb;border-radius:8px}
    code{background:#f3f4f6;padding:2px 6px;border-radius:6px}
  `;
  const base = BASE_URL || '';
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" /><meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${title}</title>
<link rel="icon" href="data:,">
<style>${styles}</style>
${opts.meta || ''}
</head>
<body>
<div class="wrap">
  <div class="row" style="justify-content:space-between;align-items:baseline">
    <h1>${title}</h1>
    <div class="muted">${base ? `<span class="badge">BASE_URL: ${base}</span>` : ''}</div>
  </div>
  ${body}
</div>
</body></html>`;
}

// ---------- COUPON ISSUANCE (/coupon) ----------
app.get('/coupon', (req, res) => {
  const offer = safeStr(req.query.offer) || 'default-offer';
  const slug = safeStr(req.query.slug) || CLIENT_POPEYES_SLUG; // optional override
  const token = crypto.randomUUID().replace(/-/g, '') + crypto.randomBytes(4).toString('hex');

  const passes = loadPasses();
  const pass = {
    token,
    offer,
    status: 'issued',
    created_at: nowISO(),
    redeemed: false,
    redeemed_at: null,
    store_id: null,
    slug,
    source_ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress || '',
  };
  passes.push(pass);
  savePasses(passes);

  const redeemUrl = `${BASE_URL || ''}/redeem.html`;
  const cashierHint = `<code>${token}</code>`;

  const body = `
  <div class="card">
    <h2>✅ Your Offer is Ready</h2>
    <p>Show this screen at the register. The cashier will scan or enter your one-time code below.</p>
    <div class="card">
      <div class="row" style="justify-content:space-between;align-items:center">
        <div>
          <div class="muted">Offer</div>
          <div style="font-size:20px;font-weight:600">${offer}</div>
        </div>
        <div style="text-align:right">
          <div class="muted">One-time Code</div>
          <div style="font-size:22px;font-weight:700;letter-spacing:1px">${token.slice(0,6).toUpperCase()}-${token.slice(-6).toUpperCase()}</div>
        </div>
      </div>
      <div class="muted" style="margin-top:8px">Created: ${pass.created_at}</div>
    </div>
    <div class="row">
      <a class="btn" href="${redeemUrl}">Cashier Redeem Page</a>
      <a class="btn" href="javascript:window.print()">Print</a>
      <a class="btn" href="#" onclick="(async()=>{try{await navigator.clipboard.writeText('${token}');alert('Token copied');}catch(e){alert('Copy failed')}})()">Copy Token</a>
    </div>
    <p class="muted">Cashier will enter token ${cashierHint} with their store ID.</p>
  </div>
  <div class="muted">Need help? Provide this token to support: <code>${token}</code></div>
  `;
  res.type('html').send(htmlPage('Coupon', body));
});

// ---------- CASHIER PAGE (/redeem.html) ----------
app.get('/redeem.html', (req, res) => {
  // Dynamic fallback (works even if no /public/redeem.html file exists)
  const body = `
  <div class="card">
    <h2>Cashier Redeem</h2>
    <p class="muted">Enter the customer’s one-time code and your Store ID. Requires valid API key.</p>
    <div class="grid">
      <div>
        <label>One-time Token</label><br/>
        <input id="token" placeholder="paste token (no spaces)" style="width:100%"/>
      </div>
      <div>
        <label>Store ID</label><br/>
        <input id="store_id" placeholder="e.g. MCK-001" style="width:100%"/>
      </div>
      <div>
        <label>API Key</label><br/>
        <input id="api_key" placeholder="x-api-key" style="width:100%"/>
      </div>
    </div>
    <div class="row" style="margin-top:12px">
      <button class="btn primary" onclick="redeem()">Redeem Now</button>
      <button class="btn" onclick="resetForm()">Reset</button>
    </div>
    <pre id="out" class="card" style="white-space:pre-wrap"></pre>
  </div>
  <script>
    async function redeem(){
      const token = document.getElementById('token').value.trim();
      const store_id = document.getElementById('store_id').value.trim();
      const api_key = document.getElementById('api_key').value.trim();
      const out = document.getElementById('out');
      out.textContent = 'Redeeming...';
      try{
        const res = await fetch('/api/redeem', {
          method:'POST',
          headers:{'Content-Type':'application/json','x-api-key':api_key},
          body: JSON.stringify({ token, store_id })
        });
        const data = await res.json();
        out.textContent = JSON.stringify(data,null,2);
      }catch(e){
        out.textContent = 'Error: ' + e.message;
      }
    }
    function resetForm(){
      document.getElementById('token').value='';
      document.getElementById('store_id').value='';
      document.getElementById('api_key').value='';
      document.getElementById('out').textContent='';
    }
  </script>
  `;
  res.type('html').send(htmlPage('Redeem • Cashier', body));
});

// ---------- REDEEM API (POST /api/redeem) ----------
app.post('/api/redeem', requireApiKey, (req, res) => {
  const token = safeStr(req.body.token);
  const store_id = safeStr(req.body.store_id) || 'unknown';
  if (!token) return res.status(400).json({ error: 'token required' });

  const passes = loadPasses();
  const idx = passes.findIndex(p => p.token === token);
  if (idx === -1) return res.status(404).json({ error: 'token not found' });

  const pass = passes[idx];
  if (pass.redeemed) {
    return res.status(409).json({
      error: 'already redeemed',
      redeemed_at: pass.redeemed_at,
      store_id: pass.store_id
    });
  }

  pass.redeemed = true;
  pass.redeemed_at = nowISO();
  pass.status = 'redeemed';
  pass.store_id = store_id;
  passes[idx] = pass;
  savePasses(passes);

  res.json({ ok: true, token, offer: pass.offer, redeemed_at: pass.redeemed_at, store_id });
});

// ---------- ADMIN: HUB (/hub) ----------
app.get('/hub', (req, res) => {
  const passes = loadPasses();
  const total = passes.length;
  const redeemed = passes.filter(p => p.redeemed).length;
  const unredeemed = total - redeemed;

  const sampleLinks = `
    <div class="row">
      <a class="btn" href="/coupon?offer=test-offer">Issue Test Coupon</a>
      <a class="btn" href="/redeem.html">Cashier Page</a>
      <a class="btn" href="/hub/dashboard">Analytics Admin</a>
      <a class="btn" href="/client/popeyes?token=${encodeURIComponent(CLIENT_POPEYES_TOKEN)}">Client Dashboard (Popeyes)</a>
    </div>
  `;

  const list = passes.slice(-50).reverse().map(p => `
    <tr>
      <td><code>${p.token.slice(0,8)}…</code></td>
      <td>${p.offer}</td>
      <td>${p.slug || ''}</td>
      <td>${p.status}</td>
      <td>${p.created_at}</td>
      <td>${p.redeemed ? 'yes' : 'no'}</td>
      <td>${p.redeemed_at || ''}</td>
      <td>${p.store_id || ''}</td>
    </tr>
  `).join('');

  const body = `
  <div class="grid">
    <div class="card"><div class="muted">Total</div><div style="font-size:26px;font-weight:700">${total}</div></div>
    <div class="card"><div class="muted">Redeemed</div><div style="font-size:26px;font-weight:700">${redeemed}</div></div>
    <div class="card"><div class="muted">Unredeemed</div><div style="font-size:26px;font-weight:700">${unredeemed}</div></div>
  </div>
  ${sampleLinks}
  <div class="card">
    <h3>Recent (last 50)</h3>
    <table>
      <thead><tr><th>token</th><th>offer</th><th>slug</th><th>status</th><th>created_at</th><th>redeemed</th><th>redeemed_at</th><th>store_id</th></tr></thead>
      <tbody>${list || '<tr><td colspan="8" class="muted">No passes yet.</td></tr>'}</tbody>
    </table>
  </div>`;
  res.type('html').send(htmlPage('Admin Hub', body));
});

// ---------- ADMIN: DASHBOARD (/hub/dashboard) ----------
app.get('/hub/dashboard', (req, res) => {
  const q = {
    offer: safeStr(req.query.offer),
    store_id: safeStr(req.query.store_id),
    from: safeStr(req.query.from),
    to: safeStr(req.query.to),
    slug: safeStr(req.query.slug)
  };
  const passes = loadPasses();

  const fromTs = q.from ? Date.parse(q.from) : null;
  const toTs = q.to ? Date.parse(q.to) : null;

  const filtered = passes.filter(p => {
    if (q.offer && p.offer !== q.offer) return false;
    if (q.store_id && (p.store_id || '') !== q.store_id) return false;
    if (q.slug && (p.slug || '') !== q.slug) return false;
    if (fromTs && Date.parse(p.created_at) < fromTs) return false;
    if (toTs && Date.parse(p.created_at) > toTs) return false;
    return true;
  });

  const totals = {
    total: filtered.length,
    redeemed: filtered.filter(p => p.redeemed).length,
    unredeemed: filtered.filter(p => !p.redeemed).length,
  };

  const byOffer = Object.entries(filtered.reduce((acc, p) => {
    acc[p.offer] = acc[p.offer] || { issued: 0, redeemed: 0 };
    acc[p.offer].issued += 1;
    if (p.redeemed) acc[p.offer].redeemed += 1;
    return acc;
  }, {})).map(([offer, v]) => ({ offer, ...v }));

  const rows = filtered.slice().reverse().map(p => `
    <tr>
      <td><code>${p.token.slice(0,8)}…</code></td>
      <td>${p.offer}</td>
      <td>${p.slug || ''}</td>
      <td>${p.status}</td>
      <td>${p.created_at}</td>
      <td>${p.redeemed ? 'yes' : 'no'}</td>
      <td>${p.redeemed_at || ''}</td>
      <td>${p.store_id || ''}</td>
    </tr>
  `).join('');

  const queryStr = new URLSearchParams(Object.fromEntries(Object.entries(q).filter(([,v]) => v))).toString();
  const csvPath = `/hub/dashboard/report-analytics.csv${queryStr ? `?${queryStr}` : ''}`;

  const body = `
  <div class="card">
    <h2>Filters</h2>
    <form class="row" method="GET" action="/hub/dashboard">
      <input name="offer" placeholder="offer" value="${q.offer}"/>
      <input name="slug" placeholder="slug" value="${q.slug}"/>
      <input name="store_id" placeholder="store_id" value="${q.store_id}"/>
      <input name="from" placeholder="from (YYYY-MM-DD)" value="${q.from}"/>
      <input name="to" placeholder="to (YYYY-MM-DD)" value="${q.to}"/>
      <button class="btn primary" type="submit">Apply</button>
      <a class="btn" href="/hub/dashboard">Reset</a>
      <a class="btn" href="${csvPath}">Download CSV (API key required)</a>
    </form>
  </div>

  <div class="grid">
    <div class="card"><div class="muted">Total</div><div style="font-size:26px;font-weight:700">${totals.total}</div></div>
    <div class="card"><div class="muted">Redeemed</div><div style="font-size:26px;font-weight:700">${totals.redeemed}</div></div>
    <div class="card"><div class="muted">Unredeemed</div><div style="font-size:26px;font-weight:700">${totals.unredeemed}</div></div>
  </div>

  <div class="card">
    <h3>By Offer</h3>
    <table>
      <thead><tr><th>Offer</th><th>Issued</th><th>Redeemed</th></tr></thead>
      <tbody>
        ${byOffer.length ? byOffer.map(r => `<tr><td>${r.offer}</td><td>${r.issued}</td><td>${r.redeemed}</td></tr>`).join('') : '<tr><td colspan="3" class="muted">No data</td></tr>'}
      </tbody>
    </table>
  </div>

  <div class="card">
    <h3>Records</h3>
    <table>
      <thead><tr><th>token</th><th>offer</th><th>slug</th><th>status</th><th>created_at</th><th>redeemed</th><th>redeemed_at</th><th>store_id</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="8" class="muted">No records</td></tr>'}</tbody>
    </table>
  </div>
  `;
  res.type('html').send(htmlPage('Analytics Admin', body));
});

// ---------- ADMIN CSV (exact path under /hub/dashboard) ----------
app.get('/hub/dashboard/report-analytics.csv', requireApiKey, (req, res) => {
  const q = {
    offer: safeStr(req.query.offer),
    store_id: safeStr(req.query.store_id),
    from: safeStr(req.query.from),
    to: safeStr(req.query.to),
    slug: safeStr(req.query.slug)
  };
  const passes = loadPasses();
  const fromTs = q.from ? Date.parse(q.from) : null;
  const toTs = q.to ? Date.parse(q.to) : null;

  const filtered = passes.filter(p => {
    if (q.offer && p.offer !== q.offer) return false;
    if (q.store_id && (p.store_id || '') !== q.store_id) return false;
    if (q.slug && (p.slug || '') !== q.slug) return false;
    if (fromTs && Date.parse(p.created_at) < fromTs) return false;
    if (toTs && Date.parse(p.created_at) > toTs) return false;
    return true;
  });

  const rows = filtered.map(p => ({
    token: p.token,
    offer: p.offer,
    status: p.status,
    created_at: p.created_at,
    redeemed: p.redeemed ? 'yes' : 'no',
    redeemed_at: p.redeemed_at || '',
    store_id: p.store_id || '',
    slug: p.slug || '',
    source_ip: p.source_ip || ''
  }));

  const csv = toCSV(rows);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="report-analytics.csv"');
  res.send(csv);
});

// ---------- CLIENT-FACING DASHBOARD (Popeyes McKinney) ----------
app.get('/client/popeyes', requireClientToken, (req, res) => {
  const slug = CLIENT_POPEYES_SLUG;
  const passes = loadPasses().filter(p => (p.slug || '').toLowerCase() === slug);

  const total = passes.length;
  const redeemed = passes.filter(p => p.redeemed).length;
  const unredeemed = total - redeemed;

  // Links to client endpoints with auth token passed in header or query
  const baseQuery = new URLSearchParams({ slug, token: CLIENT_POPEYES_TOKEN }).toString();
  const jsonUrl = `/api/client-report?${baseQuery}`;
  const csvUrl = `/api/client-report.csv?${baseQuery}`;

  const body = `
  <div class="card">
    <h2>${slug.replace(/-/g, ' ')} — Client Dashboard</h2>
    <div class="grid">
      <div class="card"><div class="muted">Total Issued</div><div style="font-size:26px;font-weight:700">${total}</div></div>
      <div class="card"><div class="muted">Redeemed</div><div style="font-size:26px;font-weight:700">${redeemed}</div></div>
      <div class="card"><div class="muted">Unredeemed</div><div style="font-size:26px;font-weight:700">${unredeemed}</div></div>
    </div>
    <div class="row" style="margin-top:8px">
      <a class="btn" href="${jsonUrl}">Download JSON</a>
      <a class="btn" href="${csvUrl}">Download CSV</a>
    </div>
  </div>
  <div class="card">
    <h3>Filters (client-side)</h3>
    <form class="row" onsubmit="go(event)">
      <input id="offer" placeholder="offer"/>
      <input id="from" placeholder="from (YYYY-MM-DD)"/>
      <input id="to" placeholder="to (YYYY-MM-DD)"/>
      <button class="btn primary" type="submit">Apply</button>
      <a class="btn" href="/client/popeyes?token=${encodeURIComponent(CLIENT_POPEYES_TOKEN)}">Reset</a>
    </form>
  </div>
  <script>
    function go(e){
      e.preventDefault();
      const params = new URLSearchParams(window.location.search);
      const token = params.get('token') || '';
      const offer = document.getElementById('offer').value.trim();
      const from = document.getElementById('from').value.trim();
      const to = document.getElementById('to').value.trim();
      const q = new URLSearchParams({ token });
      if (offer) q.set('offer', offer);
      if (from) q.set('from', from);
      if (to) q.set('to', to);
      window.location.href = '/client/popeyes?' + q.toString();
    }
  </script>
  `;
  res.type('html').send(htmlPage('Client Dashboard • Popeyes McKinney', body));
});

// ---------- CLIENT REPORT ENDPOINTS (JSON / CSV) ----------
function filterForClient(req) {
  const slug = (req.query.slug || CLIENT_POPEYES_SLUG).toLowerCase();
  const offer = safeStr(req.query.offer);
  const fromTs = req.query.from ? Date.parse(req.query.from) : null;
  const toTs = req.query.to ? Date.parse(req.query.to) : null;

  const passes = loadPasses().filter(p => (p.slug || '').toLowerCase() === slug);
  return passes.filter(p => {
    if (offer && p.offer !== offer) return false;
    if (fromTs && Date.parse(p.created_at) < fromTs) return false;
    if (toTs && Date.parse(p.created_at) > toTs) return false;
    return true;
  });
}
// Require client token for both
app.get('/api/client-report', requireClientToken, (req, res) => {
  const rows = filterForClient(req).map(p => ({
    token: p.token,
    offer: p.offer,
    status: p.status,
    created_at: p.created_at,
    redeemed: !!p.redeemed,
    redeemed_at: p.redeemed_at,
    store_id: p.store_id || '',
    slug: p.slug || ''
  }));
  res.json({ slug: (req.query.slug || CLIENT_POPEYES_SLUG), count: rows.length, rows });
});
app.get('/api/client-report.csv', requireClientToken, (req, res) => {
  const rows = filterForClient(req).map(p => ({
    token: p.token,
    offer: p.offer,
    status: p.status,
    created_at: p.created_at,
    redeemed: p.redeemed ? 'yes' : 'no',
    redeemed_at: p.redeemed_at || '',
    store_id: p.store_id || '',
    slug: p.slug || ''
  }));
  const csv = toCSV(rows);
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="client-report.csv"');
  res.send(csv);
});

// ---------- HEALTH / ROOT ----------
app.get('/', (req, res) => {
  const body = `
    <div class="card">
      <h2>Coupon Server</h2>
      <div class="grid">
        <div class="card">
          <div class="muted">Issue</div>
          <a class="btn" href="/coupon?offer=test-offer">/coupon?offer=test-offer</a>
        </div>
        <div class="card">
          <div class="muted">Cashier</div>
          <a class="btn" href="/redeem.html">/redeem.html</a>
        </div>
        <div class="card">
          <div class="muted">Admin</div>
          <a class="btn" href="/hub">/hub</a>
          <a class="btn" href="/hub/dashboard">/hub/dashboard</a>
        </div>
        <div class="card">
          <div class="muted">Client</div>
          <a class="btn" href="/client/popeyes?token=${encodeURIComponent(CLIENT_POPEYES_TOKEN)}">/client/popeyes</a>
        </div>
      </div>
      <p class="muted">Host: ${os.hostname()}</p>
    </div>
  `;
  res.type('html').send(htmlPage('Coupon Server', body));
});

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`Coupon server running on :${PORT}`);
  if (!API_KEY) console.warn('⚠️  Missing API_KEY env');
  if (!BASE_URL && !process.env.COUPON_BASE_URL) console.warn('⚠️  Missing BASE_URL/COUPON_BASE_URL env');
  if (!CLIENT_POPEYES_TOKEN) console.warn('⚠️  Missing CLIENT_POPEYES_TOKEN env');
});
