import type { Difficulty, MatchMode } from "@/server/domain/types";

export const AI_ML_TIE_BREAK_REASONS = [
  "none",
  "blank_forfeit",
  "correctness",
  "completeness_or_specificity",
  "clarity",
  "exact_equivalence",
] as const;

export type AiMlTieBreakReason = (typeof AI_ML_TIE_BREAK_REASONS)[number];

export interface AiMlEvaluationCriterion {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly maxScore: number;
}

export interface AiMlEvaluationQuestion {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly prompt: string;
  readonly difficulty: Difficulty;
  readonly category: string;
  readonly referenceAnswerNotes: string;
  readonly requiredConcepts: readonly string[];
  readonly optionalNuances: readonly string[];
  readonly seriousErrors: readonly string[];
  readonly criteria: readonly AiMlEvaluationCriterion[];
}

/**
 * Server-owned, identity-free input to a judge. The parser exported by this
 * module normalizes the answers and deeply freezes the returned value. Persist
 * that parsed value before an evaluation is attempted and reuse it for retries.
 */
export interface AiMlEvaluationSnapshot {
  readonly mode: MatchMode;
  readonly schemaVersion: string;
  readonly instructions: string;
  readonly question: AiMlEvaluationQuestion;
  readonly answers: {
    readonly A: string;
    readonly B?: string;
  };
}

export interface AiMlCriterionScore {
  readonly criterionId: string;
  readonly score: number;
}

export interface AiMlJudgeTokenUsage {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedTokens: number | null;
  readonly reasoningTokens: number | null;
}

export type AiMlJudgeAttemptClassification =
  | "success"
  | "network"
  | "timeout"
  | "rate_limit"
  | "provider_5xx"
  | "provider_4xx"
  | "refusal"
  | "incomplete"
  | "schema_invalid"
  | "semantic_invalid"
  | "configuration"
  | "unknown";

/** Safe to persist or emit as structured telemetry. Contains no prompt data. */
export interface AiMlJudgeAttemptMetadata extends AiMlJudgeTokenUsage {
  /** Durable server-generated attempt identifier; never provider or player data. */
  readonly reservationId?: string | null;
  readonly attempt: number;
  readonly classification: AiMlJudgeAttemptClassification;
  readonly retryable: boolean;
  readonly latencyMs: number;
  readonly httpStatus: number | null;
  readonly responseId: string | null;
  readonly returnedModel: string | null;
}

export interface AiMlJudgeProviderMetadata extends AiMlJudgeTokenUsage {
  readonly attemptCount: number;
  readonly responseId: string | null;
  readonly requestedModel: string;
  readonly returnedModel: string;
  readonly latencyMs: number;
  readonly attempts: readonly AiMlJudgeAttemptMetadata[];
}

interface AiMlJudgeSuccessBase {
  readonly scoresA: AiMlCriterionScore[];
  readonly rawScoreA: number;
  readonly officialScoreA: number;
  readonly tieBreakReason: AiMlTieBreakReason;
  readonly explanation: string;
  readonly provider: AiMlJudgeProviderMetadata;
}

export interface AiMlDuelJudgeSuccess extends AiMlJudgeSuccessBase {
  readonly kind: "DUEL";
  readonly scoresB: AiMlCriterionScore[];
  readonly rawScoreB: number;
  readonly officialScoreB: number;
  readonly winnerLabel: "A" | "B";
}

export interface AiMlPracticeJudgeSuccess extends AiMlJudgeSuccessBase {
  readonly kind: "PRACTICE";
  readonly tieBreakReason: "none";
}

export type AiMlJudgeSuccess = AiMlDuelJudgeSuccess | AiMlPracticeJudgeSuccess;

export type AiMlJudgeFailureCode =
  | "BUDGET_CIRCUIT_OPEN"
  | "BUDGET_ACCOUNTING_FAILED"
  | "NETWORK"
  | "TIMEOUT"
  | "RATE_LIMIT"
  | "PROVIDER_5XX"
  | "PROVIDER_4XX"
  | "REFUSAL"
  | "INCOMPLETE"
  | "SCHEMA_INVALID"
  | "SEMANTIC_INVALID"
  | "CONFIGURATION"
  | "UNKNOWN";

export interface AiMlJudgeFailure {
  readonly code: AiMlJudgeFailureCode;
  readonly retryable: boolean;
  readonly attemptCount: number;
  readonly attempts: readonly AiMlJudgeAttemptMetadata[];
}

/** Successful results are returned; terminal failures are thrown as typed errors. */
export type AiMlJudgeResult = AiMlJudgeSuccess;

export interface AiMlJudgeEvaluationOptions {
  readonly requestedModel?: string;
  /** Persisted evaluation ID used only for server-side attempt accounting. */
  readonly evaluationId?: string;
  /** Unique worker claim; a new value is used for every manual recovery. */
  readonly claimId?: string;
  /** Persisted participants charged by the durable per-user request circuit. */
  readonly participantUserIds?: readonly string[];
}

export interface AiMlJudgeAdapter {
  evaluate(
    snapshot: AiMlEvaluationSnapshot,
    options?: AiMlJudgeEvaluationOptions,
  ): Promise<AiMlJudgeResult>;
}

export class AiMlJudgeUnavailableError
  extends Error
  implements AiMlJudgeFailure
{
  readonly code: AiMlJudgeFailureCode;
  readonly retryable: boolean;
  readonly attemptCount: number;
  readonly attempts: readonly AiMlJudgeAttemptMetadata[];

  constructor(failure: AiMlJudgeFailure) {
    super("AI/ML judging is temporarily unavailable");
    this.name = "AiMlJudgeUnavailableError";
    this.code = failure.code;
    this.retryable = failure.retryable;
    this.attemptCount = failure.attemptCount;
    this.attempts = failure.attempts;
  }
}
