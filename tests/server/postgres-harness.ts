import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";

import postgres from "postgres";

import type { Database } from "../../src/server/db/client";

export interface PostgresHarness {
  sql: Database;
  reset(): Promise<void>;
  close(): Promise<void>;
}

export async function createPostgresHarness(
  databaseUrl: string,
): Promise<PostgresHarness> {
  const schema = `leetbattle_test_${randomBytes(8).toString("hex")}`;
  const admin = postgres(databaseUrl, { max: 1 });
  await admin.unsafe(`CREATE SCHEMA "${schema}"`);

  const scopedUrl = new URL(databaseUrl);
  scopedUrl.searchParams.set("options", `-c search_path=${schema}`);
  const sql = postgres(scopedUrl.toString(), { max: 10, prepare: false });
  const migration = await readFile(
    new URL("../../db/migrations/001_initial.sql", import.meta.url),
    "utf8",
  );
  await sql.unsafe(migration);

  return {
    sql,
    async reset() {
      await sql.unsafe(
        "TRUNCATE TABLE profiles, problem_registry RESTART IDENTITY CASCADE; ALTER SEQUENCE execution_server_sequence RESTART WITH 1",
      );
    },
    async close() {
      await sql.end({ timeout: 5 });
      await admin.unsafe(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
      await admin.end({ timeout: 5 });
    },
  };
}
