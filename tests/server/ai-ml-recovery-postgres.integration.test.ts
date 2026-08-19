import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  AiMlJudgeUnavailableError,
  type AiMlEvaluationSnapshot,
  type AiMlJudgeAdapter,
  type AiMlJudgeEvaluationOptions,
  type AiMlJudgeResult,
} from "@/server/ai-ml";
import { AiMlArenaService } from "@/server/arena/arena-service";
import {
  createPostgresHarness,
  type PostgresHarness,
} from "./postgres-harness";

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);
const HASH = "a".repeat(64);

const snapshot: AiMlEvaluationSnapshot = {
  mode: "DUEL",
  schemaVersion: "ai-ml-judge-v1",
  instructions: "Immutable private instructions.",
  question: {
    id: "budget-recovery-question",
    version: 1,
    title: "Recovery question",
    prompt: "Explain a production ML tradeoff.",
    difficulty: "EASY",
    category: "Testing",
    referenceAnswerNotes: "Private notes.",
    requiredConcepts: ["Required concept"],
    optionalNuances: ["Optional nuance"],
    seriousErrors: ["Serious error"],
    criteria: [
      {
        id: "technical_correctness",
        label: "Technical correctness",
        description: "Correctness.",
        maxScore: 45,
      },
      {
        id: "relevant_completeness",
        label: "Completeness",
        description: "Completeness.",
        maxScore: 25,
      },
      {
        id: "technical_depth",
        label: "Depth",
        description: "Depth.",
        maxScore: 20,
      },
      {
        id: "clarity",
        label: "Clarity",
        description: "Clarity.",
        maxScore: 10,
      },
    ],
  },
  answers: {
    A: "Persisted anonymous answer A.",
    B: "Persisted anonymous answer B.",
  },
};

const scoreA = [
  { criterionId: "technical_correctness", score: 40 },
  { criterionId: "relevant_completeness", score: 20 },
  { criterionId: "technical_depth", score: 10 },
  { criterionId: "clarity", score: 6 },
];
const scoreB = [
  { criterionId: "technical_correctness", score: 39 },
  { criterionId: "relevant_completeness", score: 20 },
  { criterionId: "technical_depth", score: 10 },
  { criterionId: "clarity", score: 6 },
];

function successResult(): AiMlJudgeResult {
  return {
    kind: "DUEL",
    scoresA: scoreA,
    scoresB: scoreB,
    rawScoreA: 76,
    rawScoreB: 75,
    officialScoreA: 76,
    officialScoreB: 75,
    winnerLabel: "A",
    tieBreakReason: "none",
    explanation: "Answer A is more technically correct.",
    provider: {
      attemptCount: 1,
      responseId: "resp_recovery",
      requestedModel: "persisted-model-version",
      returnedModel: "persisted-model-version-2026-08-01",
      latencyMs: 25,
      inputTokens: 100,
      outputTokens: 30,
      cachedTokens: 10,
      reasoningTokens: 5,
      attempts: [
        {
          reservationId: "22222222-2222-4222-8222-222222222222",
          attempt: 1,
          classification: "success",
          retryable: false,
          latencyMs: 25,
          httpStatus: 200,
          responseId: "resp_recovery",
          returnedModel: "persisted-model-version-2026-08-01",
          inputTokens: 100,
          outputTokens: 30,
          cachedTokens: 10,
          reasoningTokens: 5,
          rawAnswer: "must never persist",
        } as never,
      ],
    },
  };
}

integration("PostgreSQL AI/ML judge recovery policy", () => {
  let harness: PostgresHarness;

  beforeAll(async () => {
    harness = await createPostgresHarness(databaseUrl!);
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
  });

  async function fixture(): Promise<{ evaluationId: string; matchId: string }> {
    const answerB = snapshot.answers.B;
    if (answerB === undefined) throw new Error("duel fixture answer B missing");
    await harness.sql`
      INSERT INTO profiles (clerk_user_id, username)
      VALUES ('host', 'BudgetHost'), ('opponent', 'BudgetOpponent')
    `;
    await harness.sql`
      INSERT INTO player_records (clerk_user_id)
      VALUES ('host'), ('opponent')
    `;
    await harness.sql`
      INSERT INTO ai_ml_question_registry
        (question_id, version, title, prompt, difficulty, category, tags,
         answer_constraints, private_material, rubric_hash)
      VALUES
        ('budget-recovery-question', 1, 'Recovery question',
         'Explain a production ML tradeoff.', 'EASY', 'Testing', '[]'::jsonb,
         '{}'::jsonb, '{}'::jsonb, ${HASH})
      ON CONFLICT DO NOTHING
    `;
    await harness.sql`
      INSERT INTO ai_ml_judge_prompts
        (version, duel_instructions, practice_instructions, schema_version)
      VALUES (1, 'Duel instructions.', 'Practice instructions.', 'ai-ml-judge-v1')
      ON CONFLICT DO NOTHING
    `;
    const [room] = await harness.sql<{ id: string }[]>`
      INSERT INTO rooms
        (invite_token_hash, host_user_id, difficulty, mode, challenge_type)
      VALUES (${"b".repeat(64)}, 'host', 'EASY', 'DUEL', 'AI_ML')
      RETURNING id
    `;
    if (!room) throw new Error("fixture room missing");
    const [match] = await harness.sql<{ id: string }[]>`
      INSERT INTO matches
        (room_id, round_number, state, difficulty, problem_id, problem_version,
         problem_title, starts_at, answer_deadline_at, challenge_type, mode)
      VALUES
        (${room.id}, 1, 'JUDGING', 'EASY', 'budget-recovery-question', 1,
         'Recovery question', clock_timestamp() - interval '1 minute',
         clock_timestamp() + interval '9 minutes', 'AI_ML', 'DUEL')
      RETURNING id
    `;
    if (!match) throw new Error("fixture match missing");
    await harness.sql`
      UPDATE rooms SET active_match_id = ${match.id} WHERE id = ${room.id}
    `;
    await harness.sql`
      INSERT INTO match_participants
        (match_id, clerk_user_id, slot, activity, connected)
      VALUES
        (${match.id}, 'host', 1, 'JUDGING', true),
        (${match.id}, 'opponent', 2, 'JUDGING', true)
    `;
    await harness.sql`
      INSERT INTO ai_ml_answers
        (match_id, clerk_user_id, normalized_answer, word_count,
         character_count, utf8_byte_count)
      VALUES
        (${match.id}, 'host', ${snapshot.answers.A}, 4,
         ${snapshot.answers.A.length}, ${snapshot.answers.A.length}),
        (${match.id}, 'opponent', ${answerB}, 4,
         ${answerB.length}, ${answerB.length})
    `;
    const [evaluation] = await harness.sql<{ id: string }[]>`
      INSERT INTO ai_ml_evaluations
        (match_id, immutable_snapshot, snapshot_hash, answer_a_user_id,
         answer_b_user_id, question_id, question_version, rubric_hash,
         prompt_version, schema_version, requested_model)
      VALUES
        (${match.id}, ${harness.sql.json(snapshot as never)}, ${HASH}, 'host',
         'opponent', 'budget-recovery-question', 1, ${HASH}, 1,
         'ai-ml-judge-v1', 'persisted-model-version')
      RETURNING id
    `;
    if (!evaluation) throw new Error("fixture evaluation missing");
    return { evaluationId: evaluation.id, matchId: match.id };
  }

  it("keeps permanent failures terminal and strips private telemetry fields", async () => {
    const { evaluationId, matchId } = await fixture();
    let calls = 0;
    const judge: AiMlJudgeAdapter = {
      async evaluate() {
        calls += 1;
        throw new AiMlJudgeUnavailableError({
          code: "PROVIDER_4XX",
          retryable: false,
          attemptCount: 1,
          attempts: [
            {
              reservationId: "11111111-1111-4111-8111-111111111111",
              attempt: 1,
              classification: "provider_4xx",
              retryable: false,
              latencyMs: 10,
              httpStatus: 400,
              responseId: "resp_failed",
              returnedModel: "persisted-model-version",
              inputTokens: 10,
              outputTokens: 0,
              cachedTokens: 0,
              reasoningTokens: 0,
              rawAnswer: "private player answer",
              prompt: "private instructions",
            } as never,
          ],
        });
      },
    };
    const arena = new AiMlArenaService(harness.sql, judge);

    await expect(arena.evaluate(evaluationId)).resolves.toBe(false);
    const [failed] = await harness.sql<
      {
        retry_not_before: string | null;
        failure_metadata: { retryable: boolean };
        provider_attempts: unknown[];
      }[]
    >`
      SELECT retry_not_before::text, failure_metadata, provider_attempts
      FROM ai_ml_evaluations WHERE id = ${evaluationId}
    `;
    expect(failed?.retry_not_before).toBeNull();
    expect(failed?.failure_metadata.retryable).toBe(false);
    expect(failed?.provider_attempts).toHaveLength(1);
    expect(JSON.stringify(failed?.provider_attempts)).not.toMatch(
      /private|rawAnswer|prompt/i,
    );
    const [terminal] = await harness.sql<
      {
        state: string;
        end_reason: string;
        records_applied: boolean;
        winner_user_id: string | null;
        outcomes: string[];
        wins: number;
        losses: number;
      }[]
    >`
      SELECT match.state, match.end_reason, match.records_applied,
             match.winner_user_id,
             array_agg(participant.outcome ORDER BY participant.slot)
               AS outcomes,
             sum(record.wins)::int AS wins,
             sum(record.losses)::int AS losses
      FROM matches match
      JOIN match_participants participant ON participant.match_id = match.id
      JOIN player_records record
        ON record.clerk_user_id = participant.clerk_user_id
      WHERE match.id = ${matchId}
      GROUP BY match.id
    `;
    expect(terminal).toEqual({
      state: "REMATCH_PENDING",
      end_reason: "JUDGE_FAILED",
      records_applied: false,
      winner_user_id: null,
      outcomes: ["NO_CONTEST", "NO_CONTEST"],
      wins: 0,
      losses: 0,
    });
    await expect(
      arena.retryEvaluation({
        actorUserId: "host",
        matchId,
        idempotencyKey: "permanent-retry",
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE", status: 409 });
    await expect(arena.evaluate(evaluationId)).resolves.toBe(false);
    expect(calls).toBe(1);
  });

  it("uses a five-minute retry window when the durable circuit opens", async () => {
    const { evaluationId, matchId } = await fixture();
    const judge: AiMlJudgeAdapter = {
      async evaluate() {
        throw new AiMlJudgeUnavailableError({
          code: "BUDGET_CIRCUIT_OPEN",
          retryable: true,
          attemptCount: 0,
          attempts: [],
        });
      },
    };
    const arena = new AiMlArenaService(harness.sql, judge, {
      recoveryRateLimitSeconds: 1,
      budgetCircuitRecoveryRateLimitSeconds: 300,
    });

    await expect(arena.evaluate(evaluationId)).resolves.toBe(false);
    const [failed] = await harness.sql<{ retry_seconds: number }[]>`
      SELECT extract(epoch FROM retry_not_before - updated_at)::int
        AS retry_seconds
      FROM ai_ml_evaluations WHERE id = ${evaluationId}
    `;
    expect(failed?.retry_seconds).toBeGreaterThanOrEqual(299);
    await expect(
      arena.retryEvaluation({
        actorUserId: "host",
        matchId,
        idempotencyKey: "budget-retry",
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED", status: 429 });
  });

  it("recovers retryable failures idempotently with the persisted payload", async () => {
    const { evaluationId, matchId } = await fixture();
    const calls: Array<{
      snapshot: AiMlEvaluationSnapshot;
      options: AiMlJudgeEvaluationOptions | undefined;
    }> = [];
    const judge: AiMlJudgeAdapter = {
      async evaluate(received, options) {
        calls.push({ snapshot: received, options });
        if (calls.length === 1) {
          throw new AiMlJudgeUnavailableError({
            code: "NETWORK",
            retryable: true,
            attemptCount: 1,
            attempts: [
              {
                reservationId: "11111111-1111-4111-8111-111111111111",
                attempt: 1,
                classification: "network",
                retryable: true,
                latencyMs: 15,
                httpStatus: null,
                responseId: null,
                returnedModel: null,
                inputTokens: null,
                outputTokens: null,
                cachedTokens: null,
                reasoningTokens: null,
              },
            ],
          });
        }
        return successResult();
      },
    };
    const arena = new AiMlArenaService(harness.sql, judge, {
      recoveryRateLimitSeconds: 1,
    });

    await expect(arena.evaluate(evaluationId)).resolves.toBe(false);
    await harness.sql`
      UPDATE ai_ml_evaluations
      SET retry_not_before = clock_timestamp() - interval '1 second'
      WHERE id = ${evaluationId}
    `;
    await expect(
      arena.retryEvaluation({
        actorUserId: "host",
        matchId,
        idempotencyKey: "retry-once",
      }),
    ).resolves.toBe(true);
    await expect(
      arena.retryEvaluation({
        actorUserId: "host",
        matchId,
        idempotencyKey: "retry-once",
      }),
    ).resolves.toBe(false);

    expect(calls).toHaveLength(2);
    expect(calls[0]?.snapshot).toEqual(snapshot);
    expect(calls[1]?.snapshot).toEqual(snapshot);
    expect(calls[0]?.options?.requestedModel).toBe("persisted-model-version");
    expect(calls[1]?.options?.requestedModel).toBe("persisted-model-version");
    expect(calls[0]?.options?.claimId).not.toBe(calls[1]?.options?.claimId);

    const [completed] = await harness.sql<
      {
        status: string;
        attempt_count: number;
        provider_attempts: unknown[];
        wins: number;
      }[]
    >`
      SELECT evaluation.status, evaluation.attempt_count::int,
             evaluation.provider_attempts, record.wins::int
      FROM ai_ml_evaluations evaluation
      JOIN player_records record ON record.clerk_user_id = 'host'
      WHERE evaluation.id = ${evaluationId}
    `;
    expect(completed).toMatchObject({
      status: "COMPLETED",
      attempt_count: 2,
      wins: 1,
    });
    expect(completed?.provider_attempts).toHaveLength(2);
    expect(JSON.stringify(completed?.provider_attempts)).not.toContain(
      "must never persist",
    );
  });
});
