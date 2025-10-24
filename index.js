// index.js
// One-time coupon server (Node 18+)
// Requires env: COUPON_BASE_URL or BASE_URL, API_KEY

const express = require('express');
const fs = require('fs');
const path = require('path');                 // <- keep this ONCE
const crypto = require('crypto');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// ---------- CORS (allow local redeem.html and other origins) ----------
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); // restrict to specific origins if needed
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, x-user-id');
  res.setHeader('Access-Control-Allow-Methods', 'POST,GET,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200); // preflight
  next();
});

// ---------- Static assets (/public -> /static/...) ----------
app.use('/static', express.static(path.join(__dirname, 'public')));

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
const AVG_TICKET = Number(process.env.AVG_TICKET || 18);

// ---------- Paths ----------
const PASSES_FILE = path.join(__dirname, 'passes.json');
const OFFERS_FILE = path.join(__dirname, 'offers.json');
const STORES_FILE = path.join(__dirname, 'stores.json');
const ANALYTICS_FILE = path.join(__dirname, 'analytics.json');
const LOYALTY_FILE = path.join(__dirname, 'loyalty.json');

// ---------- Helpers for JSON files ----------
function readJsonSafe(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return fallback; }
}
function writeJsonSafe(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

// Ensure files exist
if (!fs.existsSync(PASSES_FILE)) writeJsonSafe(PASSES_FILE, { passes: [] });
if (!fs.existsSync(ANALYTICS_FILE)) writeJsonSafe(ANALYTICS_FILE, { events: [] });
if (!fs.existsSync(LOYALTY_FILE)) writeJsonSafe(LOYALTY_FILE, { entries: [] });

// Load offers & stores (canonical sources)
const OFFERS = readJsonSafe(OFFERS_FILE, {});
const STORES = readJsonSafe(STORES_FILE, {});

// ---------- Analytics helpers ----------
function appendAnalyticsEvent(evt) {
  const now = new Date().toISOString();
  const record = { ts: now, ...evt };
  const buf = readJsonSafe(ANALYTICS_FILE, { events: [] });
  buf.events.push(record);
  writeJsonSafe(ANALYTICS_FILE, buf);
  return record;
}

// ---------- Loyalty helpers ----------
function addLoyalty({ user_id = 'anon', restaurant, points = 10, reason = 'coupon_redeem' }) {
  const buf = readJsonSafe(LOYALTY_FILE, { entries: [] });
  buf.entries.push({ ts: new Date().toISOString(), user_id, restaurant, points, reason });
  writeJsonSafe(LOYALTY_FILE, buf);
}

// ---------- Token helpers ----------
function genToken(bytes = 12) {
  return crypto.randomBytes(bytes).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// Create pass (store token hash only)
function createPass(rawToken, offerId) {
  const token_hash = hashToken(rawToken);
  const now = Math.floor(Date.now() / 1000);
  const offer = OFFERS[offerId] || null;
  const expires_at = offer && offer.expires_days
    ? now + offer.expires_days * 24 * 60 * 60
    : now + 90 * 24 * 60 * 60;

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

/**
 * Redeem by raw token with:
 * - invalid/already used/expired checks
 * - store existence check
 * - OPTIONAL store-restriction enforcement (offer.store_id)
 * - brand safety check (restaurant mismatch)
 */
function redeemPassByRawToken(rawToken, store_code, staff_id) {
  const db = readJsonSafe(PASSES_FILE, { passes: [] });
  const token_hash = hashToken(rawToken);
  const p = db.passes.find(x => x.token_hash === token_hash);
  if (!p) return { ok: false, reason: 'invalid', message: 'Invalid coupon' };
  if (p.status === 'redeemed') return { ok: false, reason: 'already_used', message: 'Coupon already redeemed' };

  const now = Math.floor(Date.now() / 1000);
  if (p.expires_at && now > p.expires_at) return { ok: false, reason: 'expired', message: 'Coupon expired' };

  // store metadata may be a string (brand) or object {brand, pos, ...}
  const storeRecord = STORES[store_code];
  const storeName = typeof storeRecord === 'string'
    ? storeRecord
    : (storeRecord && storeRecord.brand) || null;
  if (!storeName) return { ok: false, reason: 'unknown_store', message: 'Unknown store code' };

  const offer = OFFERS[p.offer_id] || {};
  // enforce store-specific restriction
  if (offer.store_id && store_code !== offer.store_id) {
    return { ok: false, reason: 'wrong_store', message: `Coupon only valid at store ${offer.store_id}` };
  }
  // brand safety
  if (p.restaurant && storeName !== p.restaurant) {
    return { ok: false, reason: 'mismatch', message: `Coupon is for ${p.restaurant} — not valid at this store.` };
  }

  // mark redeemed
  p.status = 'redeemed';
  p.redeemed_at = now;
  p.redeemed_by = { store_code, staff_id: staff_id || null };
  writeJsonSafe(PASSES_FILE, db);
  return { ok: true, message: 'Redeemed', offer_id: p.offer_id };
}

// ---------- POS adapter stubs (optional; fill with real API calls or local bridge) ----------
const adapters = {
  async square(ctx) { console.log('[POS:square] apply', ctx); },
  async toast(ctx)  { console.log('[POS:toast] apply', ctx);  },
  async clover(ctx) { console.log('[POS:clover] apply', ctx); },
  async 'local-bridge'(ctx) {
    if (!ctx.store.bridge_url) throw new Error('bridge_url missing for local-bridge');
    const res = await fetch(ctx.store.bridge_url, {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body: JSON.stringify({
        offer_id: ctx.offer_id,
        order_id: ctx.order_id || null,
        discount: ctx.offer.discount || null
      })
    }).catch(e => { throw new Error('local-bridge unreachable: ' + e.message); });
    if (!res.ok) throw new Error('local-bridge HTTP ' + res.status);
  }
};
async function applyDiscountToPOS({ store_meta, offer, offer_id, order_id }) {
  const provider = (store_meta && store_meta.pos) || null;
  if (!provider) { console.log('[POS] no provider; skipping'); return; }
  const fn = adapters[provider];
  if (!fn) { console.log('[POS] unknown provider', provider); return; }
  const ctx = { store: store_meta, offer, offer_id, order_id };
  await fn(ctx);
}

// ---------- Offers catalog API (Hub) ----------
app.get('/api/offers', (req, res) => {
  const { lat, lon, limit = 100 } = req.query;
  const items = Object.entries(OFFERS)
    .filter(([id]) => !String(id).startsWith('//')) // ignore comment keys
    .map(([id, o]) => ({
      offer_id: id,
      title: o.title,
      details: o.description || '',
      restaurant: o.restaurant || '',
      address: o.store_address || '',
      logo: o.logo || '',
      lat: o.lat ?? null,  // optional if you add coords later
      lon: o.lon ?? null
    }));

  let rows = items;
  if (lat && lon) {
    const toRad = d => (d * Math.PI) / 180;
    const R = 6371; // km
    rows = items.map(r => {
      if (r.lat != null && r.lon != null) {
        const dLat = toRad(r.lat - Number(lat));
        const dLon = toRad(r.lon - Number(lon));
        const a = Math.sin(dLat/2)**2 + Math.cos(toRad(Number(lat))) * Math.cos(toRad(r.lat)) * Math.sin(dLon/2)**2;
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        return { ...r, distance_km: R * c };
      }
      return { ...r, distance_km: null };
    }).sort((a,b) => (a.distance_km ?? 1e9) - (b.distance_km ?? 1e9));
  }

  res.json(rows.slice(0, Number(limit)));
});

app.get('/api/offers/:offerId', (req, res) => {
  const o = OFFERS[req.params.offerId];
  if (!o) return res.status(404).json({ error: 'Not found' });
  appendAnalyticsEvent({ event: 'view', offer_id: req.params.offerId, restaurant: o.restaurant || null });
  res.json({ offer_id: req.params.offerId, ...o });
});

// ---------- Analytics event ingest ----------
app.post('/api/analytics/event', (req, res) => {
  const { event, offer_id=null, restaurant=null, user_id=null, meta=null } = req.body || {};
  if (!event) return res.status(400).json({ error: 'event required' });
  const rec = appendAnalyticsEvent({ event, offer_id, restaurant, user_id, meta });
  res.json({ ok: true, ts: rec.ts });
});

// ---------- Hub page ----------
app.get('/hub', (req,res) => res.sendFile(path.join(__dirname, 'views', 'hub.html')));

// ---------- Wallet add (stub; logs wallet_add) ----------
app.get('/wallet/add', (req,res) => {
  const offer = req.query.offer;
  const o = offer ? OFFERS[offer] : null;
  if (!o) return res.status(404).send('Offer not found');
  appendAnalyticsEvent({ event: 'wallet_add', offer_id: offer, restaurant: o.restaurant || null });

  res.send(`
    <!doctype html><html><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>Added to Wallet</title></head>
    <body style="font-family:Arial,Helvetica,sans-serif;max-width:720px;margin:auto;padding:18px">
      <h2>Wallet Pass Ready</h2>
      <p>Your device may prompt you to save this pass when fully integrated with Apple/Google Wallet.</p>
      <p><a href="/coupon?offer=${encodeURIComponent(offer)}">Back to coupon</a></p>
    </body></html>
  `);
});

// ---------- PNG QR endpoint for a raw token (links to validate page) ----------
app.get('/api/qrcode/:token', async (req, res) => {
  const token = req.params.token;
  const url = `${BASE_URL}/validate?token=${encodeURIComponent(token)}`;
  try {
    const png = await QRCode.toBuffer(url, { type: 'png', width: 300 });
    res.setHeader('Content-Type', 'image/png');
    res.send(png);
  } catch (err) {
    console.error('QR generation error', err);
    res.status(500).send('QR error');
  }
});

// ---------- Styled coupon page: create a token and display QR + branding ----------
app.get('/coupon', (req, res) => {
  const offerId = req.query.offer;
  const offer = offerId ? OFFERS[offerId] : null;
  if (!offer) return res.status(400).send('Invalid offer id');

  // analytics: scan-on-open
  appendAnalyticsEvent({ event: 'scan', offer_id: offerId, restaurant: offer ? offer.restaurant : null });

  const rawToken = genToken();
  createPass(rawToken, offerId);

  const db = readJsonSafe(PASSES_FILE, { passes: [] });
  const last = db.passes.slice(-1)[0] || {};
  const expiresDate = last && last.expires_at ? new Date(last.expires_at * 1000) : null;
  const expires = expiresDate ? expiresDate.toLocaleDateString() : 'N/A';

  // Offer fields (with fallbacks)
  const title       = offer.title || 'Your Coupon';
  const brand       = offer.restaurant || '';
  const addr        = offer.store_address || '';
  const logo        = offer.logo || '';
  const hero        = offer.hero_image || '';
  const brandColor  = offer.brand_color || '#111';
  const accentColor = offer.accent_color || '#333';
  const finePrint   = offer.fine_print || 'One redemption per customer.';
  const descHtml    = offer.desc_html || '';
  const plainDesc   = offer.description || 'Show this coupon to the cashier to redeem. One redemption per customer.';
  const ogImg       = hero || logo || '';

  const html = `
  <!doctype html>
  <html lang="en">
  <head>
    <meta charset="utf-8">
    <title>${title}</title>
    <meta name="viewport" content="width=device-width,initial-scale=1">
    ${ogImg ? `<meta property="og:image" content="${ogImg}">` : ''}
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;800&display=swap" rel="stylesheet">
    <style>
      :root{ --brand:${brandColor}; --accent:${accentColor}; }
      *{box-sizing:border-box}
      body{font-family:Inter,system-ui,Arial,Helvetica,sans-serif;background:#fff;margin:0}
      .wrap{max-width:760px;margin:0 auto;padding:18px}
      .brandbar{display:flex;align-items:center;gap:14px;margin:6px 0 10px}
      .brandbar img.logo{height:64px}
      .brandname{color:var(--brand);font-weight:800}
      h1{font-size:40px;line-height:1.1;margin:6px 0 2px;color:#111}
      .brand{color:#666;font-style:italic;margin:0 0 6px}
      .desc{margin:10px 0 12px 0;font-size:16px;color:#111}
      .validonly{margin:8px 0 16px 0;color:#444}
      .validonly strong{color:#000}
      .hero{width:100%;border-radius:12px;display:block;margin:10px 0 16px 0}
      .card{border:1px solid #e7e7e7;border-radius:14px;padding:16px;margin:16px 0}
      .qrwrap{text-align:center;margin:10px 0}
      .code{margin:10px 0;font-size:16px}
      .code .pill{display:inline-block;background:#f2f2f2;border-radius:10px;padding:8px 12px;font-family:ui-monospace,monospace}
      .expires{margin:0 0 8px 0;color:#111}
      .fine{color:#666;font-size:13px}
      .tag{display:inline-block;background:var(--brand);color:#fff;padding:4px 8px;border-radius:6px;font-weight:600;font-size:12px}
      .divider{height:1px;background:#eee;margin:16px 0}
      .footerTip{color:#777;font-size:13px}
      .badge{display:inline-flex;align-items:center;gap:6px}
      .badge .dot{width:8px;height:8px;border-radius:50%;background:var(--brand)}
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="brandbar">
        ${logo
          ? `<img class="logo" alt="${brand} logo" src="${logo}">`
          : `<span class="badge"><span class="dot"></span><span class="brandname">${brand || ''}</span></span>`
        }
      </div>

      <h1>${title}</h1>
      <p class="brand">${brand}</p>

      ${descHtml ? `<div class="desc">${descHtml}</div>` : `<p class="desc">${plainDesc}</p>`}
      ${addr ? `<p class="validonly"><strong>Valid only at:</strong> ${addr}</p>` : ''}

      ${hero ? `<img class="hero" alt="Offer image" src="${hero}">` : ''}

      <div class="card">
        <div class="qrwrap">
          <img alt="coupon qr" src="/api/qrcode/${encodeURIComponent(rawToken)}" />
        </div>
        <p class="code">Code: <span class="pill">${rawToken}</span></p>
        <p class="expires">Expires: ${expires}</p>
        <div class="divider"></div>
        <p class="fine">${finePrint}</p>
      </div>

      <p class="footerTip"><small>
        Tip: Add this page to your phone's Home Screen for quick access. Show this screen to the cashier to redeem. One redemption per coupon.
      </small></p>
    </div>
  </body>
  </html>`;
  res.send(html);
});

// ---------- validate page (view coupon + staff-friendly info) ----------
app.get('/validate', (req, res) => {
  const rawToken = req.query.token || '';
  const p = rawToken ? findPassByRawToken(rawToken) : null;
  const now = Math.floor(Date.now() / 1000);
  const ok = p && p.status === 'issued' && (now <= (p.expires_at || 0));
  const expires = p ? new Date(p.expires_at * 1000).toLocaleDateString() : 'N/A';

  const offer = p ? (OFFERS[p.offer_id] || {}) : {};
  const validStoreText = offer.store_id ? offer.store_id : ('Any ' + (offer.restaurant || 'location'));
  const addr = offer.store_address || '';
  const title = offer.title || 'Coupon';
  const brand = offer.restaurant || '';
  const desc = offer.description || '';

  // analytics: view
  if (p && p.offer_id) {
    appendAnalyticsEvent({ event: 'view', offer_id: p.offer_id, restaurant: brand || null });
  }

  const html = `
  <!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
  <meta name="viewport" content="width=device-width,initial-scale=1"></head>
  <body style="font-family:Arial,Helvetica,sans-serif;max-width:720px;margin:auto;padding:18px">
    <h1 style="margin:0 0 4px 0">${title}</h1>
    ${brand ? `<p style="margin:0 0 18px 0;color:#666;font-style:italic">${brand}</p>` : ''}
    ${desc ? `<p style="margin:0 0 18px 0">${desc}</p>` : ''}
    <p><strong>Valid Store:</strong> ${validStoreText}</p>
    ${addr ? `<p><strong>Address:</strong> ${addr}</p>` : ''}

    <hr style="margin:18px 0"/>
    ${ rawToken ? `<div style="text-align:center"><img alt="coupon qr" src="/api/qrcode/${encodeURIComponent(rawToken)}" /></div>` : '<p>No token provided</p>' }
    <p style="font-family:monospace">Code: <strong>${rawToken || ''}</strong></p>
    <p>Status: <strong>${ok ? 'Valid' : (rawToken ? 'Invalid or Redeemed' : '—')}</strong></p>
    <p>Expires: ${expires}</p>

    <p><small>For redemption, open your register’s redeem.html, select your store, then scan/paste the Code.</small></p>
  </body></html>`;
  res.send(html);
});

// ---------- POST /api/redeem (protected by x-api-key) ----------
app.post('/api/redeem', async (req, res) => {
  const key = req.header('x-api-key');
  if (!key || key !== API_KEY) return res.status(401).json({ ok: false, message: 'Invalid API key' });

  const { token, store_id, staff_id, order_id } = req.body || {};
  if (!token || !store_id) return res.status(400).json({ ok: false, message: 'Missing token or store_id', reason: 'missing' });

  const result = redeemPassByRawToken(token, store_id, staff_id);
  if (result.ok) {
    const pass = findPassByRawToken(token);
    const offer = OFFERS[pass.offer_id] || {};
    const rawStore = STORES[store_id];
    const store_meta = (typeof rawStore === 'string') ? { brand: rawStore } : (rawStore || {});

    // analytics + loyalty
    appendAnalyticsEvent({ event: 'redeem', offer_id: pass.offer_id, restaurant: offer.restaurant || null, meta: { store_id } });
    addLoyalty({ user_id: (req.headers['x-user-id'] || 'anon'), restaurant: offer.restaurant || '', points: 10 });

    // Try POS apply (optional)
    try {
      await applyDiscountToPOS({
        store_meta,
        offer,
        offer_id: pass.offer_id,
        order_id: order_id || null
      });
    } catch (e) {
      console.error('POS apply error:', e.message);
    }

    return res.json({
      ok: true,
      message: 'Redeemed',
      offer: { id: pass.offer_id, title: offer.title || '', restaurant: offer.restaurant || '' },
      token_hash: pass.token_hash
    });
  } else {
    return res.status(400).json({ ok: false, message: result.message || 'Error', reason: result.reason });
  }
});

// ---------- Admin page (CSV download after API key paste) ----------
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

// ---------- /report — protected CSV (existing redemption CSV) ----------
app.get('/report', (req, res) => {
  const key = req.header('x-api-key');
  if (!key || key !== API_KEY) return res.status(401).send('Invalid API key');

  const db = readJsonSafe(PASSES_FILE, { passes: [] });
  const headers = [
    'id','offer_id','restaurant','status','issued_at','expires_at',
    'redeemed_at','redeemed_by_store','redeemed_by_staff','token_hash'
  ];
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
  const csv = [headers.join(',')]
    .concat(rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(',')))
    .join('\n');

  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition','attachment; filename="redeem_report.csv"');
  res.send(csv);
});

// ---------- Analytics CSV (separate) ----------
app.get('/report-analytics.csv', (req,res) => {
  const key = req.header('x-api-key');
  if (!key || key !== API_KEY) return res.status(401).send('Invalid API key');

  const buf = readJsonSafe(ANALYTICS_FILE, { events: [] });
  const rows = buf.events || [];
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition','attachment; filename="acp_analytics.csv"');
  res.write('ts,event,offer_id,restaurant,user_id,meta\n');
  for (const r of rows) {
    const meta = r.meta ? JSON.stringify(r.meta).replace(/[\n\r,]/g,' ') : '';
    res.write([r.ts, r.event, r.offer_id||'', r.restaurant||'', r.user_id||'', meta].join(',')+'\n');
  }
  res.end();
});

// ---------- Dashboard API + page ----------
app.get('/api/dashboard/summary', (req, res) => {
  const buf = readJsonSafe(ANALYTICS_FILE, { events: [] });
  const ev = buf.events || [];
  const scans = ev.filter(e => e.event === 'scan').length;
  const wallet_adds = ev.filter(e => e.event === 'wallet_add').length;
  const redemptions = ev.filter(e => e.event === 'redeem').length;

  const estimated_revenue = redemptions * AVG_TICKET;

  // last 30 days by day
  const cutoff = Date.now() - 30*24*60*60*1000;
  const map = new Map();
  ev.forEach(e => {
    const t = new Date(e.ts).getTime();
    if (isNaN(t) || t < cutoff) return;
    const day = new Date(e.ts).toISOString().slice(0,10);
    const cur = map.get(day) || { scans:0, redemptions:0 };
    if (e.event === 'scan') cur.scans++;
    if (e.event === 'redeem') cur.redemptions++;
    map.set(day, cur);
  });
  const daily = [...map.entries()].sort((a,b)=>a[0].localeCompare(b[0]))
                  .map(([day,v])=>({ day, ...v }));

  res.json({ scans, wallet_adds, redemptions, estimated_revenue, daily });
});

app.get(['/dashboard', '/hub/dashboard'], (req, res) =>
  res.sendFile(path.join(__dirname, 'views', 'dashboard.html'))
);

app.get('/healthz', (req, res) => res.send('ok'));

// ---------- Start ----------
app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}, BASE_URL=${BASE_URL}`);
});
