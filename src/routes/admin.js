// src/routes/admin.js
const router = require("express").Router();
const { requireAdminApiKey } = require("../middleware/adminAuth");
const { adminLimiter } = require("../middleware/rateLimiters");
const { resetDemoData } = require("../data/demoSeed");
const { invalidateOffersCache } = require("../services/offersService");

router.use(adminLimiter);
router.use(requireAdminApiKey);

router.post("/reset-demo", async (req, res, next) => {
  try {
    await resetDemoData();
    invalidateOffersCache();
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

module.exports = router;
