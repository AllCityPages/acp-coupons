// index.js — ACP Coupons (Node 20.x)
// Light marketplace UI + Wallet + Geo alerts + Analytics + CSV/PDF + SW cache control

const express = require('express');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const QRCode = require('qrcode');
const puppeteer = require('puppeteer');
const https = require('https'); // NEW: use https instead of fetch for geocode

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

// ensure dirs/files
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(PUBLIC_DIR)) fs.mkdirSync(PUBLIC_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ passes: [], redemptions: [] }, null, 2));
if (!fs.existsSync(EVENTS_FILE)) fs.writeFileSync(EVENTS_FILE, JSON.stringify({ events: [] }, null, 2));

// ---------- helpers ----------
const nowISO = () => new Date().toISOString();
const randHex = (n = 16) => crypto.randomBytes(n).toString('hex');
const sha12 = s => crypto.createHash('sha256').update(s).digest('hex').slice(0, 12);
const jread = async (f, fb) => { try { return JSON.parse(await fsp.readFile(f, 'utf8')); } catch { return fb; } };
const jwrite = (f, o) => fsp.writeFile(f, JSON.stringify(o, null, 2));
const csvEsc = v => {
  const s = (v ?? '').toString();
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function sendCsv(res, filename, csvString) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.status(200).send('\uFEFF' + csvString);
}

function requireKeyJson(req, res, next) {
  const k = req.header('x-api-key') || req.query.key || '';
  if (!API_KEY) return res.status(500).json({ error: 'Server missing API_KEY' });
  if (k !== API_KEY) return res.status(401).json({ error: 'Invalid API key' });
  next();
}

function parseDateISO(s){
  const d = new Date(String(s || ''));
  return Number.isFinite(d.getTime()) ? d : null;
}

function daysUntil(date){
  const now = new Date();
  const ms = date.getTime() - now.getTime();
  return Math.max(0, Math.ceil(ms / (1000*60*60*24)));
}

function isExpiredOffer(o){
  // Preferred: expires_on (YYYY-MM-DD or ISO)
  if (o && o.expires_on){
    const d = parseDateISO(o.expires_on);
    if (d) return d.getTime() < Date.now();
  }
  // Backcompat: expires_days (treated as remaining days if you keep manually updating it)
  if (typeof o.expires_days === 'number' && o.expires_days <= 0) return true;
  return false;
}

// ---------- Geocode helpers ----------
const NOM_USER_AGENT = 'ACP-Coupons/1.0 (contact: info@AllCityPages.com)';
function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }
function isFiniteNum(v){ return typeof v === 'number' && Number.isFinite(v); }
function normalizeAddrEntry(entry){
  if (typeof entry === 'string') return { label: entry };
  return {
    label: (entry && entry.label) ? String(entry.label).trim() : '',
    lat: isFiniteNum(entry?.lat) ? Number(entry.lat) : undefined,
    lng: isFiniteNum(entry?.lng) ? Number(entry.lng) : undefined
  };
}

// NEW: plain https JSON fetcher (no global fetch / node-fetch needed)
function httpGetJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const options = {
        hostname: u.hostname,
        path: u.pathname + u.search,
        method: 'GET',
        headers
      };
      const req = https.request(options, res => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data || '[]');
            resolve(json);
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('error', reject);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

async function geocodeLabel(label){
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&addressdetails=0&limit=1&q=${encodeURIComponent(label)}`;
  try{
    const arr = await httpGetJson(url, { 'User-Agent': NOM_USER_AGENT, 'Accept': 'application/json' });
    if (Array.isArray(arr) && arr[0]?.lat && arr[0]?.lon){
      return { lat: Number(arr[0].lat), lng: Number(arr[0].lon) };
    }
  }catch(e){
    console.error('geocodeLabel error for', label, e.message || e);
  }
  return null;
}

// Small utilities
const toSlug = (s) => (s || '')
  .toLowerCase()
  .normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
  .replace(/[^a-z0-9]+/g,'-')
  .replace(/(^-|-$)/g,'')
  .slice(0, 48);

// kill cache for APIs + offers.json
app.use((req, res, next) => {
  if (req.path.startsWith('/api/') || req.path === '/offers.json') {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.setHeader('Surrogate-Control', 'no-store');
  }
  next();
});

// ---------- static ----------
app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    } else if (/\.(css|js|mjs|png|jpg|jpeg|gif|svg|webp|ico|woff2?|ttf)$/.test(filePath)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    }
  }
}));

// serve /static/* from /public/*
app.use('/static', express.static(PUBLIC_DIR));

// SW no-cache
app.get('/service-worker.js', (req, res) => {
  res.setHeader('Service-Worker-Allowed', '/');
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.type('application/javascript; charset=utf-8');
  res.sendFile(path.join(PUBLIC_DIR, 'service-worker.js'));
});

// health
app.get('/health', (_req, res) => res.json({ ok: true, time: nowISO() }));

// explicit MIME-correct catalog/PWA routes
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

// ---------- load catalogs ----------
async function loadCatalog() {
  const offers = await jread(OFFERS_FILE, {});
  const stores = await jread(STORES_FILE, {});
  return { offers, stores };
}

// ======================================================================
//  COUPON ISSUANCE / VIEW  (single, with attribution)
// ======================================================================
app.get('/coupon', async (req, res) => {
  const { offers } = await loadCatalog();
  const id = (req.query.offer || '').toString();
  const offer = offers[id];
  if (!offer) return res.status(400).send('Invalid offer id');

  const src = (req.query.src || 'direct').toString(); // attribution

  const db = await jread(DB_FILE, { passes: [], redemptions: [] });
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

app.get('/coupon/view', async (req, res) => {
  const token = (req.query.token || '').toString();
  const db = await jread(DB_FILE, { passes: [] });
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
<p>Status: <b>${pass.status.toUpperCase()}</b>${pass.status === 'redeemed' ? ' ✅' : ''}</p>
<p>Token (short): <code>${pass.token_hash}</code></p>
<a class="contrast" href="/redeem.html?token=${encodeURIComponent(token)}">Show Cashier</a>
</body></html>`);
});

// ======================================================================
//  CASHIER REDEEM API
// ======================================================================
app.post('/api/redeem', async (req, res) => {
  if ((req.header('x-api-key') || '') !== API_KEY) {
    return res.status(401).json({ error: 'Invalid API key' });
  }
  const { token, store_id, staff } = req.body || {};
  if (!token || !store_id) return res.status(400).json({ error: 'Missing token/store_id' });

  const db = await jread(DB_FILE, { passes: [], redemptions: [] });
  const pass = db.passes.find(p => p.token === token);
  if (!pass) return res.status(404).json({ error: 'Token not found' });
  if (pass.status === 'redeemed') {
    return res.status(409).json({ error: 'Already redeemed', redeemed_at: pass.redeemed_at });
  }

  pass.status = 'redeemed';
  pass.redeemed_at = nowISO();
  pass.redeemed_by_store = store_id;
  pass.redeemed_by_staff = staff || '';
  db.redemptions.push({
    token,
    offer: pass.offer,
    client_slug: pass.client_slug,
    store_id,
    staff: pass.redeemed_by_staff,
    redeemed_at: pass.redeemed_at
  });
  await jwrite(DB_FILE, db);

  res.json({ ok: true, token_hash: pass.token_hash, redeemed_at: pass.redeemed_at });
});

// ======================================================================
//  PUBLIC OFFERS API (includes logo + addresses + hero_nozoom + includes)
// ======================================================================
app.get('/api/offers', async (req, res) => {
  try {
    const map = await jread(OFFERS_FILE, {});  // { "id": { ...offer... }, ... }

    const offers = Object.entries(map)
      .filter(([id, o]) => o && o.active !== false && !isExpiredOffer(o))
      .map(([id, o]) => ({
        id,
        title: o.title,
        restaurant: o.restaurant,
        description: o.description,
        category: o.category,
        expires_days: o.expires_days,
        hero_image: o.hero_image,
        logo: o.logo,
        brand_color: o.brand_color,
        accent_color: o.accent_color,
        addresses: o.addresses || [],
        fine_print: o.fine_print,
        includes: (o.includes || o.Includes || o.bundle || '').trim()
      }));

    res.json({ offers });
  } catch (err) {
    console.error('Error in /api/offers:', err);
    res.status(500).json({ offers: [], error: 'Failed to load offers' });
  }
});

// ======================================================================
//  EVENTS
// ======================================================================
app.post('/api/save', async (req, res) => {
  const { offer_id } = req.body || {};
  const ev = await jread(EVENTS_FILE, { events: [] });
  ev.events.push({ t: nowISO(), type: 'save', offer_id, meta: {} });
  await jwrite(EVENTS_FILE, ev);
  res.json({ ok: true });
});

app.post('/api/event', async (req, res) => {
  const { type, offer_id, restaurant, client_slug, meta } = req.body || {};
  const ev = await jread(EVENTS_FILE, { events: [] });
  ev.events.push({
    t: nowISO(),
    type: type || 'unknown',
    offer_id: offer_id || '',
    restaurant: restaurant || '',
    client_slug: client_slug || '',
    meta: meta || {}
  });
  await jwrite(EVENTS_FILE, ev);
  res.json({ ok: true });
});

// ======================================================================
//  STORES / NEARBY
// ======================================================================
app.get('/api/stores', async (_req, res) => {
  try {
    const obj = await jread(STORES_FILE, {});
    const list = Object.entries(obj).map(([code, meta]) => {
      if (typeof meta === 'string') return { code, brand: meta, label: meta };
      return {
        code,
        brand: meta.brand || '',
        label: meta.label || meta.brand || code,
        lat: meta.lat || null,
        lng: meta.lng || null
      };
    }).sort((a, b) => a.code.localeCompare(b.code));
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
    const d = (isFinite(s.lat) && isFinite(s.lng))
      ? haversine(me.lat, me.lng, s.lat, s.lng)
      : Infinity;
    return { code, brand: s.brand || '', distanceKm: d };
  }).filter(s => s.distanceKm <= R).sort((a, b) => a.distanceKm - b.distanceKm);

  res.json({ stores: list });
});
function haversine(lat1, lon1, lat2, lon2) {
  const toRad = v => v * Math.PI / 180, R = 6371;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ======================================================================
//  ADMIN (Hub, CSV, PDF) + Geocode + Sync Stores
// ======================================================================
function requireKey(req, res, next) {
  const k = req.header('x-api-key') || req.query.key || '';
  if (!API_KEY) return res.status(500).send('Server missing API_KEY');
  if (k !== API_KEY) return res.status(401).send('Invalid API key');
  next();
}

// ADMIN: Geocode offers.json addresses (protected)
// GET /admin/geocode?key=API_KEY[&dry=1][&id=offerId]
// ADMIN: Geocode offers.json addresses (protected)
// GET /admin/geocode?key=API_KEY[&dry=1][&id=offerId]
// ADMIN: Geocode offers.json addresses (protected)
// GET /admin/geocode?key=API_KEY[&dry=1][&id=offerId]
app.get('/admin/geocode', requireKey, async (req, res) => {
  try {
    const dry = String(req.query.dry || '') === '1';
    const onlyId = (req.query.id || '').toString();

    // Load catalogs
    const offers = await jread(OFFERS_FILE, {});
    const storesRaw = await jread(STORES_FILE, {});

    // Normalize stores into a simple list so we can "borrow" coords
    const storeList = Object.entries(storesRaw).map(([code, meta]) => {
      if (typeof meta === 'string') {
        return { code, brand: meta, label: meta, lat: null, lng: null };
      }
      return {
        code,
        brand: meta.brand || '',
        label: meta.label || meta.brand || code,
        lat: isFiniteNum(meta.lat) ? Number(meta.lat) : null,
        lng: isFiniteNum(meta.lng) ? Number(meta.lng) : null
      };
    });

    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 15);
    const backupPath = OFFERS_FILE.replace(/\.json$/i, `.backup-${stamp}.json`);
    if (!dry) fs.copyFileSync(OFFERS_FILE, backupPath);

    const ids = Object.keys(offers).filter(id => !onlyId || id === onlyId);
    let requests = 0, hits = 0, misses = 0, touchedOffers = 0, borrowed = 0;

    for (const id of ids) {
      const o = offers[id];

      // Normalize to array "addresses"
      let list = [];
      if (Array.isArray(o.addresses)) {
        list = o.addresses.map(normalizeAddrEntry);
      } else if (o.address) {
        list = [normalizeAddrEntry(o.address)];
        delete o.address;
      }

      let updated = false;
      const brand = (o.restaurant || o.brand || '').trim();

      for (let i = 0; i < list.length; i++) {
        const a = list[i];
        if (!a?.label) continue;

        const hasGeo = isFiniteNum(a.lat) && isFiniteNum(a.lng);
        if (hasGeo) continue;

        // 1) Try external geocode
        requests++;
        let geo = await geocodeLabel(a.label);
        if (geo && isFiniteNum(geo.lat) && isFiniteNum(geo.lng)) {
          a.lat = geo.lat;
          a.lng = geo.lng;
          hits++;
          updated = true;
        } else {
          // 2) Fallback: borrow from stores.json if there's a matching label
          const needle = a.label.trim().toLowerCase();
          let match = storeList.find(s =>
            s.label && s.label.trim().toLowerCase().includes(needle)
          );

          // If we didn't find by label substring, try matching by brand first
          if (!match && brand) {
            match = storeList.find(s =>
              s.brand.trim().toLowerCase() === brand.toLowerCase() &&
              s.label && s.label.trim().toLowerCase().includes(needle)
            );
          }

          if (match && isFiniteNum(match.lat) && isFiniteNum(match.lng)) {
            a.lat = match.lat;
            a.lng = match.lng;
            borrowed++;
            updated = true;
          } else {
            misses++;
          }
        }

        // Nominatim etiquette: 1 req/sec (only for actual external hits)
        await sleep(1100);
      }

      if (list.length) o.addresses = list;
      if (updated) touchedOffers++;
    }

    if (!dry) {
      await jwrite(OFFERS_FILE, offers);
    }

    res.json({
      ok: true,
      dry_run: dry,
      offers_processed: ids.length,
      offers_updated: touchedOffers,
      requests,
      hits,
      misses,
      borrowed_from_stores: borrowed,
      backup: dry ? null : path.basename(backupPath)
    });
  } catch (e) {
    console.error('geocode error', e);
    res.status(500).json({ ok: false, error: 'geocode-failed' });
  }
});

// ADMIN: Sync stores.json from offers.json (protected)
// GET /admin/sync-stores?key=API_KEY[&dry=1]
app.get('/admin/sync-stores', requireKey, async (req, res) => {
  try{
    const dry = String(req.query.dry || '') === '1';
    const offers = await jread(OFFERS_FILE, {});
    const existingStores = await jread(STORES_FILE, {}); // object map

    const indexKey = (brand, label) => `${(brand||'').trim()}|${(label||'').trim()}`.toLowerCase();
    const existingByKey = new Map();
    Object.entries(existingStores).forEach(([code, meta]) => {
      const brand = (typeof meta === 'string') ? meta : (meta.brand || '');
      const label = (typeof meta === 'string') ? meta : (meta.label || meta.brand || code);
      existingByKey.set(indexKey(brand, label), { code, meta: (typeof meta === 'string' ? { brand, label } : meta) });
    });

    const upserts = [];
    const storesOut = { ...existingStores };

    for (const [offerId, o] of Object.entries(offers)) {
      const brand = o.restaurant || o.brand || '';
      const arr = Array.isArray(o.addresses) ? o.addresses.map(normalizeAddrEntry) : [];
      arr.forEach((a, i) => {
        if (!a.label) return;
        const key = indexKey(brand, a.label);
        if (existingByKey.has(key)) {
          const { code, meta } = existingByKey.get(key);
          const oldLat = meta.lat, oldLng = meta.lng;
          const newLat = isFiniteNum(a.lat) ? a.lat : oldLat;
          const newLng = isFiniteNum(a.lng) ? a.lng : oldLng;
          const updatedMeta = { ...meta, brand: brand || meta.brand, label: a.label, lat: newLat, lng: newLng };
          if (JSON.stringify({lat:oldLat,lng:oldLng}) !== JSON.stringify({lat:newLat,lng:newLng})) {
            upserts.push({ action:'update', code, brand, label:a.label, lat:newLat, lng:newLng });
          }
          storesOut[code] = updatedMeta;
        } else {
          const code = `${toSlug(brand)||'store'}-${sha12(a.label).slice(0,6)}`;
          const meta = { brand, label: a.label };
          if (isFiniteNum(a.lat) && isFiniteNum(a.lng)) { meta.lat = a.lat; meta.lng = a.lng; }
          storesOut[code] = meta;
          existingByKey.set(key, { code, meta });
          upserts.push({ action:'insert', code, brand, label:a.label, lat: meta.lat ?? null, lng: meta.lng ?? null });
        }
      });
    }

    let backupName = null;
    if (!dry) {
      const stamp = new Date().toISOString().replace(/[-:T]/g,'').slice(0,15);
      const backupPath = STORES_FILE.replace(/\.json$/i, `.backup-${stamp}.json`);
      if (fs.existsSync(STORES_FILE)) fs.copyFileSync(STORES_FILE, backupPath);
      backupName = path.basename(backupPath);
      await jwrite(STORES_FILE, storesOut);
    }

    const total = Object.keys(storesOut).length;
    res.json({
      ok:true,
      dry_run: dry,
      total_stores_after: total,
      changes: upserts.length,
      backup: dry ? null : backupName,
      sample_changes: upserts.slice(0, 20)
    });
  }catch(e){
    console.error('sync-stores error', e);
    res.status(500).json({ ok:false, error: 'sync-stores-failed', message: e.message || String(e) });
  }
});

app.get('/hub', requireKey, async (req, res) => {
  const db = await jread(DB_FILE, { passes: [] });
  const rows = db.passes.slice().reverse().map(p => `
    <tr><td><code>${p.token_hash}</code></td><td>${p.offer}</td><td>${p.restaurant}</td>
    <td>${p.client_slug}</td><td>${p.status}</td><td>${p.issued_at}</td><td>${p.redeemed_at || ''}</td></tr>`).join('');
  const keyParam = encodeURIComponent(req.query.key || '');
  res.send(`<!doctype html><html><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Admin Hub</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/@picocss/pico@2/css/pico.min.css">
<style>
  body{padding:18px;max-width:1100px;margin:auto} table{font-size:13px}
  .admin-actions a{margin-right:.6rem}
</style>
</head><body>
<h2>Admin Hub</h2>
<p class="admin-actions">
  <a href="/hub/dashboard?key=${keyParam}">Analytics</a> ·
  <a href="/hub/dashboard/report-analytics.csv?key=${keyParam}">Download CSV</a> ·
  <a href="/hub/dashboard.pdf?key=${keyParam}">Download PDF</a> ·
  <a href="/admin/geocode?key=${keyParam}">Geocode now</a> ·
  <a href="/admin/geocode?dry=1&key=${keyParam}" title="Preview only, no write">Preview geocode (dry run)</a> ·
  <a href="/admin/sync-stores?key=${keyParam}">Sync stores now</a> ·
  <a href="/admin/sync-stores?dry=1&key=${keyParam}" title="Preview only, no write">Preview sync (dry run)</a>
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
  const db = await jread(DB_FILE, { passes: [] });
  const all = db.passes;

  const from = req.query.from ? new Date(req.query.from) : null;
  const to = req.query.to ? new Date(req.query.to) : null;
  const brand = (req.query.brand || '').toLowerCase();
  const status = (req.query.status || '').toLowerCase();

  const filtered = all.filter(p => {
    const t = new Date(p.issued_at);
    if (from && t < from) return false;
    if (to && t > to) return false;
    if (brand && (p.restaurant || '').toLowerCase() !== brand) return false;
    if (status && (p.status || '').toLowerCase() !== status) return false;
    return true;
  });

  const issued = filtered.length;
  const redeemed = filtered.filter(p => p.status === 'redeemed').length;
  const rate = issued ? Math.round(redeemed / issued * 1000) / 10 : 0;

  const byBrand = {};
  filtered.forEach(p => { byBrand[p.restaurant] = (byBrand[p.restaurant] || 0) + 1; });
  const pieLabels = Object.keys(byBrand);
  const pieData = pieLabels.map(k => byBrand[k]);

  const byDay = {};
  filtered.forEach(p => {
    const day = (p.redeemed_at || p.issued_at || '').slice(0, 10);
    if (!day) return;
    byDay[day] = (byDay[day] || 0) + (p.status === 'redeemed' ? 1 : 0);
  });
  const lineLabels = Object.keys(byDay).sort();
  const lineData = lineLabels.map(k => byDay[k]);

  const hm = Array.from({ length: 7 }, () => Array(24).fill(0));
  filtered.forEach(p => {
    if (p.status !== 'redeemed' || !p.redeemed_at) return;
    const d = new Date(p.redeemed_at);
    hm[d.getDay()][d.getHours()]++;
  });

  const heatJSON = JSON.stringify(hm).replace(/</g, '\\u003c');

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
  &nbsp; <a href="/hub/dashboard/report-analytics.csv?key=${encodeURIComponent(req.query.key || '')}">CSV</a> ·
  <a href="/hub/dashboard.pdf?key=${encodeURIComponent(req.query.key || '')}">PDF</a>
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
const heat       = JSON.parse('${heatJSON}');

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
  for (let r = 0; r < 7; r++) {
    const tr = document.createElement('tr');
    for (let c = 0; c < 24; c++) {
      const v = heat[r][c];
      const cell = document.createElement('td');
      const k = v / max;
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
  const db = await jread(DB_FILE, { passes: [] });
  const headers = ['id', 'offer', 'restaurant', 'client_slug', 'status', 'issued_at', 'redeemed_at', 'redeemed_by_store', 'redeemed_by_staff', 'token_hash'];
  const csv = [headers.join(',')]
    .concat(db.passes.map(p => headers.map(h => csvEsc(p[h] || '')).join(',')))
    .join('\n') + '\n';
  return sendCsv(res, 'redeem_report.csv', csv);
});

app.get('/events.csv', requireKey, async (_req, res) => {
  const ev = await jread(EVENTS_FILE, { events: [] });
  const headers = ['t', 'type', 'offer_id', 'restaurant', 'client_slug', 'meta', 'ua', 'ip'];
  const csv = [headers.join(',')].concat(
    ev.events.map(e => [
      e.t,
      e.type,
      e.offer_id || '',
      e.restaurant || '',
      e.client_slug || '',
      JSON.stringify(e.meta || {}),
      '', '',
    ].map(csvEsc).join(','))
  ).join('\n') + '\n';
  return sendCsv(res, 'events.csv', csv);
});

// ---------- PDF ----------
app.get('/hub/dashboard.pdf', requireKey, async (req, res) => {
  const origin = BASE_URL || `${req.protocol}://${req.get('host')}`;
  const url = `${origin}/hub/dashboard?key=${encodeURIComponent(req.query.key || '')}`;
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 120000 });
    const pdf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' }
    });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'attachment; filename="analytics.pdf"');
    res.send(pdf);
  } finally {
    await browser.close();
  }
});

// ---------- Home ----------
app.get('/', (_req, res) => res.redirect('/offers.html'));

// ======================================================================
//  Printable coupon + QR
// ======================================================================
app.get('/api/offer/:id', async (req, res) => {
  const { offers } = await loadCatalog();
  const id = req.params.id;
  const o = offers[id];
  if (!o) return res.status(404).json({ error: 'Offer not found' });
  res.json({ id, ...o });
});

// QR that issues fresh token
app.get('/qr', async (req, res) => {
  const id = (req.query.offer || '').toString();
  const src = (req.query.src || '').toString();
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

// PDF (single / 4-up)
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

  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(url.toString(), { waitUntil: 'networkidle0', timeout: 120000 });
    const pdf = await page.pdf({
      format: 'Letter',
      printBackground: true,
      margin: { top: '0.5in', right: '0.5in', bottom: '0.5in', left: '0.5in' }
    });
    res.setHeader('Content-Type', 'application/pdf');
    const name = per === '4' ? `${offer}-4up.pdf` : `${offer}.pdf`;
    res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
    res.send(pdf);
  } finally {
    await browser.close();
  }
});

// ======================================================================
//  Public aggregate stats (issued & redeemed) + sources
// ======================================================================
app.get('/api/offer-stats', async (_req, res) => {
  const db = await jread(DB_FILE, { passes: [], redemptions: [] });
  const stats = {};
  const sources = {};
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
