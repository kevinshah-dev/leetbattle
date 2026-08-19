import type { MatchEngine } from "@/server/match/match-engine";
import type { AiMlArenaService } from "@/server/arena/arena-service";
import type { RealtimeTicketService } from "@/server/realtime/tickets";

export const GLOBAL_RECOVERY_CRON = "17 */6 * * *";
export const GLOBAL_AI_ML_DEADLINE_SWEEP_LIMIT = 100;
export const GLOBAL_AI_ML_RECOVERY_LIMIT = 4;
export const GLOBAL_AI_ML_RECOVERY_CONCURRENCY = 4;

const DAILY_CLEANUP_UTC_HOUR = 0;

type RecoveryMatchService = Pick<
  MatchEngine,
  | "processDueCountdowns"
  | "expireStaleSessions"
  | "processDueDisconnects"
  | "recoverStaleExecutions"
>;

type CleanupMatchService = Pick<MatchEngine, "purgeOldRealtimeSessions">;
type CleanupTicketService = Pick<RealtimeTicketService, "purgeExpiredUses">;
interface CleanupJudgeRequestBudget {
  purgeExpiredReservations(): Promise<number>;
}
type RecoveryArenaService = Pick<
  AiMlArenaService,
  "processDueAnswerDeadlines" | "recoverEvaluations"
>;

export interface MaintenanceServices {
  readonly matches: RecoveryMatchService & CleanupMatchService;
  readonly arena: RecoveryArenaService;
  readonly tickets: CleanupTicketService;
  readonly judgeRequestBudget: CleanupJudgeRequestBudget;
}

export interface MaintenanceOptions {
  readonly includeCleanup: boolean;
}

export interface RecoveryResult {
  readonly countdowns: number;
  readonly staleSessions: number;
  readonly disconnects: number;
  readonly staleExecutions: number;
  readonly answerDeadlines: number;
  readonly aiMlEvaluations: number;
}

export interface CleanupResult {
  readonly expiredTickets: number;
  readonly expiredSessionRecords: number;
  readonly expiredJudgeRequestReservations: number;
}

export interface MaintenanceResult {
  readonly recovery: RecoveryResult;
  readonly cleanup: CleanupResult | null;
}

/**
 * Cron triggers use UTC. The recovery schedule includes 00:17 UTC, so the
 * retention work can share that database wake instead of adding another one.
 */
export function shouldRunDailyCleanup(scheduledTime: number): boolean {
  if (!Number.isFinite(scheduledTime)) return false;
  return new Date(scheduledTime).getUTCHours() === DAILY_CLEANUP_UTC_HOUR;
}

export async function runMaintenanceOperations(
  services: MaintenanceServices,
  options: MaintenanceOptions,
): Promise<MaintenanceResult> {
  const recovery: RecoveryResult = {
    countdowns: await services.matches.processDueCountdowns(),
    staleSessions: await services.matches.expireStaleSessions(),
    disconnects: await services.matches.processDueDisconnects(),
    staleExecutions: await services.matches.recoverStaleExecutions(),
    // Deadline discovery is database-only. Provider work is a separate,
    // tightly bounded concurrent phase so one cron cannot run for hours when
    // many rooms become overdue together.
    answerDeadlines: await services.arena.processDueAnswerDeadlines(
      GLOBAL_AI_ML_DEADLINE_SWEEP_LIMIT,
      { evaluateImmediately: false },
    ),
    aiMlEvaluations: await services.arena.recoverEvaluations(
      GLOBAL_AI_ML_RECOVERY_LIMIT,
      GLOBAL_AI_ML_RECOVERY_CONCURRENCY,
    ),
  };

  const cleanup: CleanupResult | null = options.includeCleanup
    ? {
        expiredTickets: await services.tickets.purgeExpiredUses(),
        expiredSessionRecords:
          await services.matches.purgeOldRealtimeSessions(),
        expiredJudgeRequestReservations:
          await services.judgeRequestBudget.purgeExpiredReservations(),
      }
    : null;

  return { recovery, cleanup };
}
