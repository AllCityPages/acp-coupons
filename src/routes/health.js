// src/routes/health.js
const express = require("express");
const { Pool } = require("pg");

const router = express.Router();

// Keep your existing health response format if you want.
// If your old endpoint returned { ok:true, ts: ... }, we keep that same contract.
router.get("/", (_req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Render-safe PG pool (created once per process)
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.DATABASE_URL.includes("render.com")
        ? { rejectUnauthorized: false }
        : undefined,
    })
  : null;

router.get("/db", async (_req, res) => {
  try {
    if (!pool) {
      return res.status(500).json({
        ok: false,
        db: "not-configured",
        error: "DATABASE_URL is missing",
      });
    }
    await pool.query("SELECT 1");
    return res.json({ ok: true, db: "connected", ts: new Date().toISOString() });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      db: "error",
      error: err.message || String(err),
      ts: new Date().toISOString(),
    });
  }
});

module.exports = router;

