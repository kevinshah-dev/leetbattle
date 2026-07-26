import { listPublicProblemsByDifficulty } from "@/problems/public/catalog";
import {
  requireAllDistinctInternalSecrets,
  requireDistinctInternalSecrets,
  requireInternalSecret,
} from "@/server/config/secrets";
import { getLeetBattleCloudflareContext } from "@/server/cloudflare/context";
import {
  closeDatabaseClient,
  createDatabase,
  getDatabase,
  type Database,
} from "@/server/db/client";
import type { Difficulty, ProblemCatalog } from "@/server/domain/types";
import { HistoryService } from "@/server/history/history-service";
import { ExecutionCoordinator } from "@/server/match/execution-coordinator";
import {
  MatchEngine,
  type MatchEngineOptions,
} from "@/server/match/match-engine";
import {
  HttpRunnerClient,
  type RunnerAdapter,
} from "@/server/match/runner-client";
import { ProfileService } from "@/server/profiles/profile-service";
import { RealtimeNotifier } from "@/server/realtime/notifier";
import { RealtimeTicketService } from "@/server/realtime/tickets";

const publicCatalog: ProblemCatalog = {
  listByDifficulty(difficulty: Difficulty) {
    return listPublicProblemsByDifficulty(difficulty).map((problem) => ({
      id: problem.id,
      version: problem.version,
      title: problem.title,
      difficulty: problem.difficulty,
    }));
  },
};

export interface ServerServices {
  db: Database;
  profiles: ProfileService;
  history: HistoryService;
  matches: MatchEngine;
  executions: ExecutionCoordinator;
  realtimeTickets: RealtimeTicketService;
  realtime: RealtimeNotifier;
}

export interface CreateServicesOptions {
  db?: Database;
  catalog?: ProblemCatalog;
  runner?: RunnerAdapter;
  match?: MatchEngineOptions;
  runnerUrl?: string;
  runnerSecret?: string;
  realtimeTicketSecret?: string;
  realtime?: RealtimeNotifier;
}

export function createServices(
  options: CreateServicesOptions = {},
): ServerServices {
  const db = options.db ?? getDatabase();
  const runnerUrl =
    options.runnerUrl ?? process.env.RUNNER_URL ?? "http://127.0.0.1:3002";
  const runnerSecretCandidate = options.runner
    ? options.runnerSecret
    : (options.runnerSecret ?? process.env.RUNNER_INTERNAL_SECRET);
  const realtimeTicketSecretCandidate =
    options.realtimeTicketSecret ?? process.env.REALTIME_TICKET_SECRET;
  const roomInviteSecretCandidate =
    options.match?.inviteSecret ?? process.env.ROOM_INVITE_SECRET;

  let runnerSecret: string | undefined;
  let realtimeTicketSecret: string;
  let roomInviteSecret: string;
  if (!options.runner || runnerSecretCandidate !== undefined) {
    const secrets = requireDistinctInternalSecrets({
      REALTIME_TICKET_SECRET: realtimeTicketSecretCandidate,
      RUNNER_INTERNAL_SECRET: runnerSecretCandidate,
      ROOM_INVITE_SECRET: roomInviteSecretCandidate,
    });
    runnerSecret = secrets.RUNNER_INTERNAL_SECRET;
    realtimeTicketSecret = secrets.REALTIME_TICKET_SECRET;
    roomInviteSecret = secrets.ROOM_INVITE_SECRET;
  } else {
    // Injected runners do not need a bearer secret, but the two remaining
    // production trust boundaries still require distinct valid values.
    realtimeTicketSecret = requireInternalSecret(
      "REALTIME_TICKET_SECRET",
      realtimeTicketSecretCandidate,
    );
    roomInviteSecret = requireInternalSecret(
      "ROOM_INVITE_SECRET",
      roomInviteSecretCandidate,
    );
    if (realtimeTicketSecret === roomInviteSecret) {
      throw new Error("Internal service secrets must be distinct");
    }
  }
  const matches = new MatchEngine(db, options.catalog ?? publicCatalog, {
    ...options.match,
    inviteSecret: roomInviteSecret,
  });
  const runner =
    options.runner ?? new HttpRunnerClient(runnerUrl, runnerSecret!);
  const realtime = options.realtime ?? new RealtimeNotifier();
  return {
    db,
    profiles: new ProfileService(db),
    history: new HistoryService(db),
    matches,
    executions: new ExecutionCoordinator(matches, runner, (matchId) =>
      realtime.matchUpdated({ matchId }),
    ),
    realtimeTickets: new RealtimeTicketService(
      db,
      matches,
      realtimeTicketSecret,
    ),
    realtime,
  };
}

let singleton: ServerServices | undefined;

/** Lazy: importing a route during `next build` never requires runtime secrets. */
export function getServices(): ServerServices {
  singleton ??= createServices();
  return singleton;
}

/**
 * Creates request-scoped services on Workers and closes the invocation-owned
 * Postgres.js client before returning. Local Node processes retain their
 * existing singleton pool and HTTP runner behavior.
 */
export async function withServices<T>(
  operation: (services: ServerServices) => Promise<T>,
): Promise<T> {
  const cloudflare = getLeetBattleCloudflareContext();
  const hyperdrive = cloudflare?.env.HYPERDRIVE_FRESH;
  if (!hyperdrive) return operation(getServices());

  const db = createDatabase(hyperdrive.connectionString, {
    hyperdrive: true,
  });
  const useServiceBindings = process.env.NODE_ENV === "production";
  const runnerService = useServiceBindings
    ? cloudflare.env.RUNNER_SERVICE
    : undefined;
  const productionSecrets = useServiceBindings
    ? requireAllDistinctInternalSecrets({
        REALTIME_TICKET_SECRET:
          cloudflare.env.REALTIME_TICKET_SECRET ??
          process.env.REALTIME_TICKET_SECRET,
        RUNNER_INTERNAL_SECRET:
          cloudflare.env.RUNNER_INTERNAL_SECRET ??
          process.env.RUNNER_INTERNAL_SECRET,
        ROOM_INVITE_SECRET:
          cloudflare.env.ROOM_INVITE_SECRET ?? process.env.ROOM_INVITE_SECRET,
        REALTIME_NOTIFY_SECRET:
          cloudflare.env.REALTIME_NOTIFY_SECRET ??
          process.env.REALTIME_NOTIFY_SECRET,
      })
    : null;
  const runnerSecret =
    productionSecrets?.RUNNER_INTERNAL_SECRET ??
    cloudflare.env.RUNNER_INTERNAL_SECRET ??
    process.env.RUNNER_INTERNAL_SECRET;
  const serviceRunnerSecret = runnerService
    ? requireInternalSecret("RUNNER_INTERNAL_SECRET", runnerSecret)
    : runnerSecret;
  const runner = runnerService
    ? new HttpRunnerClient(
        "https://leetbattle-runner.internal",
        serviceRunnerSecret!,
        (input, init) => runnerService.fetch(input, init),
      )
    : undefined;
  const realtimeService = useServiceBindings
    ? cloudflare.env.REALTIME_SERVICE
    : undefined;
  const realtime = realtimeService
    ? new RealtimeNotifier(
        realtimeService,
        productionSecrets?.REALTIME_NOTIFY_SECRET ??
          cloudflare.env.REALTIME_NOTIFY_SECRET ??
          process.env.REALTIME_NOTIFY_SECRET,
      )
    : undefined;

  try {
    return await operation(
      createServices({
        db,
        ...(runner ? { runner } : {}),
        ...(serviceRunnerSecret ? { runnerSecret: serviceRunnerSecret } : {}),
        runnerUrl: process.env.RUNNER_URL,
        realtimeTicketSecret:
          productionSecrets?.REALTIME_TICKET_SECRET ??
          cloudflare.env.REALTIME_TICKET_SECRET ??
          process.env.REALTIME_TICKET_SECRET,
        match: {
          inviteSecret:
            productionSecrets?.ROOM_INVITE_SECRET ??
            cloudflare.env.ROOM_INVITE_SECRET ??
            process.env.ROOM_INVITE_SECRET,
        },
        ...(realtime ? { realtime } : {}),
      }),
    );
  } finally {
    await closeDatabaseClient(db);
  }
}
