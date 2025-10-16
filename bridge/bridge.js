// bridge.js — Local Bridge to auto-apply discount via keystrokes
// Listens on http://127.0.0.1:1969/apply-discount and simulates a hotkey/PLU in the POS.
//
// Requirements: Node 18+. One-time: `npm install` in this folder, then `node bridge.js`.
// Security: Listens only on 127.0.0.1 (this computer). No external access.

const express = require('express');
const bodyParser = require('body-parser');
const robot = require('robotjs');
const fs = require('fs');

const app = express();
app.use(bodyParser.json());

const PORT = 1969;
const CFG_PATH = './config.json';
let cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));

// Small delay helper
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Press a combination like ["control","alt","d"] or a single key like ["f7"]
async function pressCombo(keys) {
  if (!Array.isArray(keys) || keys.length === 0) return;
  if (keys.length === 1) {
    robot.keyTap(keys[0]);
    return;
  }
  // Hold all but last
  for (let i = 0; i < keys.length - 1; i++) robot.keyToggle(keys[i], 'down');
  robot.keyTap(keys[keys.length - 1]);
  // Release
  for (let i = keys.length - 2; i >= 0; i--) robot.keyToggle(keys[i], 'up');
}

async function typeString(s) { robot.typeString(s); }

app.post('/apply-discount', async (req, res) => {
  try {
    const payload = req.body || {};
    console.log('[bridge] apply-discount', JSON.stringify(payload));

    // Read fresh config each time so manager can tweak without restart
    cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));

    // 1) Optional: bring POS to front (if you set a global hotkey that works anywhere, you can skip this)
    // (Most stores click the POS window once and leave it focused.)

    // 2) Preferred: press a single hotkey that POS maps to discount (simplest)
    if (Array.isArray(cfg.applyHotkey) && cfg.applyHotkey.length) {
      await pressCombo(cfg.applyHotkey);
      if (cfg.delayMs) await sleep(cfg.delayMs);
    }

    // 3) Or: type a PLU/SKU then Enter
    if (cfg.plu && typeof cfg.plu === 'string' && cfg.plu.trim()) {
      await typeString(cfg.plu.trim());
      if (cfg.pressEnter) robot.keyTap('enter');
    }

    res.json({ ok: true });
  } catch (e) {
    console.error('bridge error:', e);
    res.status(500).json({ ok: false, message: e.message });
  }
});

app.listen(PORT, '127.0.0.1', () => {
  console.log(`Local Bridge listening on http://127.0.0.1:${PORT}`);
});
