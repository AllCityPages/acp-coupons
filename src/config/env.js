// src/config/env.js
function requireEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

const env = {
  NODE_ENV: process.env.NODE_ENV || "development",
  PORT: Number(process.env.PORT || 3000),

  // Admin security
  ADMIN_API_KEY: process.env.ADMIN_API_KEY || "",

  // Rate limiting
  ADMIN_RL_WINDOW_MS: Number(process.env.ADMIN_RL_WINDOW_MS || 60_000),
  ADMIN_RL_MAX: Number(process.env.ADMIN_RL_MAX || 30),

  // Offer caching
  OFFERS_CACHE_TTL_MS: Number(process.env.OFFERS_CACHE_TTL_MS || 30_000),

  // Demo reset / cleanup
  ENABLE_DEMO_RESET_JOB: process.env.ENABLE_DEMO_RESET_JOB === "true",
  DEMO_RESET_EVERY_MS: Number(process.env.DEMO_RESET_EVERY_MS || 0), // 0 disables
  ENABLE_CLEANUP_JOB: process.env.ENABLE_CLEANUP_JOB !== "false",
  CLEANUP_EVERY_MS: Number(process.env.CLEANUP_EVERY_MS || 60_000),
};

module.exports = { env, requireEnv };
