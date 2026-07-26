export type ExecutionIntegrityVerdict =
  "runtime_error" | "infrastructure_error";

export interface ExecutionIntegrity {
  readonly executionSucceeded: boolean;
  readonly exitCode: number;
  readonly completedCases: number;
  readonly expectedCases: number;
}

/**
 * A valid final supervisor packet proves the trusted outer command ran.
 * Once it reports `ok`, an early clean exit is user-controlled incomplete
 * execution, while a failure of the outer command itself remains an
 * infrastructure failure.
 */
export function executionIntegrityVerdict({
  executionSucceeded,
  exitCode,
  completedCases,
  expectedCases,
}: ExecutionIntegrity): ExecutionIntegrityVerdict | undefined {
  if (!executionSucceeded || exitCode !== 0) return "infrastructure_error";
  if (completedCases !== expectedCases) return "runtime_error";
  return undefined;
}
