import {
  ContainerProxy,
  Sandbox,
  getSandbox,
  type ExecResult,
} from "@cloudflare/sandbox";

import { compareJudgeOutput } from "../../../src/problems/server/compare.server";
import { generateJavaHarness } from "../../../services/runner/harness/java";
import { generatePythonHarness } from "../../../services/runner/harness/python";
import type {
  AdapterExecutionRequest,
  HarnessMessage,
  RunnerAdapter,
  RunnerResult,
  RunnerVerdict,
  SampleResult,
} from "../../../services/runner/types";
import { executionIntegrityVerdict } from "./execution-integrity";

export { ContainerProxy };

export class JudgeSandbox extends Sandbox {
  override enableInternet = false;
}

const WORKSPACE = "/workspace/leetbattle";
const TRUSTED_COMMAND = "/opt/leetbattle/run-judge";
const HARNESS_MARKER = "__LEETBATTLE_PROTOCOL__";
const SUPERVISOR_MARKER = "__LEETBATTLE_SUPERVISOR__";
const MAX_CASE_INPUT_BYTES = 8 * 1024 * 1024;
const SUPERVISOR_OVERHEAD_MS = 20_000;
const SANDBOX_PROCESS_KILL_TIMEOUT_MS = 3_000;
const SANDBOX_DESTROY_TIMEOUT_MS = 15_000;

const SAFE_MESSAGES: Readonly<Record<RunnerVerdict, string>> = {
  accepted: "All evaluated cases passed.",
  wrong_answer: "The returned value did not match the required result.",
  compile_error: "The source could not be compiled.",
  runtime_error: "The program stopped with a runtime error.",
  time_limit: "The program exceeded the time limit.",
  memory_limit: "The program exceeded the memory limit.",
  output_limit: "The program produced too much output.",
  source_limit: "The submitted source exceeds the allowed size or format.",
  infrastructure_error: "The execution service is temporarily unavailable.",
};

type SupervisorStatus =
  | "ok"
  | "compile_error"
  | "runtime_error"
  | "time_limit"
  | "memory_limit"
  | "output_limit"
  | "infrastructure_error";

interface SupervisorMessage {
  readonly status: SupervisorStatus;
  readonly compileMs: number;
  readonly runtimeMs: number;
}

function result(
  request: AdapterExecutionRequest,
  verdict: RunnerVerdict,
  passed: number,
  runtimeMs: number,
  compileMs?: number,
  samples?: readonly SampleResult[],
): RunnerResult {
  return {
    executionId: request.executionId,
    status:
      verdict === "infrastructure_error" ? "infrastructure_error" : "completed",
    verdict,
    passed,
    total: request.cases.length,
    runtimeMs,
    ...(compileMs === undefined ? {} : { compileMs }),
    message: SAFE_MESSAGES[verdict],
    ...(request.mode === "samples" && samples ? { samples } : {}),
  };
}

function finiteDuration(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function isHarnessMessage(value: unknown): value is HarnessMessage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "compile_error") {
    return finiteDuration(candidate.compileMs) !== undefined;
  }
  if (candidate.kind === "ready") {
    return finiteDuration(candidate.compileMs) !== undefined;
  }
  return (
    candidate.kind === "case" &&
    (candidate.status === "ok" ||
      candidate.status === "runtime_error" ||
      candidate.status === "memory_limit" ||
      candidate.status === "output_limit") &&
    finiteDuration(candidate.runtimeMs) !== undefined
  );
}

function parseHarnessMessages(stdout: string): HarnessMessage[] {
  const messages: HarnessMessage[] = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith(HARNESS_MARKER)) continue;
    try {
      const decoded: unknown = JSON.parse(line.slice(HARNESS_MARKER.length));
      if (isHarnessMessage(decoded)) messages.push(decoded);
    } catch {
      // Submitted code can write arbitrary output. Only valid protocol packets
      // are considered, and expected values never enter the sandbox.
    }
  }
  return messages;
}

function parseSupervisorMessage(stdout: string): SupervisorMessage | undefined {
  let message: SupervisorMessage | undefined;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith(SUPERVISOR_MARKER)) continue;
    try {
      const decoded: unknown = JSON.parse(line.slice(SUPERVISOR_MARKER.length));
      if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
        continue;
      }
      const candidate = decoded as Record<string, unknown>;
      if (
        candidate.status !== "ok" &&
        candidate.status !== "compile_error" &&
        candidate.status !== "runtime_error" &&
        candidate.status !== "time_limit" &&
        candidate.status !== "memory_limit" &&
        candidate.status !== "output_limit" &&
        candidate.status !== "infrastructure_error"
      ) {
        continue;
      }
      const compileMs = finiteDuration(candidate.compileMs);
      const runtimeMs = finiteDuration(candidate.runtimeMs);
      if (compileMs === undefined || runtimeMs === undefined) continue;
      message = { status: candidate.status, compileMs, runtimeMs };
    } catch {
      // The final root-owned supervisor packet wins over any forged packet.
    }
  }
  return message;
}

function boundedActual(value: unknown, maxBytes: number): string | undefined {
  try {
    const serialized = JSON.stringify(value);
    if (new TextEncoder().encode(serialized).byteLength > maxBytes) {
      return undefined;
    }
    return serialized;
  } catch {
    return undefined;
  }
}

function completedCases(
  request: AdapterExecutionRequest,
  messages: readonly HarnessMessage[],
  trustedRuntimeMs: number,
): {
  readonly passed: number;
  readonly samples: readonly SampleResult[];
  readonly terminalVerdict?: RunnerVerdict;
} {
  const readyIndex = messages.findIndex((message) => message.kind === "ready");
  if (readyIndex < 0) {
    return { passed: 0, samples: [], terminalVerdict: "runtime_error" };
  }

  let passed = 0;
  const samples: SampleResult[] = [];
  const caseMessages = messages
    .slice(readyIndex + 1)
    .filter(
      (message): message is Extract<HarnessMessage, { kind: "case" }> =>
        message.kind === "case",
    )
    .slice(0, request.cases.length);

  for (let index = 0; index < caseMessages.length; index += 1) {
    const message = caseMessages[index]!;
    const judgeCase = request.cases[index]!;
    const reportedRuntime = Math.min(
      finiteDuration(message.runtimeMs) ?? 0,
      trustedRuntimeMs,
    );
    if (message.status !== "ok") {
      const verdict = message.status;
      if (request.mode === "samples") {
        samples.push({
          id: `sample-${index + 1}`,
          status: "ERROR",
          runtimeMs: reportedRuntime,
          message: SAFE_MESSAGES[verdict],
        });
      }
      return { passed, samples, terminalVerdict: verdict };
    }

    const matches = compareJudgeOutput(
      request.problem.comparator,
      message.actual,
      judgeCase.expected,
    );
    if (matches) passed += 1;
    if (request.mode === "samples") {
      const actual = boundedActual(
        message.actual,
        Math.min(request.problem.public.limits.maxOutputBytes, 8_192),
      );
      samples.push({
        id: `sample-${index + 1}`,
        status: matches ? "PASSED" : "FAILED",
        runtimeMs: reportedRuntime,
        ...(actual === undefined ? {} : { actual }),
        ...(matches ? {} : { message: SAFE_MESSAGES.wrong_answer }),
      });
    }
  }
  return { passed, samples };
}

function verdictFromSupervisor(
  status: Exclude<SupervisorStatus, "ok">,
): RunnerVerdict {
  return status;
}

async function withDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error("sandbox_operation_timeout")),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([operation, deadline]);
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

function disposeRpcValue(value: unknown): void {
  try {
    const disposeSymbol = (
      Symbol as typeof Symbol & { readonly dispose?: symbol }
    ).dispose;
    if (
      !disposeSymbol ||
      value === null ||
      (typeof value !== "object" && typeof value !== "function")
    ) {
      return;
    }
    const dispose = (value as Record<symbol, unknown>)[disposeSymbol];
    if (typeof dispose === "function") Reflect.apply(dispose, value, []);
  } catch {
    // Sandbox destruction remains the final cleanup boundary if an RPC value
    // has already been detached or cannot be explicitly disposed.
  }
}

function interpretExecution(
  request: AdapterExecutionRequest,
  execution: ExecResult,
): RunnerResult {
  const supervisor = parseSupervisorMessage(execution.stdout);
  if (!supervisor) {
    return result(request, "infrastructure_error", 0, 0);
  }
  const harnessMessages = parseHarnessMessages(execution.stdout);
  const evaluated = completedCases(
    request,
    harnessMessages,
    supervisor.runtimeMs,
  );

  if (supervisor.status !== "ok") {
    return result(
      request,
      verdictFromSupervisor(supervisor.status),
      evaluated.passed,
      supervisor.runtimeMs,
      supervisor.compileMs,
      evaluated.samples,
    );
  }
  if (evaluated.terminalVerdict) {
    return result(
      request,
      evaluated.terminalVerdict,
      evaluated.passed,
      supervisor.runtimeMs,
      supervisor.compileMs,
      evaluated.samples,
    );
  }

  const completedCount = harnessMessages
    .slice(harnessMessages.findIndex((message) => message.kind === "ready") + 1)
    .filter((message) => message.kind === "case").length;
  const integrityVerdict = executionIntegrityVerdict({
    executionSucceeded: execution.success,
    exitCode: execution.exitCode,
    completedCases: completedCount,
    expectedCases: request.cases.length,
  });
  if (integrityVerdict) {
    return result(
      request,
      integrityVerdict,
      evaluated.passed,
      supervisor.runtimeMs,
      supervisor.compileMs,
    );
  }
  return result(
    request,
    evaluated.passed === request.cases.length ? "accepted" : "wrong_answer",
    evaluated.passed,
    supervisor.runtimeMs,
    supervisor.compileMs,
    evaluated.samples,
  );
}

export class CloudflareSandboxRunnerAdapter implements RunnerAdapter {
  constructor(
    private readonly namespace: DurableObjectNamespace<JudgeSandbox>,
  ) {}

  async execute(request: AdapterExecutionRequest): Promise<RunnerResult> {
    const limits = request.problem.public.limits;
    if (
      new TextEncoder().encode(request.source).byteLength >
        limits.maxSourceBytes ||
      request.source.includes("\0") ||
      (request.language === "java" &&
        /^\s*package\s+[\w.]+\s*;/m.test(request.source))
    ) {
      return result(request, "source_limit", 0, 0);
    }

    const cases = `${request.cases
      .map((judgeCase) => JSON.stringify({ args: judgeCase.args }))
      .join("\n")}\n`;
    if (new TextEncoder().encode(cases).byteLength > MAX_CASE_INPUT_BYTES) {
      return result(request, "infrastructure_error", 0, 0);
    }
    const sourceName =
      request.language === "python" ? "solution.py" : "Solution.java";
    const harnessName =
      request.language === "python" ? "harness.py" : "Harness.java";
    const harness =
      request.language === "python"
        ? generatePythonHarness(
            request.problem.public.functionName,
            limits.maxOutputBytes,
            `${WORKSPACE}/solution.py`,
          )
        : generateJavaHarness(request.problem.public, limits.maxOutputBytes);

    const sandbox = getSandbox(this.namespace, `judge-${crypto.randomUUID()}`, {
      transport: "rpc",
      enableDefaultSession: false,
      keepAlive: false,
      sleepAfter: "1m",
      normalizeId: true,
      labels: {
        workload: "leetbattle-judge",
        language: request.language,
      },
    });
    let phase = "provision_workspace";
    let judgeProcess:
      { readonly id: string; kill(signal?: string): Promise<void> } | undefined;
    let processNeedsTermination = false;
    try {
      await sandbox.mkdir(WORKSPACE, { recursive: true });
      phase = "write_inputs";
      await Promise.all([
        sandbox.writeFile(`${WORKSPACE}/${sourceName}`, request.source),
        sandbox.writeFile(`${WORKSPACE}/${harnessName}`, harness),
        sandbox.writeFile(`${WORKSPACE}/cases.ndjson`, cases),
      ]);

      phase = "start_judge";
      const startedAt = performance.now();
      const process = await sandbox.startProcess(TRUSTED_COMMAND, {
        cwd: WORKSPACE,
        autoCleanup: false,
        env: {
          LEETBATTLE_LANGUAGE: request.language,
          LEETBATTLE_COMPILE_WALL_MS: String(limits.compileTimeMs),
          LEETBATTLE_COMPILE_CPU_MS: String(limits.compileTimeMs),
          LEETBATTLE_RUN_CPU_MS: String(limits.runTimeMs),
          LEETBATTLE_RUN_WALL_MS: String(limits.wallTimeMs),
          LEETBATTLE_MEMORY_MB: String(limits.memoryMb),
          LEETBATTLE_MAX_PROCESSES: String(limits.maxProcesses),
          LEETBATTLE_MAX_OUTPUT_BYTES: String(limits.maxOutputBytes),
          LEETBATTLE_MAX_WORKSPACE_MB: String(limits.maxWorkspaceMb),
        },
      });
      judgeProcess = process;
      processNeedsTermination = true;
      phase = "wait_for_judge";
      const completed = await process.waitForExit(
        limits.compileTimeMs + limits.wallTimeMs + SUPERVISOR_OVERHEAD_MS,
      );
      const exitCode = completed.exitCode;
      disposeRpcValue(completed);
      processNeedsTermination = false;
      phase = "read_judge_output";
      const logs = await process.getLogs();
      const stdout = logs.stdout;
      const stderr = logs.stderr;
      disposeRpcValue(logs);
      const execution: ExecResult = {
        success: exitCode === 0,
        exitCode,
        stdout,
        stderr,
        command: TRUSTED_COMMAND,
        duration: Math.max(0, Math.round(performance.now() - startedAt)),
        timestamp: new Date().toISOString(),
      };
      return interpretExecution(request, execution);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "runner_sandbox_failed",
          executionId: request.executionId,
          phase,
          errorType: error instanceof Error ? error.name : "UnknownError",
        }),
      );
      return result(request, "infrastructure_error", 0, 0);
    } finally {
      if (judgeProcess && processNeedsTermination) {
        try {
          await withDeadline(
            judgeProcess.kill("SIGKILL"),
            SANDBOX_PROCESS_KILL_TIMEOUT_MS,
          );
        } catch (error) {
          console.error(
            JSON.stringify({
              event: "runner_sandbox_process_kill_failed",
              executionId: request.executionId,
              processId: judgeProcess.id,
              errorType: error instanceof Error ? error.name : "UnknownError",
            }),
          );
        }
      }
      if (judgeProcess) disposeRpcValue(judgeProcess);
      try {
        await withDeadline(sandbox.destroy(), SANDBOX_DESTROY_TIMEOUT_MS);
      } catch (error) {
        console.error(
          JSON.stringify({
            event: "runner_sandbox_destroy_failed",
            executionId: request.executionId,
            errorType: error instanceof Error ? error.name : "UnknownError",
          }),
        );
      }
    }
  }
}
