import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to run migrations");
}

const migrationsDirectory = fileURLToPath(
  new URL("./migrations", import.meta.url),
);
const sql = postgres(databaseUrl, { max: 1 });

try {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT clock_timestamp()
    )
  `;

  const files = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();

  for (const file of files) {
    const version = basename(file, ".sql");
    const [existing] = await sql<{ version: string }[]>`
      SELECT version FROM schema_migrations WHERE version = ${version}
    `;
    if (existing) continue;

    const migration = await readFile(join(migrationsDirectory, file), "utf8");
    await sql.unsafe(migration);
    await sql`INSERT INTO schema_migrations (version) VALUES (${version}) ON CONFLICT DO NOTHING`;
    console.info(`Applied migration ${version}`);
  }
} finally {
  await sql.end();
}
