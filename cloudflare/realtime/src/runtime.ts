import postgres from "postgres";

import { listPublicProblemsByDifficulty } from "@/problems/public/catalog";
import type { Database } from "@/server/db/client";
import type {
  Difficulty,
  ProblemCatalog,
  PublicProblemRef,
} from "@/server/domain/types";
import { MatchEngine } from "@/server/match/match-engine";
import {
  runMaintenanceOperations,
  type MaintenanceOptions,
  type MaintenanceResult,
} from "@/server/realtime/maintenance";
import { RealtimeTicketService } from "@/server/realtime/tickets";
import { REALTIME_SOCKET_LEASE_RENEW_AFTER_SECONDS } from "@/server/realtime/timing";

const problemCatalog: ProblemCatalog = Object.freeze({
  listByDifficulty(difficulty: Difficulty): readonly PublicProblemRef[] {
    return listPublicProblemsByDifficulty(difficulty).map((problem) => ({
      id: problem.id,
      version: problem.version,
      title: problem.title,
      difficulty: problem.difficulty,
    }));
  },
});

export interface RealtimeRuntime {
  readonly db: Database;
  readonly matches: MatchEngine;
  readonly tickets: RealtimeTicketService;
}

export function assertDistinctRealtimeSecrets(env: Env): void {
  if (
    new Set([
      env.REALTIME_TICKET_SECRET,
      env.ROOM_INVITE_SECRET,
      env.REALTIME_NOTIFY_SECRET,
    ]).size !== 3
  ) {
    throw new Error("Realtime service secrets must be distinct");
  }
}

function openDatabase(env: Env): Database {
  return postgres(env.HYPERDRIVE_FRESH.connectionString, {
    max: 1,
    idle_timeout: 10,
    connect_timeout: 10,
    prepare: true,
    fetch_types: false,
  });
}

export async function withDatabase<T>(
  env: Env,
  operation: (db: Database) => Promise<T>,
): Promise<T> {
  const db = openDatabase(env);
  let operationFailed = false;

  try {
    return await operation(db);
  } catch (error) {
    operationFailed = true;
    throw error;
  } finally {
    try {
      await db.end({ timeout: 5 });
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "realtime.database.close_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      if (!operationFailed) throw error;
    }
  }
}

export async function withRealtimeRuntime<T>(
  env: Env,
  operation: (runtime: RealtimeRuntime) => Promise<T>,
): Promise<T> {
  assertDistinctRealtimeSecrets(env);
  return withDatabase(env, async (db) => {
    const matches = new MatchEngine(db, problemCatalog, {
      inviteSecret: env.ROOM_INVITE_SECRET,
    });
    const tickets = new RealtimeTicketService(
      db,
      matches,
      env.REALTIME_TICKET_SECRET,
    );

    return operation({ db, matches, tickets });
  });
}

/**
 * Returns the next room-local deadline understood by the existing match model.
 * The query is intentionally cache-disabled through HYPERDRIVE_FRESH.
 */
export async function nextMatchWakeAt(
  db: Database,
  matchId: string,
): Promise<number | null> {
  const [row] = await db<{ wake_at: string | null }[]>`
    SELECT min(
      CASE
        WHEN deadline <= clock_timestamp()
          THEN clock_timestamp() + interval '5 seconds'
        ELSE deadline
      END
    )::text AS wake_at
    FROM (
      SELECT starts_at AS deadline
      FROM matches
      WHERE id = ${matchId} AND state = 'COUNTDOWN' AND starts_at IS NOT NULL

      UNION ALL

      SELECT reconnect_deadline AS deadline
      FROM match_participants
      WHERE match_id = ${matchId} AND reconnect_deadline IS NOT NULL

      UNION ALL

      SELECT last_seen_at
        + (${REALTIME_SOCKET_LEASE_RENEW_AFTER_SECONDS} * interval '1 second')
        AS deadline
      FROM realtime_sessions
      WHERE match_id = ${matchId} AND disconnected_at IS NULL

      UNION ALL

      SELECT created_at + interval '120 seconds' AS deadline
      FROM executions
      WHERE match_id = ${matchId} AND status IN ('QUEUED', 'RUNNING')
    ) deadlines
  `;

  if (!row?.wake_at) return null;
  const timestamp = Date.parse(row.wake_at);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export async function runGlobalMaintenance(
  env: Env,
  options: MaintenanceOptions,
): Promise<MaintenanceResult> {
  const result = await withRealtimeRuntime(env, (runtime) =>
    runMaintenanceOperations(runtime, options),
  );

  console.log(
    JSON.stringify({
      event: "realtime.maintenance.completed",
      cleanupRan: result.cleanup !== null,
      ...result.recovery,
      ...(result.cleanup ?? {}),
    }),
  );
  return result;
}
