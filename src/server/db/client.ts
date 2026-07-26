import postgres from "postgres";

let localDatabase: ReturnType<typeof postgres> | undefined;

export type Database = ReturnType<typeof postgres>;

export interface CreateDatabaseOptions {
  hyperdrive?: boolean;
  maximumConnections?: number;
}

/**
 * Creates an invocation-owned Postgres.js client. Hyperdrive supplies the
 * reusable connection pool, so Worker requests must not retain this object in
 * module scope or share it with a later request.
 */
export function createDatabase(
  connectionString: string,
  options: CreateDatabaseOptions = {},
): Database {
  return postgres(connectionString, {
    max:
      options.maximumConnections ??
      (options.hyperdrive ? 5 : Number(process.env.DATABASE_POOL_SIZE ?? 10)),
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: options.hyperdrive ?? false,
    ...(options.hyperdrive ? { fetch_types: false } : {}),
  });
}

/** Long-lived direct client used only by the local Node.js processes. */
export function getDatabase(): Database {
  if (localDatabase) return localDatabase;

  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");

  localDatabase = createDatabase(databaseUrl);
  return localDatabase;
}

export async function closeDatabaseClient(database: Database): Promise<void> {
  await database.end({ timeout: 5 });
}

export async function closeDatabase(): Promise<void> {
  if (!localDatabase) return;
  const active = localDatabase;
  localDatabase = undefined;
  await closeDatabaseClient(active);
}
