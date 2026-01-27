// scripts/reset-demo-data.js
// Resets runtime data files to a clean demo state.
// Safe to run locally or in a hosted environment if you want to wipe data.

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');          // { passes:[], redemptions:[] }
const EVENTS_FILE = path.join(DATA_DIR, 'events.json');  // { events:[] }

function ensureDir(p) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

ensureDir(DATA_DIR);

fs.writeFileSync(DB_FILE, JSON.stringify({ passes: [], redemptions: [] }, null, 2));
fs.writeFileSync(EVENTS_FILE, JSON.stringify({ events: [] }, null, 2));

console.log('✅ Reset complete:');
console.log(' - data/db.json');
console.log(' - data/events.json');
