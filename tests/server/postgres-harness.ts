import { randomBytes } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";

import postgres from "postgres";

import type { Database } from "../../src/server/db/client";

export interface PostgresHarness {
  sql: Database;
  scopedDatabaseUrl: string;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function createPostgresHarness(
  databaseUrl: string,
): Promise<PostgresHarness> {
  const schema = `leetbattle_test_${randomBytes(8).toString("hex")}`;
  const admin = postgres(databaseUrl, { max: 1 });
  await admin.unsafe(
    "CREATE EXTENSION IF NOT EXISTS citext WITH SCHEMA public; " +
      "CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public",
  );
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);

  const scopedUrl = new URL(databaseUrl);
  scopedUrl.searchParams.set("options", `-c search_path=${schema},public`);
  const sql = postgres(scopedUrl.toString(), { max: 10, prepare: false });
  const migrationsDirectory = new URL("../../db/migrations/", import.meta.url);
  const migrationFiles = (await readdir(migrationsDirectory))
    .filter((file) => file.endsWith(".sql"))
    .sort();
  const migrationConnection = await sql.reserve();
  try {
    for (const file of migrationFiles) {
      const migration = await readFile(
        new URL(file, migrationsDirectory),
        "utf8",
      );
      await migrationConnection.unsafe(migration);
    }
  } finally {
    migrationConnection.release();
  }

  return {
    sql,
    scopedDatabaseUrl: scopedUrl.toString(),
    async reset() {
      await sql.unsafe(
        "TRUNCATE TABLE ai_ml_judge_request_reservations, profiles, problem_registry RESTART IDENTITY CASCADE; ALTER SEQUENCE execution_server_sequence RESTART WITH 1",
      );
    },
    async close() {
      await sql.end({ timeout: 5 });
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end({ timeout: 5 });
    },
  };
}
