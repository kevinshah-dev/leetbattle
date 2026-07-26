import { timingSafeEqual } from "node:crypto";
import type {
  IncomingMessage,
  RequestListener,
  ServerResponse,
} from "node:http";

import { requireInternalSecret } from "../../src/server/config/secrets";
import { executeRunnerRequest } from "./execute";
import type { RunnerAdapter } from "./types";

// Allows a max-sized source even when every character needs JSON escaping.
const MAX_HTTP_BODY_BYTES = 512 * 1024;

export interface RunnerHttpOptions {
  readonly adapter: RunnerAdapter;
  readonly sharedSecret: string;
  readonly maxBodyBytes?: number;
  readonly readiness?: () => Promise<boolean>;
}

function json(response: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "X-Content-Type-Options": "nosniff",
  });
  response.end(body);
}

function authorized(request: IncomingMessage, sharedSecret: string): boolean {
  const header = request.headers.authorization;
  if (!header?.startsWith("Bearer ")) return false;
  const received = Buffer.from(header.slice(7), "utf8");
  const expected = Buffer.from(sharedSecret, "utf8");
  return (
    received.length === expected.length && timingSafeEqual(received, expected)
  );
}

async function readJson(
  request: IncomingMessage,
  maxBytes: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const rawChunk of request) {
    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
    bytes += chunk.byteLength;
    if (bytes > maxBytes) throw new RangeError("request_too_large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createRunnerHttpHandler(
  options: RunnerHttpOptions,
): RequestListener {
  const sharedSecret = requireInternalSecret(
    "RUNNER_INTERNAL_SECRET",
    options.sharedSecret,
  );
  const maxBytes = options.maxBodyBytes ?? MAX_HTTP_BODY_BYTES;

  return (request, response) => {
    void (async () => {
      if (request.method === "GET" && request.url === "/health") {
        const ready = options.readiness
          ? await options.readiness().catch(() => false)
          : true;
        json(response, ready ? 200 : 503, {
          status: ready ? "ok" : "unavailable",
        });
        return;
      }
      if (request.method !== "POST" || request.url !== "/v1/execute") {
        json(response, 404, { error: "not_found" });
        return;
      }
      if (!authorized(request, sharedSecret)) {
        json(response, 401, { error: "unauthorized" });
        return;
      }
      if (
        !request.headers["content-type"]
          ?.toLowerCase()
          .startsWith("application/json")
      ) {
        json(response, 415, { error: "unsupported_media_type" });
        return;
      }
      let value: unknown;
      try {
        value = await readJson(request, maxBytes);
      } catch (error) {
        json(response, error instanceof RangeError ? 413 : 400, {
          error:
            error instanceof RangeError ? "request_too_large" : "invalid_json",
        });
        return;
      }
      const executed = await executeRunnerRequest(value, options.adapter);
      if (!executed.ok) {
        json(response, executed.status, executed.body);
        return;
      }
      json(
        response,
        executed.result.status === "infrastructure_error" ? 503 : 200,
        executed.result,
      );
    })().catch(() => {
      if (!response.headersSent) {
        json(response, 500, { error: "internal_error" });
      } else {
        response.destroy();
      }
    });
  };
}
