import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const { Client } = pg;
const here = dirname(fileURLToPath(import.meta.url));
const migrationDirectory = join(here, "..", "migrations");
const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl && !process.env.PGHOST) {
  throw new Error("Set DATABASE_URL or PGHOST/PGDATABASE/PGUSER/PGPASSWORD to run migrations");
}

const client = new Client(databaseUrl ? { connectionString: databaseUrl } : {});
await client.connect();

try {
  await client.query("SELECT pg_advisory_lock($1)", [74011233]);
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);

  const files = (await readdir(migrationDirectory))
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/i.test(name))
    .sort();
  const appliedResult = await client.query("SELECT version FROM schema_migrations");
  const applied = new Set(appliedResult.rows.map((row) => row.version));

  for (const version of files) {
    if (applied.has(version)) continue;

    const sql = await readFile(join(migrationDirectory, version), "utf8");
    console.info(`Applying database migration ${version}`);
    await client.query("BEGIN");
    try {
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (version) VALUES ($1)", [version]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw new Error(`Migration ${version} failed`, { cause: error });
    }
  }
} finally {
  try {
    await client.query("SELECT pg_advisory_unlock($1)", [74011233]);
  } finally {
    await client.end();
  }
}

console.info("Database migrations are up to date");
