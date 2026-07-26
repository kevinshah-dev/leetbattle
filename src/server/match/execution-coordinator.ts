import type { ExecutionKind, RunnerResult } from "@/server/domain/types";

import type { CompletedExecution, MatchEngine } from "./match-engine";
import { infrastructureFailure, type RunnerAdapter } from "./runner-client";

export interface ExecuteCommand {
  actorUserId: string;
  matchId: string;
  idempotencyKey: string;
  kind: ExecutionKind;
  source: string;
}

export interface ExecuteResponse {
  executionId: string;
  pending: boolean;
  result: RunnerResult | null;
  completion: CompletedExecution | null;
}

export class ExecutionCoordinator {
  constructor(
    private readonly engine: MatchEngine,
    private readonly runner: RunnerAdapter,
    private readonly notify: (
      matchId: string,
    ) => Promise<void> = async () => {},
  ) {}

  /**
   * Persists receipt/order before crossing the runner boundary, retries one
   * infrastructure failure, and synchronously persists the callback result.
   */
  async execute(command: ExecuteCommand): Promise<ExecuteResponse> {
    const execution = await this.engine.startExecution(command);
    if (!execution.created) {
      const existing = await this.engine.getExecutionResult(
        command.actorUserId,
        execution.id,
      );
      return {
        executionId: execution.id,
        pending: existing.status !== "COMPLETED",
        result: existing.result,
        completion: null,
      };
    }
    await this.notify(command.matchId);

    let result = infrastructureFailure();
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      await this.engine.markExecutionRunning(execution.id, attempt);
      await this.notify(command.matchId);
      result = await this.runner.execute({
        executionId: execution.id,
        problemId: execution.problemId,
        problemVersion: execution.problemVersion,
        language: execution.language,
        kind: execution.kind,
        source: command.source,
      });
      if (result.verdict !== "INFRA_ERROR") break;
    }
    const completion = await this.engine.completeExecution(
      execution.id,
      result,
    );
    await this.notify(command.matchId);
    return {
      executionId: execution.id,
      pending: false,
      result,
      completion,
    };
  }
}
