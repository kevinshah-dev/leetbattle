import { describe, expect, it } from "vitest";

import { createRunnerHttpHandler } from "../../services/runner/http";
import type { RunnerAdapter } from "../../services/runner/types";
import {
  INTERNAL_SECRET_PLACEHOLDERS,
  requireAllDistinctInternalSecrets,
  requireDistinctInternalSecrets,
  requireInternalSecret,
} from "../../src/server/config/secrets";
import type { Database } from "../../src/server/db/client";
import type { MatchEngine } from "../../src/server/match/match-engine";
import type { RunnerAdapter as ServerRunnerAdapter } from "../../src/server/match/runner-client";
import { RealtimeTicketService } from "../../src/server/realtime/tickets";
import { createServices } from "../../src/server/services";

const unusedDatabase = (() => undefined) as unknown as Database;
const unusedEngine = null as unknown as MatchEngine;
const unusedRunner: RunnerAdapter = {
  execute: async () => {
    throw new Error("not invoked");
  },
};
const injectedRunner: ServerRunnerAdapter = {
  execute: async () => ({
    verdict: "INFRA_ERROR",
    passedCount: 0,
    totalCount: 0,
    runtimeMs: null,
    compileMs: null,
  }),
};
const ticketSecret = `ticket-${"a".repeat(40)}`;
const runnerSecret = `runner-${"b".repeat(40)}`;
const roomSecret = `room-${"c".repeat(40)}`;

describe("internal secret validation", () => {
  it.each(Object.values(INTERNAL_SECRET_PLACEHOLDERS))(
    "rejects published placeholder sentinel %# without echoing it",
    (placeholder) => {
      let error: unknown;
      try {
        requireInternalSecret("RUNNER_INTERNAL_SECRET", placeholder);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(Error);
      expect(String(error)).toMatch(/placeholder/i);
      expect(String(error)).not.toContain(placeholder);
    },
  );

  it("uses byte length and requires pairwise-distinct values", () => {
    expect(() =>
      requireInternalSecret("RUNNER_INTERNAL_SECRET", "é".repeat(16)),
    ).not.toThrow();
    expect(() =>
      requireInternalSecret("RUNNER_INTERNAL_SECRET", "a".repeat(31)),
    ).toThrow(/32 bytes/);
    expect(() =>
      requireDistinctInternalSecrets({
        REALTIME_TICKET_SECRET: ticketSecret,
        RUNNER_INTERNAL_SECRET: ticketSecret,
        ROOM_INVITE_SECRET: roomSecret,
      }),
    ).toThrow(/distinct/);
    expect(
      requireDistinctInternalSecrets({
        REALTIME_TICKET_SECRET: ticketSecret,
        RUNNER_INTERNAL_SECRET: runnerSecret,
        ROOM_INVITE_SECRET: roomSecret,
      }),
    ).toEqual({
      REALTIME_TICKET_SECRET: ticketSecret,
      RUNNER_INTERNAL_SECRET: runnerSecret,
      ROOM_INVITE_SECRET: roomSecret,
    });
  });

  it("keeps the realtime notification trust boundary distinct", () => {
    const notifySecret = `notify-${"d".repeat(40)}`;
    expect(
      requireAllDistinctInternalSecrets({
        REALTIME_TICKET_SECRET: ticketSecret,
        RUNNER_INTERNAL_SECRET: runnerSecret,
        ROOM_INVITE_SECRET: roomSecret,
        REALTIME_NOTIFY_SECRET: notifySecret,
      }),
    ).toEqual({
      REALTIME_TICKET_SECRET: ticketSecret,
      RUNNER_INTERNAL_SECRET: runnerSecret,
      ROOM_INVITE_SECRET: roomSecret,
      REALTIME_NOTIFY_SECRET: notifySecret,
    });
    expect(() =>
      requireAllDistinctInternalSecrets({
        REALTIME_TICKET_SECRET: ticketSecret,
        RUNNER_INTERNAL_SECRET: runnerSecret,
        ROOM_INVITE_SECRET: roomSecret,
        REALTIME_NOTIFY_SECRET: runnerSecret,
      }),
    ).toThrow(/distinct/);
  });

  it("applies placeholder rejection at runner and ticket boundaries", () => {
    expect(() =>
      createRunnerHttpHandler({
        adapter: unusedRunner,
        sharedSecret: INTERNAL_SECRET_PLACEHOLDERS.RUNNER_INTERNAL_SECRET,
      }),
    ).toThrow(/placeholder/);
    expect(
      () =>
        new RealtimeTicketService(
          unusedDatabase,
          unusedEngine,
          INTERNAL_SECRET_PLACEHOLDERS.REALTIME_TICKET_SECRET,
        ),
    ).toThrow(/placeholder/);
  });

  it("preserves injected runner construction without requiring its bearer secret", () => {
    expect(() =>
      createServices({
        db: unusedDatabase,
        runner: injectedRunner,
        realtimeTicketSecret: ticketSecret,
        match: { inviteSecret: roomSecret },
      }),
    ).not.toThrow();
    expect(() =>
      createServices({
        db: unusedDatabase,
        runner: injectedRunner,
        realtimeTicketSecret: roomSecret,
        match: { inviteSecret: roomSecret },
      }),
    ).toThrow(/distinct/);
  });
});
