// src/middleware/adminAuth.js
const crypto = require("crypto");
const { env } = require("../config/env");

function timingSafeEqual(a, b) {
  const aBuf = Buffer.from(a || "", "utf8");
  const bBuf = Buffer.from(b || "", "utf8");
  if (aBuf.length !== bBuf.length) return false;
  return crypto.timingSafeEqual(aBuf, bBuf);
}

function requireAdminApiKey(req, res, next) {
  if (!env.ADMIN_API_KEY) {
    // In production you should set this. In dev you can allow empty if you want.
    return res.status(500).json({ error: "ADMIN_API_KEY not configured" });
  }

  // Support either header or bearer token
  const headerKey = req.header("x-admin-key");
  const auth = req.header("authorization") || "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7) : "";

  const provided = headerKey || bearer;

  if (!provided || !timingSafeEqual(provided, env.ADMIN_API_KEY)) {
    return res.status(401).json({ error: "Unauthorized" });
  }

  next();
}

module.exports = { requireAdminApiKey };
