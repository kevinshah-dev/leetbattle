import { NextResponse } from "next/server";
import { ZodError } from "zod";

import { DomainError } from "@/server/domain/errors";

const JSON_HEADERS = {
  "cache-control": "no-store, max-age=0",
  "content-type": "application/json; charset=utf-8",
} as const;

export function json<T>(body: T, init?: ResponseInit): NextResponse<T> {
  const headers = new Headers(init?.headers);
  for (const [name, value] of Object.entries(JSON_HEADERS))
    headers.set(name, value);
  return NextResponse.json(body, { ...init, headers });
}

export function appOrigin(request: Request): string {
  const configured = process.env.APP_ORIGIN;
  if (configured) return new URL(configured).origin;
  return new URL(request.url).origin;
}

export function requireMutationOrigin(request: Request): void {
  const origin = request.headers.get("origin");
  if (!origin) return;
  if (origin !== appOrigin(request)) {
    throw new DomainError(
      "AUTH_REQUIRED",
      "Cross-origin mutation rejected",
      403,
    );
  }
}

export async function readJson(
  request: Request,
  maximumBytes = 100 * 1024,
): Promise<unknown> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maximumBytes) {
    throw new DomainError("SOURCE_TOO_LARGE", "Request body is too large", 413);
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    throw new DomainError(
      "INVALID_STATE",
      "Request body could not be read",
      400,
    );
  }
  if (Buffer.byteLength(text, "utf8") > maximumBytes) {
    throw new DomainError("SOURCE_TOO_LARGE", "Request body is too large", 413);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new DomainError(
      "INVALID_STATE",
      "Request body must be valid JSON",
      400,
    );
  }
}

export async function apiRoute<T>(
  operation: () => Promise<NextResponse<T>>,
): Promise<NextResponse> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DomainError) {
      return json(
        {
          error: {
            code: error.code,
            message: error.message,
            ...(error.retryAt ? { details: { retryAt: error.retryAt } } : {}),
          },
        },
        { status: error.status },
      );
    }
    if (error instanceof ZodError) {
      return json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "Request validation failed",
            details: error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            })),
          },
        },
        { status: 422 },
      );
    }
    console.error(
      "Unhandled API error",
      error instanceof Error ? error.message : "unknown error",
    );
    return json(
      {
        error: {
          code: "INTERNAL_ERROR",
          message: "The request could not be completed",
        },
      },
      { status: 500 },
    );
  }
}
