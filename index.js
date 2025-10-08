// index.js
// Minimal one-time coupon server
// Node 18+ recommended

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: false }));

// Config from environment
const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || (`http://localhost:${PORT}`);
const API_KEY = process.env.API_KEY || ''; // protect this (do not commit)
const PASSES_FILE = path.join(__dirname, 'passes.json');
const OFFERS_FILE = path.join(__dirname, 'offers.json');
const STORES_FILE = path.join(__dirname, 'stores.json');

// Helper: safe read JSON file, fallback default
function readJsonSafe(filePath, fallback) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}
function writeJsonSafe(filePath, obj) {
  fs.writeFileSync(filePath, JSON.stringify(obj, null, 2));
}

// Ensure passes.json exists
if (!fs.existsSync(PASSES_FILE)) {
  writeJsonSafe(PASSES_FILE, { passes: [] });
}

// Load static files (offers/stores)
const OFFERS = readJsonSafe(OFFERS_FILE, {});
const STORES = readJsonSafe(STORES_FILE, {});

// Utility: generate random token (URL-safe)
function genToken(bytes = 12) {
  return crypto.randomBytes(bytes).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/,'');
}
function hashToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

// Create a new pass (store only hash)
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

// Find pass by raw token (using hash)
function findPassByRawToken(rawToken) {
  const token_hash = hashToken(rawToken);
  const db = readJsonSafe(PASSES_FILE, { passes: [] });
  return db.passes.find(p => p.token_hash === token_hash);
}

// Redeem pass safely (idempotent)
function redeemPassByRawToken(rawToken, store_code, staff_id) {
  const db = readJsonSafe(PASSES_FILE, { passes: [] });
  const token_hash = hashToken(rawToken);
  const p = db.passes.find(x => x.token_hash === token_hash);
  if (!p) return { ok:false, reason:'invalid', message:'Invalid coupon' };
  if (p.status === 'redeemed') return { ok:false, reason:'already_used', message:'Coupon already redeemed' };
  const now = Math.floor(Date.now() / 1000);
  if (p.expires_at && now > p.expires_at) return { ok:false, reason:'expired', message:'Coupon expired' };

  // check store mapping
  const storeName = (STORES && STORES[store_code]) ? STORES[store_code] : null;
  if (!storeName) return { ok:false, reason:'unknown_store', message:'Unknown store code' };

  // check restaurant match
  if (p.restaurant && storeName !== p.restaurant) {
    return { ok:false, reason:'mismatch', message: `Coupon is for ${p.restaurant} — not valid at this store.` };
  }

  // mark as redeemed
  p.status = 'redeemed';
  p.redeemed_at = now;
  p.redeemed_by = { store_code, staff_id: staff_id || null };

  writeJsonSafe(PASSES_FILE, db);
  return { ok:true, message:'Redeemed', offer_id: p.offer_id };
}

// QR image endpoint: returns PNG data (application/png)
app.get('/api/qrcode/:token', async (req, res) => {
  const token = req.params.token;
  const url = `${BASE_URL}/validate?token=${encodeURIComponent(token)}`;
  try {
    const png = await QRCode.toBuffer(url, { type: 'png', width: 300 });
    res.setHeader('Content-Type', 'image/png');
    return res.send(png);
  } catch (err) {
    return res.status(500).send('QR error');
  }
});

// coupon page -> generate token and show coupon HTML
app.get('/coupon', async (req, res) => {
  const offerId = req.query.offer;
  if (!offerId || !OFFERS[offerId]) {
    return res.status(400).send('Invalid offer id');
  }
  const rawToken = genToken();
  createPass(rawToken, offerId);

  // Show a minimal coupon page with QR (image from /api/qrcode/:token)
  const expires_ts = readJsonSafe(PASSES_FILE, { passes: [] }).passes.slice(-1)[0].expires_at;
  const expires = new Date(expires_ts * 1000).toLocaleDateString();

  const html = `
  <!doctype html>
  <html>
  <head><meta charset="utf-8"><title>Save your coupon</title></head>
  <body style="font-family:Arial;max-width:720px;margin:auto;padding:18px">
    <h1>Save your one-time coupon</h1>
    <p>Show this to the cashier to redeem. One redemption per coupon.</p>
    <div style="text-align:center">
      <img alt="coupon qr" src="/api/qrcode/${encodeURIComponent(rawToken)}" />
    </div>
    <p style="font-family:monospace">Code: <strong>${rawToken}</strong></p>
    <p>Expires: ${expires}</p>
    <p>If the QR doesn't work, show the code above to staff.</p>
    <p><small>Tip: Add to Home Screen for quick access</small></p>
  </body>
  </html>`;
  res.send(html);
});

// validate page: show same UI if someone navigates to validate?token=...
app.get('/validate', (req, res) => {
  const rawToken = req.query.token;
  if (!rawToken) return res.status(400).send('Missing token');
  const p = findPassByRawToken(rawToken);
  const ok = p && p.status === 'issued' && (Math.floor(Date.now()/1000) <= p.expires_at);
  const expires = p ? new Date(p.expires_at * 1000).toLocaleDateString() : 'N/A';
  const html = `
  <!doctype html><html><head><meta charset="utf-8"><title>Coupon</title></head><body style="font-family:Arial;max-width:720px;margin:auto;padding:18px">
    <h1>Coupon</h1>
    <div style="text-align:center"><img alt="coupon qr" src="/api/qrcode/${encodeURIComponent(rawToken)}" /></div>
    <p style="font-family:monospace">Code: <strong>${rawToken}</strong></p>
    <p>Status: <strong>${ok ? 'Valid' : 'Invalid or Redeemed'}</strong></p>
    <p>Expires: ${expires}</p>
    <p>Show this to cashier to redeem. One redemption per coupon.</p>
  </body></html>`;
  res.send(html);
});

// API redeem: POST with JSON { token, store_id, staff_id } + header x-api-key
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

// Admin report (CSV) protected by x-api-key
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
    (p.redeemed_by && p.redeemed_by.store_code) || (p.redeemed_by && p.redeemed_by.store_code) || (p.redeemed_by && p.redeemed_by.store) || '',
    (p.redeemed_by && p.redeemed_by.staff_id) || (p.redeemed_by && p.redeemed_by.staff) || '',
    p.token_hash || ''
  ]);
  const csv = [headers.join(',')].concat(rows.map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(','))).join('\n');
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition','attachment; filename="redeem_report.csv"');
  res.send(csv);
});

// small health
app.get('/healthz', (req,res) => res.send('ok'));

app.listen(PORT, () => {
  console.log(`Server listening on ${PORT}, BASE_URL=${BASE_URL}`);
});
