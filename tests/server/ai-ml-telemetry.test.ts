import { describe, expect, it } from "vitest";

import { safeAiMlJudgeAttemptTelemetry } from "@/server/arena/arena-service";
import { canRetryAiMlEvaluation } from "@/server/presentation";

describe("AI/ML judge telemetry safety", () => {
  it("persists only the non-sensitive attempt allowlist", () => {
    const telemetry = safeAiMlJudgeAttemptTelemetry([
      {
        reservationId: "attempt-123",
        attempt: 1,
        classification: "success",
        retryable: false,
        latencyMs: 120,
        httpStatus: 200,
        responseId: "resp_123",
        returnedModel: "gpt-5.4-nano-2026-08-01",
        inputTokens: 40,
        outputTokens: 20,
        cachedTokens: 10,
        reasoningTokens: 5,
        rawAnswer: "private player answer",
        prompt: "private rubric and judge prompt",
      } as never,
    ]);

    expect(telemetry).toEqual([
      {
        reservationId: "attempt-123",
        attempt: 1,
        classification: "success",
        retryable: false,
        latencyMs: 120,
        httpStatus: 200,
        responseId: "resp_123",
        returnedModel: "gpt-5.4-nano-2026-08-01",
        inputTokens: 40,
        outputTokens: 20,
        cachedTokens: 10,
        reasoningTokens: 5,
      },
    ]);
    expect(JSON.stringify(telemetry)).not.toMatch(
      /private|answer|prompt|rubric/i,
    );
  });
});

describe("AI/ML judge recovery presentation", () => {
  const serverTimestamp = "2026-08-19T12:00:00.000Z";

  it("never exposes manual recovery for a non-retryable failure", () => {
    expect(
      canRetryAiMlEvaluation({
        status: "FAILED",
        failureRetryable: false,
        retryNotBefore: null,
        serverTimestamp,
      }),
    ).toBe(false);
  });

  it("exposes recovery only after a retryable failure's cooldown", () => {
    expect(
      canRetryAiMlEvaluation({
        status: "FAILED",
        failureRetryable: true,
        retryNotBefore: "2026-08-19T12:00:01.000Z",
        serverTimestamp,
      }),
    ).toBe(false);
    expect(
      canRetryAiMlEvaluation({
        status: "FAILED",
        failureRetryable: true,
        retryNotBefore: "2026-08-19T11:59:59.000Z",
        serverTimestamp,
      }),
    ).toBe(true);
  });
});
