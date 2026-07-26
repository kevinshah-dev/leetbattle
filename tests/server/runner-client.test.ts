import { describe, expect, it, vi } from "vitest";

import { HttpRunnerClient } from "../../src/server/match/runner-client";

const baseRequest = {
  executionId: "00000000-0000-4000-8000-000000000001",
  problemId: "paired-pulses",
  problemVersion: 1,
  language: "PYTHON" as const,
  source: "class Solution: pass",
};

describe("runner trust-boundary adapter", () => {
  it("never forwards submit diagnostics from the isolated runner", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          executionId: baseRequest.executionId,
          status: "completed",
          verdict: "wrong_answer",
          passed: 8,
          total: 12,
          runtimeMs: 4,
          compileMs: 12,
          message: "secret hidden fixture input and expected value",
        }),
        { status: 200 },
      ),
    );
    const client = new HttpRunnerClient(
      "http://runner.test",
      "secret",
      fetchMock,
    );
    const result = await client.execute({ ...baseRequest, kind: "SUBMIT" });
    expect(result.verdict).toBe("WRONG_ANSWER");
    expect(result.details).toBeUndefined();
  });

  it("allows bounded sample-only output to return to its owner", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          executionId: baseRequest.executionId,
          status: "completed",
          verdict: "accepted",
          passed: 3,
          total: 3,
          runtimeMs: 2,
          compileMs: 0,
          message: "All visible samples passed",
        }),
        { status: 200 },
      ),
    );
    const client = new HttpRunnerClient(
      "http://runner.test",
      "secret",
      fetchMock,
    );
    const result = await client.execute({ ...baseRequest, kind: "RUN" });
    expect(result.details).toEqual({
      samples: [],
      message: "All visible samples passed",
    });
  });

  it("converts transport and malformed responses into retryable infrastructure failures", async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValue(new Error("offline"));
    const client = new HttpRunnerClient(
      "http://runner.test",
      "secret",
      fetchMock,
    );
    await expect(
      client.execute({ ...baseRequest, kind: "SUBMIT" }),
    ).resolves.toMatchObject({
      verdict: "INFRA_ERROR",
    });
  });

  it.each([
    { passed: 0, total: 0, runtimeMs: 1 },
    { passed: 2, total: 3, runtimeMs: 1 },
    { passed: 2.5, total: 3, runtimeMs: 1 },
    { passed: 3, total: 3, runtimeMs: -1 },
  ])("does not trust an inconsistent accepted result %#", async (counts) => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          executionId: baseRequest.executionId,
          status: "completed",
          verdict: "accepted",
          compileMs: 0,
          ...counts,
        }),
        { status: 200 },
      ),
    );
    const client = new HttpRunnerClient(
      "http://runner.test",
      "secret",
      fetchMock,
    );
    await expect(
      client.execute({ ...baseRequest, kind: "SUBMIT" }),
    ).resolves.toMatchObject({ verdict: "INFRA_ERROR" });
  });
});
