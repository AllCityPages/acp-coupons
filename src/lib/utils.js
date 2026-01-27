// src/lib/utils.js
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const https = require('https');

const nowISO = () => new Date().toISOString();
const randHex = (n = 16) => crypto.randomBytes(n).toString('hex');
const sha12 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 12);

const jread = async (f, fb) => {
  try { return JSON.parse(await fsp.readFile(f, 'utf8')); }
  catch { return fb; }
};
const jwrite = (f, o) => fsp.writeFile(f, JSON.stringify(o, null, 2));

const csvEsc = (v) => {
  const s = (v ?? '').toString();
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

function sendCsv(res, filename, csvString) {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.status(200).send('\uFEFF' + csvString);
}

// Offer expiry helpers
function parseDateISO(s) {
  const d = new Date(String(s || ''));
  return Number.isFinite(d.getTime()) ? d : null;
}
function daysUntil(date) {
  const now = new Date();
  const ms = date.getTime() - now.getTime();
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}
function isExpiredOffer(o) {
  if (o && o.expires_on) {
    const d = parseDateISO(o.expires_on);
    if (d) return d.getTime() < Date.now();
  }
  if (typeof o.expires_days === 'number' && o.expires_days <= 0) return true;
  return false;
}

// Slug util
const toSlug = (s) => (s || '')
  .toLowerCase()
  .normalize('NFKD').replace(/[\u0300-\u036f]/g,'')
  .replace(/[^a-z0-9]+/g,'-')
  .replace(/(^-|-$)/g,'')
  .slice(0, 48);

// Geo helpers
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

function httpGetJson(url, headers = {}) {
  return new Promise((resolve, reject) => {
    try {
      const u = new URL(url);
      const options = { hostname: u.hostname, path: u.pathname + u.search, method: 'GET', headers };
      const req = https.request(options, res => {
        let data = '';
        res.on('data', chunk => (data += chunk));
        res.on('end', () => {
          try { resolve(JSON.parse(data || '[]')); }
          catch (e) { reject(e); }
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

function haversine(lat1, lon1, lat2, lon2) {
  const toRad = v => v * Math.PI / 180, R = 6371;
  const dLat = toRad(lat2 - lat1), dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function safeFileMtimeMs(filePath) {
  try { return fs.statSync(filePath).mtimeMs; }
  catch { return 0; }
}

module.exports = {
  nowISO, randHex, sha12,
  jread, jwrite,
  csvEsc, sendCsv,
  parseDateISO, daysUntil, isExpiredOffer,
  toSlug,
  sleep, isFiniteNum, normalizeAddrEntry,
  httpGetJson, geocodeLabel,
  haversine,
  safeFileMtimeMs
};
