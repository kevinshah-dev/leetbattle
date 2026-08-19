import { listPublicProblemsByDifficulty } from "@/problems/public/catalog";
import {
  getPublicAiMlQuestion,
  listPublicAiMlQuestionsByDifficulty,
} from "@/arena/public";
import {
  requireAllDistinctInternalSecrets,
  requireDistinctInternalSecrets,
  requireInternalSecret,
} from "@/server/config/secrets";
import {
  AiMlJudgeUnavailableError,
  OPENAI_JUDGE_DEFAULT_MODEL,
  OpenAiJudgeAdapter,
  PostgresAiMlJudgeRequestBudget,
  type AiMlEvaluationSnapshot,
  type AiMlJudgeAdapter,
  type AiMlJudgeEvaluationOptions,
  type AiMlJudgeRequestBudget,
  type AiMlJudgeResult,
} from "@/server/ai-ml";
import {
  createE2eFakeAiMlJudge,
  isE2eFakeAiMlJudgeEnabled,
} from "@/server/ai-ml/e2e-fake-judge";
import {
  AiMlArenaService,
  type AiMlArenaOptions,
} from "@/server/arena/arena-service";
import { getLeetBattleCloudflareContext } from "@/server/cloudflare/context";
import {
  closeDatabaseClient,
  createDatabase,
  getDatabase,
  type Database,
} from "@/server/db/client";
import type {
  AiMlQuestionCatalog,
  Difficulty,
  ProblemCatalog,
} from "@/server/domain/types";
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

const aiMlCatalog: AiMlQuestionCatalog = {
  listByDifficulty(difficulty: Difficulty) {
    return listPublicAiMlQuestionsByDifficulty(difficulty).map((question) => ({
      id: question.id,
      version: question.version,
      title: question.title,
      prompt: question.prompt,
      difficulty: question.difficulty,
      category: question.category,
      answerConstraints: { ...question.answerConstraints },
    }));
  },
  get(id: string, version: number) {
    const question = getPublicAiMlQuestion(id, version);
    return question
      ? {
          id: question.id,
          version: question.version,
          title: question.title,
          prompt: question.prompt,
          difficulty: question.difficulty,
          category: question.category,
          answerConstraints: { ...question.answerConstraints },
        }
      : null;
  },
};

export interface ServerServices {
  db: Database;
  profiles: ProfileService;
  history: HistoryService;
  matches: MatchEngine;
  arena: AiMlArenaService;
  judgeRequestBudget: PostgresAiMlJudgeRequestBudget;
  executions: ExecutionCoordinator;
  realtimeTickets: RealtimeTicketService;
  realtime: RealtimeNotifier;
}

export interface CreateServicesOptions {
  db?: Database;
  catalog?: ProblemCatalog;
  runner?: RunnerAdapter;
  judge?: AiMlJudgeAdapter;
  openAiApiKey?: string;
  openAiJudgeModel?: string;
  arena?: Omit<AiMlArenaOptions, "requestedModel">;
  openAiJudgeMaxDailyRequests?: number;
  openAiJudgeMaxDailyRequestsPerUser?: number;
  openAiJudgeMaxDailyRequestsPerMatch?: number;
  match?: MatchEngineOptions;
  runnerUrl?: string;
  runnerSecret?: string;
  realtimeTicketSecret?: string;
  realtime?: RealtimeNotifier;
}

class LazyOpenAiJudgeAdapter implements AiMlJudgeAdapter {
  private adapter: OpenAiJudgeAdapter | null = null;

  constructor(
    private readonly apiKey: string | undefined,
    private readonly model: string,
    private readonly requestBudget: AiMlJudgeRequestBudget,
  ) {}

  evaluate(
    snapshot: AiMlEvaluationSnapshot,
    options?: AiMlJudgeEvaluationOptions,
  ): Promise<AiMlJudgeResult> {
    if (!this.apiKey?.trim()) {
      throw new AiMlJudgeUnavailableError({
        code: "CONFIGURATION",
        retryable: false,
        attemptCount: 0,
        attempts: Object.freeze([]),
      });
    }
    this.adapter ??= new OpenAiJudgeAdapter({
      apiKey: this.apiKey,
      model: this.model,
      requestBudget: this.requestBudget,
    });
    return this.adapter.evaluate(snapshot, options);
  }
}

function positiveIntegerSetting(
  name: string,
  value: number | string | undefined,
  fallback: number,
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
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
    aiMlCatalog: options.match?.aiMlCatalog ?? aiMlCatalog,
    inviteSecret: roomInviteSecret,
  });
  const runner =
    options.runner ?? new HttpRunnerClient(runnerUrl, runnerSecret!);
  const realtime = options.realtime ?? new RealtimeNotifier();
  const judgeModel =
    options.openAiJudgeModel ??
    process.env.OPENAI_JUDGE_MODEL ??
    OPENAI_JUDGE_DEFAULT_MODEL;
  if (!judgeModel.trim()) {
    throw new Error("OPENAI_JUDGE_MODEL must not be blank");
  }
  const maxJudgeRequestsPerDay = positiveIntegerSetting(
    "OPENAI_JUDGE_MAX_DAILY_REQUESTS",
    options.openAiJudgeMaxDailyRequests ??
      process.env.OPENAI_JUDGE_MAX_DAILY_REQUESTS,
    1_000,
  );
  const maxJudgeRequestsPerUserPerDay = positiveIntegerSetting(
    "OPENAI_JUDGE_MAX_DAILY_REQUESTS_PER_USER",
    options.openAiJudgeMaxDailyRequestsPerUser ??
      process.env.OPENAI_JUDGE_MAX_DAILY_REQUESTS_PER_USER,
    50,
  );
  const maxJudgeRequestsPerMatchPerDay = positiveIntegerSetting(
    "OPENAI_JUDGE_MAX_DAILY_REQUESTS_PER_MATCH",
    options.openAiJudgeMaxDailyRequestsPerMatch ??
      process.env.OPENAI_JUDGE_MAX_DAILY_REQUESTS_PER_MATCH,
    6,
  );
  const judgeRequestBudget = new PostgresAiMlJudgeRequestBudget(
    db,
    maxJudgeRequestsPerDay,
    maxJudgeRequestsPerUserPerDay,
    maxJudgeRequestsPerMatchPerDay,
  );
  const judge =
    options.judge ??
    (isE2eFakeAiMlJudgeEnabled()
      ? createE2eFakeAiMlJudge()
      : new LazyOpenAiJudgeAdapter(
          options.openAiApiKey ?? process.env.OPENAI_API_KEY,
          judgeModel,
          judgeRequestBudget,
        ));
  return {
    db,
    profiles: new ProfileService(db),
    history: new HistoryService(db),
    matches,
    arena: new AiMlArenaService(db, judge, {
      ...options.arena,
      requestedModel: judgeModel,
    }),
    judgeRequestBudget,
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
        openAiApiKey:
          cloudflare.env.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
        openAiJudgeModel:
          cloudflare.env.OPENAI_JUDGE_MODEL ?? process.env.OPENAI_JUDGE_MODEL,
        openAiJudgeMaxDailyRequests: positiveIntegerSetting(
          "OPENAI_JUDGE_MAX_DAILY_REQUESTS",
          cloudflare.env.OPENAI_JUDGE_MAX_DAILY_REQUESTS ??
            process.env.OPENAI_JUDGE_MAX_DAILY_REQUESTS,
          1_000,
        ),
        openAiJudgeMaxDailyRequestsPerUser: positiveIntegerSetting(
          "OPENAI_JUDGE_MAX_DAILY_REQUESTS_PER_USER",
          cloudflare.env.OPENAI_JUDGE_MAX_DAILY_REQUESTS_PER_USER ??
            process.env.OPENAI_JUDGE_MAX_DAILY_REQUESTS_PER_USER,
          50,
        ),
        openAiJudgeMaxDailyRequestsPerMatch: positiveIntegerSetting(
          "OPENAI_JUDGE_MAX_DAILY_REQUESTS_PER_MATCH",
          cloudflare.env.OPENAI_JUDGE_MAX_DAILY_REQUESTS_PER_MATCH ??
            process.env.OPENAI_JUDGE_MAX_DAILY_REQUESTS_PER_MATCH,
          6,
        ),
        ...(realtime ? { realtime } : {}),
      }),
    );
  } finally {
    await closeDatabaseClient(db);
  }
}
