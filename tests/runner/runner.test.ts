import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  accountTrustedCaseRuntime,
  classifyDockerExit,
  DockerRunnerAdapter,
  isRunnerResourceName,
} from "../../services/runner/adapters/docker";
import { executeRunnerRequest } from "../../services/runner/execute";
import { generateJavaHarness } from "../../services/runner/harness/java";
import { generatePythonHarness } from "../../services/runner/harness/python";
import { createRunnerHttpHandler } from "../../services/runner/http";
import { registerGracefulShutdown } from "../../services/runner/server";
import type { RunnerAdapter, RunnerResult } from "../../services/runner/types";
import { getServerProblem } from "../../src/problems/server/bank.server";

const SECRET = "runner-test-secret-at-least-24-bytes";
const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
});

function accepted(executionId: string, total: number): RunnerResult {
  return {
    executionId,
    status: "completed",
    verdict: "accepted",
    passed: total,
    total,
    runtimeMs: 7,
    message: "adapter message is not trusted",
  };
}

function request(overrides: Record<string, unknown> = {}) {
  return {
    executionId: "execution_1234",
    problemId: "paired-pulses",
    problemVersion: 1,
    language: "PYTHON",
    mode: "submit",
    source:
      "class Solution:\n    def pairedPulses(self, pulses):\n        return 0\n",
    ...overrides,
  };
}

async function listen(
  adapter: RunnerAdapter,
  readiness?: () => Promise<boolean>,
): Promise<string> {
  const server = createServer(
    createRunnerHttpHandler({ adapter, sharedSecret: SECRET, readiness }),
  );
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected TCP server address");
  return `http://127.0.0.1:${address.port}`;
}

describe("trusted execution resolver", () => {
  it("resolves only public samples for Run and only hidden fixtures for Submit", async () => {
    const execute = vi.fn<RunnerAdapter["execute"]>(async (job) =>
      accepted(job.executionId, job.cases.length),
    );
    const adapter: RunnerAdapter = { execute };
    const samples = await executeRunnerRequest(
      request({ mode: "samples" }),
      adapter,
    );
    const submit = await executeRunnerRequest(
      request({ mode: "submit" }),
      adapter,
    );
    expect(samples.ok && samples.result.total).toBe(3);
    expect(submit.ok && submit.result.total).toBe(12);
    expect(execute.mock.calls[0]![0].cases).toBe(
      execute.mock.calls[0]![0].problem.samples,
    );
    expect(execute.mock.calls[1]![0].cases).toBe(
      execute.mock.calls[1]![0].problem.hidden,
    );
  });

  it.each([
    null,
    {},
    request({ executionId: "x" }),
    request({ problemVersion: 0 }),
    request({ language: "javascript" }),
    request({ mode: "hidden" }),
    request({ source: 4 }),
  ])(
    "rejects malformed request %# before invoking an adapter",
    async (value) => {
      const adapter: RunnerAdapter = { execute: vi.fn() };
      const response = await executeRunnerRequest(value, adapter);
      expect(response).toEqual({
        ok: false,
        status: 400,
        body: { error: "invalid_request" },
      });
      expect(adapter.execute).not.toHaveBeenCalled();
    },
  );

  it("rejects unknown immutable problem versions", async () => {
    const adapter: RunnerAdapter = { execute: vi.fn() };
    expect(
      await executeRunnerRequest(request({ problemVersion: 999 }), adapter),
    ).toEqual({
      ok: false,
      status: 404,
      body: { error: "unknown_problem" },
    });
  });

  it("turns adapter exceptions into retryable infrastructure failures", async () => {
    const response = await executeRunnerRequest(request(), {
      execute: async () => {
        throw new Error("daemon detail must not escape");
      },
    });
    expect(response.ok && response.result).toMatchObject({
      status: "infrastructure_error",
      verdict: "infrastructure_error",
      message: "The execution service is temporarily unavailable.",
    });
    expect(JSON.stringify(response)).not.toContain("daemon detail");
  });

  it("whitelists response fields and strips sample/actual data from submit", async () => {
    const malicious = {
      ...accepted("forged-id", 12),
      verdict: "wrong_answer",
      passed: 5,
      message: "hidden expected PRIVATE_FIXTURE_SENTINEL actual SECRET",
      samples: [{ id: "hidden-7", status: "FAILED", actual: "SECRET" }],
      hiddenInput: "SECRET",
    } as unknown as RunnerResult;
    const response = await executeRunnerRequest(request(), {
      execute: async () => malicious,
    });
    expect(response.ok && response.result).toEqual({
      executionId: "execution_1234",
      status: "completed",
      verdict: "wrong_answer",
      passed: 5,
      total: 12,
      runtimeMs: 7,
      message: "The returned value did not match the required result.",
    });
    expect(JSON.stringify(response)).not.toContain("SECRET");
    expect(JSON.stringify(response)).not.toContain("PRIVATE_FIXTURE_SENTINEL");
  });

  it.each([
    { passed: 0, total: 12 },
    { passed: 11, total: 12 },
    { passed: 12.5, total: 12 },
    { passed: 12, total: 0 },
  ])("never preserves an inconsistent accepted result: %o", async (counts) => {
    const candidate = {
      ...accepted("execution_1234", counts.total),
      ...counts,
    };
    const response = await executeRunnerRequest(request(), {
      execute: async () => candidate,
    });
    expect(response.ok && response.result).toMatchObject({
      status: "infrastructure_error",
      verdict: "infrastructure_error",
      passed: 0,
      total: 12,
    });
  });

  it("rejects oversized source and Java package declarations without starting Docker", async () => {
    const adapter = new DockerRunnerAdapter({
      dockerCommand: "definitely-not-a-real-docker-command",
    });
    const oversized = await executeRunnerRequest(
      request({ source: "x".repeat(64 * 1024 + 1) }),
      adapter,
    );
    expect(oversized.ok && oversized.result.verdict).toBe("source_limit");
    const packageSource = await executeRunnerRequest(
      request({
        language: "JAVA",
        source: "package attack; class Solution {}",
      }),
      adapter,
    );
    expect(packageSource.ok && packageSource.result.verdict).toBe(
      "source_limit",
    );
  });
});

describe("runner HTTP trust boundary", () => {
  it("requires a bearer token and JSON content type", async () => {
    const base = await listen({
      execute: async (job) => accepted(job.executionId, job.cases.length),
    });
    const unauthorized = await fetch(`${base}/v1/execute`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request()),
    });
    expect(unauthorized.status).toBe(401);
    const wrongType = await fetch(`${base}/v1/execute`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECRET}`,
        "content-type": "text/plain",
      },
      body: JSON.stringify(request()),
    });
    expect(wrongType.status).toBe(415);
  });

  it("serves a safe synchronous verdict without echoing source", async () => {
    const base = await listen({
      execute: async (job) => accepted(job.executionId, job.cases.length),
    });
    const source =
      "class Solution:\n    # UNIQUE_SOURCE_SENTINEL\n    def pairedPulses(self, pulses): return 0";
    const response = await fetch(`${base}/v1/execute`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(request({ source })),
    });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain("UNIQUE_SOURCE_SENTINEL");
    expect(JSON.parse(text)).toMatchObject({
      verdict: "accepted",
      passed: 12,
      total: 12,
    });
  });

  it("bounds request bodies before parsing", async () => {
    const base = await listen({
      execute: async (job) => accepted(job.executionId, job.cases.length),
    });
    const response = await fetch(`${base}/v1/execute`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECRET}`,
        "content-type": "application/json",
      },
      body: "x".repeat(512 * 1024 + 1),
    });
    expect(response.status).toBe(413);
  });

  it("exposes only a non-sensitive health response", async () => {
    const base = await listen({
      execute: async (job) => accepted(job.executionId, job.cases.length),
    });
    const response = await fetch(`${base}/health`);
    expect(await response.json()).toEqual({ status: "ok" });
  });

  it("reports dependency-aware unavailability without diagnostics", async () => {
    const base = await listen(
      {
        execute: async (job) => accepted(job.executionId, job.cases.length),
      },
      async () => false,
    );
    const response = await fetch(`${base}/health`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ status: "unavailable" });
  });

  it("requires a runner secret of at least 32 bytes", () => {
    expect(() =>
      createRunnerHttpHandler({
        adapter: {
          execute: async (job) => accepted(job.executionId, job.cases.length),
        },
        sharedSecret: "x".repeat(31),
      }),
    ).toThrow(/32 bytes/);
  });
});

describe("harness and Docker policy", () => {
  it("accounts aggregate runtime from trusted monotonic timestamps", () => {
    const first = accountTrustedCaseRuntime(0, 100, 109.2, 20);
    expect(first).toEqual({
      caseRuntimeMs: 10,
      totalRuntimeMs: 10,
      exceeded: false,
    });
    const second = accountTrustedCaseRuntime(
      first.totalRuntimeMs,
      200,
      211.1,
      20,
    );
    expect(second).toEqual({
      caseRuntimeMs: 12,
      totalRuntimeMs: 22,
      exceeded: true,
    });
    expect(accountTrustedCaseRuntime(7, 10, 9, 20)).toEqual({
      caseRuntimeMs: 0,
      totalRuntimeMs: 7,
      exceeded: false,
    });
  });

  it("distinguishes Docker OOM kills from CPU-limit signals", () => {
    expect(classifyDockerExit({ OOMKilled: true, ExitCode: 137 })).toBe(
      "memory_limit",
    );
    expect(classifyDockerExit({ OOMKilled: false, ExitCode: 137 })).toBe(
      "time_limit",
    );
    expect(classifyDockerExit({ OOMKilled: false, ExitCode: 152 })).toBe(
      "time_limit",
    );
    expect(
      classifyDockerExit({ OOMKilled: false, ExitCode: 1 }),
    ).toBeUndefined();
    expect(
      classifyDockerExit({
        OOMKilled: false,
        ExitCode: 0,
        Status: "exited",
        Error: "",
      }),
    ).toBe("runtime_error");
  });

  it("accepts only exact runner-owned resource names for orphan cleanup", () => {
    const container = `leetbattle-${"a".repeat(24)}`;
    expect(isRunnerResourceName("container", container)).toBe(true);
    expect(isRunnerResourceName("volume", `${container}-submission`)).toBe(
      true,
    );
    for (const unsafe of [
      "leetbattle-",
      "leetbattle-production",
      `${container}extra`,
      `prefix-${container}`,
      "leetbattle-../../submission",
    ]) {
      expect(isRunnerResourceName("container", unsafe)).toBe(false);
      expect(isRunnerResourceName("volume", unsafe)).toBe(false);
    }
  });

  it("generates input-only harnesses with no fixture or expected output", () => {
    const problem = getServerProblem("phase-aligned-subsequence", 1)!;
    const python = generatePythonHarness(problem.public.functionName, 65_536);
    const java = generateJavaHarness(problem.public, 65_536);
    const privateStringInput = problem.hidden
      .flatMap((testCase) => testCase.args)
      .filter((value): value is string => typeof value === "string")
      .sort((left, right) => right.length - left.length)[0]!;
    for (const harness of [python, java]) {
      expect(harness).not.toContain(privateStringInput);
      expect(harness).not.toContain('"expected"');
      expect(harness).not.toContain(problem.canonical.python.slice(0, 40));
      expect(harness).toContain(problem.public.functionName);
    }
  });

  it("declares the required container isolation controls and fixed-file staging", async () => {
    const adapterSource = await readFile(
      fileURLToPath(
        new URL("../../services/runner/adapters/docker.ts", import.meta.url),
      ),
      "utf8",
    );
    for (const required of [
      '"--network"',
      '"none"',
      '"--read-only"',
      '"--cap-drop"',
      '"no-new-privileges:true"',
      '"--pids-limit"',
      '"--memory"',
      '"--cpus"',
      '"--ulimit"',
      '"--tmpfs"',
      '"--user"',
    ]) {
      expect(adapterSource).toContain(required);
    }
    expect(adapterSource).not.toContain("shell: true");
    expect(adapterSource).toContain("sourceName, harnessName");
    expect(adapterSource).toContain("limits.runTimeMs");
    expect(adapterSource).toContain("performance.now()");
    expect(adapterSource).toContain("RUNNER_RESOURCE_LABEL");
    expect(adapterSource).not.toContain(
      "runtimeMs += Math.max(0, message.runtimeMs)",
    );
    expect(adapterSource).not.toContain(
      'if (!matches && request.mode === "submit")',
    );
  });
});

describe("runner shutdown", () => {
  it("stops accepting work while allowing an in-flight request to drain", async () => {
    let release!: () => void;
    let entered!: () => void;
    const enteredRequest = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const server = createServer((_request, response) => {
      void (async () => {
        entered();
        await released;
        response.end("done");
      })();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    const responsePromise = fetch(`http://127.0.0.1:${address.port}/work`);
    await enteredRequest;
    const closed = new Promise<void>((resolve) =>
      server.once("close", resolve),
    );
    const shutdown = registerGracefulShutdown(server, 2_000);
    shutdown();
    release();
    expect(await (await responsePromise).text()).toBe("done");
    await closed;
  });
});
