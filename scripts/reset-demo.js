// scripts/reset-demo.js
const { resetDemoData } = require("../src/data/demoSeed");
const { invalidateOffersCache } = require("../src/services/offersService");

(async () => {
  await resetDemoData();
  invalidateOffersCache();
  console.log("✅ Demo data reset complete.");
  process.exit(0);
})().catch((e) => {
  console.error("❌ Demo reset failed:", e);
  process.exit(1);
});
