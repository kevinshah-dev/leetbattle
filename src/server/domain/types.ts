export const DIFFICULTIES = ["EASY", "MEDIUM", "HARD"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

export const LANGUAGES = ["PYTHON", "JAVA"] as const;
export type Language = (typeof LANGUAGES)[number];

export const MATCH_MODES = ["DUEL", "PRACTICE"] as const;
export type MatchMode = (typeof MATCH_MODES)[number];

export const MATCH_STATES = [
  "LOBBY",
  "COUNTDOWN",
  "ACTIVE",
  "FINISHED",
  "REMATCH_PENDING",
] as const;
export type MatchState = (typeof MATCH_STATES)[number];

export const END_REASONS = [
  "ACCEPTED",
  "FORFEIT",
  "CANCELLED",
  "NO_CONTEST",
] as const;
export type EndReason = (typeof END_REASONS)[number];

export const EXECUTION_VERDICTS = [
  "ACCEPTED",
  "WRONG_ANSWER",
  "COMPILE_ERROR",
  "RUNTIME_ERROR",
  "TIMEOUT",
  "MEMORY_LIMIT",
  "OUTPUT_LIMIT",
  "INFRA_ERROR",
] as const;
export type ExecutionVerdict = (typeof EXECUTION_VERDICTS)[number];
export type ExecutionKind = "RUN" | "SUBMIT";
export type PlayerActivity =
  | "THINKING"
  | "COMPILING"
  | "JUDGING"
  | "COOLDOWN"
  | "ACCEPTED"
  | "DISCONNECTED";

export interface PublicProblemRef {
  id: string;
  version: number;
  title: string;
  difficulty: Difficulty;
}

export interface ProblemCatalog {
  listByDifficulty(difficulty: Difficulty): readonly PublicProblemRef[];
}

export interface MatchEvent {
  matchId: string;
  version: number;
  type: string;
  payload: Record<string, unknown>;
  serverTimestamp: string;
}

export interface PlayerSnapshot {
  username: string;
  slot: 1 | 2;
  isSelf: boolean;
  language: Language | null;
  ready: boolean;
  connected: boolean;
  activity: PlayerActivity;
  bestPassedCount: number;
  hiddenTestCount: number | null;
  cooldownUntil: string | null;
  outcome: "WIN" | "LOSS" | "DRAW" | "NO_CONTEST" | "CANCELLED" | null;
}

export interface MatchSnapshot {
  roomId: string;
  matchId: string;
  mode: MatchMode;
  roundNumber: number;
  difficulty: Difficulty;
  state: MatchState;
  version: number;
  serverTimestamp: string;
  startsAt: string | null;
  finishedAt: string | null;
  rematchDeadline: string | null;
  endReason: EndReason | null;
  winnerUsername: string | null;
  problem: PublicProblemRef | null;
  players: PlayerSnapshot[];
  rematchVotes: number[];
  rematchCreatedMatchId: string | null;
}

export interface RunnerResult {
  verdict: ExecutionVerdict;
  passedCount: number;
  totalCount: number;
  runtimeMs: number | null;
  compileMs: number | null;
  /** Only visible-sample output or a sanitized player-owned diagnostic. Never hidden case data. */
  details?: Record<string, unknown>;
}
