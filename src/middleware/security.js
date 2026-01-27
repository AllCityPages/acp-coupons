// src/middleware/security.js
const helmet = require("helmet");

function applySecurityMiddleware(app) {
  app.disable("x-powered-by");

  // Helmet gives sensible security headers
  app.use(helmet());

  // If you need CORS, uncomment and configure:
  // const cors = require("cors");
  // app.use(cors({ origin: ["https://yourdomain.com"], credentials: true }));
}

module.exports = { applySecurityMiddleware };
