import { randomInt, randomUUID } from "node:crypto";

import type postgres from "postgres";

import type {
  AiMlEvaluationSnapshot,
  AiMlJudgeAdapter,
  AiMlJudgeAttemptMetadata,
} from "@/server/ai-ml";
import { AiMlJudgeUnavailableError } from "@/server/ai-ml";
import type { Database } from "@/server/db/client";
import { hashPayload } from "@/server/domain/crypto";
import { DomainError, requireActor } from "@/server/domain/errors";
import type { Difficulty, MatchMode } from "@/server/domain/types";
import {
  AiMlAnswerLimitError,
  assertAiMlAnswerWithinLimits,
} from "@/shared/ai-ml-answer";

type Tx = postgres.TransactionSql;

type EvaluationStatus =
  "PENDING" | "IN_PROGRESS" | "COMPLETED" | "FAILED" | "SKIPPED";

type TieBreakReason =
  | "none"
  | "blank_forfeit"
  | "correctness"
  | "completeness_or_specificity"
  | "clarity"
  | "exact_equivalence";

interface ArenaMatchRow {
  id: string;
  room_id: string;
  mode: MatchMode;
  state:
    | "LOBBY"
    | "COUNTDOWN"
    | "ACTIVE"
    | "JUDGING"
    | "FINISHED"
    | "REMATCH_PENDING";
  difficulty: Difficulty;
  problem_id: string | null;
  problem_version: number | null;
  answer_deadline_at: string | null;
  records_applied: boolean;
  round_number: number;
}

interface ArenaParticipantRow {
  clerk_user_id: string;
  slot: 1 | 2;
}

interface ArenaAnswerRow extends ArenaParticipantRow {
  normalized_answer: string;
  submission_source: "PLAYER" | "DEADLINE";
  submitted_at: string;
}

interface EvaluationRow {
  id: string;
  match_id: string;
  status: EvaluationStatus;
  immutable_snapshot: AiMlEvaluationSnapshot;
  answer_a_user_id: string | null;
  answer_b_user_id: string | null;
  attempt_count: number;
  worker_claim_id: string | null;
  claimed_at: string | null;
  retry_not_before: string | null;
  requested_model: string;
  failure_retryable: boolean;
}

interface PrivateQuestionMaterial {
  referenceAnswerNotes: string;
  requiredConcepts: string[];
  optionalNuances: string[];
  seriousErrors: string[];
  criteria: Array<{
    id: string;
    label: string;
    description: string;
    weight: number;
  }>;
}

interface JudgeSuccess {
  kind: "DUEL" | "PRACTICE";
  scoresA: Array<{ criterionId: string; score: number }>;
  scoresB?: Array<{ criterionId: string; score: number }>;
  winnerLabel?: "A" | "B";
  tieBreakReason: Exclude<TieBreakReason, "blank_forfeit"> | "blank_forfeit";
  explanation: string;
  rawScoreA: number;
  rawScoreB?: number;
  officialScoreA: number;
  officialScoreB?: number;
  provider: {
    attemptCount: number;
    responseId: string | null;
    requestedModel: string;
    returnedModel: string;
    latencyMs: number;
    inputTokens: number | null;
    outputTokens: number | null;
    cachedTokens: number | null;
    reasoningTokens: number | null;
    attempts: readonly AiMlJudgeAttemptMetadata[];
  };
}

export interface AiMlArenaOptions {
  requestedModel?: string;
  rematchWindowSeconds?: number;
  recoveryRateLimitSeconds?: number;
  budgetCircuitRecoveryRateLimitSeconds?: number;
  staleClaimSeconds?: number;
  chooseAnswerAIndex?: (participantCount: number) => number;
}

export interface AiMlDeadlineProcessingOptions {
  /**
   * Room-local alarms and foreground requests may judge immediately. Global
   * sweeps disable this so discovering many overdue rounds never serializes
   * many provider calls inside one scheduled invocation.
   */
  evaluateImmediately?: boolean;
}

const DEFAULTS = {
  requestedModel: "gpt-5.4-nano",
  rematchWindowSeconds: 30,
  recoveryRateLimitSeconds: 30,
  budgetCircuitRecoveryRateLimitSeconds: 300,
  staleClaimSeconds: 180,
} as const;

const SAFE_ATTEMPT_CLASSIFICATIONS = new Set([
  "success",
  "network",
  "timeout",
  "rate_limit",
  "provider_5xx",
  "provider_4xx",
  "refusal",
  "incomplete",
  "schema_invalid",
  "semantic_invalid",
  "configuration",
  "unknown",
]);

function safeTelemetryInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function safeTelemetryText(value: unknown, maximumLength = 255): string | null {
  return typeof value === "string" && value.length > 0
    ? value.slice(0, maximumLength)
    : null;
}

/** Whitelists non-sensitive fields before judge telemetry reaches JSONB. */
export function safeAiMlJudgeAttemptTelemetry(
  attempts: readonly AiMlJudgeAttemptMetadata[],
): postgres.JSONValue[] {
  return attempts.map((attempt) => ({
    reservationId: safeTelemetryText(attempt.reservationId, 128),
    attempt:
      typeof attempt.attempt === "number" &&
      Number.isInteger(attempt.attempt) &&
      attempt.attempt >= 1 &&
      attempt.attempt <= 3
        ? attempt.attempt
        : null,
    classification: SAFE_ATTEMPT_CLASSIFICATIONS.has(attempt.classification)
      ? attempt.classification
      : "unknown",
    retryable: attempt.retryable === true,
    latencyMs: safeTelemetryInteger(attempt.latencyMs),
    httpStatus:
      typeof attempt.httpStatus === "number" &&
      Number.isInteger(attempt.httpStatus) &&
      attempt.httpStatus >= 100 &&
      attempt.httpStatus <= 599
        ? attempt.httpStatus
        : null,
    responseId: safeTelemetryText(attempt.responseId),
    returnedModel: safeTelemetryText(attempt.returnedModel),
    inputTokens: safeTelemetryInteger(attempt.inputTokens),
    outputTokens: safeTelemetryInteger(attempt.outputTokens),
    cachedTokens: safeTelemetryInteger(attempt.cachedTokens),
    reasoningTokens: safeTelemetryInteger(attempt.reasoningTokens),
  }));
}

function assertIdempotencyKey(key: string): void {
  if (!key || key.length > 200) {
    throw new DomainError(
      "IDEMPOTENCY_KEY_REQUIRED",
      "A non-empty idempotency key of at most 200 characters is required",
      422,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function parsePrivateMaterial(value: unknown): PrivateQuestionMaterial {
  if (!isRecord(value)) throw new Error("AI/ML private material is invalid");
  const referenceAnswerNotes = value.referenceAnswerNotes;
  const requiredConcepts = value.requiredConcepts;
  const optionalNuances = value.optionalNuances;
  const seriousErrors = value.seriousErrors;
  const criteria = value.criteria;
  if (
    typeof referenceAnswerNotes !== "string" ||
    !Array.isArray(requiredConcepts) ||
    !requiredConcepts.every((item) => typeof item === "string") ||
    !Array.isArray(optionalNuances) ||
    !optionalNuances.every((item) => typeof item === "string") ||
    !Array.isArray(seriousErrors) ||
    !seriousErrors.every((item) => typeof item === "string") ||
    !Array.isArray(criteria)
  ) {
    throw new Error("AI/ML private material is invalid");
  }
  const parsedCriteria = criteria.map((criterion) => {
    if (
      !isRecord(criterion) ||
      typeof criterion.id !== "string" ||
      typeof criterion.label !== "string" ||
      typeof criterion.description !== "string" ||
      typeof criterion.weight !== "number" ||
      !Number.isInteger(criterion.weight) ||
      criterion.weight <= 0
    ) {
      throw new Error("AI/ML rubric criterion is invalid");
    }
    return {
      id: criterion.id,
      label: criterion.label,
      description: criterion.description,
      weight: criterion.weight,
    };
  });
  if (
    parsedCriteria.length < 3 ||
    parsedCriteria.length > 5 ||
    parsedCriteria.reduce((sum, criterion) => sum + criterion.weight, 0) !== 100
  ) {
    throw new Error(
      "AI/ML rubric must contain three to five criteria totaling 100",
    );
  }
  return {
    referenceAnswerNotes,
    requiredConcepts: [...requiredConcepts] as string[],
    optionalNuances: [...optionalNuances] as string[],
    seriousErrors: [...seriousErrors] as string[],
    criteria: parsedCriteria,
  };
}

function officialTieScores(raw: number, winner: "A" | "B") {
  const winning = raw < 100 ? raw + 1 : 100;
  const losing = raw < 100 ? raw : 99;
  return winner === "A"
    ? { officialScoreA: winning, officialScoreB: losing }
    : { officialScoreA: losing, officialScoreB: winning };
}

export class AiMlArenaService {
  private readonly options: Required<AiMlArenaOptions>;

  constructor(
    private readonly sql: Database,
    private readonly judge: AiMlJudgeAdapter,
    options: AiMlArenaOptions = {},
  ) {
    this.options = {
      requestedModel: options.requestedModel ?? DEFAULTS.requestedModel,
      rematchWindowSeconds:
        options.rematchWindowSeconds ?? DEFAULTS.rematchWindowSeconds,
      recoveryRateLimitSeconds:
        options.recoveryRateLimitSeconds ?? DEFAULTS.recoveryRateLimitSeconds,
      budgetCircuitRecoveryRateLimitSeconds:
        options.budgetCircuitRecoveryRateLimitSeconds ??
        DEFAULTS.budgetCircuitRecoveryRateLimitSeconds,
      staleClaimSeconds:
        options.staleClaimSeconds ?? DEFAULTS.staleClaimSeconds,
      chooseAnswerAIndex:
        options.chooseAnswerAIndex ?? ((length) => randomInt(length)),
    };
  }

  private async lockMatch(tx: Tx, matchId: string): Promise<ArenaMatchRow> {
    const [match] = await tx<ArenaMatchRow[]>`
      SELECT id, room_id, mode, state, difficulty, problem_id, problem_version,
             answer_deadline_at::text, records_applied, round_number
      FROM matches
      WHERE id = ${matchId} AND challenge_type = 'AI_ML'
      FOR UPDATE
    `;
    if (!match)
      throw new DomainError("MATCH_NOT_FOUND", "AI/ML match not found", 404);
    return match;
  }

  private async lockParticipant(
    tx: Tx,
    matchId: string,
    actorUserId: string,
  ): Promise<ArenaParticipantRow> {
    const [participant] = await tx<ArenaParticipantRow[]>`
      SELECT clerk_user_id, slot
      FROM match_participants
      WHERE match_id = ${matchId} AND clerk_user_id = ${actorUserId}
      FOR UPDATE
    `;
    if (!participant) {
      throw new DomainError(
        "NOT_A_PARTICIPANT",
        "You are not a participant in this match",
        403,
      );
    }
    return participant;
  }

  private async appendEvent(
    tx: Tx,
    matchId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    const inserted = await tx`
      WITH bumped AS (
        UPDATE matches
        SET version = version + 1, updated_at = clock_timestamp()
        WHERE id = ${matchId}
        RETURNING version
      )
      INSERT INTO match_events
        (match_id, version, event_type, payload, server_timestamp)
      SELECT ${matchId}, version, ${eventType},
             ${tx.json(payload as postgres.JSONValue)},
             GREATEST(
               clock_timestamp(),
               COALESCE(
                 (SELECT max(server_timestamp) + interval '1 microsecond'
                  FROM match_events WHERE match_id = ${matchId}),
                 '-infinity'::timestamptz
               )
             )
      FROM bumped
    `;
    if (inserted.count !== 1) throw new Error("Could not append AI/ML event");
  }

  private async reserveCommand(
    tx: Tx,
    input: {
      actorUserId: string;
      idempotencyKey: string;
      commandType: string;
      matchId: string;
      payload: unknown;
    },
  ): Promise<boolean> {
    assertIdempotencyKey(input.idempotencyKey);
    const payloadHash = hashPayload(input.payload);
    const inserted = await tx`
      INSERT INTO command_receipts
        (actor_user_id, idempotency_key, command_type, match_id, payload_hash)
      VALUES
        (${input.actorUserId}, ${input.idempotencyKey}, ${input.commandType},
         ${input.matchId}, ${payloadHash})
      ON CONFLICT DO NOTHING
    `;
    if (inserted.count === 1) return false;
    const [existing] = await tx<
      {
        command_type: string;
        match_id: string | null;
        payload_hash: string;
        completed: boolean;
      }[]
    >`
      SELECT command_type, match_id, payload_hash, response IS NOT NULL AS completed
      FROM command_receipts
      WHERE actor_user_id = ${input.actorUserId}
        AND idempotency_key = ${input.idempotencyKey}
    `;
    if (
      !existing ||
      existing.command_type !== input.commandType ||
      existing.match_id !== input.matchId ||
      existing.payload_hash !== payloadHash
    ) {
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "That idempotency key was already used for a different command",
        409,
      );
    }
    if (!existing.completed) {
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "The original command is still being completed",
        409,
      );
    }
    return true;
  }

  private async completeCommand(
    tx: Tx,
    actorUserId: string,
    idempotencyKey: string,
    response: Record<string, unknown>,
  ): Promise<void> {
    await tx`
      UPDATE command_receipts
      SET response = ${tx.json(response as postgres.JSONValue)},
          completed_at = clock_timestamp()
      WHERE actor_user_id = ${actorUserId}
        AND idempotency_key = ${idempotencyKey}
        AND response IS NULL
    `;
  }

  async submitAnswer(input: {
    actorUserId: string;
    matchId: string;
    idempotencyKey: string;
    answer: string;
  }): Promise<{ evaluationId: string | null; duplicate: boolean }> {
    requireActor(input.actorUserId);
    assertIdempotencyKey(input.idempotencyKey);
    let measured;
    try {
      measured = assertAiMlAnswerWithinLimits(input.answer);
    } catch (error) {
      if (!(error instanceof AiMlAnswerLimitError)) throw error;
      const violation = error.measurement.violations[0];
      throw new DomainError(
        violation === "TOO_MANY_WORDS"
          ? "ANSWER_WORD_LIMIT"
          : violation === "TOO_MANY_CHARACTERS"
            ? "ANSWER_CHARACTER_LIMIT"
            : "ANSWER_BYTE_LIMIT",
        "The answer exceeds the AI/ML Arena limit",
        413,
      );
    }

    const prepared = await this.sql.begin(async (tx) => {
      const match = await this.lockMatch(tx, input.matchId);
      const participant = await this.lockParticipant(
        tx,
        input.matchId,
        input.actorUserId,
      );
      const duplicate = await this.reserveCommand(tx, {
        actorUserId: input.actorUserId,
        idempotencyKey: input.idempotencyKey,
        commandType: "SUBMIT_AI_ML_ANSWER",
        matchId: input.matchId,
        payload: { answer: measured.normalized },
      });
      if (duplicate) return { evaluationId: null, duplicate: true };
      if (match.state !== "ACTIVE" || !match.answer_deadline_at) {
        throw new DomainError(
          "INVALID_STATE",
          "AI/ML answers are accepted only during the active round",
          409,
        );
      }
      const [withinDeadline] = await tx<{ allowed: boolean }[]>`
        SELECT clock_timestamp() < ${match.answer_deadline_at}::timestamptz AS allowed
      `;
      if (!withinDeadline?.allowed) {
        throw new DomainError(
          "ANSWER_DEADLINE_PASSED",
          "The ten-minute answer deadline has passed",
          409,
        );
      }
      const inserted = await tx`
        INSERT INTO ai_ml_answers
          (match_id, clerk_user_id, normalized_answer, word_count,
           character_count, utf8_byte_count, submission_source)
        VALUES
          (${input.matchId}, ${input.actorUserId}, ${measured.normalized},
           ${measured.wordCount}, ${measured.characterCount},
           ${measured.utf8ByteCount}, 'PLAYER')
        ON CONFLICT DO NOTHING
      `;
      if (inserted.count !== 1) {
        throw new DomainError(
          "ANSWER_ALREADY_SUBMITTED",
          "Your final answer is already locked",
          409,
        );
      }
      await this.appendEvent(tx, input.matchId, "AI_ML_ANSWER_SUBMITTED", {
        slot: participant.slot,
      });
      const evaluationId = await this.prepareEvaluationTx(tx, match);
      await this.completeCommand(tx, input.actorUserId, input.idempotencyKey, {
        ok: true,
        evaluationId,
      });
      return { evaluationId, duplicate: false };
    });

    if (prepared.evaluationId) await this.evaluate(prepared.evaluationId);
    return prepared;
  }

  private async prepareEvaluationTx(
    tx: Tx,
    match: ArenaMatchRow,
  ): Promise<string | null> {
    if (match.state !== "ACTIVE") return null;
    if (!match.problem_id || !match.problem_version) {
      throw new Error("Active AI/ML match has no selected question");
    }
    const participants = await tx<ArenaParticipantRow[]>`
      SELECT clerk_user_id, slot
      FROM match_participants
      WHERE match_id = ${match.id}
      ORDER BY slot
      FOR UPDATE
    `;
    const expected = match.mode === "PRACTICE" ? 1 : 2;
    if (participants.length !== expected) return null;
    const answers = await tx<ArenaAnswerRow[]>`
      SELECT participant.clerk_user_id, participant.slot,
             answer.normalized_answer, answer.submission_source,
             answer.submitted_at::text
      FROM match_participants participant
      JOIN ai_ml_answers answer
        ON answer.match_id = participant.match_id
       AND answer.clerk_user_id = participant.clerk_user_id
      WHERE participant.match_id = ${match.id}
      ORDER BY participant.slot
      FOR UPDATE OF answer
    `;
    if (answers.length !== expected) return null;

    const [question] = await tx<
      {
        question_id: string;
        version: number;
        title: string;
        prompt: string;
        difficulty: Difficulty;
        category: string;
        private_material: unknown;
        rubric_hash: string;
      }[]
    >`
      SELECT question_id, version, title, prompt, difficulty, category,
             private_material, rubric_hash
      FROM ai_ml_question_registry
      WHERE question_id = ${match.problem_id}
        AND version = ${match.problem_version}
    `;
    const [prompt] = await tx<
      {
        version: number;
        duel_instructions: string;
        practice_instructions: string;
        schema_version: string;
      }[]
    >`
      SELECT version, duel_instructions, practice_instructions, schema_version
      FROM ai_ml_judge_prompts
      WHERE active
      ORDER BY version DESC
      LIMIT 1
    `;
    if (!question || !prompt) {
      throw new DomainError(
        "JUDGE_UNAVAILABLE",
        "AI/ML judging configuration is unavailable",
        503,
      );
    }
    const privateMaterial = parsePrivateMaterial(question.private_material);
    const answerAIndex = this.options.chooseAnswerAIndex(answers.length);
    if (
      !Number.isInteger(answerAIndex) ||
      answerAIndex < 0 ||
      answerAIndex >= answers.length
    ) {
      throw new Error("Anonymous answer mapper returned an invalid index");
    }
    const answerA = answers[answerAIndex]!;
    const answerB =
      match.mode === "DUEL"
        ? answers.find(
            (answer) => answer.clerk_user_id !== answerA.clerk_user_id,
          )
        : undefined;
    if (match.mode === "DUEL" && !answerB) {
      throw new Error("Duel evaluation requires two anonymous answers");
    }
    const snapshot: AiMlEvaluationSnapshot = {
      mode: match.mode,
      schemaVersion: prompt.schema_version,
      instructions:
        match.mode === "DUEL"
          ? prompt.duel_instructions
          : prompt.practice_instructions,
      question: {
        id: question.question_id,
        version: question.version,
        title: question.title,
        prompt: question.prompt,
        difficulty: question.difficulty,
        category: question.category,
        referenceAnswerNotes: privateMaterial.referenceAnswerNotes,
        requiredConcepts: privateMaterial.requiredConcepts,
        optionalNuances: privateMaterial.optionalNuances,
        seriousErrors: privateMaterial.seriousErrors,
        criteria: privateMaterial.criteria.map((criterion) => ({
          id: criterion.id,
          label: criterion.label,
          description: criterion.description,
          maxScore: criterion.weight,
        })),
      },
      answers: {
        A: answerA.normalized_answer,
        ...(answerB ? { B: answerB.normalized_answer } : {}),
      },
    };
    const snapshotHash = hashPayload(snapshot);
    const [evaluation] = await tx<{ id: string }[]>`
      INSERT INTO ai_ml_evaluations
        (match_id, immutable_snapshot, snapshot_hash, answer_a_user_id,
         answer_b_user_id, question_id, question_version, rubric_hash,
         prompt_version, schema_version, requested_model)
      VALUES
        (${match.id}, ${tx.json(snapshot as unknown as postgres.JSONValue)},
         ${snapshotHash}, ${answerA.clerk_user_id},
         ${answerB?.clerk_user_id ?? null}, ${question.question_id},
         ${question.version}, ${question.rubric_hash}, ${prompt.version},
         ${prompt.schema_version}, ${this.options.requestedModel})
      ON CONFLICT (match_id) DO NOTHING
      RETURNING id
    `;
    if (!evaluation) return null;

    await tx`
      UPDATE matches
      SET state = 'JUDGING', updated_at = clock_timestamp()
      WHERE id = ${match.id} AND state = 'ACTIVE'
    `;
    await this.appendEvent(tx, match.id, "AI_ML_JUDGING_STARTED", {});

    const blanks = answers.filter(
      (answer) => answer.normalized_answer.length === 0,
    );
    if (blanks.length === answers.length) {
      await this.finalizeSkippedTx(
        tx,
        match,
        evaluation.id,
        participants,
        answers.some((answer) => answer.submission_source === "DEADLINE")
          ? "ANSWER_TIMEOUT"
          : "NO_CONTEST",
      );
      return null;
    }
    return evaluation.id;
  }

  private async finalizeSkippedTx(
    tx: Tx,
    match: ArenaMatchRow,
    evaluationId: string,
    participants: ArenaParticipantRow[],
    endReason: "ANSWER_TIMEOUT" | "NO_CONTEST",
  ): Promise<void> {
    await tx`
      UPDATE ai_ml_evaluations
      SET status = 'SKIPPED', raw_score_a = 0,
          raw_score_b = CASE WHEN ${match.mode} = 'DUEL' THEN 0 ELSE NULL END,
          official_score_a = 0,
          official_score_b = CASE WHEN ${match.mode} = 'DUEL' THEN 0 ELSE NULL END,
          tie_break_reason = 'none', completion_classification = 'blank_no_contest',
          explanation = CASE
            WHEN ${match.mode} = 'PRACTICE'
              THEN 'No answer was submitted, so this practice attempt received 0.'
            ELSE 'Neither player submitted an answer, so the round was not contested.'
          END,
          completed_at = clock_timestamp(), updated_at = clock_timestamp()
      WHERE id = ${evaluationId} AND status = 'PENDING'
    `;
    await tx`
      UPDATE matches
      SET state = 'FINISHED', winner_user_id = NULL, end_reason = ${endReason},
          finished_at = clock_timestamp(), records_applied = false,
          updated_at = clock_timestamp()
      WHERE id = ${match.id} AND state = 'JUDGING'
    `;
    for (const participant of participants) {
      await tx`
        UPDATE match_participants
        SET outcome = 'NO_CONTEST', activity = 'THINKING',
            active_execution_id = NULL, updated_at = clock_timestamp()
        WHERE match_id = ${match.id}
          AND clerk_user_id = ${participant.clerk_user_id}
      `;
    }
    await this.appendEvent(tx, match.id, "AI_ML_AUTOMATIC_RESOLUTION", {
      kind: match.mode === "PRACTICE" ? "PRACTICE_BLANK" : "TWO_BLANKS",
      scores: participants.map((participant) => ({
        slot: participant.slot,
        score: 0,
      })),
    });
    await this.appendEvent(tx, match.id, "MATCH_FINISHED", {
      endReason,
      winnerSlot: null,
    });
    if (match.mode === "DUEL") await this.openRematchTx(tx, match.id);
  }

  private async openRematchTx(tx: Tx, matchId: string): Promise<void> {
    const [pending] = await tx<{ rematch_deadline: string }[]>`
      UPDATE matches
      SET state = 'REMATCH_PENDING',
          rematch_deadline = clock_timestamp()
            + (${this.options.rematchWindowSeconds} * interval '1 second'),
          updated_at = clock_timestamp()
      WHERE id = ${matchId} AND state = 'FINISHED'
      RETURNING rematch_deadline::text
    `;
    if (pending) {
      await this.appendEvent(tx, matchId, "REMATCH_OPENED", {
        deadline: pending.rematch_deadline,
      });
    }
  }

  async processAnswerDeadlineForMatch(
    matchId: string,
    options: AiMlDeadlineProcessingOptions = {},
  ): Promise<boolean> {
    const prepared = await this.sql.begin(async (tx) => {
      const match = await this.lockMatch(tx, matchId);
      if (match.state !== "ACTIVE" || !match.answer_deadline_at) {
        return { processed: false, evaluationId: null };
      }
      const [due] = await tx<{ due: boolean }[]>`
        SELECT ${match.answer_deadline_at}::timestamptz <= clock_timestamp() AS due
      `;
      if (!due?.due) return { processed: false, evaluationId: null };
      const missing = await tx<ArenaParticipantRow[]>`
        SELECT participant.clerk_user_id, participant.slot
        FROM match_participants participant
        LEFT JOIN ai_ml_answers answer
          ON answer.match_id = participant.match_id
         AND answer.clerk_user_id = participant.clerk_user_id
        WHERE participant.match_id = ${matchId} AND answer.id IS NULL
        ORDER BY participant.slot
        FOR UPDATE OF participant
      `;
      for (const participant of missing) {
        await tx`
          INSERT INTO ai_ml_answers
            (match_id, clerk_user_id, normalized_answer, word_count,
             character_count, utf8_byte_count, submission_source, submitted_at)
          VALUES
            (${matchId}, ${participant.clerk_user_id}, '', 0, 0, 0,
             'DEADLINE', ${match.answer_deadline_at}::timestamptz)
          ON CONFLICT DO NOTHING
        `;
        await this.appendEvent(tx, matchId, "AI_ML_ANSWER_TIMED_OUT", {
          slot: participant.slot,
        });
      }
      return {
        processed: true,
        evaluationId: await this.prepareEvaluationTx(tx, match),
      };
    });
    if (prepared.evaluationId && options.evaluateImmediately !== false) {
      await this.evaluate(prepared.evaluationId);
    }
    return prepared.processed;
  }

  async processDueAnswerDeadlines(
    limit = 100,
    options: AiMlDeadlineProcessingOptions = {},
  ): Promise<number> {
    const rows = await this.sql<{ id: string }[]>`
      SELECT id FROM matches
      WHERE challenge_type = 'AI_ML' AND state = 'ACTIVE'
        AND answer_deadline_at IS NOT NULL
        AND answer_deadline_at <= clock_timestamp()
      ORDER BY answer_deadline_at, id
      LIMIT ${Math.max(1, Math.min(500, Math.trunc(limit)))}
    `;
    let processed = 0;
    for (const row of rows) {
      if (await this.processAnswerDeadlineForMatch(row.id, options)) {
        processed += 1;
      }
    }
    return processed;
  }

  private async claimEvaluation(
    evaluationId: string,
  ): Promise<(EvaluationRow & { claimId: string }) | null> {
    return this.sql.begin(async (tx) => {
      const [evaluation] = await tx<EvaluationRow[]>`
        SELECT id, match_id, status, immutable_snapshot, answer_a_user_id,
               answer_b_user_id, attempt_count, worker_claim_id,
               claimed_at::text, retry_not_before::text, requested_model,
               COALESCE(failure_metadata->>'retryable' = 'true', false)
                 AS failure_retryable
        FROM ai_ml_evaluations
        WHERE id = ${evaluationId}
        FOR UPDATE
      `;
      if (
        !evaluation ||
        evaluation.status === "COMPLETED" ||
        evaluation.status === "SKIPPED"
      ) {
        return null;
      }
      if (evaluation.status === "IN_PROGRESS" && evaluation.claimed_at) {
        const [stale] = await tx<{ stale: boolean }[]>`
          SELECT ${evaluation.claimed_at}::timestamptz
            <= clock_timestamp()
              - (${this.options.staleClaimSeconds} * interval '1 second') AS stale
        `;
        if (!stale?.stale) return null;
      }
      if (evaluation.status === "FAILED" && evaluation.retry_not_before) {
        const [ready] = await tx<{ ready: boolean }[]>`
          SELECT ${evaluation.retry_not_before}::timestamptz <= clock_timestamp() AS ready
        `;
        if (!ready?.ready) return null;
      }
      if (evaluation.status === "FAILED" && !evaluation.failure_retryable) {
        return null;
      }
      const claimId = randomUUID();
      const [claimed] = await tx<EvaluationRow[]>`
        UPDATE ai_ml_evaluations
        SET status = 'IN_PROGRESS', worker_claim_id = ${claimId},
            claimed_at = clock_timestamp(), retry_not_before = NULL,
            failure_code = NULL, failure_metadata = NULL,
            started_at = COALESCE(started_at, clock_timestamp()),
            updated_at = clock_timestamp()
        WHERE id = ${evaluationId}
        RETURNING id, match_id, status, immutable_snapshot, answer_a_user_id,
                  answer_b_user_id, attempt_count, worker_claim_id,
                  claimed_at::text, retry_not_before::text, requested_model,
                  false AS failure_retryable
      `;
      return claimed ? { ...claimed, claimId } : null;
    });
  }

  async evaluate(evaluationId: string): Promise<boolean> {
    const claim = await this.claimEvaluation(evaluationId);
    if (!claim) return false;

    let result: JudgeSuccess;
    try {
      result = (await this.judge.evaluate(claim.immutable_snapshot, {
        requestedModel: claim.requested_model,
        evaluationId: claim.id,
        claimId: claim.claimId,
        participantUserIds: [
          claim.answer_a_user_id,
          claim.answer_b_user_id,
        ].filter((userId): userId is string => userId !== null),
      })) as JudgeSuccess;
    } catch (error) {
      await this.persistFailure(claim, error);
      return false;
    }
    return this.persistSuccess(claim, result);
  }

  private async persistFailure(
    claim: EvaluationRow & { claimId: string },
    error: unknown,
  ): Promise<void> {
    const unavailable =
      error instanceof AiMlJudgeUnavailableError ? error : null;
    const attemptCount = unavailable ? unavailable.attemptCount : 1;
    const failureCode = unavailable?.code ?? "JUDGE_REQUEST_FAILED";
    const retryable = unavailable?.retryable ?? true;
    const safeAttempts = safeAiMlJudgeAttemptTelemetry(
      unavailable?.attempts ?? [],
    );
    const safeMetadata = unavailable
      ? { retryable, attempts: safeAttempts }
      : { retryable: true };
    const retryDelaySeconds = !retryable
      ? null
      : failureCode === "BUDGET_CIRCUIT_OPEN"
        ? this.options.budgetCircuitRecoveryRateLimitSeconds
        : this.options.recoveryRateLimitSeconds;
    await this.sql.begin(async (tx) => {
      // Keep the lock order identical to successful finalization: match first,
      // then evaluation. This also makes a permanent failure and its no-contest
      // outcome one atomic terminal transition.
      const match = await this.lockMatch(tx, claim.match_id);
      if (match.state !== "JUDGING") return;
      const [failed] = await tx<
        { match_id: string; retry_at: string | null }[]
      >`
        UPDATE ai_ml_evaluations
        SET status = 'FAILED', attempt_count = attempt_count + ${attemptCount},
            provider_attempts = provider_attempts || ${tx.json(safeAttempts)},
            failure_code = ${failureCode},
            failure_metadata = ${tx.json(safeMetadata as postgres.JSONValue)},
            retry_not_before = CASE
              WHEN ${retryDelaySeconds}::integer IS NULL THEN NULL
              ELSE clock_timestamp()
                + (${retryDelaySeconds}::integer * interval '1 second')
            END,
            worker_claim_id = NULL, claimed_at = NULL,
            updated_at = clock_timestamp()
        WHERE id = ${claim.id} AND status = 'IN_PROGRESS'
          AND worker_claim_id = ${claim.claimId}
        RETURNING match_id, retry_not_before::text AS retry_at
      `;
      if (!failed) return;
      await this.appendEvent(tx, failed.match_id, "AI_ML_JUDGE_FAILED", {
        retryAt: failed.retry_at,
        retryable,
      });
      if (retryable) return;

      await tx`
        UPDATE matches
        SET state = 'FINISHED', winner_user_id = NULL,
            end_reason = 'JUDGE_FAILED', finished_at = clock_timestamp(),
            records_applied = false, updated_at = clock_timestamp()
        WHERE id = ${match.id} AND state = 'JUDGING'
      `;
      await tx`
        UPDATE match_participants
        SET outcome = 'NO_CONTEST', activity = 'THINKING',
            active_execution_id = NULL, updated_at = clock_timestamp()
        WHERE match_id = ${match.id}
      `;
      await this.appendEvent(tx, match.id, "MATCH_FINISHED", {
        endReason: "JUDGE_FAILED",
        winnerSlot: null,
      });
      if (match.mode === "DUEL") await this.openRematchTx(tx, match.id);
    });
  }

  private async persistSuccess(
    claim: EvaluationRow & { claimId: string },
    result: JudgeSuccess,
  ): Promise<boolean> {
    const answerA = claim.immutable_snapshot.answers.A;
    const answerB = claim.immutable_snapshot.answers.B;
    const blankA = answerA.length === 0;
    const blankB = answerB === "";
    const blankForfeit =
      claim.immutable_snapshot.mode === "DUEL" && blankA !== blankB;

    let rawScoreA = result.rawScoreA;
    let rawScoreB = result.rawScoreB ?? null;
    let officialScoreA = result.officialScoreA;
    let officialScoreB = result.officialScoreB ?? null;
    let winnerLabel = result.winnerLabel ?? null;
    let tieBreakReason: TieBreakReason = result.tieBreakReason;

    if (blankForfeit) {
      winnerLabel = blankA ? "B" : "A";
      tieBreakReason = "blank_forfeit";
      if (blankA) {
        rawScoreA = 0;
        officialScoreA = 0;
        rawScoreB = Math.max(0, rawScoreB ?? 0);
        officialScoreB = Math.max(1, rawScoreB);
      } else {
        rawScoreB = 0;
        officialScoreB = 0;
        rawScoreA = Math.max(0, rawScoreA);
        officialScoreA = Math.max(1, rawScoreA);
      }
    } else if (
      claim.immutable_snapshot.mode === "DUEL" &&
      rawScoreB !== null &&
      rawScoreA === rawScoreB &&
      winnerLabel
    ) {
      const adjusted = officialTieScores(rawScoreA, winnerLabel);
      officialScoreA = adjusted.officialScoreA;
      officialScoreB = adjusted.officialScoreB;
    }

    const winnerUserId =
      winnerLabel === "A"
        ? claim.answer_a_user_id
        : winnerLabel === "B"
          ? claim.answer_b_user_id
          : null;
    if (claim.immutable_snapshot.mode === "DUEL" && !winnerUserId) {
      throw new Error("Validated duel judgment did not map to a participant");
    }

    return this.sql.begin(async (tx) => {
      // Lock and verify the authoritative match before marking the model
      // response complete. A late response must not commit after another
      // terminal path has already resolved the round.
      const match = await this.lockMatch(tx, claim.match_id);
      if (match.state !== "JUDGING") return false;
      const [evaluation] = await tx<{ match_id: string }[]>`
        UPDATE ai_ml_evaluations
        SET status = 'COMPLETED',
            attempt_count = attempt_count + ${result.provider.attemptCount},
            returned_model = ${result.provider.returnedModel},
            provider_attempts = provider_attempts || ${tx.json(
              safeAiMlJudgeAttemptTelemetry(result.provider.attempts),
            )},
            criterion_scores = ${tx.json({
              A: result.scoresA,
              B: result.scoresB ?? null,
            } as postgres.JSONValue)},
            raw_score_a = ${rawScoreA}, raw_score_b = ${rawScoreB},
            official_score_a = ${officialScoreA},
            official_score_b = ${officialScoreB},
            winner_user_id = ${winnerUserId},
            tie_break_reason = ${tieBreakReason},
            explanation = ${result.explanation},
            provider_response_id = ${result.provider.responseId},
            input_tokens = ${result.provider.inputTokens},
            output_tokens = ${result.provider.outputTokens},
            cached_tokens = ${result.provider.cachedTokens},
            reasoning_tokens = ${result.provider.reasoningTokens},
            latency_ms = ${result.provider.latencyMs},
            completion_classification = ${
              blankForfeit
                ? "blank_forfeit"
                : tieBreakReason === "none"
                  ? "judged"
                  : "tie_break"
            },
            failure_code = NULL, failure_metadata = NULL,
            retry_not_before = NULL, worker_claim_id = NULL, claimed_at = NULL,
            completed_at = clock_timestamp(), updated_at = clock_timestamp()
        WHERE id = ${claim.id} AND status = 'IN_PROGRESS'
          AND worker_claim_id = ${claim.claimId}
        RETURNING match_id
      `;
      if (!evaluation) return false;
      const participants = await tx<ArenaParticipantRow[]>`
        SELECT clerk_user_id, slot
        FROM match_participants
        WHERE match_id = ${match.id}
        ORDER BY slot
        FOR UPDATE
      `;
      const timedOut = await tx<{ exists: boolean }[]>`
        SELECT true AS exists FROM ai_ml_answers
        WHERE match_id = ${match.id} AND submission_source = 'DEADLINE'
        LIMIT 1
      `;
      const endReason = timedOut.length > 0 ? "ANSWER_TIMEOUT" : "JUDGED";
      const applyRecords = match.mode === "DUEL" && winnerUserId !== null;
      await tx`
        UPDATE matches
        SET state = 'FINISHED', winner_user_id = ${winnerUserId},
            end_reason = ${endReason}, finished_at = clock_timestamp(),
            records_applied = ${applyRecords}, updated_at = clock_timestamp()
        WHERE id = ${match.id} AND state = 'JUDGING'
      `;
      for (const participant of participants) {
        const outcome =
          match.mode === "PRACTICE"
            ? "DRAW"
            : participant.clerk_user_id === winnerUserId
              ? "WIN"
              : "LOSS";
        await tx`
          UPDATE match_participants
          SET outcome = ${outcome}, activity = 'THINKING',
              active_execution_id = NULL, updated_at = clock_timestamp()
          WHERE match_id = ${match.id}
            AND clerk_user_id = ${participant.clerk_user_id}
        `;
        if (applyRecords) {
          await tx`
            UPDATE player_records
            SET wins = wins + ${participant.clerk_user_id === winnerUserId ? 1 : 0},
                losses = losses + ${participant.clerk_user_id === winnerUserId ? 0 : 1},
                updated_at = clock_timestamp()
            WHERE clerk_user_id = ${participant.clerk_user_id}
          `;
        }
      }
      const scoreForUser = (userId: string): number => {
        if (userId === claim.answer_a_user_id) return officialScoreA;
        if (userId === claim.answer_b_user_id && officialScoreB !== null)
          return officialScoreB;
        return 0;
      };
      const winnerSlot = participants.find(
        (participant) => participant.clerk_user_id === winnerUserId,
      )?.slot;
      await this.appendEvent(tx, match.id, "AI_ML_JUDGMENT_COMPLETED", {
        scores: participants.map((participant) => ({
          slot: participant.slot,
          score: scoreForUser(participant.clerk_user_id),
        })),
        winnerSlot: winnerSlot ?? null,
        tieBreakReason,
        automaticBlank: blankForfeit,
      });
      await this.appendEvent(tx, match.id, "MATCH_FINISHED", {
        endReason,
        winnerSlot: winnerSlot ?? null,
      });
      if (match.mode === "DUEL") await this.openRematchTx(tx, match.id);
      return true;
    });
  }

  async retryEvaluation(input: {
    actorUserId: string;
    matchId: string;
    idempotencyKey: string;
  }): Promise<boolean> {
    requireActor(input.actorUserId);
    const evaluationId = await this.sql.begin(async (tx) => {
      const match = await this.lockMatch(tx, input.matchId);
      await this.lockParticipant(tx, input.matchId, input.actorUserId);
      const duplicate = await this.reserveCommand(tx, {
        actorUserId: input.actorUserId,
        idempotencyKey: input.idempotencyKey,
        commandType: "RETRY_AI_ML_JUDGING",
        matchId: input.matchId,
        payload: {},
      });
      if (duplicate) return null;
      if (match.state !== "JUDGING") {
        throw new DomainError(
          "INVALID_STATE",
          "This match is not waiting for a judge recovery",
          409,
        );
      }
      const [evaluation] = await tx<
        {
          id: string;
          status: EvaluationStatus;
          ready: boolean;
          retryable: boolean;
        }[]
      >`
        SELECT id, status,
               retry_not_before IS NULL
                 OR retry_not_before <= clock_timestamp() AS ready,
               COALESCE(failure_metadata->>'retryable' = 'true', false)
                 AS retryable
        FROM ai_ml_evaluations
        WHERE match_id = ${match.id}
        FOR UPDATE
      `;
      if (!evaluation || evaluation.status !== "FAILED") {
        throw new DomainError(
          "INVALID_STATE",
          "Judging is already in progress or complete",
          409,
        );
      }
      if (!evaluation.retryable) {
        throw new DomainError(
          "INVALID_STATE",
          "This judge failure cannot be retried",
          409,
        );
      }
      if (!evaluation.ready) {
        throw new DomainError(
          "RATE_LIMITED",
          "Judge recovery is rate limited",
          429,
        );
      }
      await this.completeCommand(tx, input.actorUserId, input.idempotencyKey, {
        ok: true,
        evaluationId: evaluation.id,
      });
      return evaluation.id;
    });
    return evaluationId ? this.evaluate(evaluationId) : false;
  }

  async recoverEvaluations(limit = 50, concurrency = 4): Promise<number> {
    const rows = await this.sql<{ id: string }[]>`
      SELECT id
      FROM ai_ml_evaluations
      WHERE status = 'PENDING'
         OR (status = 'IN_PROGRESS'
             AND claimed_at <= clock_timestamp()
               - (${this.options.staleClaimSeconds} * interval '1 second'))
      ORDER BY created_at, id
      LIMIT ${Math.max(1, Math.min(200, Math.trunc(limit)))}
    `;
    const workerCount = Math.min(
      rows.length,
      Math.max(1, Math.min(8, Math.trunc(concurrency))),
    );
    let cursor = 0;
    let completed = 0;
    await Promise.all(
      Array.from({ length: workerCount }, async () => {
        for (;;) {
          const index = cursor;
          cursor += 1;
          const row = rows[index];
          if (!row) return;
          if (await this.evaluate(row.id)) completed += 1;
        }
      }),
    );
    return completed;
  }

  async recoverEvaluationForMatch(matchId: string): Promise<number> {
    const [evaluation] = await this.sql<{ id: string }[]>`
      SELECT id FROM ai_ml_evaluations
      WHERE match_id = ${matchId}
        AND (
          status = 'PENDING'
          OR (status = 'IN_PROGRESS'
              AND claimed_at <= clock_timestamp()
                - (${this.options.staleClaimSeconds} * interval '1 second'))
        )
    `;
    if (!evaluation) return 0;
    await this.evaluate(evaluation.id);
    return 1;
  }
}
