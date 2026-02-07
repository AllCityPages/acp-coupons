/**
 * scripts/migrate.js
 * Applies db/migrations/*.sql in order and records them in acp_core.schema_migrations.
 *
 * Run:
 *   npm run migrate
 *
 * Requires:
 *   DATABASE_URL env var
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Client } = require("pg");

const MIGRATIONS_DIR = path.join(process.cwd(), "db", "migrations");

function requireEnv(name) {
  if (!process.env[name]) {
    console.error(`ERROR: ${name} is not set.`);
    process.exit(1);
  }
}

function listSqlFiles() {
  if (!fs.existsSync(MIGRATIONS_DIR)) {
    console.error(`ERROR: Missing migrations dir: ${MIGRATIONS_DIR}`);
    process.exit(1);
  }
  return fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.toLowerCase().endsWith(".sql"))
    .sort((a, b) => a.localeCompare(b));
}

function sha256(str) {
  return crypto.createHash("sha256").update(str, "utf8").digest("hex");
}

async function ensureMigrationsTable(client) {
  await client.query(`CREATE SCHEMA IF NOT EXISTS acp_core;`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS acp_core.schema_migrations (
      id         bigserial PRIMARY KEY,
      filename   text NOT NULL UNIQUE,
      checksum   text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

async function appliedMap(client) {
  const res = await client.query(`SELECT filename, checksum FROM acp_core.schema_migrations;`);
  const m = new Map();
  for (const r of res.rows) m.set(r.filename, r.checksum);
  return m;
}

async function applyFile(client, filename) {
  const full = path.join(MIGRATIONS_DIR, filename);
  const sql = fs.readFileSync(full, "utf8");
  const sum = sha256(sql);

  await client.query("BEGIN;");
  try {
    await client.query(sql);
    await client.query(
      `INSERT INTO acp_core.schema_migrations (filename, checksum) VALUES ($1, $2);`,
      [filename, sum]
    );
    await client.query("COMMIT;");
    console.log(`✅ Applied ${filename}`);
  } catch (e) {
    await client.query("ROLLBACK;");
    console.error(`❌ Failed ${filename}`);
    throw e;
  }
}

async function main() {
  requireEnv("DATABASE_URL");

  // Render Postgres uses SSL; this avoids local cert issues.
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  await client.connect();
  try {
    await ensureMigrationsTable(client);

    const files = listSqlFiles();
    const applied = await appliedMap(client);

    for (const f of files) {
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, f), "utf8");
      const sum = sha256(sql);

      if (applied.has(f)) {
        if (applied.get(f) !== sum) {
          throw new Error(
            `Checksum mismatch for already-applied migration: ${f}\n` +
              `Fix: revert changes to ${f} OR create a new migration (0002_...).`
          );
        }
        console.log(`↩︎ Skipping ${f}`);
        continue;
      }

      await applyFile(client, f);
    }

    console.log("✅ All migrations complete.");
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err?.stack || err);
  process.exit(1);
});

