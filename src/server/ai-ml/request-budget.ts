import type { Database } from "@/server/db/client";

const BUDGET_ADVISORY_LOCK_NAME = "leetbattle.ai_ml_judge_request_budget.v1";
const RESERVATION_RETENTION_DAYS = 8;
const RESERVATION_CLEANUP_BATCH = 500;

export interface AiMlJudgeRequestBudgetInput {
  readonly evaluationId: string;
  readonly claimId: string;
  readonly adapterAttempt: number;
  readonly requestedModel: string;
  /** Persisted participants charged for this outbound attempt. */
  readonly participantUserIds: readonly string[];
}

export interface AiMlJudgeRequestReservation {
  readonly id: string;
  readonly reservedAt: string;
}

export interface AiMlJudgeRequestBudget {
  reserve(
    input: AiMlJudgeRequestBudgetInput,
  ): Promise<AiMlJudgeRequestReservation>;
}

export class AiMlJudgeRequestBudgetExceededError extends Error {
  constructor() {
    super("The AI/ML judge request budget is exhausted");
    this.name = "AiMlJudgeRequestBudgetExceededError";
  }
}

export class PostgresAiMlJudgeRequestBudget implements AiMlJudgeRequestBudget {
  constructor(
    private readonly sql: Database,
    private readonly maxRequestsPerRollingDay: number,
    private readonly maxRequestsPerUserPerRollingDay = 50,
    private readonly maxRequestsPerMatchPerRollingDay = 6,
  ) {
    if (
      !Number.isSafeInteger(maxRequestsPerRollingDay) ||
      maxRequestsPerRollingDay < 1
    ) {
      throw new RangeError("AI/ML daily judge request budget must be positive");
    }
    if (
      !Number.isSafeInteger(maxRequestsPerUserPerRollingDay) ||
      maxRequestsPerUserPerRollingDay < 1
    ) {
      throw new RangeError(
        "AI/ML per-user daily judge request budget must be positive",
      );
    }
    if (
      !Number.isSafeInteger(maxRequestsPerMatchPerRollingDay) ||
      maxRequestsPerMatchPerRollingDay < 1
    ) {
      throw new RangeError(
        "AI/ML per-match daily judge request budget must be positive",
      );
    }
  }

  async reserve(
    input: AiMlJudgeRequestBudgetInput,
  ): Promise<AiMlJudgeRequestReservation> {
    if (!Array.isArray(input.participantUserIds)) {
      throw new TypeError("Invalid AI/ML judge request reservation");
    }
    const participantUserIds = [...new Set(input.participantUserIds)].sort();
    if (
      !Number.isInteger(input.adapterAttempt) ||
      input.adapterAttempt < 1 ||
      input.adapterAttempt > 3 ||
      input.requestedModel.trim() === "" ||
      participantUserIds.length !== input.participantUserIds.length ||
      participantUserIds.length < 1 ||
      participantUserIds.length > 2 ||
      participantUserIds.some((userId) => userId.trim() === "")
    ) {
      throw new TypeError("Invalid AI/ML judge request reservation");
    }

    return this.sql.begin(async (tx) => {
      // All web/realtime workers contend on the same PostgreSQL advisory lock,
      // making the rolling-window count and insert one atomic decision.
      await tx`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${BUDGET_ADVISORY_LOCK_NAME}, 0)
        )
      `;

      // Keep one week beyond the active rolling window for operations while
      // bounding work per reservation. At steady state this drains faster than
      // the configured request rate can add rows.
      await tx`
        WITH expired AS (
          SELECT id
          FROM ai_ml_judge_request_reservations
          WHERE reserved_at < clock_timestamp()
            - (${RESERVATION_RETENTION_DAYS} * interval '1 day')
          ORDER BY reserved_at, id
          LIMIT ${RESERVATION_CLEANUP_BATCH}
        )
        DELETE FROM ai_ml_judge_request_reservations reservation
        USING expired
        WHERE reservation.id = expired.id
      `;

      const [existing] = await tx<
        {
          id: string;
          reserved_at: string;
          evaluation_id: string;
          requested_model: string;
          charged_user_ids: string[];
        }[]
      >`
        SELECT id, reserved_at::text, evaluation_id, requested_model,
               charged_user_ids
        FROM ai_ml_judge_request_reservations
        WHERE claim_id = ${input.claimId}
          AND adapter_attempt = ${input.adapterAttempt}
      `;
      if (existing) {
        if (
          existing.evaluation_id !== input.evaluationId ||
          existing.requested_model !== input.requestedModel ||
          existing.charged_user_ids.length !== participantUserIds.length ||
          existing.charged_user_ids.some(
            (userId, index) => userId !== participantUserIds[index],
          )
        ) {
          throw new Error("Judge request reservation identity mismatch");
        }
        return { id: existing.id, reservedAt: existing.reserved_at };
      }

      const [usage] = await tx<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM ai_ml_judge_request_reservations
        WHERE reserved_at >= clock_timestamp() - interval '24 hours'
      `;
      if ((usage?.count ?? 0) >= this.maxRequestsPerRollingDay) {
        throw new AiMlJudgeRequestBudgetExceededError();
      }

      const [matchUsage] = await tx<{ count: number }[]>`
        SELECT count(*)::int AS count
        FROM ai_ml_judge_request_reservations
        WHERE evaluation_id = ${input.evaluationId}
          AND reserved_at >= clock_timestamp() - interval '24 hours'
      `;
      if ((matchUsage?.count ?? 0) >= this.maxRequestsPerMatchPerRollingDay) {
        throw new AiMlJudgeRequestBudgetExceededError();
      }

      const [overUserBudget] = await tx<{ charged_user_id: string }[]>`
        SELECT charged_user_id
        FROM ai_ml_judge_request_reservations reservation
        CROSS JOIN LATERAL unnest(reservation.charged_user_ids)
          AS charged_user_id
        WHERE reservation.reserved_at >=
              clock_timestamp() - interval '24 hours'
          AND charged_user_id = ANY(${tx.array(participantUserIds)}::text[])
        GROUP BY charged_user_id
        HAVING count(*) >= ${this.maxRequestsPerUserPerRollingDay}
        LIMIT 1
      `;
      if (overUserBudget) {
        throw new AiMlJudgeRequestBudgetExceededError();
      }

      const [reservation] = await tx<{ id: string; reserved_at: string }[]>`
        INSERT INTO ai_ml_judge_request_reservations
          (evaluation_id, claim_id, adapter_attempt, requested_model,
           charged_user_ids)
        VALUES
          (${input.evaluationId}, ${input.claimId}, ${input.adapterAttempt},
           ${input.requestedModel}, ${tx.array(participantUserIds)}::text[])
        RETURNING id, reserved_at::text
      `;
      if (!reservation) throw new Error("Judge request reservation failed");
      return {
        id: reservation.id,
        reservedAt: reservation.reserved_at,
      };
    });
  }

  /**
   * Daily maintenance removes the complete expired tail. Request-path cleanup
   * above remains deliberately bounded so a provider call never inherits a
   * large retention delete.
   */
  async purgeExpiredReservations(): Promise<number> {
    const rows = await this.sql<{ id: string }[]>`
      DELETE FROM ai_ml_judge_request_reservations
      WHERE reserved_at < clock_timestamp()
        - (${RESERVATION_RETENTION_DAYS} * interval '1 day')
      RETURNING id
    `;
    return rows.length;
  }
}
