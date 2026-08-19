import { describe, expect, it } from "vitest";

import {
  createE2eFakeAiMlJudge,
  E2E_FAKE_AI_ML_JUDGE_ENV,
  isE2eFakeAiMlJudgeEnabled,
} from "../../src/server/ai-ml/e2e-fake-judge";
import type { AiMlEvaluationSnapshot } from "../../src/server/ai-ml";
import { aiMlE2eGateReason } from "../e2e/environment";

const validEnvironment = {
  APP_ORIGIN: "http://127.0.0.1:3000",
  E2E_BASE_URL: "http://127.0.0.1:3000",
  LEETBATTLE_E2E_FAKE_AI_ML_JUDGE: "1",
  RUN_REAL_E2E: "1",
} as const;

const snapshot: AiMlEvaluationSnapshot = {
  mode: "DUEL",
  schemaVersion: "ai-ml-judge-v1",
  instructions: "Score only against the supplied rubric.",
  question: {
    id: "e2e-question",
    version: 1,
    title: "E2E question",
    prompt: "Explain the concept.",
    difficulty: "EASY",
    category: "Testing",
    referenceAnswerNotes: "A private reference answer.",
    requiredConcepts: ["One required concept"],
    optionalNuances: [],
    seriousErrors: [],
    criteria: [
      {
        id: "correctness",
        label: "Correctness",
        description: "Technical correctness",
        maxScore: 45,
      },
      {
        id: "coverage",
        label: "Coverage",
        description: "Required concept coverage",
        maxScore: 25,
      },
      {
        id: "reasoning",
        label: "Reasoning",
        description: "Causal reasoning",
        maxScore: 20,
      },
      {
        id: "clarity",
        label: "Clarity",
        description: "Clear and direct",
        maxScore: 10,
      },
    ],
  },
  answers: {
    A: "A complete answer.",
    B: "A shorter answer.",
  },
};

describe("guarded AI/ML browser-test judge", () => {
  it("is disabled by default and accepts only an explicit loopback E2E opt-in", () => {
    expect(isE2eFakeAiMlJudgeEnabled({})).toBe(false);
    expect(isE2eFakeAiMlJudgeEnabled(validEnvironment)).toBe(true);
  });

  it("fails closed outside the real local-browser boundary", () => {
    expect(() =>
      isE2eFakeAiMlJudgeEnabled({
        ...validEnvironment,
        RUN_REAL_E2E: "0",
      }),
    ).toThrow(`requires RUN_REAL_E2E=1`);
    expect(() =>
      isE2eFakeAiMlJudgeEnabled({
        ...validEnvironment,
        APP_ORIGIN: "https://leetbattle.example.com",
        E2E_BASE_URL: "https://leetbattle.example.com",
      }),
    ).toThrow("restricted to a loopback");
    expect(() =>
      isE2eFakeAiMlJudgeEnabled({
        ...validEnvironment,
        E2E_BASE_URL: "http://localhost:3000",
      }),
    ).toThrow("to have the same origin");
    expect(() =>
      isE2eFakeAiMlJudgeEnabled({
        ...validEnvironment,
        [E2E_FAKE_AI_ML_JUDGE_ENV]: "yes",
      }),
    ).toThrow("must be either 0 or 1");
  });

  it("keeps Playwright's gate aligned with the server boundary", () => {
    const browserEnvironment = {
      ...validEnvironment,
      CLERK_SECRET_KEY: "sk_test_e2e",
      E2E_CLERK_GUEST_EMAIL: "guest@example.test",
      E2E_CLERK_HOST_EMAIL: "host@example.test",
      NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_test_e2e",
    };
    expect(aiMlE2eGateReason(browserEnvironment)).toBeNull();
    expect(
      aiMlE2eGateReason({ ...browserEnvironment, APP_ORIGIN: undefined }),
    ).toContain("requires APP_ORIGIN");
    expect(
      aiMlE2eGateReason({
        ...browserEnvironment,
        APP_ORIGIN: "https://leetbattle.example.com",
        E2E_BASE_URL: "https://leetbattle.example.com",
      }),
    ).toContain("restricted to loopback");
  });

  it("returns stable valid duel and practice scores without network access", async () => {
    const judge = createE2eFakeAiMlJudge();
    await expect(
      judge.evaluate(snapshot, { requestedModel: "persisted-model" }),
    ).resolves.toMatchObject({
      kind: "DUEL",
      rawScoreA: 100,
      rawScoreB: 90,
      officialScoreA: 100,
      officialScoreB: 90,
      winnerLabel: "A",
      tieBreakReason: "none",
      provider: {
        requestedModel: "persisted-model",
        returnedModel: "leetbattle-e2e-fake-judge-v1",
        attemptCount: 1,
      },
    });

    await expect(
      judge.evaluate({
        ...snapshot,
        mode: "PRACTICE",
        answers: { A: snapshot.answers.A },
      }),
    ).resolves.toMatchObject({
      kind: "PRACTICE",
      rawScoreA: 100,
      officialScoreA: 100,
      tieBreakReason: "none",
    });
  });
});
