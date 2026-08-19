import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  AiMlJudgeRequestBudgetExceededError,
  PostgresAiMlJudgeRequestBudget,
} from "@/server/ai-ml";
import { closeDatabaseClient, createDatabase } from "@/server/db/client";
import {
  createPostgresHarness,
  type PostgresHarness,
} from "./postgres-harness";

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

function reservationInput(
  adapterAttempt = 1,
  participantUserIds: readonly string[] = ["host"],
) {
  return {
    evaluationId: randomUUID(),
    claimId: randomUUID(),
    adapterAttempt,
    requestedModel: "persisted-gpt-5.4-nano-version",
    participantUserIds,
  };
}

integration("PostgreSQL AI/ML judge request budget", () => {
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

  it("atomically caps concurrent workers across one rolling window", async () => {
    const budget = new PostgresAiMlJudgeRequestBudget(harness.sql, 2);
    const results = await Promise.allSettled([
      budget.reserve(reservationInput()),
      budget.reserve(reservationInput()),
      budget.reserve(reservationInput()),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(2);
    const rejection = results.find((result) => result.status === "rejected");
    expect(rejection).toMatchObject({
      reason: expect.any(AiMlJudgeRequestBudgetExceededError),
    });
    const [usage] = await harness.sql<{ count: number }[]>`
      SELECT count(*)::int AS count
      FROM ai_ml_judge_request_reservations
    `;
    expect(usage?.count).toBe(2);
  });

  it("deduplicates one adapter attempt without refunding or double counting", async () => {
    const budget = new PostgresAiMlJudgeRequestBudget(harness.sql, 1);
    const input = reservationInput();

    const first = await budget.reserve(input);
    const duplicate = await budget.reserve(input);
    expect(duplicate).toEqual(first);
    await expect(
      budget.reserve({ ...input, participantUserIds: ["different-user"] }),
    ).rejects.toThrow(/identity mismatch/i);
    await expect(
      budget.reserve({ ...input, adapterAttempt: 2 }),
    ).rejects.toBeInstanceOf(AiMlJudgeRequestBudgetExceededError);

    const rows = await harness.sql<
      {
        evaluation_id: string;
        claim_id: string;
        adapter_attempt: number;
        requested_model: string;
        charged_user_ids: string[];
      }[]
    >`
      SELECT evaluation_id, claim_id, adapter_attempt::int, requested_model,
             charged_user_ids
      FROM ai_ml_judge_request_reservations
    `;
    expect(rows).toEqual([
      {
        evaluation_id: input.evaluationId,
        claim_id: input.claimId,
        adapter_attempt: 1,
        requested_model: input.requestedModel,
        charged_user_ids: ["host"],
      },
    ]);
  });

  it("round-trips participant arrays with the production Hyperdrive client settings", async () => {
    const hyperdriveSql = createDatabase(harness.scopedDatabaseUrl, {
      hyperdrive: true,
      maximumConnections: 1,
    });
    try {
      const budget = new PostgresAiMlJudgeRequestBudget(hyperdriveSql, 10);
      const input = reservationInput(1, ["host", "guest"]);
      const first = await budget.reserve(input);

      await expect(budget.reserve(input)).resolves.toEqual(first);
      const [stored] = await hyperdriveSql<{ charged_user_ids: string[] }[]>`
        SELECT charged_user_ids
        FROM ai_ml_judge_request_reservations
        WHERE id = ${first.id}
      `;
      expect(stored?.charged_user_ids).toEqual(["guest", "host"]);
    } finally {
      await closeDatabaseClient(hyperdriveSql);
    }
  });

  it("atomically prevents one participant from consuming the shared budget", async () => {
    const budget = new PostgresAiMlJudgeRequestBudget(harness.sql, 100, 2, 6);

    const results = await Promise.allSettled([
      budget.reserve(reservationInput(1, ["heavy-user"])),
      budget.reserve(reservationInput(1, ["heavy-user", "opponent"])),
      budget.reserve(reservationInput(1, ["heavy-user"])),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(2);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({
      reason: expect.any(AiMlJudgeRequestBudgetExceededError),
    });
    await expect(
      budget.reserve(reservationInput(1, ["another-user"])),
    ).resolves.toMatchObject({ id: expect.any(String) });
  });

  it("caps repeated manual recovery attempts for one match evaluation", async () => {
    const budget = new PostgresAiMlJudgeRequestBudget(harness.sql, 100, 50, 2);
    const evaluationId = randomUUID();

    const results = await Promise.allSettled([
      budget.reserve({ ...reservationInput(), evaluationId }),
      budget.reserve({ ...reservationInput(), evaluationId }),
      budget.reserve({ ...reservationInput(), evaluationId }),
    ]);
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(2);
    expect(
      results.find((result) => result.status === "rejected"),
    ).toMatchObject({
      reason: expect.any(AiMlJudgeRequestBudgetExceededError),
    });
  });

  it("expires rolling usage after 24 hours and bounds telemetry retention", async () => {
    const budget = new PostgresAiMlJudgeRequestBudget(harness.sql, 1);
    const first = await budget.reserve(reservationInput());
    await harness.sql`
      UPDATE ai_ml_judge_request_reservations
      SET reserved_at = clock_timestamp() - interval '25 hours'
      WHERE id = ${first.id}
    `;

    const second = await budget.reserve(reservationInput());
    await harness.sql`
      UPDATE ai_ml_judge_request_reservations
      SET reserved_at = CASE
        WHEN id = ${first.id}
          THEN clock_timestamp() - interval '9 days'
        ELSE clock_timestamp() - interval '7 days'
      END
    `;

    await expect(budget.purgeExpiredReservations()).resolves.toBe(1);
    const rows = await harness.sql<{ id: string }[]>`
      SELECT id FROM ai_ml_judge_request_reservations
    `;
    expect(rows).toEqual([{ id: second.id }]);
  });
});
