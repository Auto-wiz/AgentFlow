/**
 * Applies SQL migrations via drizzle-orm + pg (TCP). Prints full Postgres errors —
 * drizzle-kit sometimes exits non‑zero without a clear SQL message in npm output.
 *
 * Uses the same migrations folder + meta/_journal.json as `drizzle-kit migrate`.
 * Default migration history table: drizzle.__drizzle_migrations (same as Drizzle Kit).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import pg from "pg";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(__dirname, "..");
const migrationsFolder = path.join(pkgRoot, "migrations");

const url = process.env.DATABASE_URL?.trim();
if (!url) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

console.log("Migrations folder:", migrationsFolder);

const pool = new pg.Pool({ connectionString: url });
const db = drizzle(pool);

try {
  await migrate(db, { migrationsFolder });
  console.log("Migrations applied successfully.");
} catch (err) {
  console.error("Migration failed:");
  console.error(err);
  process.exit(1);
} finally {
  await pool.end();
}
