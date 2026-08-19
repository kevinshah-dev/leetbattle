import type {
  AiMlEvaluationSnapshot,
  AiMlJudgeAdapter,
  AiMlJudgeProviderMetadata,
  AiMlJudgeResult,
} from "./contracts";
import { parseAiMlEvaluationSnapshot } from "./schemas";
import {
  validateAiMlDuelScoring,
  validateAiMlPracticeScoring,
} from "./scoring";

export const E2E_FAKE_AI_ML_JUDGE_ENV =
  "LEETBATTLE_E2E_FAKE_AI_ML_JUDGE" as const;

type E2eJudgeEnvironment = Readonly<
  Partial<
    Record<
      | typeof E2E_FAKE_AI_ML_JUDGE_ENV
      | "APP_ORIGIN"
      | "E2E_BASE_URL"
      | "RUN_REAL_E2E",
      string | undefined
    >
  >
>;

function loopbackOrigin(name: string, value: string | undefined): URL {
  if (!value?.trim()) {
    throw new Error(`${E2E_FAKE_AI_ML_JUDGE_ENV}=1 requires ${name} to be set`);
  }

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(
      `${E2E_FAKE_AI_ML_JUDGE_ENV}=1 requires ${name} to be an absolute URL`,
    );
  }

  if (
    !["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname) ||
    !["http:", "https:"].includes(parsed.protocol)
  ) {
    throw new Error(
      `${E2E_FAKE_AI_ML_JUDGE_ENV}=1 is restricted to a loopback http(s) origin`,
    );
  }
  return parsed;
}

/**
 * The fake can only be selected by a deliberately opted-in browser suite
 * running against the same loopback origin as the application. A production
 * or staging origin therefore fails closed even if the flag is misconfigured.
 */
export function isE2eFakeAiMlJudgeEnabled(
  environment: E2eJudgeEnvironment = process.env,
): boolean {
  const flag = environment[E2E_FAKE_AI_ML_JUDGE_ENV];
  if (flag === undefined || flag === "" || flag === "0") return false;
  if (flag !== "1") {
    throw new Error(`${E2E_FAKE_AI_ML_JUDGE_ENV} must be either 0 or 1`);
  }
  if (environment.RUN_REAL_E2E !== "1") {
    throw new Error(`${E2E_FAKE_AI_ML_JUDGE_ENV}=1 requires RUN_REAL_E2E=1`);
  }

  const appOrigin = loopbackOrigin("APP_ORIGIN", environment.APP_ORIGIN);
  const e2eOrigin = loopbackOrigin("E2E_BASE_URL", environment.E2E_BASE_URL);
  if (appOrigin.origin !== e2eOrigin.origin) {
    throw new Error(
      `${E2E_FAKE_AI_ML_JUDGE_ENV}=1 requires APP_ORIGIN and E2E_BASE_URL to have the same origin`,
    );
  }
  return true;
}

function providerMetadata(
  requestedModel: string,
  callNumber: number,
): AiMlJudgeProviderMetadata {
  const returnedModel = "leetbattle-e2e-fake-judge-v1";
  return Object.freeze({
    attemptCount: 1,
    responseId: `e2e-fake-${callNumber}`,
    requestedModel,
    returnedModel,
    latencyMs: 0,
    inputTokens: null,
    outputTokens: null,
    cachedTokens: null,
    reasoningTokens: null,
    attempts: Object.freeze([
      Object.freeze({
        attempt: 1,
        classification: "success" as const,
        retryable: false,
        latencyMs: 0,
        httpStatus: null,
        responseId: `e2e-fake-${callNumber}`,
        returnedModel,
        inputTokens: null,
        outputTokens: null,
        cachedTokens: null,
        reasoningTokens: null,
      }),
    ]),
  });
}

/** Deterministic fake used only by the guarded real-browser E2E boundary. */
export function createE2eFakeAiMlJudge(): AiMlJudgeAdapter {
  let callNumber = 0;
  return {
    async evaluate(snapshotInput, options): Promise<AiMlJudgeResult> {
      const snapshot: AiMlEvaluationSnapshot =
        parseAiMlEvaluationSnapshot(snapshotInput);
      callNumber += 1;
      const provider = providerMetadata(
        options?.requestedModel ?? "leetbattle-e2e-fake-judge",
        callNumber,
      );
      const fullScores = snapshot.question.criteria.map((criterion) => ({
        criterionId: criterion.id,
        score: criterion.maxScore,
      }));

      if (snapshot.mode === "PRACTICE") {
        return Object.freeze({
          ...validateAiMlPracticeScoring(snapshot, {
            schemaVersion: snapshot.schemaVersion,
            scoresA: fullScores,
            feedback:
              "Deterministic E2E judge: the answer covered the rubric requirements.",
          }),
          provider,
        });
      }

      const lowerScores = snapshot.question.criteria.map(
        (criterion, index) => ({
          criterionId: criterion.id,
          score:
            index === 0
              ? Math.max(0, criterion.maxScore - 10)
              : criterion.maxScore,
        }),
      );
      return Object.freeze({
        ...validateAiMlDuelScoring(snapshot, {
          schemaVersion: snapshot.schemaVersion,
          scoresA: fullScores,
          scoresB: lowerScores,
          winner: "A",
          tieBreakReason: "none",
          explanation:
            "Deterministic E2E judge: Answer A covered the rubric more completely.",
        }),
        provider,
      });
    },
  };
}
