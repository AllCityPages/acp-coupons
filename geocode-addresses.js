// geocode-addresses.js
// Batch-geocode offers.json addresses via OpenStreetMap Nominatim (no key).
// - Fills in {lat,lng} where missing
// - Leaves existing coords untouched
// - Backs up offers.json to offers.backup-YYYYMMDD-HHMMSS.json
//
// Usage: node geocode-addresses.js

const fs = require('fs');
const path = require('path');
const https = require('https');

const OFFERS_FILE = path.join(__dirname, 'offers.json');

// 1 req/sec per Nominatim usage policy. Be polite.
const DELAY_MS = 1100;
const NOM_BASE = 'https://nominatim.openstreetmap.org/search';

function sleep(ms){ return new Promise(r => setTimeout(r, ms)); }

function fetchJSON(url){
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        'User-Agent': 'ACP-Coupons/1.0 (contact: info@AllCityPages.com)',
        'Accept': 'application/json'
      }
    }, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e){ reject(e); }
      });
    });
    req.on('error', reject);
  });
}

async function geocodeOne(label){
  const q = encodeURIComponent(label);
  const url = `${NOM_BASE}?format=jsonv2&q=${q}&addressdetails=0&limit=1`;
  try{
    const arr = await fetchJSON(url);
    if (Array.isArray(arr) && arr[0] && arr[0].lat && arr[0].lon){
      return { lat: Number(arr[0].lat), lng: Number(arr[0].lon) };
    }
  }catch(e){}
  return null;
}

function normalizeAddrEntry(entry){
  if (typeof entry === 'string') return { label: entry };
  // already object-like:
  return {
    label: entry.label || String(entry.label || '').trim(),
    lat: isFinite(entry.lat) ? Number(entry.lat) : undefined,
    lng: isFinite(entry.lng) ? Number(entry.lng) : undefined
  };
}

(async function main(){
  const raw = fs.readFileSync(OFFERS_FILE, 'utf8');
  const offers = JSON.parse(raw);

  // backup
  const ts = new Date();
  const tag = ts.toISOString().replace(/[-:T]/g,'').slice(0,15);
  const backup = OFFERS_FILE.replace(/\.json$/i, `.backup-${tag}.json`);
  fs.writeFileSync(backup, JSON.stringify(offers, null, 2));
  console.log(`Backup written: ${path.basename(backup)}`);

  // iterate offers
  const offerIds = Object.keys(offers);
  let misses = 0, hits = 0, totalRequests = 0;

  for (const id of offerIds){
    const o = offers[id];

    // Normalize to an array called "addresses"
    let addrs = [];
    if (Array.isArray(o.addresses)) addrs = o.addresses.map(normalizeAddrEntry);
    else if (o.address) addrs = [ normalizeAddrEntry(o.address) ];
    else { continue; }

    let updated = false;

    for (let i=0;i<addrs.length;i++){
      const a = addrs[i];
      const needsGeo = !(isFinite(a.lat) && isFinite(a.lng));
      if (!needsGeo || !a.label) continue;

      totalRequests++;
      console.log(`[${id}] Geocoding: ${a.label}`);
      const geo = await geocodeOne(a.label);
      if (geo){
        a.lat = geo.lat;
        a.lng = geo.lng;
        hits++;
        updated = true;
        console.log(`  -> ${geo.lat.toFixed(6)}, ${geo.lng.toFixed(6)}`);
      } else {
        misses++;
        console.log(`  !! not found`);
      }
      await sleep(DELAY_MS);
    }

    // write normalized array back, and drop legacy "address" if present
    if (updated){
      offers[id].addresses = addrs;
      delete offers[id].address;
    }else{
      // still write normalized array if it changed shape
      offers[id].addresses = addrs;
      delete offers[id].address;
    }
  }

  fs.writeFileSync(OFFERS_FILE, JSON.stringify(offers, null, 2));
  console.log(`Done. Requests: ${totalRequests}, hits: ${hits}, misses: ${misses}`);
})();
