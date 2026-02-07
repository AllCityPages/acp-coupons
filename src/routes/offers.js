const router = require("express").Router();

// Temporary placeholder so the server can start.
// We'll wire this to real offer logic next.
router.get("/", (req, res) => {
  res.json({ ok: true, message: "offers route placeholder" });
});

module.exports = router;

