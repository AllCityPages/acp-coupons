// src/routes/health.js
const router = require("express").Router();

router.get("/", (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

module.exports = router;
