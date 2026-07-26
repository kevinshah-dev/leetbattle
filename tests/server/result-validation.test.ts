import { describe, expect, it } from "vitest";

import {
  executionCompletedEventPayload,
  normalizeRunnerResult,
} from "../../src/server/match/match-engine";
import type { RunnerResult } from "../../src/server/domain/types";

const valid: RunnerResult = {
  verdict: "ACCEPTED",
  passedCount: 12,
  totalCount: 12,
  runtimeMs: 2.5,
  compileMs: 10,
};

describe("runner result validation", () => {
  it("accepts measured, internally consistent results without coercion", () => {
    expect(normalizeRunnerResult(valid)).toBe(valid);
  });

  it.each([
    { field: "passedCount", value: Number.NaN },
    { field: "passedCount", value: 1.5 },
    { field: "passedCount", value: -1 },
    { field: "totalCount", value: Number.POSITIVE_INFINITY },
    { field: "totalCount", value: Number.MAX_SAFE_INTEGER },
    { field: "runtimeMs", value: Number.NaN },
    { field: "runtimeMs", value: Number.POSITIVE_INFINITY },
    { field: "runtimeMs", value: -0.1 },
    { field: "compileMs", value: Number.NEGATIVE_INFINITY },
  ])("rejects unsafe $field=$value", ({ field, value }) => {
    expect(() =>
      normalizeRunnerResult({ ...valid, [field]: value } as RunnerResult),
    ).toThrow(/unsafe/);
  });

  it("requires an acceptance to pass a nonempty complete suite", () => {
    expect(() =>
      normalizeRunnerResult({
        ...valid,
        passedCount: 0,
        totalCount: 0,
      }),
    ).toThrow(/accepted result/i);
    expect(() =>
      normalizeRunnerResult({
        ...valid,
        passedCount: 11,
        totalCount: 12,
      }),
    ).toThrow(/accepted result/i);
    expect(() => normalizeRunnerResult({ ...valid, runtimeMs: null })).toThrow(
      /accepted result/i,
    );
  });

  it("rejects passed counts above total for every verdict", () => {
    expect(() =>
      normalizeRunnerResult({
        ...valid,
        verdict: "WRONG_ANSWER",
        passedCount: 13,
      }),
    ).toThrow(/greater than total/i);
  });
});

describe("shared execution result events", () => {
  it("omits every sample outcome field from a RUN event", () => {
    expect(
      executionCompletedEventPayload({
        slot: 1,
        kind: "RUN",
        result: valid,
        activity: "THINKING",
        cooldownUntil: "2026-01-01T00:00:10Z",
      }),
    ).toEqual({ slot: 1, kind: "RUN", activity: "THINKING" });
  });

  it("keeps aggregate hidden progress in a SUBMIT event", () => {
    expect(
      executionCompletedEventPayload({
        slot: 2,
        kind: "SUBMIT",
        result: valid,
        activity: "ACCEPTED",
        cooldownUntil: null,
      }),
    ).toEqual({
      slot: 2,
      kind: "SUBMIT",
      accepted: true,
      passedCount: 12,
      totalCount: 12,
      activity: "ACCEPTED",
      cooldownUntil: null,
    });
  });
});
