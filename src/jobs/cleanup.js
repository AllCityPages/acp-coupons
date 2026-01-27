// src/jobs/cleanup.js
const { env } = require("../config/env");
const { store } = require("../data/store");
const { resetDemoData } = require("../data/demoSeed");

let cleanupTimer = null;
let demoResetTimer = null;

function startJobs() {
  if (env.ENABLE_CLEANUP_JOB) {
    cleanupTimer = setInterval(async () => {
      try {
        const result = await store.cleanupExpired();
        if (result?.cleaned) console.log("Cleanup:", result);
      } catch (e) {
        console.error("Cleanup job error:", e);
      }
    }, env.CLEANUP_EVERY_MS).unref();
  }

  if (env.ENABLE_DEMO_RESET_JOB && env.DEMO_RESET_EVERY_MS > 0) {
    demoResetTimer = setInterval(async () => {
      try {
        await resetDemoData();
        console.log("Demo data reset");
      } catch (e) {
        console.error("Demo reset job error:", e);
      }
    }, env.DEMO_RESET_EVERY_MS).unref();
  }
}

function stopJobs() {
  if (cleanupTimer) clearInterval(cleanupTimer);
  if (demoResetTimer) clearInterval(demoResetTimer);
}

module.exports = { startJobs, stopJobs };
