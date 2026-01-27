// src/index.js
const http = require("http");
const { createApp } = require("./app");
const { env } = require("./config/env");
const { startJobs, stopJobs } = require("./jobs/cleanup");

const app = createApp();
const server = http.createServer(app);

server.listen(env.PORT, () => {
  console.log(`Server listening on port ${env.PORT} (${env.NODE_ENV})`);
});

startJobs();

function shutdown(signal) {
  console.log(`Received ${signal}. Shutting down...`);
  stopJobs();
  server.close(() => {
    console.log("HTTP server closed.");
    process.exit(0);
  });

  // force close after 10s
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
