import type {
  ExecutionKind,
  Language,
  RunnerResult,
} from "@/server/domain/types";

export interface RunnerRequest {
  executionId: string;
  problemId: string;
  problemVersion: number;
  language: Language;
  kind: ExecutionKind;
  source: string;
}

export interface RunnerAdapter {
  execute(request: RunnerRequest): Promise<RunnerResult>;
}

type Fetch = typeof fetch;
export const RUNNER_HTTP_TIMEOUT_MS = 180_000;

const VERDICTS: Readonly<Record<string, RunnerResult["verdict"]>> = {
  ACCEPTED: "ACCEPTED",
  WRONG_ANSWER: "WRONG_ANSWER",
  COMPILE_ERROR: "COMPILE_ERROR",
  RUNTIME_ERROR: "RUNTIME_ERROR",
  TIMEOUT: "TIMEOUT",
  TIME_LIMIT: "TIMEOUT",
  MEMORY_LIMIT: "MEMORY_LIMIT",
  MEMORY_LIMIT_EXCEEDED: "MEMORY_LIMIT",
  OUTPUT_LIMIT: "OUTPUT_LIMIT",
  OUTPUT_LIMIT_EXCEEDED: "OUTPUT_LIMIT",
  INFRA_ERROR: "INFRA_ERROR",
  INFRASTRUCTURE_ERROR: "INFRA_ERROR",
  SOURCE_LIMIT: "COMPILE_ERROR",
};

function finiteNumberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function safeCountOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value)
    ? value
    : null;
}

/** HTTP trust-boundary adapter; it deliberately returns no hidden-case diagnostics. */
export class HttpRunnerClient implements RunnerAdapter {
  constructor(
    private readonly baseUrl: string,
    private readonly bearerSecret: string,
    private readonly fetchImplementation: Fetch = fetch,
  ) {}

  async execute(request: RunnerRequest): Promise<RunnerResult> {
    try {
      const response = await this.fetchImplementation(
        new URL("/v1/execute", this.baseUrl),
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${this.bearerSecret}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            executionId: request.executionId,
            problemId: request.problemId,
            problemVersion: request.problemVersion,
            language: request.language,
            mode: request.kind === "RUN" ? "samples" : "submit",
            source: request.source,
          }),
          signal: AbortSignal.timeout(RUNNER_HTTP_TIMEOUT_MS),
        },
      );
      if (!response.ok) return infrastructureFailure();
      const body = (await response.json()) as Record<string, unknown>;
      if (body.executionId !== request.executionId)
        return infrastructureFailure();
      if (body.status === "infrastructure_error")
        return infrastructureFailure();
      const rawVerdict =
        typeof body.verdict === "string" ? body.verdict.toUpperCase() : "";
      const verdict = VERDICTS[rawVerdict];
      if (!verdict) return infrastructureFailure();
      const passed = safeCountOrNull(body.passed);
      const total = safeCountOrNull(body.total);
      if (
        passed === null ||
        total === null ||
        total <= 0 ||
        passed < 0 ||
        passed > total ||
        (verdict === "ACCEPTED" && passed !== total)
      ) {
        return infrastructureFailure();
      }
      const runtimeMs = finiteNumberOrNull(body.runtimeMs);
      const compileMs = finiteNumberOrNull(body.compileMs);
      if (runtimeMs !== null && runtimeMs < 0) return infrastructureFailure();
      if (compileMs !== null && compileMs < 0) return infrastructureFailure();
      if (verdict === "ACCEPTED" && runtimeMs === null)
        return infrastructureFailure();
      const result: RunnerResult = {
        verdict,
        passedCount: passed,
        totalCount: total,
        runtimeMs,
        compileMs,
      };
      // Sample-mode output belongs only to the requesting player. Submit-mode
      // messages are discarded at this boundary to prevent hidden data leaks.
      if (request.kind === "RUN") {
        const samples = Array.isArray(body.samples)
          ? body.samples.slice(0, 100).flatMap((candidate, index) => {
              if (
                !candidate ||
                typeof candidate !== "object" ||
                Array.isArray(candidate)
              )
                return [];
              const row = candidate as Record<string, unknown>;
              if (
                row.status !== "PASSED" &&
                row.status !== "FAILED" &&
                row.status !== "ERROR"
              ) {
                return [];
              }
              return [
                {
                  id:
                    typeof row.id === "string"
                      ? row.id.slice(0, 100)
                      : `sample-${index + 1}`,
                  status: row.status,
                  ...(typeof row.runtimeMs === "number"
                    ? { runtimeMs: row.runtimeMs }
                    : {}),
                  ...(typeof row.actual === "string"
                    ? { actual: row.actual.slice(0, 4_096) }
                    : {}),
                  ...(typeof row.message === "string"
                    ? { message: row.message.slice(0, 4_096) }
                    : {}),
                },
              ];
            })
          : [];
        result.details = {
          samples,
          ...(typeof body.message === "string"
            ? { message: body.message.slice(0, 16_384) }
            : {}),
        };
      }
      return result;
    } catch {
      return infrastructureFailure();
    }
  }
}

export function infrastructureFailure(): RunnerResult {
  return {
    verdict: "INFRA_ERROR",
    passedCount: 0,
    totalCount: 0,
    runtimeMs: null,
    compileMs: null,
  };
}
