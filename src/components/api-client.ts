export type Difficulty = "EASY" | "MEDIUM" | "HARD";
export type Language = "PYTHON" | "JAVA";
export type MatchState =
  | "LOBBY"
  | "COUNTDOWN"
  | "ACTIVE"
  | "FINISHED"
  | "REMATCH_PENDING"
  | "CANCELLED"
  | "NO_CONTEST";
export type PlayerActivity =
  | "WAITING"
  | "READY"
  | "THINKING"
  | "COMPILING"
  | "JUDGING"
  | "COOLDOWN"
  | "VERIFYING"
  | "ACCEPTED"
  | "DISCONNECTED";

export interface PlayerHud {
  id: string;
  username: string;
  role: "HOST" | "CHALLENGER";
  connected: boolean;
  ready: boolean;
  language: Language | null;
  activity: PlayerActivity;
  bestPassed: number;
  totalTests: number;
  cooldownUntil: string | null;
  rematchVoted: boolean;
}

export interface PublicSample {
  id: string;
  input: string;
  output: string;
  explanation?: string;
}

export interface PublicProblem {
  id: string;
  version: number;
  title: string;
  difficulty: Difficulty;
  description: string;
  constraints: string[];
  samples: PublicSample[];
  functionName: string;
  contracts: Record<Language, string>;
  starterCode: Record<Language, string>;
  limits: {
    wallMs: number;
    memoryMb: number;
  };
}

export interface ActivityEvent {
  id: string;
  serverTimestamp: string;
  tone: "NEUTRAL" | "SELF" | "OPPONENT" | "SUCCESS" | "DANGER";
  message: string;
}

export interface SampleResult {
  id: string;
  status: "PASSED" | "FAILED" | "ERROR";
  runtimeMs?: number;
  actual?: string;
  message?: string;
}

export interface SubmissionSummary {
  verdict:
    | "ACCEPTED"
    | "WRONG_ANSWER"
    | "COMPILE_ERROR"
    | "RUNTIME_ERROR"
    | "TIME_LIMIT"
    | "MEMORY_LIMIT"
    | "OUTPUT_LIMIT"
    | "INFRASTRUCTURE_ERROR";
  passed: number;
  total: number;
  runtimeMs?: number;
  message: string;
}

export interface MatchResult {
  outcome: "WIN" | "LOSS" | "DRAW" | "CANCELLED" | "NO_CONTEST";
  endReason: "ACCEPTED" | "FORFEIT" | "CANCELLED" | "DISCONNECT" | "NO_CONTEST";
  winnerUsername: string | null;
  durationMs: number;
}

export interface RoomSnapshot {
  matchId: string;
  roundNumber: number;
  roomCode: string;
  inviteUrl?: string;
  version: number;
  serverNow: string;
  state: MatchState;
  difficulty: Difficulty;
  startsAt: string | null;
  finishedAt: string | null;
  rematchDeadline: string | null;
  self: PlayerHud;
  opponent: PlayerHud | null;
  problem: PublicProblem | null;
  activity: ActivityEvent[];
  sampleRun: {
    status: "IDLE" | "RUNNING" | "COMPLETE";
    results: SampleResult[];
  } | null;
  lastSubmission: SubmissionSummary | null;
  result: MatchResult | null;
}

export interface PlayerProfile {
  username: string;
  wins: number;
  losses: number;
  createdAt?: string;
}

export interface MatchHistoryItem {
  id: string;
  roomCode: string;
  playedAt: string;
  opponentUsername: string;
  problemTitle: string;
  difficulty: Difficulty;
  language: Language;
  outcome: "WIN" | "LOSS" | "DRAW" | "NO_CONTEST";
  durationMs: number;
  endReason: string;
}

export type RoomCommand =
  | { type: "SELECT_LANGUAGE"; payload: { language: Language } }
  | { type: "SET_READY"; payload: { ready: boolean } }
  | { type: "RUN_SAMPLES"; payload: { language: Language; source: string } }
  | { type: "SUBMIT"; payload: { language: Language; source: string } }
  | { type: "REMATCH_VOTE"; payload: { vote: boolean } }
  | { type: "FORFEIT"; payload: Record<string, never> }
  | { type: "CANCEL"; payload: Record<string, never> };

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
    cache: "no-store",
  });

  const body = (await response.json().catch(() => null)) as {
    error?: { code?: string; message?: string; details?: unknown };
    message?: string;
  } | null;

  if (!response.ok) {
    throw new ApiError(
      body?.error?.message ||
        body?.message ||
        `Request failed (${response.status})`,
      response.status,
      body?.error?.code,
      body?.error?.details,
    );
  }

  return body as T;
}

export function getProfile(signal?: AbortSignal) {
  return request<{ profile: PlayerProfile | null }>("/api/profile", { signal });
}

export function saveProfile(username: string) {
  return request<{ profile: PlayerProfile }>("/api/profile", {
    method: "POST",
    body: JSON.stringify({ username }),
  });
}

export function createRoom(difficulty: Difficulty) {
  return request<{
    roomCode: string;
    inviteUrl: string;
    snapshot: RoomSnapshot;
  }>("/api/rooms", {
    method: "POST",
    body: JSON.stringify({ difficulty, idempotencyKey: crypto.randomUUID() }),
  });
}

export function joinRoom(roomCode: string) {
  return request<{ snapshot: RoomSnapshot }>("/api/rooms/join", {
    method: "POST",
    body: JSON.stringify({ roomCode, idempotencyKey: crypto.randomUUID() }),
  });
}

export function getRoom(roomCode: string, signal?: AbortSignal) {
  return request<{ snapshot: RoomSnapshot }>(
    `/api/rooms/${encodeURIComponent(roomCode)}`,
    { signal },
  );
}

export function sendRoomCommand(
  roomCode: string,
  matchId: string,
  expectedVersion: number,
  command: RoomCommand,
) {
  return request<{ accepted: true; version: number; snapshot?: RoomSnapshot }>(
    `/api/rooms/${encodeURIComponent(roomCode)}/commands`,
    {
      method: "POST",
      body: JSON.stringify({
        idempotencyKey: crypto.randomUUID(),
        matchId,
        expectedVersion,
        ...command,
      }),
    },
  );
}

export function getHistory(signal?: AbortSignal) {
  return request<{ profile: PlayerProfile; matches: MatchHistoryItem[] }>(
    "/api/history",
    { signal },
  );
}

export function getRealtimeToken(roomCode: string, signal?: AbortSignal) {
  return request<{ token: string; expiresAt: string }>(
    `/api/rooms/${encodeURIComponent(roomCode)}/realtime-token`,
    {
      method: "POST",
      signal,
    },
  );
}
