import { describe, expect, it, vi } from "vitest";

import type { Database } from "../../src/server/db/client";
import type { MatchSnapshot } from "../../src/server/domain/types";
import type { MatchEngine } from "../../src/server/match/match-engine";
import { presentRoomSnapshot } from "../../src/server/presentation";

function snapshot(matchId: string, version: number): MatchSnapshot {
  return {
    roomId: "room-1",
    matchId,
    mode: "DUEL",
    roundNumber: matchId === "match-1" ? 1 : 2,
    difficulty: "EASY",
    state: "LOBBY",
    version,
    serverTimestamp: "2026-01-01T00:00:00Z",
    startsAt: null,
    finishedAt: null,
    rematchDeadline: null,
    endReason: null,
    winnerUsername: null,
    problem: null,
    players: [
      {
        username: "Host",
        slot: 1,
        isSelf: true,
        language: null,
        ready: false,
        connected: true,
        activity: "THINKING",
        bestPassedCount: 0,
        hiddenTestCount: null,
        cooldownUntil: null,
        outcome: null,
      },
    ],
    rematchVotes: [],
    rematchCreatedMatchId: null,
  };
}

describe("room presentation consistency", () => {
  it("restarts all independent reads when the active match changes", async () => {
    const first = snapshot("match-1", 8);
    const rematch = snapshot("match-2", 1);
    const db = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]) as unknown as Database;
    const matches = {
      eventsSince: vi.fn().mockResolvedValue([]),
      getSnapshot: vi
        .fn()
        .mockResolvedValueOnce(rematch)
        .mockResolvedValueOnce(rematch),
    } as unknown as MatchEngine;

    const presented = await presentRoomSnapshot({
      actorUserId: "host",
      inviteToken: "invite",
      snapshot: first,
      db,
      matches,
      appOrigin: "http://localhost:3000",
    });

    expect(presented).toMatchObject({
      matchId: "match-2",
      roundNumber: 2,
      version: 1,
    });
    expect(matches.eventsSince).toHaveBeenNthCalledWith(
      1,
      "host",
      "match-1",
      0,
      50,
    );
    expect(matches.eventsSince).toHaveBeenNthCalledWith(
      2,
      "host",
      "match-2",
      0,
      50,
    );
    expect(db).toHaveBeenCalledTimes(2);
  });

  it("fails closed after the bounded retry budget", async () => {
    const first = snapshot("match-1", 1);
    let version = 1;
    const db = vi.fn().mockResolvedValue([]) as unknown as Database;
    const matches = {
      eventsSince: vi.fn().mockResolvedValue([]),
      getSnapshot: vi.fn().mockImplementation(async () => {
        version += 1;
        return snapshot("match-1", version);
      }),
    } as unknown as MatchEngine;
    await expect(
      presentRoomSnapshot({
        actorUserId: "host",
        inviteToken: "invite",
        snapshot: first,
        db,
        matches,
        appOrigin: "http://localhost:3000",
      }),
    ).rejects.toThrow(/coherent snapshot/);
    expect(matches.getSnapshot).toHaveBeenCalledTimes(4);
  });

  it("presents cancellation as a distinct result instead of a draw", async () => {
    const cancelled = snapshot("match-1", 4);
    cancelled.state = "FINISHED";
    cancelled.finishedAt = "2026-01-01T00:00:10Z";
    cancelled.endReason = "CANCELLED";
    cancelled.players[0]!.outcome = "CANCELLED";
    const db = vi.fn().mockResolvedValue([]) as unknown as Database;
    const matches = {
      eventsSince: vi.fn().mockResolvedValue([]),
      getSnapshot: vi.fn().mockResolvedValue(cancelled),
    } as unknown as MatchEngine;
    const presented = await presentRoomSnapshot({
      actorUserId: "host",
      inviteToken: "invite",
      snapshot: cancelled,
      db,
      matches,
      appOrigin: "http://localhost:3000",
    });
    expect(presented.result).toMatchObject({
      outcome: "CANCELLED",
      endReason: "CANCELLED",
    });
  });

  it("presents practice as a private solo completion without an invite", async () => {
    const practice = snapshot("match-1", 5);
    practice.mode = "PRACTICE";
    practice.state = "FINISHED";
    practice.startsAt = "2026-01-01T00:00:02Z";
    practice.finishedAt = "2026-01-01T00:00:10Z";
    practice.endReason = "ACCEPTED";
    practice.winnerUsername = "Host";
    practice.players[0]!.language = "PYTHON";
    practice.players[0]!.outcome = "WIN";
    practice.players[0]!.bestPassedCount = 12;
    practice.players[0]!.hiddenTestCount = 12;
    const db = vi.fn().mockResolvedValue([
      {
        kind: "SUBMIT",
        status: "COMPLETED",
        verdict: "ACCEPTED",
        result_summary: {
          verdict: "ACCEPTED",
          passedCount: 12,
          totalCount: 12,
          runtimeMs: 3,
        },
      },
    ]) as unknown as Database;
    const matches = {
      eventsSince: vi.fn().mockResolvedValue([
        {
          matchId: "match-1",
          version: 1,
          type: "MATCH_CREATED",
          payload: { mode: "PRACTICE" },
          serverTimestamp: "2026-01-01T00:00:00Z",
        },
        {
          matchId: "match-1",
          version: 2,
          type: "COUNTDOWN_STARTED",
          payload: { mode: "PRACTICE" },
          serverTimestamp: "2026-01-01T00:00:01Z",
        },
      ]),
      getSnapshot: vi.fn().mockResolvedValue(practice),
    } as unknown as MatchEngine;

    const presented = await presentRoomSnapshot({
      actorUserId: "host",
      inviteToken: "internal-room-token",
      snapshot: practice,
      db,
      matches,
      appOrigin: "http://localhost:3000",
    });

    expect(presented).toMatchObject({
      mode: "PRACTICE",
      opponent: null,
      latestExecution: { kind: "SUBMIT", status: "COMPLETE" },
      result: { outcome: "WIN", endReason: "ACCEPTED", durationMs: 8_000 },
      lastSubmission: {
        verdict: "ACCEPTED",
        message: "Every hidden test passed. Practice complete.",
      },
    });
    expect(presented.inviteUrl).toBeUndefined();
    expect(
      presented.activity.map((event) => event.message).join(" "),
    ).not.toMatch(/rival|both players|rematch/i);
  });

  it("identifies the newest execution so a submit replaces stale sample output", async () => {
    const active = snapshot("match-1", 5);
    active.mode = "PRACTICE";
    active.state = "ACTIVE";
    const db = vi.fn().mockResolvedValue([
      {
        kind: "SUBMIT",
        status: "COMPLETED",
        verdict: "WRONG_ANSWER",
        result_summary: {
          verdict: "WRONG_ANSWER",
          passedCount: 4,
          totalCount: 12,
        },
      },
      {
        kind: "RUN",
        status: "COMPLETED",
        verdict: "ACCEPTED",
        result_summary: {
          details: {
            samples: [{ id: "sample-1", status: "PASSED", runtimeMs: 1 }],
          },
        },
      },
    ]) as unknown as Database;
    const matches = {
      eventsSince: vi.fn().mockResolvedValue([]),
      getSnapshot: vi.fn().mockResolvedValue(active),
    } as unknown as MatchEngine;

    const presented = await presentRoomSnapshot({
      actorUserId: "host",
      inviteToken: "internal-room-token",
      snapshot: active,
      db,
      matches,
      appOrigin: "http://localhost:3000",
    });

    expect(presented.latestExecution).toEqual({
      kind: "SUBMIT",
      status: "COMPLETE",
    });
    expect(presented.lastSubmission?.verdict).toBe("WRONG_ANSWER");
    expect(presented.sampleRun?.results).toHaveLength(1);
  });
});
