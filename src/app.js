// src/app.js
const express = require("express");
const { applySecurityMiddleware } = require("./middleware/security");

const healthRoutes = require("./routes/health");
const offersRoutes = require("./routes/offers");
const adminRoutes = require("./routes/admin");

function createApp() {
  const app = express();

  // Security headers, rate limits, etc.
  applySecurityMiddleware(app);

  // Parsers
  app.use(express.json({ limit: "1mb" }));
  app.use(express.urlencoded({ extended: false, limit: "1mb" }));

  // Routes
  app.use("/health", healthRoutes);   // should include /health and /health/db inside routes/health.js
  app.use("/offers", offersRoutes);
  app.use("/admin", adminRoutes);

  // 404
  app.use((req, res) => res.status(404).json({ error: "Not found" }));

  // error handler
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

module.exports = { createApp };

