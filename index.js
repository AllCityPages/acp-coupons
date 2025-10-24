// index.js
// One-time Coupon Server + Deals Hub + Analytics + Dashboard + Wallet Stub
// ------------------------------------------------------------

const express = require("express");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const bodyParser = require("body-parser");

// -------------------------
// Config
// -------------------------
const app = express();
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || "dev_api_key_change_me";
const BASE_URL =
  process.env.COUPON_BASE_URL ||
  process.env.BASE_URL ||
  `http://localhost:${PORT}`;

const DATA_DIR = path.join(__dirname, "data");
const PASSES_FILE = path.join(DATA_DIR, "passes.json");        // issued passes
const REDEEM_FILE = path.join(DATA_DIR, "redemptions.json");   // redemptions
const ANALYTICS_FILE = path.join(DATA_DIR, "analytics.json");  // analytics events
const OFFERS_FILE = path.join(DATA_DIR, "offers.json");        // optional offers catalog

// Toggle: require API key to read dashboard API
const REQUIRE_API_KEY_FOR_DASHBOARD = true;

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// -------------------------
// Tiny JSON store helpers
// -------------------------
function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

// Initialize files if missing
if (!fs.existsSync(PASSES_FILE)) writeJSON(PASSES_FILE, []);
if (!fs.existsSync(REDEEM_FILE)) writeJSON(REDEEM_FILE, []);
if (!fs.existsSync(ANALYTICS_FILE)) writeJSON(ANALYTICS_FILE, []);
if (!fs.existsSync(OFFERS_FILE)) {
  // Seed with a few sample offers (edit this file to manage hub deals)
  writeJSON(OFFERS_FILE, [
    { id: "mcd-bogo", name: "McD BOGO", headline: "Buy 1, Get 1 FREE", active: true },
    { id: "bk-bogo", name: "BK BOGO", headline: "Buy 1 Combo, Get 1 FREE", active: true },
    { id: "taco-2for1", name: "Taco Special", headline: "2 for 1 Tacos", active: false }
  ]);
}

// -------------------------
// Security helpers
// -------------------------
function requireApiKey(req, res, next) {
  const provided = req.get("x-api-key");
  if (!provided || provided !== API_KEY) {
    return res.status(401).json({ ok: false, error: "invalid_api_key" });
  }
  next();
}

// -------------------------
// Utilities
// -------------------------
function nowISO() {
  return new Date().toISOString();
}
function genToken() {
  return crypto.randomBytes(16).toString("hex");
}
function clientIp(req) {
  return (
    req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "unknown"
  );
}
function toCSV(rows) {
  if (!rows || rows.length === 0) return "";
  const headers = Array.from(
    rows.reduce((set, r) => {
      Object.keys(r).forEach((k) => set.add(k));
      return set;
    }, new Set())
  );
  const esc = (v) => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [headers.join(","), ...rows.map((r) => headers.map((h) => esc(r[h])).join(","))].join(
    "\n"
  );
}

// -------------------------
// Static & basic
// -------------------------
app.get("/", (req, res) => {
  res.type("html").send(`
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif; padding: 24px; line-height: 1.4; }
      a.btn { display:inline-block; padding:10px 14px; border-radius:10px; text-decoration:none; border:1px solid #ccc; }
    </style>
    <h1>Coupon Server</h1>
    <p>Base URL: <code>${BASE_URL}</code></p>
    <ul>
      <li><a class="btn" href="/hub">Deals Hub</a></li>
      <li><a class="btn" href="/dashboard">Dashboard</a></li>
      <li><a class="btn" href="/admin-analytics">Admin Analytics</a></li>
      <li><a class="btn" href="/coupon?offer=mcd-bogo">Issue sample coupon (mcd-bogo)</a></li>
    </ul>
  `);
});

// -------------------------
// Issue a one-time coupon
// -------------------------
// GET /coupon?offer=offer-id
app.get("/coupon", (req, res) => {
  const offer = String(req.query.offer || "").trim();
  if (!offer) return res.status(400).send("Missing ?offer id");

  const passes = readJSON(PASSES_FILE, []);
  const token = genToken();
  const pass = {
    token,
    offer,
    status: "issued",
    issued_at: nowISO(),
    ua: req.get("user-agent") || "",
    ip: clientIp(req)
  };
  passes.push(pass);
  writeJSON(PASSES_FILE, passes);

  // Fire-and-forget: record analytics "coupon_issued"
  const analytics = readJSON(ANALYTICS_FILE, []);
  analytics.push({
    event: "coupon_issued",
    offer,
    token,
    ts: nowISO(),
    ua: req.get("user-agent") || "",
    ip: clientIp(req),
    meta: {}
  });
  writeJSON(ANALYTICS_FILE, analytics);

  const redeemUrl = `${BASE_URL}/redeem.html?token=${encodeURIComponent(token)}`;
  const walletUrl = `${BASE_URL}/wallet/add?token=${encodeURIComponent(token)}`;
  const trackViewUrl = `${BASE_URL}/api/analytics`;

  res.type("html").send(`
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root { --bg:#0d0f14; --card:#161a22; --text:#e8eef8; --muted:#a8b3c7; --cta:#2f86ff; --ok:#22c55e; --warn:#f59e0b; }
      body { margin:0; background:var(--bg); color:var(--text); font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; }
      .wrap { max-width: 680px; margin: 0 auto; padding: 24px; }
      .card { background: var(--card); border: 1px solid #222936; padding: 20px; border-radius: 18px; box-shadow: 0 10px 30px rgba(0,0,0,.25); }
      .badge { display:inline-block; padding:4px 10px; border-radius:999px; background:#102544; color:#cfe1ff; font-size:12px; border:1px solid #1f3a63; }
      h1 { margin: 8px 0 2px; font-size: 24px; }
      .sub { color: var(--muted); margin-top: 0; }
      .row { display:flex; gap:10px; flex-wrap:wrap; margin-top: 14px; }
      .btn { appearance:none; border:none; cursor:pointer; padding:12px 14px; border-radius:12px; font-weight:600; }
      .btn-cta { background: var(--cta); color:#fff; }
      .btn-ghost { background: transparent; border:1px solid #2a3446; color:#dbe6ff; }
      .meta { margin-top: 14px; color: var(--muted); font-size: 12px; }
      .token { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; color:#9dd3ff; }
      .tip { margin-top: 18px; font-size: 13px; color: #cbd5e1; }
      a { color: #8ab4ff; text-decoration: none; }
    </style>
    <div class="wrap">
      <div class="card">
        <span class="badge">Limited • One-Time</span>
        <h1>Your Coupon is Ready</h1>
        <p class="sub">Offer: <strong>${offer}</strong></p>

        <div class="row">
          <a class="btn btn-cta" href="${walletUrl}" id="addWallet">Add to Wallet</a>
          <a class="btn btn-ghost" href="${redeemUrl}">Show to Cashier</a>
        </div>

        <div class="meta">
          Token: <span class="token">${token}</span>
        </div>
        <p class="tip">Tip: Add to your home screen for quick access (Share ▸ Add to Home Screen on iOS; ⋮ ▸ Add to Home screen on Android).</p>
      </div>
    </div>

    <script>
      // Track "coupon_view"
      fetch("${trackViewUrl}", {
        method:"POST",
        headers: {"Content-Type":"application/json"},
        body: JSON.stringify({ event:"coupon_view", offer:"${offer}", token:"${token}", meta:{} })
      }).catch(()=>{});
    </script>
  `);
});

// -------------------------
// Redeem API (one-shot)
// -------------------------
// POST /api/redeem  { token, store_id }
app.post("/api/redeem", requireApiKey, (req, res) => {
  const { token, store_id } = req.body || {};
  if (!token) return res.status(400).json({ ok: false, error: "missing_token" });

  const passes = readJSON(PASSES_FILE, []);
  const idx = passes.findIndex((p) => p.token === token);

  if (idx === -1) return res.status(404).json({ ok: false, error: "not_found" });

  if (passes[idx].status === "redeemed") {
    return res.status(409).json({ ok: false, error: "already_redeemed", redeemed_at: passes[idx].redeemed_at });
  }

  passes[idx].status = "redeemed";
  passes[idx].redeemed_at = nowISO();
  passes[idx].redeemed_store_id = store_id || null;
  writeJSON(PASSES_FILE, passes);

  // Record redemption row
  const redemptions = readJSON(REDEEM_FILE, []);
  redemptions.push({
    token,
    offer: passes[idx].offer,
    store_id: store_id || "",
    redeemed_at: passes[idx].redeemed_at,
    ua: req.get("user-agent") || "",
    ip: clientIp(req)
  });
  writeJSON(REDEEM_FILE, redemptions);

  // Analytics event
  const analytics = readJSON(ANALYTICS_FILE, []);
  analytics.push({
    event: "coupon_redeemed",
    offer: passes[idx].offer,
    token,
    ts: nowISO(),
    ua: req.get("user-agent") || "",
    ip: clientIp(req),
    meta: { store_id: store_id || "" }
  });
  writeJSON(ANALYTICS_FILE, analytics);

  res.json({ ok: true, token, status: "redeemed" });
});

// -------------------------
// Reports (CSV)
// -------------------------
// GET /report  (redemptions CSV)
app.get("/report", requireApiKey, (req, res) => {
  const rows = readJSON(REDEEM_FILE, []);
  const csv = toCSV(rows);
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=redemptions.csv");
  res.send(csv);
});

// GET /report-analytics.csv
app.get("/report-analytics.csv", requireApiKey, (req, res) => {
  const rows = readJSON(ANALYTICS_FILE, []);
  const csv = toCSV(rows);
  res.setHeader("Content-Type", "text/csv");
  res.setHeader("Content-Disposition", "attachment; filename=analytics.csv");
  res.send(csv);
});

// -------------------------
// Analytics ingest
// -------------------------
// POST /api/analytics { event, offer, token, meta }
app.post("/api/analytics", (req, res) => {
  const { event, offer, token, meta } = req.body || {};
  if (!event) return res.status(400).json({ ok: false, error: "missing_event" });

  const analytics = readJSON(ANALYTICS_FILE, []);
  analytics.push({
    event,
    offer: offer || "",
    token: token || "",
    ts: nowISO(),
    ua: req.get("user-agent") || "",
    ip: clientIp(req),
    meta: meta || {}
  });
  writeJSON(ANALYTICS_FILE, analytics);

  res.json({ ok: true });
});

// -------------------------
// Wallet stub
// -------------------------
// GET /wallet/add?token=...
app.get("/wallet/add", (req, res) => {
  const token = String(req.query.token || "");
  // You could branch for platform here (detect iOS/Android/desktop)
  // For now, just simulate success and track analytics.
  // Track "wallet_add"
  const analytics = readJSON(ANALYTICS_FILE, []);
  analytics.push({
    event: "wallet_add",
    token,
    offer: null,
    ts: nowISO(),
    ua: req.get("user-agent") || "",
    ip: clientIp(req),
    meta: {}
  });
  writeJSON(ANALYTICS_FILE, analytics);

  res.type("html").send(`
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; padding: 24px; line-height: 1.45; }
      .ok { color: #16a34a; }
      a.btn { display:inline-block; margin-top:16px; padding:10px 14px; border-radius:10px; text-decoration:none; background:#111827; color:#e5e7eb; border:1px solid #30363d; }
    </style>
    <h2 class="ok">Added to Wallet (stubbed)</h2>
    <p>Token: <code>${token || "n/a"}</code></p>
    <p>This is a stub. Integrate Apple/Google Wallet here later.</p>
    <a class="btn" href="/">Back</a>
  `);
});

// -------------------------
// Deals Hub page
// -------------------------
app.get("/hub", (req, res) => {
  const offers = readJSON(OFFERS_FILE, []);
  const active = offers.filter((o) => o.active);
  res.type("html").send(`
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root{ --bg:#0b1020; --card:#121a2b; --border:#22314f; --text:#eaf1ff; --muted:#9fb1d4; --cta:#4f8cff }
      body { margin:0; background:var(--bg); color:var(--text); font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; }
      .wrap { max-width: 1000px; margin: 0 auto; padding: 24px; }
      h1 { margin: 0 0 6px; }
      p.sub { color: var(--muted); margin-top:0 }
      .grid { display:grid; grid-template-columns: repeat(auto-fill, minmax(260px,1fr)); gap:16px; margin-top: 18px; }
      .card { background: var(--card); border:1px solid var(--border); padding:16px; border-radius:16px; }
      .card h3 { margin: 0 0 6px; font-size: 18px; }
      .card p { margin: 0 0 12px; color: var(--muted); }
      .row { display:flex; gap:10px; }
      a.btn { flex:1; text-align:center; display:inline-block; padding:10px 12px; border-radius:12px; text-decoration:none; border:1px solid var(--border); color:#cfe1ff; }
      a.btn.cta { background: var(--cta); color:#fff; border-color: transparent; }
      .topbar { display:flex; gap:10px; align-items:center; justify-content:space-between; margin-bottom: 12px; }
      .topbar a { color:#cfe1ff; text-decoration:none; font-weight:600 }
    </style>
    <div class="wrap">
      <div class="topbar">
        <div>
          <h1>Deals Hub</h1>
          <p class="sub">Tap a deal to get your one-time coupon.</p>
        </div>
        <div>
          <a href="/dashboard">Dashboard</a> &nbsp;·&nbsp; <a href="/admin-analytics">Admin Analytics</a>
        </div>
      </div>

      <div class="grid">
        ${
          active.length
            ? active
                .map(
                  (o) => `
          <div class="card">
            <h3>${o.name}</h3>
            <p>${o.headline || ""}</p>
            <div class="row">
              <a class="btn" href="/coupon?offer=${encodeURIComponent(o.id)}">Get Coupon</a>
              <a class="btn cta" href="/coupon?offer=${encodeURIComponent(o.id)}">Claim</a>
            </div>
          </div>`
                )
                .join("")
            : `<p>No active deals.</p>`
        }
      </div>
    </div>
  `);
});

// -------------------------
// Dashboard API + Page
// -------------------------
app.get("/api/dashboard", (req, res, next) => {
  if (REQUIRE_API_KEY_FOR_DASHBOARD) return requireApiKey(req, res, next);
  next();
}, (req, res) => {
  const passes = readJSON(PASSES_FILE, []);
  const redemptions = readJSON(REDEEM_FILE, []);
  const analytics = readJSON(ANALYTICS_FILE, []);

  // Aggregate by offer
  const byOffer = {};
  for (const p of passes) {
    const key = p.offer || "unknown";
    byOffer[key] = byOffer[key] || { offer: key, issued: 0, redeemed: 0 };
    byOffer[key].issued += 1;
    if (p.status === "redeemed") byOffer[key].redeemed += 1;
  }

  // Today stats
  const today = new Date();
  const d0 = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const issuedToday = passes.filter((p) => new Date(p.issued_at).getTime() >= d0).length;
  const redeemedToday = redemptions.filter((r) => new Date(r.redeemed_at).getTime() >= d0).length;

  // Events last 7d
  const t7 = Date.now() - 7 * 24 * 3600 * 1000;
  const events7 = analytics.filter((a) => new Date(a.ts).getTime() >= t7).length;

  res.json({
    ok: true,
    totals: {
      issued: passes.length,
      redeemed: redemptions.length,
      redemption_rate:
        passes.length > 0 ? Number(((redemptions.length / passes.length) * 100).toFixed(2)) : 0
    },
    today: { issued: issuedToday, redeemed: redeemedToday },
    events_last_7d: events7,
    by_offer: Object.values(byOffer).sort((a, b) => b.issued - a.issued)
  });
});

app.get("/dashboard", (req, res) => {
  // client fetches /api/dashboard; user should pass x-api-key (prompt in UI)
  res.type("html").send(`
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      :root { --bg:#0c1020; --card:#141a2e; --text:#eaf1ff; --muted:#9fb1d4; --accent:#4f8cff; --border:#22314f }
      * { box-sizing: border-box }
      body { margin:0; background:var(--bg); color:var(--text); font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial; }
      .wrap { max-width: 1100px; margin: 0 auto; padding: 24px; }
      .top { display:flex; gap:12px; align-items:center; justify-content:space-between; }
      .card { background:var(--card); border:1px solid var(--border); border-radius:16px; padding:16px; }
      .grid { display:grid; grid-template-columns: repeat(auto-fit,minmax(240px,1fr)); gap:12px; margin-top: 14px; }
      .kpi { font-size: 28px; font-weight: 700; }
      .muted { color: var(--muted) }
      input, button { padding:10px 12px; border-radius:10px; border:1px solid var(--border); background:#0f1424; color:#eaf1ff; }
      button { background: var(--accent); border-color: transparent; cursor: pointer; }
      table { width:100%; border-collapse: collapse; margin-top: 12px; }
      th, td { text-align:left; padding:10px; border-bottom:1px solid var(--border); }
      a { color:#cfe1ff; text-decoration:none }
    </style>
    <div class="wrap">
      <div class="top">
        <h1>Deals Dashboard</h1>
        <div>
          <a href="/hub">Hub</a> &nbsp;·&nbsp; <a href="/admin-analytics">Admin Analytics</a>
        </div>
      </div>

      <div class="card" style="margin-top:12px;">
        <label class="muted">x-api-key</label>
        <div style="display:flex; gap:8px; margin-top:6px;">
          <input id="key" placeholder="Enter API key to load stats" style="flex:1" />
          <button id="load">Load</button>
        </div>
        <div id="err" class="muted" style="margin-top:8px; display:none;"></div>
      </div>

      <div class="grid">
        <div class="card">
          <div class="muted">Total Issued</div>
          <div class="kpi" id="k_issued">—</div>
        </div>
        <div class="card">
          <div class="muted">Total Redeemed</div>
          <div class="kpi" id="k_redeemed">—</div>
        </div>
        <div class="card">
          <div class="muted">Redemption Rate</div>
          <div class="kpi" id="k_rate">—</div>
        </div>
        <div class="card">
          <div class="muted">Events (7d)</div>
          <div class="kpi" id="k_ev7">—</div>
        </div>
      </div>

      <div class="card" style="margin-top:12px;">
        <div class="muted">Today</div>
        <div style="display:flex; gap:16px; margin-top:6px;">
          <div>Issued: <strong id="t_issued">—</strong></div>
          <div>Redeemed: <strong id="t_redeemed">—</strong></div>
        </div>
      </div>

      <div class="card" style="margin-top:12px;">
        <div class="top" style="gap:8px">
          <h3 style="margin:0">By Offer</h3>
          <div>
            <a href="/report">Download Redemptions CSV</a> &nbsp;·&nbsp;
            <a href="/report-analytics.csv">Download Analytics CSV</a>
          </div>
        </div>
        <table id="tbl">
          <thead><tr><th>Offer</th><th>Issued</th><th>Redeemed</th><th>Rate</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
    </div>

    <script>
      const $ = (id) => document.getElementById(id);
      $("load").onclick = async () => {
        const key = $("key").value.trim();
        $("err").style.display = "none";
        try {
          const r = await fetch("/api/dashboard", { headers: { "x-api-key": key || "" } });
          if (!r.ok) throw new Error("HTTP " + r.status);
          const j = await r.json();

          $("k_issued").textContent = j.totals.issued;
          $("k_redeemed").textContent = j.totals.redeemed;
          $("k_rate").textContent = j.totals.redemption_rate + "%";
          $("k_ev7").textContent = j.events_last_7d;

          $("t_issued").textContent = j.today.issued;
          $("t_redeemed").textContent = j.today.redeemed;

          const tb = $("tbl").querySelector("tbody");
          tb.innerHTML = "";
          j.by_offer.forEach(row => {
            const tr = document.createElement("tr");
            const rate = row.issued ? ((row.redeemed / row.issued) * 100).toFixed(1) + "%" : "0%";
            tr.innerHTML = \`<td>\${row.offer}</td><td>\${row.issued}</td><td>\${row.redeemed}</td><td>\${rate}</td>\`;
            tb.appendChild(tr);
          });
        } catch (e) {
          $("err").textContent = "Failed to load. Check API key.";
          $("err").style.display = "block";
        }
      };
    </script>
  `);
});

// Aliases:
// /hub/dashboard  -> dashboard page
app.get("/hub/dashboard", (req, res) => res.redirect(302, "/dashboard"));
// /hub/dashboard/report-analytics.csv -> analytics csv
app.get("/hub/dashboard/report-analytics.csv", (req, res) =>
  res.redirect(302, "/report-analytics.csv")
);

// -------------------------
// Admin Analytics Page
// -------------------------
app.get("/admin-analytics", (req, res) => {
  res.type("html").send(`
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; background:#0c1020; color:#eaf1ff; margin:0 }
      .wrap { max-width: 900px; margin: 0 auto; padding: 24px; }
      .card { background:#141a2e; border:1px solid #22314f; border-radius:16px; padding:16px; }
      a.btn { display:inline-block; padding:10px 14px; border-radius:10px; text-decoration:none; background:#4f8cff; color:#fff; }
      .muted { color:#9fb1d4 }
      input { padding:10px 12px; border-radius:10px; border:1px solid #22314f; background:#0f1424; color:#eaf1ff; width: 340px; }
    </style>
    <div class="wrap">
      <h1>Admin • Analytics</h1>
      <p class="muted">Download CSV with your <code>x-api-key</code>.</p>

      <div class="card">
        <p><strong>Analytics CSV</strong></p>
        <p class="muted">Endpoint: <code>GET /report-analytics.csv</code></p>
        <p>
          <a class="btn" href="/report-analytics.csv" id="dl">Download</a>
          &nbsp; &nbsp; <a class="btn" href="/report">Redemptions CSV</a>
        </p>
      </div>
      <p style="margin-top:14px"><a href="/dashboard">Go to Dashboard</a> • <a href="/hub">Deals Hub</a></p>
    </div>
    <script>
      // This page relies on your browser to include x-api-key (will prompt when clicked).
      // If your proxy doesn't allow custom headers on link clicks, you can curl it or use the Dashboard page.
    </script>
  `);
});

// -------------------------
// Minimal cashier page (redeem.html) for scanning into
// -------------------------
app.get("/redeem.html", (req, res) => {
  const token = String(req.query.token || "");
  res.type("html").send(`
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <style>
      body { font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial; padding: 24px; }
      input, button { padding:10px 12px; border-radius:10px; border:1px solid #cbd5e1; }
      button { background:#111827; color:#fff; cursor:pointer }
      .row { display:flex; gap:8px; flex-wrap:wrap; }
      .ok { color:#16a34a }
      .err { color:#dc2626 }
    </style>
    <h2>Redeem Coupon</h2>
    <div class="row">
      <input id="token" placeholder="Scan or paste token" value="${token}" style="min-width:320px" />
      <input id="store" placeholder="Store ID (optional)" />
      <input id="key" placeholder="x-api-key" />
      <button id="go">Redeem</button>
    </div>
    <p id="out"></p>

    <script>
      const $ = (id) => document.getElementById(id);
      $("go").onclick = async () => {
        const token = $("token").value.trim();
        const store_id = $("store").value.trim();
        const key = $("key").value.trim();
        $("out").textContent = "Redeeming...";
        try {
          const r = await fetch("/api/redeem", {
            method:"POST",
            headers: { "Content-Type":"application/json", "x-api-key": key },
            body: JSON.stringify({ token, store_id })
          });
          const j = await r.json();
          if (!j.ok) {
            $("out").innerHTML = '<span class="err">Error: '+(j.error || 'failed')+'</span>';
            return;
          }
          $("out").innerHTML = '<span class="ok">Redeemed!</span>';
        } catch (e) {
          $("out").innerHTML = '<span class="err">Network error</span>';
        }
      };
    </script>
  `);
});

// -------------------------
// Start
// -------------------------
app.listen(PORT, () => {
  console.log(`Coupon server running on ${BASE_URL} (PORT=${PORT})`);
});
