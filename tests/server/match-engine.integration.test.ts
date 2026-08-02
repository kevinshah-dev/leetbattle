import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import type {
  Difficulty,
  ProblemCatalog,
  RunnerResult,
} from "../../src/server/domain/types";
import { DomainError } from "../../src/server/domain/errors";
import { HistoryService } from "../../src/server/history/history-service";
import { MatchEngine } from "../../src/server/match/match-engine";
import { ProfileService } from "../../src/server/profiles/profile-service";
import { RealtimeTicketService } from "../../src/server/realtime/tickets";
import {
  createPostgresHarness,
  type PostgresHarness,
} from "./postgres-harness";

const databaseUrl = process.env.DATABASE_URL;
const integration = describe.skipIf(!databaseUrl);

const catalog: ProblemCatalog = {
  listByDifficulty(difficulty: Difficulty) {
    return [
      {
        id: `${difficulty.toLowerCase()}-one`,
        version: 1,
        title: `${difficulty} One`,
        difficulty,
      },
      {
        id: `${difficulty.toLowerCase()}-two`,
        version: 1,
        title: `${difficulty} Two`,
        difficulty,
      },
    ];
  },
};

const accepted = (runtimeMs: number): RunnerResult => ({
  verdict: "ACCEPTED",
  passedCount: 12,
  totalCount: 12,
  runtimeMs,
  compileMs: 1,
});

const wrong: RunnerResult = {
  verdict: "WRONG_ANSWER",
  passedCount: 7,
  totalCount: 12,
  runtimeMs: 5,
  compileMs: 1,
};

const infra: RunnerResult = {
  verdict: "INFRA_ERROR",
  passedCount: 0,
  totalCount: 0,
  runtimeMs: null,
  compileMs: null,
};

function postgresErrorCode(error: unknown): string | null {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  return null;
}

async function waitForRowLock(
  probe: () => PromiseLike<unknown>,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      await probe();
    } catch (error) {
      if (postgresErrorCode(error) === "55P03") return;
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("Timed out waiting for the expected PostgreSQL row lock");
}

integration("PostgreSQL authoritative match engine", () => {
  let harness: PostgresHarness;
  let profiles: ProfileService;
  let history: HistoryService;
  let engine: MatchEngine;
  let command = 0;

  const key = (prefix: string) => `${prefix}-${++command}`;

  beforeAll(async () => {
    harness = await createPostgresHarness(databaseUrl!);
  });

  afterAll(async () => {
    await harness.close();
  });

  beforeEach(async () => {
    await harness.reset();
    command = 0;
    profiles = new ProfileService(harness.sql);
    history = new HistoryService(harness.sql);
    engine = new MatchEngine(harness.sql, catalog, {
      countdownMs: 0,
      reconnectGraceSeconds: 0,
      rematchWindowSeconds: 30,
      inviteSecret:
        "integration invite secret that is at least thirty two bytes",
      chooseIndex: () => 0,
    });
  });

  async function players() {
    await profiles.create("host", "Host_Player");
    await profiles.create("opponent", "Opponent_Player");
    await profiles.create("outsider", "Outside_Player");
  }

  async function activeMatch() {
    await players();
    const created = await engine.createRoom({
      actorUserId: "host",
      difficulty: "EASY",
      idempotencyKey: key("create"),
    });
    await engine.joinRoom({
      actorUserId: "opponent",
      inviteToken: created.inviteToken,
      idempotencyKey: key("join"),
    });
    const matchId = created.snapshot.matchId;
    const roomId = created.snapshot.roomId;
    const hostSession = await engine.connectSession({
      actorUserId: "host",
      roomId,
      matchId,
    });
    const opponentSession = await engine.connectSession({
      actorUserId: "opponent",
      roomId,
      matchId,
    });
    await engine.setLanguage({
      actorUserId: "host",
      matchId,
      language: "PYTHON",
      idempotencyKey: key("language"),
    });
    await engine.setLanguage({
      actorUserId: "opponent",
      matchId,
      language: "JAVA",
      idempotencyKey: key("language"),
    });
    await engine.setReady({
      actorUserId: "host",
      matchId,
      ready: true,
      idempotencyKey: key("ready"),
    });
    await engine.setReady({
      actorUserId: "opponent",
      matchId,
      ready: true,
      idempotencyKey: key("ready"),
    });
    const snapshot = await engine.getSnapshotByMatch("host", matchId);
    expect(snapshot.state).toBe("ACTIVE");
    return {
      ...created,
      matchId,
      roomId,
      hostSession,
      opponentSession,
    };
  }

  it("enforces case-insensitive profile uniqueness and room authorization", async () => {
    await profiles.create("one", "ArcadeAce");
    await expect(profiles.create("two", "arcadeace")).rejects.toMatchObject({
      code: "USERNAME_TAKEN",
    });
    await profiles.create("two", "SecondAce");
    const room = await engine.createRoom({
      actorUserId: "one",
      difficulty: "MEDIUM",
      idempotencyKey: key("create"),
    });
    await expect(
      engine.getSnapshot("two", room.snapshot.roomId),
    ).rejects.toMatchObject({
      code: "NOT_A_PARTICIPANT",
    });
    await expect(
      engine.joinRoom({
        actorUserId: "one",
        inviteToken: room.inviteToken,
        idempotencyKey: key("join"),
      }),
    ).rejects.toMatchObject({ code: "HOST_CANNOT_JOIN_OWN_ROOM" });
  });

  it("runs a solo practice without opponents, records, forfeits, or rematches", async () => {
    await players();
    const room = await engine.createRoom({
      actorUserId: "host",
      difficulty: "MEDIUM",
      mode: "PRACTICE",
      idempotencyKey: key("practice-create"),
    });
    const { matchId, roomId } = room.snapshot;
    expect(room.snapshot).toMatchObject({
      mode: "PRACTICE",
      state: "LOBBY",
      problem: null,
    });
    expect(room.snapshot.players).toHaveLength(1);

    await expect(
      engine.joinRoom({
        actorUserId: "opponent",
        inviteToken: room.inviteToken,
        idempotencyKey: key("practice-join"),
      }),
    ).rejects.toMatchObject({ code: "ROOM_NOT_FOUND", status: 404 });

    const firstSession = await engine.connectSession({
      actorUserId: "host",
      roomId,
      matchId,
    });
    await engine.setLanguage({
      actorUserId: "host",
      matchId,
      language: "PYTHON",
      idempotencyKey: key("practice-language"),
    });
    const active = await engine.setReady({
      actorUserId: "host",
      matchId,
      ready: true,
      idempotencyKey: key("practice-ready"),
    });
    expect(active).toMatchObject({
      mode: "PRACTICE",
      state: "ACTIVE",
      problem: { id: "medium-one" },
    });

    await engine.disconnectSession(firstSession.sessionId, "host");
    expect(await engine.processDueDisconnects()).toBe(0);
    expect(await engine.getSnapshotByMatch("host", matchId)).toMatchObject({
      state: "ACTIVE",
      finishedAt: null,
    });
    await engine.connectSession({ actorUserId: "host", roomId, matchId });

    const failedSubmission = await engine.startExecution({
      actorUserId: "host",
      matchId,
      idempotencyKey: key("practice-submit"),
      kind: "SUBMIT",
      source: "wrong",
    });
    const failed = await engine.completeExecution(failedSubmission.id, wrong);
    expect(failed).toMatchObject({
      matchState: "ACTIVE",
      winnerUserId: null,
    });
    expect(failed.cooldownUntil).not.toBeNull();
    await harness.sql`
      UPDATE match_participants
      SET cooldown_until = clock_timestamp() - interval '1 second'
      WHERE match_id = ${matchId} AND clerk_user_id = 'host'
    `;

    const acceptedSubmission = await engine.startExecution({
      actorUserId: "host",
      matchId,
      idempotencyKey: key("practice-submit"),
      kind: "SUBMIT",
      source: "accepted",
    });
    const completed = await engine.completeExecution(
      acceptedSubmission.id,
      accepted(3),
    );
    expect(completed).toMatchObject({
      matchState: "FINISHED",
      winnerUserId: "host",
    });
    const final = await engine.getSnapshotByMatch("host", matchId);
    expect(final).toMatchObject({
      mode: "PRACTICE",
      state: "FINISHED",
      endReason: "ACCEPTED",
      rematchDeadline: null,
      winnerUsername: "Host_Player",
    });
    expect(final.players[0]?.outcome).toBe("WIN");

    const [record] = await harness.sql<{ wins: number; losses: number }[]>`
      SELECT wins, losses FROM player_records WHERE clerk_user_id = 'host'
    `;
    expect(record).toEqual({ wins: 0, losses: 0 });
    expect(await history.recent("host")).toEqual([]);
    await expect(
      engine.requestRematch({
        actorUserId: "host",
        matchId,
        idempotencyKey: key("practice-rematch"),
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it(
    "avoids the room-to-match deadlock when join and realtime connect overlap",
    { timeout: 15_000 },
    async () => {
      await players();
      const room = await engine.createRoom({
        actorUserId: "host",
        difficulty: "EASY",
        idempotencyKey: key("create"),
      });
      const { matchId, roomId } = room.snapshot;
      const blocker = await harness.sql.reserve();
      let blockerOpen = false;
      let pendingConnect: ReturnType<MatchEngine["connectSession"]> | undefined;
      let pendingJoin: ReturnType<MatchEngine["joinRoom"]> | undefined;
      try {
        await blocker`BEGIN`;
        blockerOpen = true;
        await blocker`
          SELECT clerk_user_id
          FROM match_participants
          WHERE match_id = ${matchId} AND clerk_user_id = 'host'
          FOR UPDATE
        `;

        pendingConnect = engine.connectSession({
          actorUserId: "host",
          roomId,
          matchId,
        });
        await waitForRowLock(
          () => harness.sql`
          SELECT id FROM matches
          WHERE id = ${matchId}
          FOR NO KEY UPDATE NOWAIT
        `,
        );

        pendingJoin = engine.joinRoom({
          actorUserId: "opponent",
          inviteToken: room.inviteToken,
          idempotencyKey: key("join"),
        });
        await waitForRowLock(
          () => harness.sql`
          SELECT id FROM rooms
          WHERE id = ${roomId}
          FOR NO KEY UPDATE NOWAIT
        `,
        );

        await blocker`ROLLBACK`;
        blockerOpen = false;
        await Promise.all([pendingConnect, pendingJoin]);

        const [stored] = await harness.sql<
          { members: number; host_sessions: number }[]
        >`
          SELECT
            (SELECT count(*)::int FROM room_members WHERE room_id = ${roomId}) AS members,
            (SELECT count(*)::int FROM realtime_sessions
             WHERE match_id = ${matchId} AND clerk_user_id = 'host') AS host_sessions
        `;
        expect(stored).toEqual({ members: 2, host_sessions: 1 });
      } finally {
        if (blockerOpen) await blocker`ROLLBACK`;
        blocker.release();
        await Promise.allSettled(
          [pendingConnect, pendingJoin].filter(
            (pending) => pending !== undefined,
          ),
        );
      }
    },
  );

  it(
    "avoids the profile-to-match deadlock when ticket issue and connect overlap",
    { timeout: 15_000 },
    async () => {
      await players();
      const room = await engine.createRoom({
        actorUserId: "host",
        difficulty: "EASY",
        idempotencyKey: key("create"),
      });
      const { matchId, roomId } = room.snapshot;
      const tickets = new RealtimeTicketService(
        harness.sql,
        engine,
        "integration realtime secret that is at least thirty two bytes",
      );
      const blocker = await harness.sql.reserve();
      let blockerOpen = false;
      let pendingConnect: ReturnType<MatchEngine["connectSession"]> | undefined;
      let pendingIssue: ReturnType<RealtimeTicketService["issue"]> | undefined;
      try {
        await blocker`BEGIN`;
        blockerOpen = true;
        await blocker`
          SELECT clerk_user_id
          FROM match_participants
          WHERE match_id = ${matchId} AND clerk_user_id = 'host'
          FOR UPDATE
        `;

        pendingConnect = engine.connectSession({
          actorUserId: "host",
          roomId,
          matchId,
        });
        await waitForRowLock(
          () => harness.sql`
          SELECT id FROM matches
          WHERE id = ${matchId}
          FOR NO KEY UPDATE NOWAIT
        `,
        );

        pendingIssue = tickets.issue("host", roomId);
        await waitForRowLock(
          () => harness.sql`
          SELECT clerk_user_id FROM profiles
          WHERE clerk_user_id = 'host'
          FOR NO KEY UPDATE NOWAIT
        `,
        );

        await blocker`ROLLBACK`;
        blockerOpen = false;
        const [, issued] = await Promise.all([pendingConnect, pendingIssue]);
        expect(issued.token).toBeTruthy();

        const [stored] = await harness.sql<
          { host_sessions: number; ticket_issues: number }[]
        >`
          SELECT
            (SELECT count(*)::int FROM realtime_sessions
             WHERE match_id = ${matchId} AND clerk_user_id = 'host') AS host_sessions,
            (SELECT count(*)::int FROM realtime_ticket_issues
             WHERE match_id = ${matchId} AND clerk_user_id = 'host') AS ticket_issues
        `;
        expect(stored).toEqual({ host_sessions: 1, ticket_issues: 1 });
      } finally {
        if (blockerOpen) await blocker`ROLLBACK`;
        blocker.release();
        await Promise.allSettled(
          [pendingConnect, pendingIssue].filter(
            (pending) => pending !== undefined,
          ),
        );
      }
    },
  );

  it("selects and reveals a problem only after both players are ready", async () => {
    await players();
    const room = await engine.createRoom({
      actorUserId: "host",
      difficulty: "HARD",
      idempotencyKey: key("create"),
    });
    await engine.joinRoom({
      actorUserId: "opponent",
      inviteToken: room.inviteToken,
      idempotencyKey: key("join"),
    });
    const matchId = room.snapshot.matchId;
    await engine.connectSession({
      actorUserId: "host",
      roomId: room.snapshot.roomId,
      matchId,
    });
    await engine.connectSession({
      actorUserId: "opponent",
      roomId: room.snapshot.roomId,
      matchId,
    });
    for (const [actorUserId, language] of [
      ["host", "PYTHON"],
      ["opponent", "JAVA"],
    ] as const) {
      await engine.setLanguage({
        actorUserId,
        matchId,
        language,
        idempotencyKey: key("language"),
      });
    }
    await engine.setReady({
      actorUserId: "host",
      matchId,
      ready: true,
      idempotencyKey: key("ready"),
    });
    const lobby = await engine.getSnapshotByMatch("host", matchId);
    expect(lobby.state).toBe("LOBBY");
    expect(lobby.problem).toBeNull();

    const countdown = await engine.setReady({
      actorUserId: "opponent",
      matchId,
      ready: true,
      idempotencyKey: key("ready"),
    });
    expect(countdown.startsAt).not.toBeNull();
    const active = await engine.getSnapshotByMatch("opponent", matchId);
    expect(active.problem).toMatchObject({
      id: "hard-one",
      difficulty: "HARD",
    });
    const events = await engine.eventsSince("host", matchId, 0);
    const countdownEvent = events.find(
      (event) => event.type === "COUNTDOWN_STARTED",
    );
    expect(countdownEvent?.payload).not.toHaveProperty("problem");
  });

  it("requires live persisted presence before ready and countdown selection", async () => {
    await players();
    const room = await engine.createRoom({
      actorUserId: "host",
      difficulty: "EASY",
      idempotencyKey: key("create"),
    });
    await engine.joinRoom({
      actorUserId: "opponent",
      inviteToken: room.inviteToken,
      idempotencyKey: key("join"),
    });
    const matchId = room.snapshot.matchId;
    for (const actorUserId of ["host", "opponent"] as const) {
      await engine.setLanguage({
        actorUserId,
        matchId,
        language: "PYTHON",
        idempotencyKey: key("language"),
      });
    }

    await expect(
      engine.setReady({
        actorUserId: "host",
        matchId,
        ready: true,
        idempotencyKey: key("ready"),
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(
      (await engine.getSnapshotByMatch("host", matchId)).players.find(
        (player) => player.isSelf,
      )?.ready,
    ).toBe(false);

    const hostSession = await engine.connectSession({
      actorUserId: "host",
      roomId: room.snapshot.roomId,
      matchId,
    });
    await engine.setReady({
      actorUserId: "host",
      matchId,
      ready: true,
      idempotencyKey: key("ready"),
    });
    await engine.disconnectSession(hostSession.sessionId, "host");
    await engine.connectSession({
      actorUserId: "opponent",
      roomId: room.snapshot.roomId,
      matchId,
    });

    await expect(
      engine.setReady({
        actorUserId: "opponent",
        matchId,
        ready: true,
        idempotencyKey: key("ready"),
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    const sealed = await engine.getSnapshotByMatch("opponent", matchId);
    expect(sealed).toMatchObject({ state: "LOBBY", problem: null });
    expect(sealed.players.find((player) => player.isSelf)?.ready).toBe(false);

    await engine.connectSession({
      actorUserId: "host",
      roomId: room.snapshot.roomId,
      matchId,
    });
    const active = await engine.setReady({
      actorUserId: "opponent",
      matchId,
      ready: true,
      idempotencyKey: key("ready"),
    });
    expect(active.state).toBe("ACTIVE");
    expect(active.problem?.id).toBe("easy-one");
  });

  it("rejects cancellation and forfeit after countdown seals the problem", async () => {
    const countdownEngine = new MatchEngine(harness.sql, catalog, {
      countdownMs: 60_000,
      reconnectGraceSeconds: 60,
      inviteSecret:
        "countdown invite secret that contains more than thirty two bytes",
      chooseIndex: () => 0,
    });
    await players();
    const room = await countdownEngine.createRoom({
      actorUserId: "host",
      difficulty: "MEDIUM",
      idempotencyKey: key("create"),
    });
    await countdownEngine.joinRoom({
      actorUserId: "opponent",
      inviteToken: room.inviteToken,
      idempotencyKey: key("join"),
    });
    const matchId = room.snapshot.matchId;
    await countdownEngine.connectSession({
      actorUserId: "host",
      roomId: room.snapshot.roomId,
      matchId,
    });
    const opponentSession = await countdownEngine.connectSession({
      actorUserId: "opponent",
      roomId: room.snapshot.roomId,
      matchId,
    });
    for (const actorUserId of ["host", "opponent"] as const) {
      await countdownEngine.setLanguage({
        actorUserId,
        matchId,
        language: "JAVA",
        idempotencyKey: key("language"),
      });
    }
    await expect(
      countdownEngine.forfeitMatch({
        actorUserId: "opponent",
        matchId,
        idempotencyKey: key("forfeit"),
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    await countdownEngine.setReady({
      actorUserId: "host",
      matchId,
      ready: true,
      idempotencyKey: key("ready"),
    });
    const countdown = await countdownEngine.setReady({
      actorUserId: "opponent",
      matchId,
      ready: true,
      idempotencyKey: key("ready"),
    });
    expect(countdown).toMatchObject({ state: "COUNTDOWN", problem: null });
    const [stored] = await harness.sql<
      { problem_id: string; finished_at: string | null }[]
    >`
      SELECT problem_id, finished_at::text
      FROM matches WHERE id = ${matchId}
    `;
    expect(stored).toMatchObject({
      problem_id: "medium-one",
      finished_at: null,
    });

    await expect(
      countdownEngine.cancelMatch({
        actorUserId: "host",
        matchId,
        idempotencyKey: key("cancel"),
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(
      countdownEngine.forfeitMatch({
        actorUserId: "opponent",
        matchId,
        idempotencyKey: key("forfeit"),
      }),
    ).rejects.toMatchObject({ code: "INVALID_STATE" });
    expect(
      await countdownEngine.getSnapshotByMatch("host", matchId),
    ).toMatchObject({
      state: "COUNTDOWN",
      problem: null,
      finishedAt: null,
    });

    await countdownEngine.disconnectSession(
      opponentSession.sessionId,
      "opponent",
    );
    await harness.sql`
      UPDATE matches SET starts_at = clock_timestamp() WHERE id = ${matchId}
    `;
    expect(await countdownEngine.advanceCountdown(matchId)).toBe(true);
    const [disconnected] = await harness.sql<
      { grace_seconds: number; reconnect_deadline: string | null }[]
    >`
      SELECT EXTRACT(EPOCH FROM (reconnect_deadline - disconnected_at))::float8
               AS grace_seconds,
             reconnect_deadline::text
      FROM match_participants
      WHERE match_id = ${matchId} AND clerk_user_id = 'opponent'
    `;
    expect(disconnected?.reconnect_deadline).not.toBeNull();
    expect(disconnected?.grace_seconds).toBeCloseTo(60, 1);
  });

  it("uses receipt order rather than callback order and finalizes exactly once", async () => {
    const { matchId } = await activeMatch();
    const host = await engine.startExecution({
      actorUserId: "host",
      matchId,
      idempotencyKey: key("submit"),
      kind: "SUBMIT",
      source: "host source",
    });
    const opponent = await engine.startExecution({
      actorUserId: "opponent",
      matchId,
      idempotencyKey: key("submit"),
      kind: "SUBMIT",
      source: "opponent source",
    });
    await harness.sql`
      UPDATE executions
      SET received_at = CASE WHEN id = ${host.id}
        THEN '2026-01-01T00:00:00.000000Z'::timestamptz
        ELSE '2026-01-01T00:00:00.001000Z'::timestamptz END
      WHERE id IN (${host.id}, ${opponent.id})
    `;
    const laterCallback = await engine.completeExecution(
      opponent.id,
      accepted(1),
    );
    expect(laterCallback.matchState).toBe("ACTIVE");
    const firstCallback = await engine.completeExecution(host.id, accepted(20));
    expect(firstCallback.winnerUserId).toBe("host");

    const duplicate = await engine.completeExecution(host.id, accepted(20));
    expect(duplicate.duplicate).toBe(true);
    const records = await harness.sql<
      { clerk_user_id: string; wins: number; losses: number }[]
    >`
      SELECT clerk_user_id, wins, losses FROM player_records ORDER BY clerk_user_id
    `;
    expect(
      records.find((record) => record.clerk_user_id === "host"),
    ).toMatchObject({ wins: 1, losses: 0 });
    expect(
      records.find((record) => record.clerk_user_id === "opponent"),
    ).toMatchObject({
      wins: 0,
      losses: 1,
    });
  });

  it("persists a later callback without mutating gameplay after an earlier winner", async () => {
    const { matchId } = await activeMatch();
    const host = await engine.startExecution({
      actorUserId: "host",
      matchId,
      idempotencyKey: key("submit"),
      kind: "SUBMIT",
      source: "earlier",
    });
    const opponent = await engine.startExecution({
      actorUserId: "opponent",
      matchId,
      idempotencyKey: key("submit"),
      kind: "SUBMIT",
      source: "later",
    });
    await harness.sql`
      UPDATE executions
      SET received_at = CASE WHEN id = ${host.id}
        THEN '2026-01-01T00:00:00.000000Z'::timestamptz
        ELSE '2026-01-01T00:00:00.001000Z'::timestamptz END
      WHERE id IN (${host.id}, ${opponent.id})
    `;
    const winner = await engine.completeExecution(host.id, accepted(4));
    expect(winner.winnerUserId).toBe("host");
    const [beforeMatch] = await harness.sql<{ version: string }[]>`
      SELECT version::text FROM matches WHERE id = ${matchId}
    `;
    const [beforeParticipant] = await harness.sql<
      {
        active_execution_id: string | null;
        activity: string;
        best_passed_count: number;
        hidden_test_count: number | null;
        cooldown_until: string | null;
        outcome: string | null;
      }[]
    >`
      SELECT active_execution_id, activity, best_passed_count, hidden_test_count,
             cooldown_until::text, outcome
      FROM match_participants
      WHERE match_id = ${matchId} AND clerk_user_id = 'opponent'
    `;
    expect(beforeParticipant).toMatchObject({
      active_execution_id: null,
      activity: "THINKING",
      outcome: "LOSS",
    });
    const [winnerParticipant] = await harness.sql<
      {
        active_execution_id: string | null;
        activity: string;
        outcome: string;
      }[]
    >`
      SELECT active_execution_id, activity, outcome
      FROM match_participants
      WHERE match_id = ${matchId} AND clerk_user_id = 'host'
    `;
    expect(winnerParticipant).toEqual({
      active_execution_id: null,
      activity: "ACCEPTED",
      outcome: "WIN",
    });

    const late = await engine.completeExecution(opponent.id, accepted(1));
    expect(late).toMatchObject({
      verdict: "ACCEPTED",
      winnerUserId: "host",
      matchState: "REMATCH_PENDING",
      cooldownUntil: null,
    });
    const [stored] = await harness.sql<
      {
        status: string;
        verdict: string;
        passed_count: number;
        total_count: number;
      }[]
    >`
      SELECT status, verdict, passed_count, total_count
      FROM executions WHERE id = ${opponent.id}
    `;
    expect(stored).toMatchObject({
      status: "COMPLETED",
      verdict: "ACCEPTED",
      passed_count: 12,
      total_count: 12,
    });
    const [afterMatch] = await harness.sql<{ version: string }[]>`
      SELECT version::text FROM matches WHERE id = ${matchId}
    `;
    const [afterParticipant] = await harness.sql<(typeof beforeParticipant)[]>`
      SELECT active_execution_id, activity, best_passed_count, hidden_test_count,
             cooldown_until::text, outcome
      FROM match_participants
      WHERE match_id = ${matchId} AND clerk_user_id = 'opponent'
    `;
    expect(afterMatch?.version).toBe(beforeMatch?.version);
    expect(afterParticipant).toEqual(beforeParticipant);
  });

  it("captures receipt time and sequence before waiting on the match lock", async () => {
    const { matchId } = await activeMatch();
    const blocker = await harness.sql.reserve();
    let transactionOpen = false;
    try {
      await blocker`BEGIN`;
      transactionOpen = true;
      await blocker`SELECT id FROM matches WHERE id = ${matchId} FOR UPDATE`;
      const pending = engine.startExecution({
        actorUserId: "host",
        matchId,
        idempotencyKey: key("run"),
        kind: "RUN",
        source: "sample",
      });
      let ingressObserved = false;
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const [sequenceState] = await harness.sql<{ is_called: boolean }[]>`
          SELECT is_called FROM execution_server_sequence
        `;
        if (sequenceState?.is_called) {
          ingressObserved = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const [nextSequence] = await harness.sql<{ value: string }[]>`
        SELECT nextval('execution_server_sequence')::text AS value
      `;
      const [release] = await blocker<{ released_at: string }[]>`
        SELECT clock_timestamp()::text AS released_at
      `;
      await blocker`COMMIT`;
      transactionOpen = false;
      const execution = await pending;
      expect(ingressObserved).toBe(true);
      expect(Date.parse(execution.receivedAt)).toBeLessThan(
        Date.parse(release!.released_at),
      );
      expect(execution.sequence).toBeLessThan(Number(nextSequence!.value));
    } finally {
      if (transactionOpen) await blocker`ROLLBACK`;
      blocker.release();
    }
  });

  it("uses runtime then sequence when receive timestamps tie", async () => {
    const { matchId } = await activeMatch();
    const host = await engine.startExecution({
      actorUserId: "host",
      matchId,
      idempotencyKey: key("submit"),
      kind: "SUBMIT",
      source: "a",
    });
    const opponent = await engine.startExecution({
      actorUserId: "opponent",
      matchId,
      idempotencyKey: key("submit"),
      kind: "SUBMIT",
      source: "b",
    });
    await harness.sql`
      UPDATE executions SET received_at = '2026-01-01T00:00:00Z'::timestamptz
      WHERE id IN (${host.id}, ${opponent.id})
    `;
    await engine.completeExecution(host.id, accepted(20));
    const final = await engine.completeExecution(opponent.id, accepted(2));
    expect(final.winnerUserId).toBe("opponent");
  });

  it("enforces sample rate, hidden-only HUD progress, cooldown, and infra exemption", async () => {
    const { matchId } = await activeMatch();
    const run = await engine.startExecution({
      actorUserId: "host",
      matchId,
      idempotencyKey: key("run"),
      kind: "RUN",
      source: "sample",
    });
    await engine.completeExecution(run.id, {
      verdict: "ACCEPTED",
      passedCount: 3,
      totalCount: 3,
      runtimeMs: 1,
      compileMs: 1,
    });
    const snapshot = await engine.getSnapshotByMatch("opponent", matchId);
    expect(
      snapshot.players.find((player) => player.slot === 1)?.bestPassedCount,
    ).toBe(0);
    const publicEvents = await engine.eventsSince("opponent", matchId, 0);
    const runCompleted = publicEvents.find(
      (event) =>
        event.type === "EXECUTION_COMPLETED" && event.payload.kind === "RUN",
    );
    expect(runCompleted?.payload).toEqual({
      slot: 1,
      kind: "RUN",
      activity: "THINKING",
    });
    await expect(
      engine.startExecution({
        actorUserId: "host",
        matchId,
        idempotencyKey: key("run"),
        kind: "RUN",
        source: "again",
      }),
    ).rejects.toMatchObject({ code: "RATE_LIMITED" });

    const submit = await engine.startExecution({
      actorUserId: "host",
      matchId,
      idempotencyKey: key("submit"),
      kind: "SUBMIT",
      source: "wrong",
    });
    const failed = await engine.completeExecution(submit.id, wrong);
    expect(failed.cooldownUntil).not.toBeNull();
    await expect(
      engine.startExecution({
        actorUserId: "host",
        matchId,
        idempotencyKey: key("submit"),
        kind: "SUBMIT",
        source: "retry",
      }),
    ).rejects.toMatchObject({ code: "COOLDOWN_ACTIVE" });

    const opponentSubmit = await engine.startExecution({
      actorUserId: "opponent",
      matchId,
      idempotencyKey: key("submit"),
      kind: "SUBMIT",
      source: "infra",
    });
    const infrastructure = await engine.completeExecution(
      opponentSubmit.id,
      infra,
    );
    expect(infrastructure.cooldownUntil).toBeNull();
    await expect(
      engine.startExecution({
        actorUserId: "opponent",
        matchId,
        idempotencyKey: key("submit"),
        kind: "SUBMIT",
        source: "safe retry",
      }),
    ).resolves.toMatchObject({ created: true });
  });

  it("preserves a disconnected player's in-flight acceptance before forfeit", async () => {
    const { matchId, hostSession } = await activeMatch();
    const submission = await engine.startExecution({
      actorUserId: "host",
      matchId,
      idempotencyKey: key("submit"),
      kind: "SUBMIT",
      source: "winning",
    });
    await engine.disconnectSession(hostSession.sessionId, "host");
    expect(await engine.processDueDisconnects()).toBe(0);
    const completion = await engine.completeExecution(
      submission.id,
      accepted(2),
    );
    expect(completion.winnerUserId).toBe("host");
  });

  it("keeps presence live while a replacement socket overlaps an older session", async () => {
    const { matchId, roomId, hostSession } = await activeMatch();
    const before = await engine.getSnapshotByMatch("host", matchId);
    const replacement = await engine.connectSession({
      actorUserId: "host",
      roomId,
      matchId,
    });

    await engine.disconnectSession(hostSession.sessionId, "host");
    const duringHandoff = await engine.getSnapshotByMatch("host", matchId);
    expect(
      duringHandoff.players.find((player) => player.isSelf)?.connected,
    ).toBe(true);
    const handoffEvents = await engine.eventsSince(
      "host",
      matchId,
      before.version,
    );
    expect(
      handoffEvents.some(
        (event) =>
          event.type === "CONNECTION_CHANGED" &&
          event.payload.connected === false,
      ),
    ).toBe(false);

    await engine.disconnectSession(replacement.sessionId, "host");
    const disconnected = await engine.getSnapshotByMatch("host", matchId);
    expect(
      disconnected.players.find((player) => player.isSelf)?.connected,
    ).toBe(false);
  });

  it("records double disconnect as no-contest without changing records", async () => {
    const { matchId, hostSession, opponentSession } = await activeMatch();
    await engine.disconnectSession(hostSession.sessionId, "host");
    await engine.disconnectSession(opponentSession.sessionId, "opponent");
    expect(await engine.processDueDisconnects()).toBe(1);
    const snapshot = await engine.getSnapshotByMatch("host", matchId);
    expect(snapshot.endReason).toBe("NO_CONTEST");
    const records = await harness.sql<{ wins: number; losses: number }[]>`
      SELECT wins, losses FROM player_records WHERE clerk_user_id IN ('host', 'opponent')
    `;
    expect(records).toEqual([
      { wins: 0, losses: 0 },
      { wins: 0, losses: 0 },
    ]);
  });

  it("bases stale-session grace on the persisted last heartbeat", async () => {
    const { matchId, hostSession } = await activeMatch();
    const timingEngine = new MatchEngine(harness.sql, catalog, {
      countdownMs: 0,
      reconnectGraceSeconds: 60,
      inviteSecret:
        "stale timing invite secret that contains more than thirty two bytes",
      chooseIndex: () => 0,
    });
    await harness.sql`
      UPDATE realtime_sessions
      SET last_seen_at = clock_timestamp() - interval '50 seconds'
      WHERE id = ${hostSession.sessionId}
    `;
    expect(await timingEngine.expireStaleSessions()).toBe(1);
    const [timing] = await harness.sql<
      {
        disconnect_offset_seconds: number;
        grace_seconds: number;
        remaining_seconds: number;
      }[]
    >`
      SELECT
        EXTRACT(EPOCH FROM (rs.disconnected_at - rs.last_seen_at))::float8
          AS disconnect_offset_seconds,
        EXTRACT(EPOCH FROM (mp.reconnect_deadline - rs.last_seen_at))::float8
          AS grace_seconds,
        EXTRACT(EPOCH FROM (mp.reconnect_deadline - clock_timestamp()))::float8
          AS remaining_seconds
      FROM realtime_sessions rs
      JOIN match_participants mp
        ON mp.match_id = rs.match_id AND mp.clerk_user_id = rs.clerk_user_id
      WHERE rs.id = ${hostSession.sessionId} AND rs.match_id = ${matchId}
    `;
    expect(timing?.disconnect_offset_seconds).toBeCloseTo(0, 3);
    expect(timing?.grace_seconds).toBeCloseTo(60, 1);
    expect(timing?.remaining_seconds).toBeGreaterThan(0);
    expect(timing?.remaining_seconds).toBeLessThan(20);

    expect(await timingEngine.touchSession(hostSession.sessionId, "host")).toBe(
      false,
    );
    const reactivated = await timingEngine.connectSession({
      actorUserId: "host",
      roomId: (await timingEngine.getSnapshotByMatch("host", matchId)).roomId,
      matchId,
      sessionId: hostSession.sessionId,
    });
    expect(reactivated.sessionId).toBe(hostSession.sessionId);
    expect(await timingEngine.touchSession(hostSession.sessionId, "host")).toBe(
      true,
    );

    await timingEngine.disconnectSession(hostSession.sessionId, "host");
    await harness.sql`
      UPDATE realtime_sessions
      SET disconnected_at = clock_timestamp() - interval '2 minutes'
      WHERE id = ${hostSession.sessionId}
    `;
    expect(await timingEngine.purgeOldRealtimeSessions(60)).toBe(1);
  });

  it("keeps room alarm maintenance scoped to its match", async () => {
    const { matchId } = await activeMatch();
    await profiles.create("fourth", "Fourth_Player");
    const otherRoom = await engine.createRoom({
      actorUserId: "outsider",
      difficulty: "MEDIUM",
      idempotencyKey: key("other-create"),
    });
    await engine.joinRoom({
      actorUserId: "fourth",
      inviteToken: otherRoom.inviteToken,
      idempotencyKey: key("other-join"),
    });
    const otherSession = await engine.connectSession({
      actorUserId: "outsider",
      roomId: otherRoom.snapshot.roomId,
      matchId: otherRoom.snapshot.matchId,
    });
    await harness.sql`
      UPDATE realtime_sessions
      SET last_seen_at = clock_timestamp() - interval '50 seconds'
    `;

    expect(await engine.expireStaleSessionsForMatch(matchId)).toBe(2);
    const [unrelated] = await harness.sql<{ disconnected: boolean }[]>`
      SELECT disconnected_at IS NOT NULL AS disconnected
      FROM realtime_sessions
      WHERE id = ${otherSession.sessionId}
    `;
    expect(unrelated?.disconnected).toBe(false);
  });

  it("creates exactly one fresh-language rematch and persists safe history", async () => {
    const { matchId } = await activeMatch();
    const submission = await engine.startExecution({
      actorUserId: "host",
      matchId,
      idempotencyKey: key("submit"),
      kind: "SUBMIT",
      source: "never stored raw",
    });
    await engine.completeExecution(submission.id, accepted(2));
    await engine.requestRematch({
      actorUserId: "host",
      matchId,
      idempotencyKey: "host-rematch",
    });
    const rematch = await engine.requestRematch({
      actorUserId: "opponent",
      matchId,
      idempotencyKey: "opponent-rematch",
    });
    expect(rematch.matchId).not.toBe(matchId);
    expect(rematch.problem).toBeNull();
    expect(
      rematch.players.every(
        (player) => player.language === null && !player.ready,
      ),
    ).toBe(true);
    const duplicate = await engine.requestRematch({
      actorUserId: "opponent",
      matchId,
      idempotencyKey: "opponent-rematch",
    });
    expect(duplicate.matchId).toBe(rematch.matchId);
    const rounds = await harness.sql<{ count: number }[]>`
      SELECT count(*)::int AS count FROM matches
    `;
    expect(rounds[0]?.count).toBe(2);

    const entries = await history.recent("host");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ outcome: "WIN", endReason: "ACCEPTED" });
    const stored = await harness.sql<{ source_hash: string }[]>`
      SELECT source_hash FROM executions WHERE id = ${submission.id}
    `;
    expect(stored[0]?.source_hash).toHaveLength(64);
    const rawLeak = await harness.sql<{ leaked: boolean }[]>`
      SELECT EXISTS (
        SELECT 1 FROM executions WHERE result_summary::text LIKE '%never stored raw%'
      ) AS leaked
    `;
    expect(rawLeak[0]?.leaked).toBe(false);
  });

  it("issues membership-bound one-use realtime tickets", async () => {
    const { roomId } = await activeMatch();
    const tickets = new RealtimeTicketService(
      harness.sql,
      engine,
      "ticket signing secret with more than thirty two bytes",
    );
    const issued = await tickets.issue("host", roomId);
    const claims = await tickets.verifyAndConsume(issued.token);
    expect(claims).toMatchObject({ userId: "host", roomId, slot: 1 });
    await expect(tickets.verifyAndConsume(issued.token)).rejects.toMatchObject({
      code: "TICKET_REPLAYED",
    });

    const outstanding = await Promise.all([
      tickets.issue("host", roomId),
      tickets.issue("host", roomId),
      tickets.issue("host", roomId),
    ]);
    await expect(tickets.issue("host", roomId)).rejects.toMatchObject({
      code: "RATE_LIMITED",
      status: 429,
    });
    await tickets.verifyAndConsume(outstanding[0]!.token);
    await expect(tickets.issue("host", roomId)).resolves.toMatchObject({
      token: expect.any(String),
    });
  });
});

// Guard against accidentally changing the expected skip contract.
if (!databaseUrl) {
  describe("PostgreSQL integration prerequisites", () => {
    it("skips database integration only when DATABASE_URL is absent", () => {
      expect(databaseUrl).toBeUndefined();
      expect(DomainError).toBeDefined();
    });
  });
}
