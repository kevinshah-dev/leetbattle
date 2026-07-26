import { getServerProblem } from "../../src/problems/server/bank.server";
import type { SupportedLanguage } from "../../src/problems/types";
import type {
  RunnerAdapter,
  RunnerHttpRequest,
  RunnerResult,
  RunnerVerdict,
  SampleResult,
} from "./types";

export type ExecuteResponse =
  | { readonly ok: true; readonly result: RunnerResult }
  | {
      readonly ok: false;
      readonly status: 400 | 404;
      readonly body: { readonly error: "invalid_request" | "unknown_problem" };
    };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLanguage(value: unknown): SupportedLanguage | undefined {
  if (value === "python" || value === "PYTHON") return "python";
  if (value === "java" || value === "JAVA") return "java";
  return undefined;
}

function parseRequest(
  value: unknown,
):
  | (Omit<RunnerHttpRequest, "language"> & { language: SupportedLanguage })
  | undefined {
  if (!isRecord(value)) return undefined;
  const language = normalizeLanguage(value.language);
  if (
    typeof value.executionId !== "string" ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(value.executionId) ||
    typeof value.problemId !== "string" ||
    !/^[a-z0-9-]{3,80}$/.test(value.problemId) ||
    !Number.isSafeInteger(value.problemVersion) ||
    (value.problemVersion as number) < 1 ||
    !language ||
    (value.mode !== "samples" && value.mode !== "submit") ||
    typeof value.source !== "string"
  ) {
    return undefined;
  }
  return {
    executionId: value.executionId,
    problemId: value.problemId,
    problemVersion: value.problemVersion as number,
    language,
    mode: value.mode,
    source: value.source,
  };
}

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

function finiteDuration(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

function sanitizeSamples(
  samples: readonly SampleResult[] | undefined,
  total: number,
): SampleResult[] {
  if (!Array.isArray(samples)) return [];
  return samples.slice(0, total).map((sample, index) => {
    const actual =
      typeof sample.actual === "string" &&
      Buffer.byteLength(sample.actual, "utf8") <= 8_192
        ? sample.actual
        : undefined;
    const status = ["PASSED", "FAILED", "ERROR"].includes(sample.status)
      ? sample.status
      : "ERROR";
    return {
      id: `sample-${index + 1}`,
      status,
      ...(finiteDuration(sample.runtimeMs) === undefined
        ? {}
        : { runtimeMs: finiteDuration(sample.runtimeMs) }),
      ...(actual === undefined ? {} : { actual }),
      ...(status === "PASSED"
        ? {}
        : {
            message:
              status === "FAILED"
                ? SAFE_MESSAGES.wrong_answer
                : "The sample could not be evaluated.",
          }),
    };
  });
}

function sanitizeResult(
  executionId: string,
  mode: "samples" | "submit",
  total: number,
  candidate: RunnerResult,
): RunnerResult {
  let verdict: RunnerVerdict = Object.hasOwn(SAFE_MESSAGES, candidate.verdict)
    ? candidate.verdict
    : "infrastructure_error";
  const validCounts =
    total > 0 &&
    Number.isSafeInteger(candidate.passed) &&
    candidate.passed >= 0 &&
    candidate.passed <= total &&
    Number.isSafeInteger(candidate.total) &&
    candidate.total === total;
  if (!validCounts || (verdict === "accepted" && candidate.passed !== total)) {
    verdict = "infrastructure_error";
  }
  const passed =
    validCounts && verdict !== "infrastructure_error" ? candidate.passed : 0;
  return {
    executionId,
    status:
      verdict === "infrastructure_error" ? "infrastructure_error" : "completed",
    verdict,
    passed,
    total,
    runtimeMs: finiteDuration(candidate.runtimeMs) ?? 0,
    ...(finiteDuration(candidate.compileMs) === undefined
      ? {}
      : { compileMs: finiteDuration(candidate.compileMs) }),
    message: SAFE_MESSAGES[verdict],
    ...(mode === "samples"
      ? { samples: sanitizeSamples(candidate.samples, total) }
      : {}),
  };
}

export async function executeRunnerRequest(
  value: unknown,
  adapter: RunnerAdapter,
): Promise<ExecuteResponse> {
  const request = parseRequest(value);
  if (!request)
    return { ok: false, status: 400, body: { error: "invalid_request" } };
  const problem = getServerProblem(request.problemId, request.problemVersion);
  if (!problem)
    return { ok: false, status: 404, body: { error: "unknown_problem" } };
  const cases = request.mode === "samples" ? problem.samples : problem.hidden;
  try {
    const result = await adapter.execute({
      executionId: request.executionId,
      language: request.language,
      mode: request.mode,
      source: request.source,
      problem,
      cases,
    });
    return {
      ok: true,
      result: sanitizeResult(
        request.executionId,
        request.mode,
        cases.length,
        result,
      ),
    };
  } catch {
    return {
      ok: true,
      result: {
        executionId: request.executionId,
        status: "infrastructure_error",
        verdict: "infrastructure_error",
        passed: 0,
        total: cases.length,
        runtimeMs: 0,
        message: "The execution service is temporarily unavailable.",
      },
    };
  }
}
