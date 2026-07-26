import type {
  JudgeCase,
  ServerProblem,
} from "../../src/problems/server/types.server";
import type { SupportedLanguage } from "../../src/problems/types";

export type ExecutionMode = "samples" | "submit";
export type RunnerVerdict =
  | "accepted"
  | "wrong_answer"
  | "compile_error"
  | "runtime_error"
  | "time_limit"
  | "memory_limit"
  | "output_limit"
  | "source_limit"
  | "infrastructure_error";

export interface RunnerHttpRequest {
  readonly executionId: string;
  readonly problemId: string;
  readonly problemVersion: number;
  readonly language: SupportedLanguage | "PYTHON" | "JAVA";
  readonly mode: ExecutionMode;
  readonly source: string;
}

export interface SampleResult {
  readonly id: string;
  readonly status: "PASSED" | "FAILED" | "ERROR";
  readonly runtimeMs?: number;
  /** Present only for public samples and capped before serialization. */
  readonly actual?: string;
  readonly message?: string;
}

export interface RunnerResult {
  readonly executionId: string;
  readonly status: "completed" | "infrastructure_error";
  readonly verdict: RunnerVerdict;
  readonly passed: number;
  readonly total: number;
  readonly runtimeMs: number;
  readonly compileMs?: number;
  readonly message: string;
  /** Deliberately omitted for submit mode. */
  readonly samples?: readonly SampleResult[];
}

export interface AdapterExecutionRequest {
  readonly executionId: string;
  readonly language: SupportedLanguage;
  readonly mode: ExecutionMode;
  readonly source: string;
  readonly problem: ServerProblem;
  readonly cases: readonly JudgeCase[];
}

export interface RunnerAdapter {
  execute(request: AdapterExecutionRequest): Promise<RunnerResult>;
}

export interface HarnessReadyMessage {
  readonly kind: "ready";
  readonly compileMs: number;
}

export interface HarnessCaseMessage {
  readonly kind: "case";
  readonly status: "ok" | "runtime_error" | "memory_limit" | "output_limit";
  readonly actual?: unknown;
  readonly runtimeMs: number;
}

export type HarnessMessage =
  | HarnessReadyMessage
  | HarnessCaseMessage
  | {
      readonly kind: "compile_error";
      readonly compileMs: number;
    };
