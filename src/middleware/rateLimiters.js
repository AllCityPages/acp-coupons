// src/middleware/rateLimiters.js
const rateLimit = require("express-rate-limit");
const { env } = require("../config/env");

const adminLimiter = rateLimit({
  windowMs: env.ADMIN_RL_WINDOW_MS,
  max: env.ADMIN_RL_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many admin requests. Try again later." },
});

module.exports = { adminLimiter };
