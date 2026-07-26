import { describe, expect, it, vi } from "vitest";

import { ExecutionCoordinator } from "../../src/server/match/execution-coordinator";
import type { MatchEngine } from "../../src/server/match/match-engine";
import type { RunnerAdapter } from "../../src/server/match/runner-client";

const command = {
  actorUserId: "user-1",
  matchId: "match-1",
  idempotencyKey: "command-1",
  kind: "SUBMIT" as const,
  source: "source",
};

const execution = {
  id: "execution-1",
  matchId: "match-1",
  actorUserId: "user-1",
  kind: "SUBMIT" as const,
  language: "PYTHON" as const,
  problemId: "problem-1",
  problemVersion: 1,
  receivedAt: "2026-01-01T00:00:00Z",
  sequence: 1,
  created: true,
};

const accepted = {
  verdict: "ACCEPTED" as const,
  passedCount: 12,
  totalCount: 12,
  runtimeMs: 2,
  compileMs: 1,
};

describe("execution coordinator", () => {
  it("retries exactly one infrastructure failure and persists one terminal callback", async () => {
    const fakeEngine = {
      startExecution: vi.fn().mockResolvedValue(execution),
      markExecutionRunning: vi.fn().mockResolvedValue(undefined),
      completeExecution: vi.fn().mockResolvedValue({
        executionId: execution.id,
        verdict: "ACCEPTED",
        cooldownUntil: null,
        winnerUserId: "user-1",
        matchState: "REMATCH_PENDING",
        duplicate: false,
      }),
    } as unknown as MatchEngine;
    const runner: RunnerAdapter = {
      execute: vi
        .fn()
        .mockResolvedValueOnce({
          verdict: "INFRA_ERROR",
          passedCount: 0,
          totalCount: 0,
          runtimeMs: null,
          compileMs: null,
        })
        .mockResolvedValueOnce(accepted),
    };
    const coordinator = new ExecutionCoordinator(fakeEngine, runner);
    const response = await coordinator.execute(command);
    expect(runner.execute).toHaveBeenCalledTimes(2);
    expect(fakeEngine.markExecutionRunning).toHaveBeenNthCalledWith(
      1,
      execution.id,
      1,
    );
    expect(fakeEngine.markExecutionRunning).toHaveBeenNthCalledWith(
      2,
      execution.id,
      2,
    );
    expect(fakeEngine.completeExecution).toHaveBeenCalledOnce();
    expect(fakeEngine.completeExecution).toHaveBeenCalledWith(
      execution.id,
      accepted,
    );
    expect(response.pending).toBe(false);
  });

  it("never dispatches a duplicate execution to the runner", async () => {
    const fakeEngine = {
      startExecution: vi
        .fn()
        .mockResolvedValue({ ...execution, created: false }),
      getExecutionResult: vi
        .fn()
        .mockResolvedValue({ status: "RUNNING", result: null }),
    } as unknown as MatchEngine;
    const runner: RunnerAdapter = { execute: vi.fn() };
    const coordinator = new ExecutionCoordinator(fakeEngine, runner);
    const response = await coordinator.execute(command);
    expect(runner.execute).not.toHaveBeenCalled();
    expect(response).toMatchObject({
      executionId: execution.id,
      pending: true,
      result: null,
    });
  });
});
