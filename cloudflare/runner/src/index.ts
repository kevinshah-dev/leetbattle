import { requireInternalSecret } from "../../../src/server/config/secrets";
import { executeRunnerRequest } from "../../../services/runner/execute";
import type { RunnerHttpRequest } from "../../../services/runner/types";
import {
  CloudflareSandboxRunnerAdapter,
  ContainerProxy,
  JudgeSandbox,
} from "./sandbox-adapter";

export { ContainerProxy, JudgeSandbox };

const MAX_HTTP_BODY_BYTES = 512 * 1024;
const MAX_SOURCE_BYTES = 64 * 1024;
const MAX_AUTHORIZATION_BYTES = 8 * 1024;
const REQUEST_KEYS = new Set([
  "executionId",
  "problemId",
  "problemVersion",
  "language",
  "mode",
  "source",
]);

class RequestTooLargeError extends Error {}

function json(status: number, value: unknown): Response {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/json; charset=utf-8",
      "Cross-Origin-Resource-Policy": "same-origin",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseStrictRequest(value: unknown): RunnerHttpRequest | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value);
  if (
    keys.length !== REQUEST_KEYS.size ||
    keys.some((key) => !REQUEST_KEYS.has(key))
  ) {
    return undefined;
  }
  if (
    typeof value.executionId !== "string" ||
    !/^[A-Za-z0-9_-]{8,128}$/.test(value.executionId) ||
    typeof value.problemId !== "string" ||
    !/^[a-z0-9-]{3,80}$/.test(value.problemId) ||
    !Number.isSafeInteger(value.problemVersion) ||
    (value.problemVersion as number) < 1 ||
    (value.language !== "python" &&
      value.language !== "java" &&
      value.language !== "PYTHON" &&
      value.language !== "JAVA") ||
    (value.mode !== "samples" && value.mode !== "submit") ||
    typeof value.source !== "string" ||
    new TextEncoder().encode(value.source).byteLength > MAX_SOURCE_BYTES
  ) {
    return undefined;
  }
  return {
    executionId: value.executionId,
    problemId: value.problemId,
    problemVersion: value.problemVersion as number,
    language: value.language,
    mode: value.mode,
    source: value.source,
  };
}

async function readJsonBounded(
  request: Request,
  maxBytes: number,
): Promise<unknown> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^(0|[1-9][0-9]*)$/.test(contentLength)) {
      throw new SyntaxError("Invalid Content-Length");
    }
    if (Number(contentLength) > maxBytes) throw new RequestTooLargeError();
  }
  if (!request.body) throw new SyntaxError("Missing request body");

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel("request_too_large").catch(() => undefined);
        throw new RequestTooLargeError();
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(body),
  );
}

async function fixedLengthDigest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function constantTimeSecretEqual(
  supplied: string,
  expected: string,
): Promise<boolean> {
  const [left, right] = await Promise.all([
    fixedLengthDigest(supplied),
    fixedLengthDigest(expected),
  ]);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

async function authorized(
  request: Request,
  expected: string,
): Promise<boolean> {
  const header = request.headers.get("authorization") ?? "";
  const matched =
    new TextEncoder().encode(header).byteLength <= MAX_AUTHORIZATION_BYTES
      ? /^Bearer ([^\s]+)$/.exec(header)
      : null;
  const received = matched?.[1] ?? "";
  return (
    matched !== null && (await constantTimeSecretEqual(received, expected))
  );
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (
    request.method === "GET" &&
    url.pathname === "/health" &&
    url.search === ""
  ) {
    return json(200, { status: "ok" });
  }
  if (
    request.method !== "POST" ||
    url.pathname !== "/v1/execute" ||
    url.search !== ""
  ) {
    return json(404, { error: "not_found" });
  }

  const sharedSecret = requireInternalSecret(
    "RUNNER_INTERNAL_SECRET",
    env.RUNNER_INTERNAL_SECRET,
  );
  if (!(await authorized(request, sharedSecret))) {
    return json(401, { error: "unauthorized" });
  }
  const mediaType = request.headers
    .get("content-type")
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== "application/json") {
    return json(415, { error: "unsupported_media_type" });
  }
  if (request.headers.has("content-encoding")) {
    return json(415, { error: "unsupported_media_type" });
  }

  let value: unknown;
  try {
    value = await readJsonBounded(request, MAX_HTTP_BODY_BYTES);
  } catch (error) {
    return json(error instanceof RequestTooLargeError ? 413 : 400, {
      error:
        error instanceof RequestTooLargeError
          ? "request_too_large"
          : "invalid_json",
    });
  }
  const parsed = parseStrictRequest(value);
  if (!parsed) return json(400, { error: "invalid_request" });

  const startedAt = performance.now();
  const executed = await executeRunnerRequest(
    parsed,
    new CloudflareSandboxRunnerAdapter(
      env.JUDGE_SANDBOX as DurableObjectNamespace<JudgeSandbox>,
    ),
  );
  if (!executed.ok) return json(executed.status, executed.body);

  console.log(
    JSON.stringify({
      event: "runner_execution_complete",
      executionId: parsed.executionId,
      problemId: parsed.problemId,
      language: parsed.language,
      mode: parsed.mode,
      status: executed.result.status,
      verdict: executed.result.verdict,
      elapsedMs: Math.max(0, Math.round(performance.now() - startedAt)),
    }),
  );
  return json(
    executed.result.status === "infrastructure_error" ? 503 : 200,
    executed.result,
  );
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await handle(request, env);
    } catch (error) {
      console.error(
        JSON.stringify({
          event: "runner_request_failed",
          errorType: error instanceof Error ? error.name : "UnknownError",
          path: new URL(request.url).pathname,
        }),
      );
      return json(500, { error: "internal_error" });
    }
  },
} satisfies ExportedHandler<Env>;
