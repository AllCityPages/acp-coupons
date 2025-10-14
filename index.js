// index.js
// One-time coupon server (Node 18+)
// Requires environment variables: COUPON_BASE_URL or BASE_URL, and API_KEY
// Do NOT hardcode secrets in this file.

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ---------- CONFIG (require env vars) ----------
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.COUPON_BASE_URL || process.env.BASE_URL;
if (!BASE_URL) {
  console.error('FATAL: Missing environment variable COUPON_BASE_URL or BASE_URL.');
  process.exit(1);
}
const API_KEY = process.env.API_KEY;
if (!API_KEY) {
  console.error('FATAL: Missing environment variable API_KEY.');
  process.exit(1);
}

// ---------- Paths ----------
const PASSES_FILE = path.join(__dirname, 'passes.json');
const OFFERS_FILE = path.join(__dirname, 'offers.json');
const STORES_FILE = path.join(__dirname, 'stores.json');

// ---------- Helpers to prevent accidental HTML injection ----------
function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// ---------- Helpers for JSON files ----------
function readJsonSafe(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return fallback;
  }
}
function writeJsonSafe(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

// Ensure passes file exists
if (!fs.existsSync(PASSES_FILE)) {
  writeJsonSafe(PASSES_FILE, { passes: [] });
}

// Load offers & stores (canonical sources)
const OFFERS = readJsonSafe(OFFERS_FILE, {});
const STORES = readJsonSafe(STORES_FILE, {});

// ---------- Token helpers ----------
function genToken(bytes = 12) {
  return crypto.randomBytes(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/,'');
}
function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// Create pass (store token hash only)
function createPass(rawToken, offerId) {
  const token_hash = hashToken(rawToken);
  const now = Math.floor(Date.now() / 1000);
  const offer = OFFERS[offerId] || null;
  const expires_at = offer && offer.expires_days ? now + offer.expires_days * 24*60*60 : now + 90*24*60*60;
  const pass = {
    id: crypto.randomUUID(),
    token_hash,
    status: 'issued',
    issued_at: now,
    expires_at,
    redeemed_at: null,
    redeemed_by: null,
    offer_id: offerId || null,
    restaurant: offer ? offer.restaurant : null
  };
  const db = readJsonSafe(PASSES_FILE, { passes: [] });
  db.passes.push(pass);
  writeJsonSafe(PASSES_FILE, db);
  return pass;
}

function findPassByRawToken(rawToken) {
  const token_hash = hashToken(rawToken);
  const db = readJsonSafe(PASSES_FILE, { passes: [] });
  return db.passes.find(p => p.token_hash === token_hash);
}

function redeemPassByRawToken(rawToken, store_code, staff_id) {
  const db = readJsonSafe(PASSES_FILE, { passes: [] });
  const token_hash = hashToken(rawToken);
  const p = db.passes.find(x => x.token_hash === token_hash);
  if (!p) return { ok:false, reason:'invalid', message:'Invalid coupon' };
  if (p.status === 'redeemed') return { ok:false, reason:'already_used', message:'Coupon already redeemed' };
  const now = Math.floor(Date.now() / 1000);
  if (p.expires_at && now > p.expires_at) return { ok:false, reason:'expired', message:'Coupon expired' };

  const storeName = (STORES && STORES[store_code]) ? STORES[store_code] : null;
  if (!storeName) return { ok:false, reason:'unknown_store', message:'Unknown store code' };

const offer = OFFERS[p.offer_id] || {};

// If offer is locked to a specific store, enforce exact match
if (offer.store_id && store_code !== offer.store_id) {
  return { ok:false, reason:'wrong_store', message:`Coupon only valid at store ${offer.store_id}` };
}

// Still protect restaurant mismatches (belt + suspenders)
if (p.restaurant && storeName !== p.restaurant) {
  return { ok:false, reason:'mismatch', message:`Coupon is for ${p.restaurant} — not valid at this store.` };
}

  p.status = 'redeemed';
  p.redeemed_at = now;
  p.redeemed_by = { store_code, staff_id: staff_id || null };
  writeJsonSafe(PASSES_FILE, db);
  return { ok:true, message:'Redeemed', offer_id: p.offer_id };
}

// ---------- Endpoints ----------

// PNG QR endpoint for a raw token (links to validate page)
app.get('/api/qrcode/:token', async (req, res) => {
  const token = req.params.token;
  const url = `${BASE_URL}/validate?token=${encodeURIComponent(token)}`;
  try {
    const png = await QRCode.toBuffer(url, { type: 'png', width: 300 });
    res.setHeader('Content-Type', 'image/png');
    return res.send(png);
  } catch (err) {
    console.error('QR generation error', err);
    return res.status(500).send('QR error');
  }
});

// coupon page: create a token and display QR + Code
app.get('/coupon', (req, res) => {
  const offerId = req.query.offer;
  const offer = offerId ? OFFERS[offerId] : null;
  if (!offer) {
    return res.status(400).send('Invalid offer id');
  }

  const rawToken = genToken();
  createPass(rawToken, offerId);

  const db = readJsonSafe(PASSES_FILE, { passes: [] });
  const last = db.passes.slice(-1)[0] || {};
  const expires = last && last.expires_at ? new Date(last.expires_at * 1000).toLocaleDateString() : 'N/A';

  const title = offer.title || 'Your Coupon';
  const brand = offer.restaurant || '';
  const desc =
    offer.description ||
    'Show this coupon to the cashier to redeem. One redemption per customer.';

  const html = `
  <!doctype html><html><head><meta charset="utf-8">
    <title>${title}</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
  </head>
  <body style="font-family:Arial,Helvetica,sans-serif;max-width:720px;margin:auto;padding:18px">
    <h1 style="font-size:42px;margin:0 0 4px 0">${title}</h1>
    ${brand ? `<p style="margin:0 0 18px 0;color:#666;font-style:italic">${brand}</p>` : ''}
    <p style="margin:0 0 22px 0">${desc}</p>

    <div style="text-align:center;margin:22px 0">
      <img alt="coupon qr" src="/api/qrcode/${encodeURIComponent(rawToken)}" />
    </div>

    <p style="margin:0 0 8px 0">Code:
      <span style="display:inline-block;background:#f2f2f2;border-radius:8px;padding:6px 10px;font-family:monospace">
        ${rawToken}
      </span>
    </p>
    <p style="margin:0 0 16px 0">Expires: ${expires}</p>

    <p style="color:#777"><small>
      Tip: Add this page to your phone's Home Screen for quick access. Show this screen to the cashier to redeem. One redemption per coupon.
    </small></p>
  </body></html>`;
  res.send(html);
});

  // create token & store pass
  const rawToken = genToken();
  createPass(rawToken, offerId);

  // load offer data
  const offer = OFFERS[offerId] || {};
  const title = offer.title || 'Coupon';
  const restaurant = offer.restaurant || '';
  const description = offer.description || '';
  const db = readJsonSafe(PASSES_FILE, { passes: [] });
  const last = db.passes.slice(-1)[0] || {};
  const expires = last && last.expires_at ? new Date(last.expires_at * 1000).toLocaleDateString() : 'N/A';

  // HTML — slightly more styled and print-friendly
  const html = `<!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${escapeHtml(title)}</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;800&display=swap" rel="stylesheet">
    <style>
      :root{
        --maxw:720px;
        --accent:#111;
        --muted:#6b6b6b;
      }
      html,body{height:100%;margin:0}
      body{
        font-family: Inter, system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial;
        color:var(--accent);
        -webkit-font-smoothing:antialiased;
        -moz-osx-font-smoothing:grayscale;
        line-height:1.4;
        display:flex;
        justify-content:center;
        padding:24px;
        background:#fff;
      }
      .page{
        max-width:var(--maxw);
        width:100%;
      }

      header{
        margin-bottom:12px;
      }
      h1{
        font-size:42px;
        margin:0 0 6px 0;
        font-weight:800;
        letter-spacing:-0.02em;
      }
      .restaurant{
        font-size:18px;
        color:var(--muted);
        font-style:italic;
        margin-bottom:16px;
      }
      .desc{
        font-size:17px;
        margin-bottom:22px;
        color:#222;
      }

      .qr-wrap{display:flex;justify-content:center;align-items:center;margin:12px 0 8px 0}
      .qr-wrap img{width:320px;height:320px;max-width:48vw;max-height:48vw;border-radius:4px}

      .meta{display:flex;flex-direction:column;gap:10px;margin-top:12px}
      .code{font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, "Roboto Mono", monospace; font-size:20px; background:#f7f7f7;padding:8px 12px;border-radius:6px;display:inline-block}
      .expires{font-size:16px;color:var(--muted)}
      .hint{margin-top:8px;font-size:14px;color:#666}

      /* print styles: remove shadows, use full width */
      @media print {
        h1{font-size:36px}
        .qr-wrap img{width:260px;height:260px}
      }
    </style>
  </head>
  <body>
    <div class="page">
      <header>
        <h1>${escapeHtml(title)}</h1>
        <div class="restaurant">${escapeHtml(restaurant)}</div>
        <div class="desc">${escapeHtml(description)}</div>
      </header>

      <main>
        <div class="qr-wrap">
          <img alt="coupon qr" src="/api/qrcode/${encodeURIComponent(rawToken)}" />
        </div>

        <div class="meta">
          <div>Code: <span class="code">${escapeHtml(rawToken)}</span></div>
          <div class="expires">Expires: ${escapeHtml(expires)}</div>
          <div class="hint">Tip: Add this page to your phone's Home Screen for quick access. Show this screen to the cashier to redeem. One redemption per coupon.</div>
        </div>
      </main>
    </div>
  </body>
  </html>`;

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

// validate page (view coupon + staff-friendly dropdown of stores)
app.get('/validate', (req, res) => {
  const rawToken = req.query.token || '';
  const p = rawToken ? findPassByRawToken(rawToken) : null;
  const ok = p && p.status === 'issued' && (Math.floor(Date.now()/1000) <= p.expires_at);
  const expires = p ? new Date(p.expires_at * 1000).toLocaleDateString() : 'N/A';

  // build store options
  const storeOptions = Object.keys(STORES).map(code => `<option value="${code}">${code} — ${STORES[code]}</option>`).join('\n');

  const html = `
  <!doctype html><html><head><meta charset="utf-8"><title>Coupon</title></head>
  <body style="font-family:Arial;max-width:720px;margin:auto;padding:18px">
    <h1>Coupon</h1>
    ${ rawToken ? `<div style="text-align:center"><img alt="coupon qr" src="/api/qrcode/${encodeURIComponent(rawToken)}" /></div>` : '<p>No token provided</p>' }
    <p style="font-family:monospace">Code: <strong>${rawToken || ''}</strong></p>
    <p>Status: <strong>${ok ? 'Valid' : (rawToken ? 'Invalid or Redeemed' : '—')}</strong></p>
    <p>Expires: ${expires}</p>
    <p>Valid Store: ${ (OFFERS[p?.offer_id]?.store_id) || 'Any ' + (OFFERS[p?.offer_id]?.restaurant || 'location') }</p>
    <hr/>
    <h3>For Staff: quick store selector</h3>
    <p>Select your store (so you don't have to type):</p>
    <select id="storeSelect">
      ${storeOptions}
    </select>
    <p><small>To redeem: open your register's redeem.html and scan the QR, or copy the Code and paste into the register input.</small></p>
  </body></html>`;
  res.send(html);
});

// POST /api/redeem (protected by x-api-key)
app.post('/api/redeem', (req, res) => {
  const key = req.header('x-api-key');
  if (!key || key !== API_KEY) return res.status(401).json({ ok:false, message:'Invalid API key' });

  const { token, store_id, staff_id } = req.body || {};
  if (!token || !store_id) return res.status(400).json({ ok:false, message:'Missing token or store_id', reason:'missing' });

  const result = redeemPassByRawToken(token, store_id, staff_id);
  if (result.ok) {
    const pass = findPassByRawToken(token);
    const offer = OFFERS[pass.offer_id] || {};
    return res.json({ ok:true, message:'Redeemed', offer: { id: pass.offer_id, title: offer.title || '', restaurant: offer.restaurant || '' }, token_hash: pass.token_hash });
  } else {
    return res.status(400).json({ ok:false, message: result.message || 'Error', reason: result.reason });
  }
});

// Admin page (one-click CSV download after admin pastes the API key) - no secrets stored
app.get('/admin', (req, res) => {
  const html = `
  <!doctype html><html><head><meta charset="utf-8"><title>Admin — Download CSV</title></head>
  <body style="font-family:Arial;max-width:720px;margin:auto;padding:18px">
    <h1>Admin — Download Redemption CSV</h1>
    <p>Paste the API key below (it is not stored) then click "Download CSV".</p>
    <input id="apiKey" type="password" style="width:100%;padding:8px" placeholder="Paste API key here" />
    <button id="dl" style="margin-top:8px;padding:8px 12px">Download CSV</button>
    <p id="status" style="margin-top:12px;color:#444"></p>
    <script>
      document.getElementById('dl').addEventListener('click', async () => {
        const key = document.getElementById('apiKey').value.trim();
        if (!key) { alert('Paste the API key first'); return; }
        document.getElementById('status').textContent = 'Requesting report...';
        try {
          const resp = await fetch('/report', { headers: { 'x-api-key': key }});
          if (!resp.ok) {
            const txt = await resp.text();
            document.getElementById('status').textContent = 'Error: ' + txt;
            return;
          }
          const blob = await resp.blob();
          const url = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = url;
          a.download = 'redeem_report.csv';
          document.body.appendChild(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
          document.getElementById('status').textContent = 'Downloaded redeem_report.csv';
        } catch (e) {
          document.getElementById('status').textContent = 'Network or error: ' + e.message;
        }
      });
    </script>
  </body></html>`;
  res.send(html);
});

// /report — protected CSV (requires x-api-key header)
app.get('/report', (req, res) => {
  const key = req.header('x-api-key');
  if (!key || key !== API_KEY) return res.status(401).send('Invalid API key');

  const db = readJsonSafe(PASSES_FILE, { passes: [] });
  const headers = ['id','offer_id','restaurant','status','issued_at','expires_at','redeemed_at','redeemed_by_store','redeemed_by_staff','token_hash'];
  const rows = db.passes.map(p => [
    p.id,
    p.offer_id || '',
    p.restaurant || '',
    p.status || '',
    p.issued_at || '',
    p.expires_at || '',
    p.redeemed_at || '',
    (p.redeemed_by && p.redeemed_by.store_code) || '',
    (p.redeemed_by && p.redeemed_by.staff_id) || '',
    p.token_hash || ''
  ]);
  const csv = [headers.join(',')].concat(rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(','))).join('\n');
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition','attachment; filename="redeem_report.csv"');
  res.send(csv);
});

app.get('/healthz', (req, res) => res.send('ok'));

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}, BASE_URL=${BASE_URL}`);
});
