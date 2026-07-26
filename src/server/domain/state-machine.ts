import type { MatchState } from "./types";

import { DomainError } from "./errors";

const transitions: Readonly<Record<MatchState, readonly MatchState[]>> = {
  LOBBY: ["COUNTDOWN", "FINISHED"],
  COUNTDOWN: ["ACTIVE", "FINISHED"],
  ACTIVE: ["FINISHED"],
  FINISHED: ["REMATCH_PENDING"],
  REMATCH_PENDING: [],
};

export function canTransition(from: MatchState, to: MatchState): boolean {
  return transitions[from].includes(to);
}

export function assertTransition(from: MatchState, to: MatchState): void {
  if (!canTransition(from, to)) {
    throw new DomainError(
      "INVALID_STATE",
      `Match cannot transition from ${from} to ${to}`,
      409,
    );
  }
}

export function shouldApplyRecord(endReason: string): boolean {
  return endReason === "ACCEPTED" || endReason === "FORFEIT";
}

/** Earlier receipt always wins; runtime is considered only for equal timestamps. */
export function compareWinnerCandidates(
  left: { receivedAt: string; runtimeMs: number; sequence: number },
  right: { receivedAt: string; runtimeMs: number; sequence: number },
): number {
  const received = Date.parse(left.receivedAt) - Date.parse(right.receivedAt);
  if (received !== 0) return received;
  const runtime = left.runtimeMs - right.runtimeMs;
  if (runtime !== 0) return runtime;
  return left.sequence - right.sequence;
}
