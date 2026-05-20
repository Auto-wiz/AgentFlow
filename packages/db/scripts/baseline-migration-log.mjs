/**
 * Registers every migration listed in migrations/meta/_journal.json in
 * drizzle.__drizzle_migrations, skipping rows whose created_at already exists.
 *
 * Use when the Postgres schema already matches the repo migrations (objects were
 * created manually or Drizzle crashed mid-flight) but the migration journal is missing
 * rows — so `db:migrate:apply` stops failing on "already exists".
 *
 * DANGEROUS if the DB is actually empty or only partially migrated: Drizzle will then
 * think everything is applied and WILL NOT replay missing DDL.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const migrationsDir = path.join(__dirname, "../migrations");
const journalPath = path.join(migrationsDir, "meta/_journal.json");

const url = process.env.DATABASE_URL?.trim();
const dryRun = process.argv.includes("--dry-run");

function hashMigrationFile(tag) {
  const filePath = path.join(migrationsDir, `${tag}.sql`);
  const raw = fs.readFileSync(filePath, "utf8");
  return crypto.createHash("sha256").update(raw).digest("hex");
}

const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));
const entries = [...journal.entries].sort((a, b) => a.idx - b.idx);

const setupSql = `
CREATE SCHEMA IF NOT EXISTS drizzle;
CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
  id SERIAL PRIMARY KEY,
  hash text NOT NULL,
  created_at bigint
);
`;

if (dryRun) {
  console.log("[dry-run] Would ensure schema + table, then insert missing rows:\n");
  console.log(setupSql.trim());
  console.log("");
  for (const entry of entries) {
    const hash = hashMigrationFile(entry.tag);
    console.log(
      `-- ${entry.tag} (created_at=${entry.when}) hash_prefix=${hash.slice(0, 16)}…`
    );
  }
  process.exit(0);
}

if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const pool = new pg.Pool({ connectionString: url });

try {
  await pool.query(setupSql);

  for (const entry of entries) {
    const when = entry.when;
    const tag = entry.tag;
    const hash = hashMigrationFile(tag);
    const insertSql = `
INSERT INTO drizzle.__drizzle_migrations ("hash", "created_at")
SELECT $1::text, $2::bigint
WHERE NOT EXISTS (
  SELECT 1 FROM drizzle.__drizzle_migrations m WHERE m.created_at = $2
);
`;

    const res = await pool.query(insertSql, [hash, when]);
    if (res.rowCount === 1) {
      console.log(`Recorded ${tag} (created_at=${when}).`);
    } else {
      console.log(`Skip ${tag} — row with created_at=${when} already present.`);
    }
  }

  const { rows } = await pool.query(
    `SELECT id, left(hash, 12) AS hash_prefix, created_at FROM drizzle.__drizzle_migrations ORDER BY created_at ASC, id ASC`
  );
  console.log("\nCurrent migration log:");
  console.table(rows);
} finally {
  await pool.end();
}
