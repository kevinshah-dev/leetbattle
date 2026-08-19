import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  getPublicAiMlQuestion,
  listPublicAiMlQuestionsByDifficulty,
} from "../../src/arena/public/catalog";
import {
  AI_ML_EXEMPLAR_ANSWERS,
  getAiMlExemplarAnswer,
} from "../../src/arena/server/exemplar-answers.seed";
import { AI_ML_JUDGE_PROMPT } from "../../src/arena/server/judge-prompts.seed";
import { PRIVATE_AI_ML_QUESTION_BANK } from "../../src/arena/server/private-bank.seed";
import {
  AiMlJudgeUnavailableError,
  createFakeAiMlJudge,
  validateAiMlDuelScoring,
  validateAiMlPracticeScoring,
  type AiMlEvaluationSnapshot,
  type AiMlJudgeProviderMetadata,
  type AiMlJudgeResult,
  type FakeAiMlJudge,
} from "../../src/server/ai-ml";
import { AiMlArenaService } from "../../src/server/arena/arena-service";
import { hashPayload } from "../../src/server/domain/crypto";
import type {
  AiMlQuestionCatalog,
  Difficulty,
  ProblemCatalog,
} from "../../src/server/domain/types";
import { HistoryService } from "../../src/server/history/history-service";
import { MatchEngine } from "../../src/server/match/match-engine";
import { presentRoomSnapshot } from "../../src/server/presentation";
import { ProfileService } from "../../src/server/profiles/profile-service";
import { measureAiMlAnswer } from "../../src/shared/ai-ml-answer";
import {
  createPostgresHarness,
  type PostgresHarness,
} from "./postgres-harness";

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

const codingCatalog: ProblemCatalog = {
  listByDifficulty(difficulty: Difficulty) {
    return [
      {
        id: `unused-${difficulty.toLowerCase()}`,
        version: 1,
        title: `Unused ${difficulty}`,
        difficulty,
      },
    ];
  },
};

const aiMlCatalog: AiMlQuestionCatalog = {
  listByDifficulty(difficulty) {
    return listPublicAiMlQuestionsByDifficulty(difficulty).map((question) => ({
      id: question.id,
      version: question.version,
      title: question.title,
      prompt: question.prompt,
      difficulty: question.difficulty,
      category: question.category,
      answerConstraints: { ...question.answerConstraints },
    }));
  },
  get(id, version) {
    const question = getPublicAiMlQuestion(id, version);
    return question
      ? {
          id: question.id,
          version: question.version,
          title: question.title,
          prompt: question.prompt,
          difficulty: question.difficulty,
          category: question.category,
          answerConstraints: { ...question.answerConstraints },
        }
      : null;
  },
};

function jsonValue(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

async function seedAiMlJudgeData(harness: PostgresHarness): Promise<void> {
  await harness.sql`UPDATE ai_ml_question_registry SET active = false`;
  for (const question of PRIVATE_AI_ML_QUESTION_BANK) {
    const privateMaterial = {
      referenceAnswerNotes: question.referenceAnswerNotes,
      requiredConcepts: question.requiredConcepts,
      optionalNuances: question.optionalNuances,
      seriousErrors: question.seriousErrors,
      criteria: question.criteria,
    };
    await harness.sql`
      INSERT INTO ai_ml_question_registry
        (question_id, version, title, prompt, difficulty, category, tags,
         answer_constraints, private_material, rubric_hash, active, archived_at)
      VALUES
        (${question.public.id}, ${question.public.version},
         ${question.public.title}, ${question.public.prompt},
         ${question.public.difficulty}, ${question.public.category},
         ${harness.sql.json(jsonValue(question.public.tags))},
         ${harness.sql.json(jsonValue(question.public.answerConstraints))},
         ${harness.sql.json(jsonValue(privateMaterial))},
         ${hashPayload(privateMaterial)}, true, NULL)
      ON CONFLICT (question_id, version) DO UPDATE
      SET title = EXCLUDED.title,
          prompt = EXCLUDED.prompt,
          difficulty = EXCLUDED.difficulty,
          category = EXCLUDED.category,
          tags = EXCLUDED.tags,
          answer_constraints = EXCLUDED.answer_constraints,
          private_material = EXCLUDED.private_material,
          rubric_hash = EXCLUDED.rubric_hash,
          active = true,
          archived_at = NULL,
          updated_at = clock_timestamp()
    `;

    const exemplar = getAiMlExemplarAnswer(
      question.public.id,
      question.public.version,
    );
    if (!exemplar) throw new Error("Missing test AI/ML exemplar answer");
    const measurement = measureAiMlAnswer(
      exemplar.answer,
      question.public.answerConstraints,
    );
    await harness.sql`
      INSERT INTO ai_ml_exemplar_answers
        (question_id, question_version, answer, word_count,
         character_count, utf8_byte_count)
      VALUES
        (${question.public.id}, ${question.public.version},
         ${measurement.normalized}, ${measurement.wordCount},
         ${measurement.characterCount}, ${measurement.utf8ByteCount})
      ON CONFLICT (question_id, question_version) DO UPDATE
      SET answer = EXCLUDED.answer,
          word_count = EXCLUDED.word_count,
          character_count = EXCLUDED.character_count,
          utf8_byte_count = EXCLUDED.utf8_byte_count,
          updated_at = clock_timestamp()
    `;
  }

  await harness.sql`UPDATE ai_ml_judge_prompts SET active = false`;
  await harness.sql`
    INSERT INTO ai_ml_judge_prompts
      (version, duel_instructions, practice_instructions, schema_version, active)
    VALUES
      (${AI_ML_JUDGE_PROMPT.version},
       ${AI_ML_JUDGE_PROMPT.duelInstructions},
       ${AI_ML_JUDGE_PROMPT.practiceInstructions},
       ${AI_ML_JUDGE_PROMPT.schemaVersion}, true)
    ON CONFLICT (version) DO UPDATE
    SET duel_instructions = EXCLUDED.duel_instructions,
        practice_instructions = EXCLUDED.practice_instructions,
        schema_version = EXCLUDED.schema_version,
        active = true
  `;
}

const fakeProvider: AiMlJudgeProviderMetadata = {
  attemptCount: 1,
  responseId: "fake-response-1",
  requestedModel: "fake-ai-ml-judge",
  returnedModel: "fake-ai-ml-judge-v1",
  latencyMs: 2,
  inputTokens: 100,
  outputTokens: 20,
  cachedTokens: 0,
  reasoningTokens: 5,
  attempts: [
    {
      attempt: 1,
      classification: "success",
      retryable: false,
      latencyMs: 2,
      httpStatus: null,
      responseId: "fake-response-1",
      returnedModel: "fake-ai-ml-judge-v1",
      inputTokens: 100,
      outputTokens: 20,
      cachedTokens: 0,
      reasoningTokens: 5,
    },
  ],
};

function deterministicJudgment(
  snapshot: AiMlEvaluationSnapshot,
): AiMlJudgeResult {
  const fullScores = snapshot.question.criteria.map((criterion) => ({
    criterionId: criterion.id,
    score: criterion.maxScore,
  }));
  const lowerScores = snapshot.question.criteria.map((criterion, index) => ({
    criterionId: criterion.id,
    score:
      index === 0 ? Math.max(0, criterion.maxScore - 10) : criterion.maxScore,
  }));
  const zeroScores = snapshot.question.criteria.map((criterion) => ({
    criterionId: criterion.id,
    score: 0,
  }));

  if (snapshot.mode === "PRACTICE") {
    return {
      ...validateAiMlPracticeScoring(snapshot, {
        schemaVersion: snapshot.schemaVersion,
        scoresA: fullScores,
        feedback:
          "The answer covered the required concepts and stayed precise.",
      }),
      provider: fakeProvider,
    };
  }

  const blankA = snapshot.answers.A === "";
  const blankB = snapshot.answers.B === "";
  if (blankA || blankB) {
    return {
      ...validateAiMlDuelScoring(snapshot, {
        schemaVersion: snapshot.schemaVersion,
        scoresA: blankA ? zeroScores : fullScores,
        scoresB: blankB ? zeroScores : fullScores,
        winner: blankA ? "B" : "A",
        tieBreakReason: "blank_forfeit",
        explanation:
          "The nonblank answer wins automatically and was rubric scored.",
      }),
      provider: fakeProvider,
    };
  }

  return {
    ...validateAiMlDuelScoring(snapshot, {
      schemaVersion: snapshot.schemaVersion,
      scoresA: fullScores,
      scoresB: lowerScores,
      winner: "A",
      tieBreakReason: "none",
      explanation: "Answer A covered the required concepts more completely.",
    }),
    provider: fakeProvider,
  };
}

integration("PostgreSQL AI/ML Arena and history", () => {
  let harness: PostgresHarness;
  let profiles: ProfileService;
  let engine: MatchEngine;
  let arena: AiMlArenaService;
  let history: HistoryService;
  let fakeJudge: FakeAiMlJudge;
  let command = 0;

  const key = (prefix: string) => `${prefix}-${++command}`;

  beforeAll(async () => {
    harness = await createPostgresHarness(databaseUrl!);
    await seedAiMlJudgeData(harness);
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
    command = 0;
    profiles = new ProfileService(harness.sql);
    await profiles.create("host", "ArenaHost");
    await profiles.create("opponent", "ArenaOpponent");
    await profiles.create("outsider", "ArenaOutsider");

    engine = new MatchEngine(harness.sql, codingCatalog, {
      countdownMs: 0,
      answerDurationMs: 10 * 60 * 1_000,
      reconnectGraceSeconds: 60,
      rematchWindowSeconds: 30,
      inviteSecret:
        "AI ML integration invite secret with at least thirty two bytes",
      chooseIndex: () => 0,
      aiMlCatalog,
    });
    fakeJudge = createFakeAiMlJudge(deterministicJudgment);
    arena = new AiMlArenaService(harness.sql, fakeJudge, {
      chooseAnswerAIndex: () => 0,
      requestedModel: "fake-ai-ml-judge",
      rematchWindowSeconds: 30,
    });
    history = new HistoryService(harness.sql);
  });

  async function activeDuel() {
    const created = await engine.createRoom({
      actorUserId: "host",
      challengeType: "AI_ML",
      mode: "DUEL",
      difficulty: "EASY",
      idempotencyKey: key("create-duel"),
    });
    expect(created.snapshot).toMatchObject({
      challengeType: "AI_ML",
      mode: "DUEL",
      state: "LOBBY",
      aiMlQuestion: null,
      answerDeadlineAt: null,
    });
    await engine.joinRoom({
      actorUserId: "opponent",
      inviteToken: created.inviteToken,
      idempotencyKey: key("join-duel"),
    });
    const { roomId, matchId } = created.snapshot;
    await Promise.all([
      engine.connectSession({ actorUserId: "host", roomId, matchId }),
      engine.connectSession({ actorUserId: "opponent", roomId, matchId }),
    ]);
    await engine.setReady({
      actorUserId: "host",
      matchId,
      ready: true,
      idempotencyKey: key("ready-host"),
    });
    const active = await engine.setReady({
      actorUserId: "opponent",
      matchId,
      ready: true,
      idempotencyKey: key("ready-opponent"),
    });
    expect(active).toMatchObject({
      challengeType: "AI_ML",
      mode: "DUEL",
      state: "ACTIVE",
      aiMlQuestion: {
        title: "Training, Validation, and Test Sets",
        difficulty: "EASY",
      },
    });
    expect(active.players.every((player) => player.language === null)).toBe(
      true,
    );
    expect(active.startsAt).not.toBeNull();
    expect(active.answerDeadlineAt).not.toBeNull();
    expect(
      Date.parse(active.answerDeadlineAt!) - Date.parse(active.startsAt!),
    ).toBe(10 * 60 * 1_000);
    return { roomId, matchId, active, inviteToken: created.inviteToken };
  }

  async function activePractice() {
    const created = await engine.createRoom({
      actorUserId: "host",
      challengeType: "AI_ML",
      mode: "PRACTICE",
      difficulty: "MEDIUM",
      idempotencyKey: key("create-practice"),
    });
    const { roomId, matchId } = created.snapshot;
    await engine.connectSession({ actorUserId: "host", roomId, matchId });
    const active = await engine.setReady({
      actorUserId: "host",
      matchId,
      ready: true,
      idempotencyKey: key("ready-practice"),
    });
    expect(active).toMatchObject({
      challengeType: "AI_ML",
      mode: "PRACTICE",
      state: "ACTIVE",
      aiMlQuestion: { difficulty: "MEDIUM" },
    });
    return { roomId, matchId, active };
  }

  async function records() {
    return harness.sql<
      { clerk_user_id: string; wins: number; losses: number }[]
    >`
      SELECT clerk_user_id, wins::int, losses::int
      FROM player_records
      ORDER BY clerk_user_id
    `;
  }

  it("creates and readies an AI duel without languages and persists its authoritative deadline", async () => {
    const { matchId, active } = await activeDuel();
    const [stored] = await harness.sql<
      {
        state: string;
        problem_id: string;
        starts_at: string;
        answer_deadline_at: string;
      }[]
    >`
      SELECT state, problem_id, starts_at::text, answer_deadline_at::text
      FROM matches WHERE id = ${matchId}
    `;

    expect(stored).toMatchObject({
      state: "ACTIVE",
      problem_id: "mlai-fde-e01",
    });
    expect(
      Date.parse(stored!.answer_deadline_at) - Date.parse(stored!.starts_at),
    ).toBe(10 * 60 * 1_000);
    expect(active.aiMlQuestion).not.toHaveProperty("referenceAnswerNotes");
    expect(active.aiMlQuestion).not.toHaveProperty("criteria");
  });

  it("locks the first final answer and makes duplicate commands idempotent", async () => {
    const { matchId } = await activeDuel();
    const idempotencyKey = key("host-final");
    await expect(
      arena.submitAnswer({
        actorUserId: "host",
        matchId,
        idempotencyKey,
        answer: "  First final\r\nanswer.  ",
      }),
    ).resolves.toEqual({ evaluationId: null, duplicate: false });
    await expect(
      arena.submitAnswer({
        actorUserId: "host",
        matchId,
        idempotencyKey,
        answer: "First final\nanswer.",
      }),
    ).resolves.toEqual({ evaluationId: null, duplicate: true });
    await expect(
      arena.submitAnswer({
        actorUserId: "host",
        matchId,
        idempotencyKey: key("host-replacement"),
        answer: "A replacement must not be accepted.",
      }),
    ).rejects.toMatchObject({ code: "ANSWER_ALREADY_SUBMITTED", status: 409 });

    const answers = await harness.sql<
      { normalized_answer: string; word_count: number }[]
    >`
      SELECT normalized_answer, word_count::int
      FROM ai_ml_answers
      WHERE match_id = ${matchId} AND clerk_user_id = 'host'
    `;
    expect(answers).toEqual([
      { normalized_answer: "First final\nanswer.", word_count: 3 },
    ]);
    expect(fakeJudge.callCount).toBe(0);
  });

  it("reveals only the submitter's answer before the result is finalized", async () => {
    const { matchId, active, inviteToken } = await activeDuel();
    const answer =
      "Training fits parameters, while validation tunes choices and testing estimates generalization.";
    await arena.submitAnswer({
      actorUserId: "host",
      matchId,
      idempotencyKey: key("private-host-answer"),
      answer,
    });

    const hostView = await presentRoomSnapshot({
      actorUserId: "host",
      inviteToken,
      snapshot: active,
      db: harness.sql,
      matches: engine,
      appOrigin: "https://leetbattle.example.test",
    });
    const opponentView = await presentRoomSnapshot({
      actorUserId: "opponent",
      inviteToken,
      snapshot: active,
      db: harness.sql,
      matches: engine,
      appOrigin: "https://leetbattle.example.test",
    });

    expect(hostView.aiMl).toMatchObject({
      selfSubmission: { submitted: true, answer },
      opponentSubmitted: false,
      result: null,
    });
    expect(opponentView.aiMl).toMatchObject({
      selfSubmission: { submitted: false, answer: null },
      opponentSubmitted: true,
      result: null,
    });
    expect(JSON.stringify(opponentView)).not.toContain(answer);
    expect(JSON.stringify(opponentView)).not.toContain("referenceAnswerNotes");
    expect(JSON.stringify(hostView)).not.toContain("exemplarAnswer");
    expect(JSON.stringify(opponentView)).not.toContain("exemplarAnswer");
    expect(JSON.stringify(hostView)).not.toContain(
      AI_ML_EXEMPLAR_ANSWERS[0]!.answer,
    );
    const [hostSnapshot, opponentSnapshot] = await Promise.all([
      engine.getSnapshotByMatch("host", matchId),
      engine.getSnapshotByMatch("opponent", matchId),
    ]);
    expect(
      hostSnapshot.players.find((player) => player.isSelf)?.submittedAt,
    ).toEqual(expect.any(String));
    expect(
      opponentSnapshot.players.find((player) => !player.isSelf),
    ).toMatchObject({ activity: "SUBMITTED", submittedAt: null });
    expect(fakeJudge.callCount).toBe(0);
  });

  it("serializes simultaneous submissions into one deterministic evaluation and applies records once", async () => {
    const { matchId } = await activeDuel();
    const hostKey = key("host-submit");
    const opponentKey = key("opponent-submit");
    const submissions = await Promise.all([
      arena.submitAnswer({
        actorUserId: "host",
        matchId,
        idempotencyKey: hostKey,
        answer:
          "Host covers training, validation, testing, and leakage precisely.",
      }),
      arena.submitAnswer({
        actorUserId: "opponent",
        matchId,
        idempotencyKey: opponentKey,
        answer: "Opponent gives a shorter and less complete explanation.",
      }),
    ]);

    expect(
      submissions.filter((submission) => submission.evaluationId),
    ).toHaveLength(1);
    expect(fakeJudge.callCount).toBe(1);
    const evaluations = await harness.sql<
      {
        id: string;
        status: string;
        answer_a_user_id: string;
        answer_b_user_id: string;
        raw_score_a: number;
        raw_score_b: number;
        official_score_a: number;
        official_score_b: number;
        winner_user_id: string;
        attempt_count: number;
      }[]
    >`
      SELECT id, status, answer_a_user_id, answer_b_user_id,
             raw_score_a::int, raw_score_b::int,
             official_score_a::int, official_score_b::int,
             winner_user_id, attempt_count::int
      FROM ai_ml_evaluations WHERE match_id = ${matchId}
    `;
    expect(evaluations).toEqual([
      expect.objectContaining({
        status: "COMPLETED",
        answer_a_user_id: "host",
        answer_b_user_id: "opponent",
        raw_score_a: 100,
        raw_score_b: 90,
        official_score_a: 100,
        official_score_b: 90,
        winner_user_id: "host",
        attempt_count: 1,
      }),
    ]);
    expect(await records()).toEqual([
      { clerk_user_id: "host", wins: 1, losses: 0 },
      { clerk_user_id: "opponent", wins: 0, losses: 1 },
      { clerk_user_id: "outsider", wins: 0, losses: 0 },
    ]);

    const finalizedSnapshot = await engine.getSnapshotByMatch("host", matchId);
    const finalizedView = await presentRoomSnapshot({
      actorUserId: "host",
      inviteToken: "authorized-duel-token",
      snapshot: finalizedSnapshot,
      db: harness.sql,
      matches: engine,
      appOrigin: "https://leetbattle.example.test",
    });
    expect(finalizedView.aiMl?.result?.exemplarAnswer).toBe(
      getAiMlExemplarAnswer("mlai-fde-e01", 1)?.answer,
    );

    const duplicate = await arena.submitAnswer({
      actorUserId: "host",
      matchId,
      idempotencyKey: hostKey,
      answer:
        "Host covers training, validation, testing, and leakage precisely.",
    });
    expect(duplicate).toEqual({ evaluationId: null, duplicate: true });
    expect(await arena.evaluate(evaluations[0]!.id)).toBe(false);
    expect(fakeJudge.callCount).toBe(1);
    expect(await records()).toEqual([
      { clerk_user_id: "host", wins: 1, losses: 0 },
      { clerk_user_id: "opponent", wins: 0, losses: 1 },
      { clerk_user_id: "outsider", wins: 0, losses: 0 },
    ]);

    await expect(
      harness.sql`
        UPDATE ai_ml_evaluations
        SET immutable_snapshot = jsonb_set(
          immutable_snapshot,
          '{schemaVersion}',
          '"tampered"'::jsonb
        )
        WHERE id = ${evaluations[0]!.id}
      `,
    ).rejects.toThrow(/immutable/i);

    await expect(
      harness.sql`
        UPDATE ai_ml_exemplar_answers
        SET answer = answer || ' changed'
        WHERE question_id = 'mlai-fde-e01' AND question_version = 1
      `,
    ).rejects.toThrow(/immutable/i);

    const hostDetail = await history.detail("host", matchId);
    const opponentDetail = await history.detail("opponent", matchId);
    expect(hostDetail).toMatchObject({
      challengeType: "AI_ML",
      mode: "DUEL",
      outcome: "WIN",
      endReason: "JUDGED",
      aiMl: {
        winnerUsername: "ArenaHost",
        tieBreakReason: "none",
        automaticBlank: false,
        answers: [
          {
            username: "ArenaHost",
            answer:
              "Host covers training, validation, testing, and leakage precisely.",
            score: 100,
          },
          {
            username: "ArenaOpponent",
            answer: "Opponent gives a shorter and less complete explanation.",
            score: 90,
          },
        ],
      },
    });
    expect(opponentDetail).toMatchObject({
      outcome: "LOSS",
      aiMl: hostDetail.aiMl,
    });
    await expect(history.detail("outsider", matchId)).rejects.toMatchObject({
      code: "MATCH_NOT_FOUND",
      status: 404,
    });
  });

  it("maps a randomized Answer A winner back to the correct participant", async () => {
    const reverseJudge = createFakeAiMlJudge(deterministicJudgment);
    const reverseArena = new AiMlArenaService(harness.sql, reverseJudge, {
      chooseAnswerAIndex: () => 1,
      requestedModel: "fake-ai-ml-judge",
      rematchWindowSeconds: 30,
    });
    const { matchId } = await activeDuel();

    await Promise.all([
      reverseArena.submitAnswer({
        actorUserId: "host",
        matchId,
        idempotencyKey: key("reverse-host"),
        answer: "The host submitted a complete answer.",
      }),
      reverseArena.submitAnswer({
        actorUserId: "opponent",
        matchId,
        idempotencyKey: key("reverse-opponent"),
        answer: "The opponent submitted a complete answer.",
      }),
    ]);

    const [stored] = await harness.sql<
      {
        answer_a_user_id: string;
        answer_b_user_id: string;
        winner_user_id: string;
      }[]
    >`
      SELECT answer_a_user_id, answer_b_user_id, winner_user_id
      FROM ai_ml_evaluations
      WHERE match_id = ${matchId}
    `;
    expect(stored).toEqual({
      answer_a_user_id: "opponent",
      answer_b_user_id: "host",
      winner_user_id: "opponent",
    });
    expect(reverseJudge.callCount).toBe(1);
    expect(await records()).toEqual([
      { clerk_user_id: "host", wins: 0, losses: 1 },
      { clerk_user_id: "opponent", wins: 1, losses: 0 },
      { clerk_user_id: "outsider", wins: 0, losses: 0 },
    ]);
  });

  it("preserves answers and records after a terminal judge failure", async () => {
    const failingJudge = createFakeAiMlJudge(() => {
      throw new AiMlJudgeUnavailableError({
        code: "PROVIDER_4XX",
        retryable: false,
        attemptCount: 1,
        attempts: Object.freeze([]),
      });
    });
    const failingArena = new AiMlArenaService(harness.sql, failingJudge, {
      chooseAnswerAIndex: () => 0,
      requestedModel: "fake-ai-ml-judge",
      rematchWindowSeconds: 30,
    });
    const { matchId } = await activeDuel();
    const hostAnswer = "A durable host answer that must survive failure.";
    const opponentAnswer =
      "A durable opponent answer that must survive failure.";

    await Promise.all([
      failingArena.submitAnswer({
        actorUserId: "host",
        matchId,
        idempotencyKey: key("failed-host"),
        answer: hostAnswer,
      }),
      failingArena.submitAnswer({
        actorUserId: "opponent",
        matchId,
        idempotencyKey: key("failed-opponent"),
        answer: opponentAnswer,
      }),
    ]);

    const [failed] = await harness.sql<
      {
        state: string;
        end_reason: string;
        status: string;
        winner_user_id: string | null;
        records_applied: boolean;
        failure_code: string;
      }[]
    >`
      SELECT m.state, m.end_reason, evaluation.status, m.winner_user_id,
             m.records_applied, evaluation.failure_code
      FROM matches m
      JOIN ai_ml_evaluations evaluation ON evaluation.match_id = m.id
      WHERE m.id = ${matchId}
    `;
    expect(failed).toEqual({
      state: "REMATCH_PENDING",
      end_reason: "JUDGE_FAILED",
      status: "FAILED",
      winner_user_id: null,
      records_applied: false,
      failure_code: "PROVIDER_4XX",
    });
    const storedAnswers = await harness.sql<
      { clerk_user_id: string; normalized_answer: string }[]
    >`
      SELECT clerk_user_id, normalized_answer
      FROM ai_ml_answers
      WHERE match_id = ${matchId}
      ORDER BY clerk_user_id
    `;
    expect(storedAnswers).toEqual([
      { clerk_user_id: "host", normalized_answer: hostAnswer },
      { clerk_user_id: "opponent", normalized_answer: opponentAnswer },
    ]);
    expect(failingJudge.callCount).toBe(1);
    expect(await records()).toEqual([
      { clerk_user_id: "host", wins: 0, losses: 0 },
      { clerk_user_id: "opponent", wins: 0, losses: 0 },
      { clerk_user_id: "outsider", wins: 0, losses: 0 },
    ]);
    await expect(history.detail("host", matchId)).resolves.toMatchObject({
      challengeType: "AI_ML",
      mode: "DUEL",
      outcome: "NO_CONTEST",
      endReason: "JUDGE_FAILED",
      aiMl: {
        winnerUsername: null,
        answers: [
          { username: "ArenaHost", answer: hostAnswer, score: null },
          {
            username: "ArenaOpponent",
            answer: opponentAnswer,
            score: null,
          },
        ],
      },
    });
  });

  it("persists a judged practice attempt without selecting a winner or changing records", async () => {
    const { matchId } = await activePractice();
    await arena.submitAnswer({
      actorUserId: "host",
      matchId,
      idempotencyKey: key("practice-answer"),
      answer: "A complete practice response grounded in the supplied concepts.",
    });

    expect(fakeJudge.callCount).toBe(1);
    expect(await records()).toEqual([
      { clerk_user_id: "host", wins: 0, losses: 0 },
      { clerk_user_id: "opponent", wins: 0, losses: 0 },
      { clerk_user_id: "outsider", wins: 0, losses: 0 },
    ]);
    const [stored] = await harness.sql<
      {
        state: string;
        end_reason: string;
        winner_user_id: string | null;
        records_applied: boolean;
        answer_b_user_id: string | null;
      }[]
    >`
      SELECT m.state, m.end_reason, m.winner_user_id,
             m.records_applied, evaluation.answer_b_user_id
      FROM matches m
      JOIN ai_ml_evaluations evaluation ON evaluation.match_id = m.id
      WHERE m.id = ${matchId}
    `;
    expect(stored).toEqual({
      state: "FINISHED",
      end_reason: "JUDGED",
      winner_user_id: null,
      records_applied: false,
      answer_b_user_id: null,
    });
    const finalizedSnapshot = await engine.getSnapshotByMatch("host", matchId);
    const finalizedView = await presentRoomSnapshot({
      actorUserId: "host",
      inviteToken: "internal-practice-token",
      snapshot: finalizedSnapshot,
      db: harness.sql,
      matches: engine,
      appOrigin: "https://leetbattle.example.test",
    });
    expect(finalizedView.aiMl?.result?.exemplarAnswer).toBe(
      getAiMlExemplarAnswer("mlai-fde-m01", 1)?.answer,
    );
    await expect(history.detail("host", matchId)).resolves.toMatchObject({
      challengeType: "AI_ML",
      mode: "PRACTICE",
      outcome: "COMPLETED",
      aiMl: {
        winnerUsername: null,
        answers: [
          {
            username: "ArenaHost",
            answer:
              "A complete practice response grounded in the supplied concepts.",
            score: 100,
          },
        ],
      },
    });
  });

  it("keeps a permanently failed practice answer in history without fabricating a score", async () => {
    const failingJudge = createFakeAiMlJudge(() => {
      throw new AiMlJudgeUnavailableError({
        code: "PROVIDER_4XX",
        retryable: false,
        attemptCount: 1,
        attempts: Object.freeze([]),
      });
    });
    const failingArena = new AiMlArenaService(harness.sql, failingJudge, {
      chooseAnswerAIndex: () => 0,
      requestedModel: "fake-ai-ml-judge",
    });
    const { matchId } = await activePractice();
    const answer =
      "A practice answer preserved after a permanent provider failure.";

    await failingArena.submitAnswer({
      actorUserId: "host",
      matchId,
      idempotencyKey: key("failed-practice-answer"),
      answer,
    });

    const [stored] = await harness.sql<
      { state: string; end_reason: string; status: string }[]
    >`
      SELECT match.state, match.end_reason, evaluation.status
      FROM matches match
      JOIN ai_ml_evaluations evaluation ON evaluation.match_id = match.id
      WHERE match.id = ${matchId}
    `;
    expect(stored).toEqual({
      state: "FINISHED",
      end_reason: "JUDGE_FAILED",
      status: "FAILED",
    });
    await expect(history.detail("host", matchId)).resolves.toMatchObject({
      challengeType: "AI_ML",
      mode: "PRACTICE",
      outcome: "NO_CONTEST",
      endReason: "JUDGE_FAILED",
      aiMl: {
        winnerUsername: null,
        answers: [{ username: "ArenaHost", answer, score: null }],
      },
    });
    expect(await records()).toEqual([
      { clerk_user_id: "host", wins: 0, losses: 0 },
      { clerk_user_id: "opponent", wins: 0, losses: 0 },
      { clerk_user_id: "outsider", wins: 0, losses: 0 },
    ]);
  });

  it("finishes a blank practice attempt at zero without calling the judge", async () => {
    const { matchId } = await activePractice();
    await arena.submitAnswer({
      actorUserId: "host",
      matchId,
      idempotencyKey: key("blank-practice-answer"),
      answer: " \r\n\u00a0 ",
    });

    expect(fakeJudge.callCount).toBe(0);
    expect(await records()).toEqual([
      { clerk_user_id: "host", wins: 0, losses: 0 },
      { clerk_user_id: "opponent", wins: 0, losses: 0 },
      { clerk_user_id: "outsider", wins: 0, losses: 0 },
    ]);
    const [stored] = await harness.sql<
      {
        state: string;
        end_reason: string;
        status: string;
        official_score_a: number;
      }[]
    >`
      SELECT m.state, m.end_reason, evaluation.status,
             evaluation.official_score_a::int
      FROM matches m
      JOIN ai_ml_evaluations evaluation ON evaluation.match_id = m.id
      WHERE m.id = ${matchId}
    `;
    expect(stored).toEqual({
      state: "FINISHED",
      end_reason: "NO_CONTEST",
      status: "SKIPPED",
      official_score_a: 0,
    });
    await expect(history.detail("host", matchId)).resolves.toMatchObject({
      outcome: "COMPLETED",
      aiMl: {
        winnerUsername: null,
        answers: [{ username: "ArenaHost", answer: "", score: 0 }],
      },
    });
  });

  it("turns a deadline-missing answer into a blank forfeit while still judging once", async () => {
    const { matchId } = await activeDuel();
    await arena.submitAnswer({
      actorUserId: "host",
      matchId,
      idempotencyKey: key("host-before-deadline"),
      answer: "The host submitted a rubric-worthy nonblank answer.",
    });
    expect(fakeJudge.callCount).toBe(0);
    await harness.sql`
      UPDATE matches
      SET answer_deadline_at = clock_timestamp() - interval '1 second'
      WHERE id = ${matchId}
    `;

    expect(await arena.processAnswerDeadlineForMatch(matchId)).toBe(true);
    expect(fakeJudge.callCount).toBe(1);
    const [evaluation] = await harness.sql<
      {
        tie_break_reason: string;
        official_score_a: number;
        official_score_b: number;
        winner_user_id: string;
        end_reason: string;
      }[]
    >`
      SELECT evaluation.tie_break_reason,
             evaluation.official_score_a::int,
             evaluation.official_score_b::int,
             evaluation.winner_user_id,
             m.end_reason
      FROM ai_ml_evaluations evaluation
      JOIN matches m ON m.id = evaluation.match_id
      WHERE evaluation.match_id = ${matchId}
    `;
    expect(evaluation).toEqual({
      tie_break_reason: "blank_forfeit",
      official_score_a: 100,
      official_score_b: 0,
      winner_user_id: "host",
      end_reason: "ANSWER_TIMEOUT",
    });
    expect(await records()).toEqual([
      { clerk_user_id: "host", wins: 1, losses: 0 },
      { clerk_user_id: "opponent", wins: 0, losses: 1 },
      { clerk_user_id: "outsider", wins: 0, losses: 0 },
    ]);
    const answers = await harness.sql<
      {
        clerk_user_id: string;
        normalized_answer: string;
        submission_source: string;
      }[]
    >`
      SELECT clerk_user_id, normalized_answer, submission_source
      FROM ai_ml_answers WHERE match_id = ${matchId}
      ORDER BY clerk_user_id
    `;
    expect(answers).toContainEqual({
      clerk_user_id: "opponent",
      normalized_answer: "",
      submission_source: "DEADLINE",
    });
    expect((await history.detail("host", matchId)).aiMl).toMatchObject({
      automaticBlank: true,
      tieBreakReason: "blank_forfeit",
    });
  });

  it("skips judging and records when both duel answers are blank", async () => {
    const { matchId } = await activeDuel();
    await Promise.all([
      arena.submitAnswer({
        actorUserId: "host",
        matchId,
        idempotencyKey: key("blank-host"),
        answer: " \r\n ",
      }),
      arena.submitAnswer({
        actorUserId: "opponent",
        matchId,
        idempotencyKey: key("blank-opponent"),
        answer: "\u00a0",
      }),
    ]);

    expect(fakeJudge.callCount).toBe(0);
    expect(await records()).toEqual([
      { clerk_user_id: "host", wins: 0, losses: 0 },
      { clerk_user_id: "opponent", wins: 0, losses: 0 },
      { clerk_user_id: "outsider", wins: 0, losses: 0 },
    ]);
    const [stored] = await harness.sql<
      {
        state: string;
        end_reason: string;
        records_applied: boolean;
        status: string;
        raw_score_a: number;
        raw_score_b: number;
      }[]
    >`
      SELECT m.state, m.end_reason, m.records_applied,
             evaluation.status, evaluation.raw_score_a::int,
             evaluation.raw_score_b::int
      FROM matches m
      JOIN ai_ml_evaluations evaluation ON evaluation.match_id = m.id
      WHERE m.id = ${matchId}
    `;
    expect(stored).toEqual({
      state: "REMATCH_PENDING",
      end_reason: "NO_CONTEST",
      records_applied: false,
      status: "SKIPPED",
      raw_score_a: 0,
      raw_score_b: 0,
    });
    await expect(history.detail("host", matchId)).resolves.toMatchObject({
      outcome: "NO_CONTEST",
      endReason: "NO_CONTEST",
      aiMl: {
        winnerUsername: null,
        automaticBlank: true,
        answers: [
          { username: "ArenaHost", answer: "", score: 0 },
          { username: "ArenaOpponent", answer: "", score: 0 },
        ],
      },
    });
  });

  it("retains AI/ML configuration and avoids an immediate question repeat on rematch", async () => {
    const { roomId, matchId, active } = await activeDuel();
    expect(active.aiMlQuestion).not.toHaveProperty("id");
    const [firstRound] = await harness.sql<{ problem_id: string }[]>`
      SELECT problem_id FROM matches WHERE id = ${matchId}
    `;
    const firstQuestionId = firstRound?.problem_id;
    expect(firstQuestionId).toBe("mlai-fde-e01");

    await Promise.all([
      arena.submitAnswer({
        actorUserId: "host",
        matchId,
        idempotencyKey: key("host-rematch-answer"),
        answer: "A complete answer from the host for the first round.",
      }),
      arena.submitAnswer({
        actorUserId: "opponent",
        matchId,
        idempotencyKey: key("opponent-rematch-answer"),
        answer: "A shorter answer from the opponent for the first round.",
      }),
    ]);

    await engine.requestRematch({
      actorUserId: "host",
      matchId,
      idempotencyKey: key("host-rematch-vote"),
    });
    const rematch = await engine.requestRematch({
      actorUserId: "opponent",
      matchId,
      idempotencyKey: key("opponent-rematch-vote"),
    });
    expect(rematch).toMatchObject({
      roomId,
      challengeType: "AI_ML",
      mode: "DUEL",
      difficulty: "EASY",
      state: "LOBBY",
      aiMlQuestion: null,
      answerDeadlineAt: null,
    });
    expect(rematch.matchId).not.toBe(matchId);

    await Promise.all([
      engine.connectSession({
        actorUserId: "host",
        roomId,
        matchId: rematch.matchId,
      }),
      engine.connectSession({
        actorUserId: "opponent",
        roomId,
        matchId: rematch.matchId,
      }),
    ]);
    await engine.setReady({
      actorUserId: "host",
      matchId: rematch.matchId,
      ready: true,
      idempotencyKey: key("host-rematch-ready"),
    });
    const rematchActive = await engine.setReady({
      actorUserId: "opponent",
      matchId: rematch.matchId,
      ready: true,
      idempotencyKey: key("opponent-rematch-ready"),
    });

    expect(rematchActive).toMatchObject({
      challengeType: "AI_ML",
      mode: "DUEL",
      difficulty: "EASY",
      state: "ACTIVE",
    });
    expect(rematchActive.aiMlQuestion).not.toHaveProperty("id");
    const [secondRound] = await harness.sql<{ problem_id: string }[]>`
      SELECT problem_id FROM matches WHERE id = ${rematch.matchId}
    `;
    expect(secondRound?.problem_id).not.toBe(firstQuestionId);
    expect(secondRound?.problem_id).toBe("mlai-fde-e02");
  });
});
