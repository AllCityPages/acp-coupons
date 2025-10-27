// index.js — ACP Coupons (Node 20.x)
// One-time Coupon Issuance + Redeem + Admin/Client Dashboards + CSV
// ------------------------------------------------------------------
// ENV you should set in production (Render/Hostinger):
// - API_KEY                  (admin key for /hub, /report, CSVs, PDF)
// - BASE_URL  (or COUPON_BASE_URL)  e.g. https://acp-coupons.onrender.com
// Optional per-client tokens (any number, same pattern):
// - CLIENT_POPEYES_TOKEN=abc123            CLIENT_POPEYES_SLUG=popeyes
// - CLIENT_BRAUMS_TOKEN=xyz789             CLIENT_BRAUMS_SLUG=braums
// ------------------------------------------------------------------

const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const QRCode = require('qrcode');

const app = express();
app.set('trust proxy', true);
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ----------------------- CORS (simple + safe) -----------------------
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Origin, X-Requested-With, Content-Type, Accept, x-api-key'
  );
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ----------------------- Config & Paths ------------------------------
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';
const BASE_URL =
  process.env.BASE_URL ||
  process.env.COUPON_BASE_URL ||
  `http://localhost:${PORT}`;

const DATA_DIR = path.join(__dirname, 'data');
const PASSES_PATH = path.join(DATA_DIR, 'passes.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

// ----------------------- Ensure storage exists -----------------------
async function ensureDataFile() {
  try {
    await fsp.mkdir(DATA_DIR, { recursive: true });
    await fsp.access(PASSES_PATH, fs.constants.F_OK);
  } catch {
    const seed = { tokens: [], redemptions: [], offers: [] };
    await fsp.writeFile(PASSES_PATH, JSON.stringify(seed, null, 2), 'utf-8');
  }
}
function nowIso() {
  return new Date().toISOString();
}
async function readDb() {
  await ensureDataFile();
  const raw = await fsp.readFile(PASSES_PATH, 'utf-8');
  try {
    return JSON.parse(raw);
  } catch {
    // recover from corruption
    const fallback = { tokens: [], redemptions: [], offers: [] };
    await fsp.writeFile(PASSES_PATH, JSON.stringify(fallback, null, 2), 'utf-8');
    return fallback;
  }
}
async function writeDb(obj) {
  await ensureDataFile();
  const tmp = PASSES_PATH + '.tmp';
  await fsp.writeFile(tmp, JSON.stringify(obj, null, 2), 'utf-8');
  await fsp.rename(tmp, PASSES_PATH);
}

// ----------------------- Client token registry -----------------------
function loadClientTokensFromEnv() {
  // Scans env for CLIENT_*_TOKEN and optional CLIENT_*_SLUG
  const map = {};
  for (const [key, val] of Object.entries(process.env)) {
    const m = key.match(/^CLIENT_([A-Z0-9_]+)_TOKEN$/);
    if (m && val) {
      const id = m[1]; // e.g., POPEYES
      const token = val;
      const slug = process.env[`CLIENT_${id}_SLUG`] || id.toLowerCase();
      map[token] = { clientId: id, slug };
    }
  }
  return map;
}
const CLIENT_TOKENS = loadClientTokensFromEnv();

// ----------------------- Auth middleware -----------------------------
function authAdmin(req, res, next) {
  const key = req.get('x-api-key') || req.query.api_key || '';
  if (!API_KEY || key !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized (admin)' });
  }
  next();
}
function authClient(req, res, next) {
  const token = req.query.token || '';
  const info = CLIENT_TOKENS[token];
  if (!info) return res.status(401).json({ error: 'Unauthorized (client)' });
  req.client = info; // { clientId, slug }
  next();
}

// ----------------------- Helpers ------------------------------------
function randToken() {
  return crypto.randomBytes(16).toString('hex');
}
function couponUrl(token) {
  return `${BASE_URL}/coupon?token=${encodeURIComponent(token)}`;
}
function sendCsv(res, filename, csvString) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${filename}"`
  );
  // Add BOM so Excel recognizes UTF-8
  res.status(200).send('\uFEFF' + csvString);
}
function toCsv(rows, headers) {
  // rows: array of objects; headers: string[] explicit order
  const esc = (v) => {
    if (v === undefined || v === null) return '';
    const s = String(v);
    if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  const head = headers.join(',');
  const body = rows.map((r) => headers.map((h) => esc(r[h])).join(',')).join('\n');
  return head + '\n' + body + '\n';
}

// ----------------------- Static files --------------------------------
app.use(express.static(PUBLIC_DIR));

// Explicit content-type routes for PWA + data
app.get('/offers.json', (req, res) => {
  res.type('application/json; charset=utf-8');
  res.sendFile(path.join(PUBLIC_DIR, 'offers.json'));
});
app.get('/manifest.json', (req, res) => {
  res.type('application/manifest+json; charset=utf-8');
  res.sendFile(path.join(PUBLIC_DIR, 'manifest.json'));
});
app.get('/service-worker.js', (req, res) => {
  res.setHeader('Service-Worker-Allowed', '/');
  res.type('application/javascript; charset=utf-8');
  res.sendFile(path.join(PUBLIC_DIR, 'service-worker.js'));
});
app.get('/redeem.html', (req, res) => {
  res.type('text/html; charset=utf-8');
  res.sendFile(path.join(PUBLIC_DIR, 'redeem.html'));
});

// ----------------------- Coupon issuance page ------------------------
app.get('/coupon', async (req, res) => {
  try {
    const offer = String(req.query.offer || '').trim();
    const explicitToken = String(req.query.token || '').trim();

    const db = await readDb();
    let token;

    if (explicitToken) {
      // Viewing an already-issued coupon by token
      token = explicitToken;
    } else {
      if (!offer) {
        return res
          .status(400)
          .send('Missing ?offer=... or ?token=... in query string.');
      }
      token = randToken();
      db.tokens.push({
        token,
        offer,
        issued_at: nowIso(),
        ip: req.ip,
        ua: req.get('user-agent') || ''
      });
      await writeDb(db);
    }

    const redeemPage = `${BASE_URL}/redeem.html`;
    const qrPayload = `${BASE_URL}/coupon?token=${encodeURIComponent(token)}`;
    const qrDataUrl = await QRCode.toDataURL(qrPayload);

    const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>Coupon</title>
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#111">
<style>
  body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Inter,Arial,sans-serif;margin:0;background:#0f1115;color:#fff}
  .wrap{max-width:760px;margin:0 auto;padding:24px}
  .card{background:#151822;border:1px solid #22283a;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.35);padding:24px}
  h1{font-size:22px;margin:0 0 12px}
  .muted{color:#98a2b3;font-size:14px}
  .qr{display:flex;gap:20px;align-items:center;margin-top:16px;flex-wrap:wrap}
  img{background:#fff;border-radius:12px;padding:8px}
  .cta{margin-top:20px;display:flex;gap:12px;flex-wrap:wrap}
  .btn{padding:10px 14px;border-radius:10px;border:1px solid #2a3148;background:#1b2134;color:#fff;text-decoration:none;font-weight:600}
  .btn:active{transform:translateY(1px)}
  .tip{margin-top:12px;color:#cbd5e1;font-size:13px}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;color:#cbd5e1}
</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>Coupon ${offer ? `for <span class="mono">${offer}</span>` : ''}</h1>
      <p class="muted">This is your one-time coupon. Show the cashier and let them redeem it once.</p>
      <div class="qr">
        <img src="${qrDataUrl}" alt="QR code" width="180" height="180" />
        <div>
          <div class="muted">Token</div>
          <div class="mono" style="font-size:16px">${token}</div>
          <div class="tip">Tip: On iPhone, tap <span class="mono">Share &gt; Add to Home Screen</span> for quick access.</div>
        </div>
      </div>
      <div class="cta">
        <a class="btn" href="${redeemPage}">Cashier Redeem Page</a>
        <a class="btn" href="${qrPayload}">Open This Coupon Link</a>
      </div>
    </div>
  </div>
</body>
</html>`;
    res.status(200).type('text/html; charset=utf-8').send(html);
  } catch (e) {
    console.error('GET /coupon error', e);
    res.status(500).send('Server error.');
  }
});

// ----------------------- Redeem API (cashier) ------------------------
app.post('/api/redeem', authAdmin, async (req, res) => {
  try {
    const { token, store_id } = req.body || {};
    if (!token) return res.status(400).json({ error: 'Missing token' });
    const db = await readDb();
    const found = db.tokens.find((t) => t.token === token);
    if (!found) {
      return res.status(404).json({ error: 'Token not found' });
    }
    const already = db.redemptions.find((r) => r.token === token);
    if (already) {
      return res.status(200).json({
        status: 'already_redeemed',
        redeemed_at: already.redeemed_at,
        store_id: already.store_id || null
      });
    }
    db.redemptions.push({
      token,
      redeemed_at: nowIso(),
      store_id: store_id || null,
      ip: req.ip,
      ua: req.get('user-agent') || ''
    });
    await writeDb(db);
    return res.status(200).json({ status: 'ok' });
  } catch (e) {
    console.error('POST /api/redeem error', e);
    res.status(500).json({ error: 'Server error' });
  }
});

// ----------------------- Admin Hub & Dashboard -----------------------
app.get('/hub', authAdmin, async (req, res) => {
  const db = await readDb();
  res.status(200).json(db);
});

app.get('/hub/dashboard', authAdmin, async (req, res) => {
  const db = await readDb();
  const totalIssued = db.tokens.length;
  const totalRedeemed = db.redemptions.length;
  const uniqueOffers = new Set(db.tokens.map((t) => t.offer || ''));
  const rate = totalIssued ? ((totalRedeemed / totalIssued) * 100).toFixed(1) : '0.0';

  // Simple per-offer tally
  const perOffer = {};
  for (const t of db.tokens) {
    const k = t.offer || 'unknown';
    perOffer[k] = perOffer[k] || { issued: 0, redeemed: 0 };
    perOffer[k].issued++;
  }
  for (const r of db.redemptions) {
    const tok = db.tokens.find((t) => t.token === r.token);
    const k = tok?.offer || 'unknown';
    perOffer[k] = perOffer[k] || { issued: 0, redeemed: 0 };
    perOffer[k].redeemed++;
  }

  const rows = Object.entries(perOffer)
    .sort((a, b) => (b[1].issued - a[1].issued))
    .map(([offer, stats]) => {
      const cr = stats.issued ? ((stats.redeemed / stats.issued) * 100).toFixed(1) : '0.0';
      return `<tr><td>${offer}</td><td>${stats.issued}</td><td>${stats.redeemed}</td><td>${cr}%</td></tr>`;
    })
    .join('');

  const html = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Analytics Admin</title>
<style>
body{font-family:Inter,system-ui,Segoe UI,Roboto,Arial,sans-serif;background:#0f1115;color:#e5e7eb;margin:0}
.wrap{max-width:1000px;margin:0 auto;padding:24px}
.card{background:#151822;border:1px solid #22283a;border-radius:16px;box-shadow:0 10px 30px rgba(0,0,0,.35);padding:24px}
h1{margin:0 0 16px;font-size:24px}
.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;margin:16px 0}
.k{background:#10131c;border:1px solid #20273a;border-radius:12px;padding:14px}
.k .t{font-size:12px;color:#94a3b8}
.k .v{font-size:22px;font-weight:700}
table{width:100%;border-collapse:collapse;margin-top:12px}
th,td{padding:10px;border-bottom:1px solid #242b40;text-align:left}
a.btn{display:inline-block;margin-top:14px;padding:10px 12px;border-radius:10px;background:#1b2134;color:#fff;text-decoration:none;border:1px solid #2a3148;font-weight:600}
.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.small{font-size:12px;color:#94a3b8}
</style>
</head>
<body>
  <div class="wrap">
    <div class="card">
      <h1>Analytics Admin</h1>
      <div class="grid">
        <div class="k"><div class="t">Total Issued</div><div class="v">${totalIssued}</div></div>
        <div class="k"><div class="t">Total Redeemed</div><div class="v">${totalRedeemed}</div></div>
        <div class="k"><div class="t">Conversion Rate</div><div class="v">${rate}%</div></div>
        <div class="k"><div class="t">Unique Offers</div><div class="v">${uniqueOffers.size}</div></div>
      </div>
      <a class="btn" href="/hub/dashboard/report-analytics.csv">Download Redemption CSV</a>
      <div class="small">Auth: send header <span class="mono">x-api-key: ****</span> when using curl/fetch to hit protected endpoints.</div>
      <table>
        <thead>
          <tr><th>Offer</th><th>Issued</th><th>Redeemed</th><th>CR</th></tr>
        </thead>
        <tbody>${rows || '<tr><td colspan="4">No data yet</td></tr>'}</tbody>
      </table>
    </div>
  </div>
</body>
</html>`;
  res.type('text/html; charset=utf-8').send(html);
});

// ----------------------- Admin CSV -----------------------------------
app.get('/hub/dashboard/report-analytics.csv', authAdmin, async (req, res) => {
  const db = await readDb();
  const joined = db.redemptions.map((r) => {
    const tok = db.tokens.find((t) => t.token === r.token) || {};
    return {
      token: r.token,
      offer: tok.offer || '',
      issued_at: tok.issued_at || '',
      redeemed_at: r.redeemed_at || '',
      store_id: r.store_id || '',
      issued_ip: tok.ip || '',
      redeemed_ip: r.ip || '',
    };
  });
  const headers = [
    'token',
    'offer',
    'issued_at',
    'redeemed_at',
    'store_id',
    'issued_ip',
    'redeemed_ip',
  ];
  const csv = toCsv(joined, headers);
  return sendCsv(res, 'report-analytics.csv', csv);
});

// ----------------------- Client report (JSON) ------------------------
app.get('/api/client-report', authClient, async (req, res) => {
  const { offer, from, to } = req.query;
  const db = await readDb();

  // Basic filters (offer + ISO date range)
  const tokens = db.tokens.filter((t) => {
    if (offer && (t.offer || '') !== offer) return false;
    if (from && t.issued_at && t.issued_at < from) return false;
    if (to && t.issued_at && t.issued_at > to) return false;
    return true;
  });

  const mapRedeemed = new Map(db.redemptions.map((r) => [r.token, r]));

  const rows = tokens.map((t) => {
    const r = mapRedeemed.get(t.token);
    return {
      token: t.token,
      offer: t.offer || '',
      issued_at: t.issued_at || '',
      redeemed_at: r?.redeemed_at || '',
      redeemed: Boolean(r),
      store_id: r?.store_id || '',
    };
  });

  res.status(200).json({
    client: req.client, // { clientId, slug }
    count: rows.length,
    results: rows,
  });
});

// ----------------------- Client report (CSV) -------------------------
app.get('/api/client-report.csv', authClient, async (req, res) => {
  const { offer, from, to } = req.query;
  const db = await readDb();

  const tokens = db.tokens.filter((t) => {
    if (offer && (t.offer || '') !== offer) return false;
    if (from && t.issued_at && t.issued_at < from) return false;
    if (to && t.issued_at && t.issued_at > to) return false;
    return true;
  });

  const mapRedeemed = new Map(db.redemptions.map((r) => [r.token, r]));

  const rows = tokens.map((t) => {
    const r = mapRedeemed.get(t.token);
    return {
      token: t.token,
      offer: t.offer || '',
      issued_at: t.issued_at || '',
      redeemed_at: r?.redeemed_at || '',
      redeemed: r ? 'yes' : 'no',
      store_id: r?.store_id || '',
    };
  });

  const headers = ['token', 'offer', 'issued_at', 'redeemed_at', 'redeemed', 'store_id'];
  const csv = toCsv(rows, headers);
  return sendCsv(res, `client-${req.client.slug}-report.csv`, csv);
});

// ----------------------- Health -------------------------------------
app.get('/healthz', (req, res) => res.status(200).json({ ok: true }));

// ----------------------- Boot ---------------------------------------
app.listen(PORT, () => {
  console.log(`ACP Coupons server running on port ${PORT}`);
  console.log(`BASE_URL: ${BASE_URL}`);
});
