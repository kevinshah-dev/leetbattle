import { describe, expect, it, vi } from "vitest";

import type { Database } from "../../src/server/db/client";
import type { MatchSnapshot } from "../../src/server/domain/types";
import type { MatchEngine } from "../../src/server/match/match-engine";
import { presentRoomSnapshot } from "../../src/server/presentation";

function snapshot(matchId: string, version: number): MatchSnapshot {
  return {
    roomId: "room-1",
    matchId,
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
});
