import type { MatchEngine } from "@/server/match/match-engine";
import type { RealtimeTicketService } from "@/server/realtime/tickets";

export const GLOBAL_RECOVERY_CRON = "17 */6 * * *";

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

export interface MaintenanceServices {
  readonly matches: RecoveryMatchService & CleanupMatchService;
  readonly tickets: CleanupTicketService;
}

export interface MaintenanceOptions {
  readonly includeCleanup: boolean;
}

export interface RecoveryResult {
  readonly countdowns: number;
  readonly staleSessions: number;
  readonly disconnects: number;
  readonly staleExecutions: number;
}

export interface CleanupResult {
  readonly expiredTickets: number;
  readonly expiredSessionRecords: number;
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
  };

  const cleanup: CleanupResult | null = options.includeCleanup
    ? {
        expiredTickets: await services.tickets.purgeExpiredUses(),
        expiredSessionRecords:
          await services.matches.purgeOldRealtimeSessions(),
      }
    : null;

  return { recovery, cleanup };
}
