import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { DomainError } from "@/server/domain/errors";
import { appOrigin, readJson, requireMutationOrigin } from "@/server/http";

const originalAppOrigin = process.env.APP_ORIGIN;
const mutableProcessEnv: Record<string, string | undefined> = process.env;

function expectDomainError(
  operation: () => unknown,
  code: DomainError["code"],
  status: number,
): void {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ code, status });
    return;
  }
  throw new Error(`Expected DomainError ${code}`);
}

async function expectDomainRejection(
  operation: Promise<unknown>,
  code: DomainError["code"],
  status: number,
): Promise<void> {
  try {
    await operation;
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect(error).toMatchObject({ code, status });
    return;
  }
  throw new Error(`Expected DomainError ${code}`);
}

beforeEach(() => {
  delete mutableProcessEnv.APP_ORIGIN;
});

afterEach(() => {
  if (originalAppOrigin === undefined) delete mutableProcessEnv.APP_ORIGIN;
  else mutableProcessEnv.APP_ORIGIN = originalAppOrigin;
});

describe("mutation origin boundary", () => {
  it("accepts same-origin browser requests and requests without Origin", () => {
    const sameOrigin = new Request("https://battle.example/api/profile", {
      method: "POST",
      headers: { origin: "https://battle.example" },
    });
    const noOrigin = new Request("https://battle.example/api/profile", {
      method: "POST",
    });

    expect(() => requireMutationOrigin(sameOrigin)).not.toThrow();
    expect(() => requireMutationOrigin(noOrigin)).not.toThrow();
  });

  it("uses the configured application origin and rejects cross-origin writes", () => {
    mutableProcessEnv.APP_ORIGIN = "https://battle.example/deployment/path";
    const request = new Request("http://internal-web:3000/api/rooms", {
      method: "POST",
      headers: { origin: "https://attacker.example" },
    });

    expect(appOrigin(request)).toBe("https://battle.example");
    expectDomainError(
      () => requireMutationOrigin(request),
      "AUTH_REQUIRED",
      403,
    );
  });

  it("rejects the opaque null Origin value", () => {
    const request = new Request("https://battle.example/api/rooms", {
      method: "POST",
      headers: { origin: "null" },
    });

    expectDomainError(
      () => requireMutationOrigin(request),
      "AUTH_REQUIRED",
      403,
    );
  });
});

describe("JSON request body boundary", () => {
  it("rejects an oversized declared body before parsing", async () => {
    const request = new Request("https://battle.example/api/profile", {
      method: "POST",
      headers: { "content-length": "17" },
      body: "{}",
    });

    await expectDomainRejection(readJson(request, 16), "SOURCE_TOO_LARGE", 413);
  });

  it("measures the actual UTF-8 bytes even when Content-Length is misleading", async () => {
    const request = new Request("https://battle.example/api/profile", {
      method: "POST",
      headers: { "content-length": "1" },
      body: JSON.stringify("é"),
    });

    await expectDomainRejection(readJson(request, 3), "SOURCE_TOO_LARGE", 413);
  });

  it("accepts valid JSON exactly at the byte limit", async () => {
    const body = JSON.stringify({ ready: true });
    const request = new Request("https://battle.example/api/rooms", {
      method: "POST",
      body,
    });

    await expect(
      readJson(request, Buffer.byteLength(body, "utf8")),
    ).resolves.toEqual({ ready: true });
  });

  it("maps malformed JSON to a bounded domain error", async () => {
    const request = new Request("https://battle.example/api/profile", {
      method: "POST",
      body: '{"username":',
    });

    await expectDomainRejection(readJson(request), "INVALID_STATE", 400);
  });
});
