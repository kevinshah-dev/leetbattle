export const MAX_REALTIME_SOCKETS_PER_USER_PER_MATCH = 2;

const COMMAND_INTERVAL_MS = 500;
const PING_INTERVAL_MS = 5_000;
const SNAPSHOT_INTERVAL_MS = 2_000;

export interface RealtimeCommandRateState {
  commandNotBefore: number;
  pingNotBefore: number;
  snapshotNotBefore: number;
}

export type RateLimitedRealtimeCommand = "PING" | "SNAPSHOT";

export type RealtimeCommandAdmission =
  | { allowed: true; state: RealtimeCommandRateState }
  | { allowed: false; retryAt: number; state: RealtimeCommandRateState };

export function emptyRealtimeCommandRateState(): RealtimeCommandRateState {
  return {
    commandNotBefore: 0,
    pingNotBefore: 0,
    snapshotNotBefore: 0,
  };
}

function safeTimestamp(value: unknown): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;
}

export function readRealtimeCommandRateState(
  value: Partial<RealtimeCommandRateState>,
): RealtimeCommandRateState {
  return {
    commandNotBefore: safeTimestamp(value.commandNotBefore),
    pingNotBefore: safeTimestamp(value.pingNotBefore),
    snapshotNotBefore: safeTimestamp(value.snapshotNotBefore),
  };
}

export function admitRealtimeCommand(
  state: RealtimeCommandRateState,
  command: RateLimitedRealtimeCommand,
  now = Date.now(),
): RealtimeCommandAdmission {
  const commandSpecificNotBefore =
    command === "PING" ? state.pingNotBefore : state.snapshotNotBefore;
  const retryAt = Math.max(state.commandNotBefore, commandSpecificNotBefore);
  if (now < retryAt) return { allowed: false, retryAt, state };

  return {
    allowed: true,
    state: {
      ...state,
      commandNotBefore: now + COMMAND_INTERVAL_MS,
      ...(command === "PING"
        ? { pingNotBefore: now + PING_INTERVAL_MS }
        : { snapshotNotBefore: now + SNAPSHOT_INTERVAL_MS }),
    },
  };
}

export function hasReachedRealtimeSocketCap(activeCount: number): boolean {
  return activeCount >= MAX_REALTIME_SOCKETS_PER_USER_PER_MATCH;
}
