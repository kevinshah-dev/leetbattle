import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

import {
  DockerRunnerAdapter,
  isDockerAvailable,
} from "../../services/runner/adapters/docker";
import type { AdapterExecutionRequest } from "../../services/runner/types";
import {
  listServerProblems,
  getServerProblem,
} from "../../src/problems/server/bank.server";
import type { ServerProblem } from "../../src/problems/server/types.server";
import type { SupportedLanguage } from "../../src/problems/types";

const execFileAsync = promisify(execFile);
const dockerAvailable = await isDockerAvailable();
const imagesAvailable = dockerAvailable
  ? await Promise.all(
      ["leetbattle-python-runner:3.13", "leetbattle-java-runner:21"].map(
        async (image) => {
          try {
            await execFileAsync("docker", ["image", "inspect", image], {
              timeout: 3_000,
            });
            return true;
          } catch {
            return false;
          }
        },
      ),
    ).then((values) => values.every(Boolean))
  : false;
const sandboxAvailable = dockerAvailable && imagesAvailable;

function job(
  problem: ServerProblem,
  language: SupportedLanguage,
  source: string,
  mode: "samples" | "submit" = "submit",
): AdapterExecutionRequest {
  return {
    executionId: `docker_${language}_${problem.public.id.replaceAll("-", "_")}`,
    language,
    mode,
    source,
    problem,
    cases: mode === "samples" ? problem.samples : problem.hidden,
  };
}

function withShortRuntimeLimit(
  problem: ServerProblem,
  runTimeMs = 200,
): ServerProblem {
  return {
    ...problem,
    public: {
      ...problem.public,
      limits: {
        ...problem.public.limits,
        compileTimeMs: 6_000,
        runTimeMs,
        wallTimeMs: 2_000,
      },
    },
  };
}

describe.skipIf(!sandboxAvailable)(
  "Docker sandbox integration (skipped unless Docker and both pinned runner images are available)",
  () => {
    const adapter = new DockerRunnerAdapter();

    it("accepts both canonical language solutions for all seven problems", async () => {
      for (const problem of listServerProblems()) {
        for (const language of ["python", "java"] as const) {
          const judged = await adapter.execute(
            job(problem, language, problem.canonical[language]),
          );
          expect(judged, `${problem.public.id} ${language}`).toMatchObject({
            verdict: "accepted",
            passed: problem.hidden.length,
            total: problem.hidden.length,
          });
        }
      }
    }, 240_000);

    it("rejects deterministic wrong answers without returning hidden values", async () => {
      const problem = getServerProblem("paired-pulses", 1)!;
      const judged = await adapter.execute(
        job(
          problem,
          "python",
          "class Solution:\n    def pairedPulses(self, pulses):\n        return 999999\n",
        ),
      );
      expect(judged.verdict).toBe("wrong_answer");
      expect(judged.passed).toBe(0);
      expect(judged).not.toHaveProperty("samples");
    }, 30_000);

    it.each([
      [
        "python",
        "class Solution:\n  def pairedPulses(self, pulses)\n    return 0\n",
      ],
      [
        "java",
        "class Solution { public int pairedPulses(int[] pulses) { return ; } }",
      ],
    ] as const)(
      "reports a generic %s compilation error",
      async (language, source) => {
        const problem = getServerProblem("paired-pulses", 1)!;
        const judged = await adapter.execute(job(problem, language, source));
        expect(judged).toMatchObject({
          verdict: "compile_error",
          message: "The source could not be compiled.",
        });
        expect(JSON.stringify(judged)).not.toMatch(
          /SyntaxError|javac|line \d/i,
        );
      },
      30_000,
    );

    it("reports runtime errors without a stack trace", async () => {
      const problem = getServerProblem("paired-pulses", 1)!;
      const judged = await adapter.execute(
        job(
          problem,
          "python",
          "class Solution:\n    def pairedPulses(self, pulses):\n        raise RuntimeError('SECRET_TRACE')\n",
        ),
      );
      expect(judged.verdict).toBe("runtime_error");
      expect(JSON.stringify(judged)).not.toContain("SECRET_TRACE");
    }, 30_000);

    it("uses the trusted aggregate runtime limit despite a monkeypatched user clock", async () => {
      const problem = withShortRuntimeLimit(
        getServerProblem("paired-pulses", 1)!,
      );
      const judged = await adapter.execute(
        job(
          problem,
          "python",
          "import time\ntime.perf_counter_ns = lambda: 0\nclass Solution:\n    def pairedPulses(self, pulses):\n        while True: pass\n",
        ),
      );
      expect(judged.verdict).toBe("time_limit");
    }, 20_000);

    it("caps ordinary and low-level excessive output", async () => {
      const problem = getServerProblem("paired-pulses", 1)!;
      const ordinary = await adapter.execute(
        job(
          problem,
          "python",
          "class Solution:\n    def pairedPulses(self, pulses):\n        print('x' * 100000)\n        return 0\n",
        ),
      );
      expect(ordinary.verdict).toBe("output_limit");
      const lowLevel = await adapter.execute(
        job(
          problem,
          "python",
          "import os\nclass Solution:\n    def pairedPulses(self, pulses):\n        os.write(1, b'x' * 100000)\n        return 0\n",
        ),
      );
      expect(lowLevel.verdict).toBe("output_limit");
    }, 45_000);

    it("classifies memory pressure as a memory-limit verdict", async () => {
      const problem = getServerProblem("paired-pulses", 1)!;
      const judged = await adapter.execute(
        job(
          problem,
          "python",
          "class Solution:\n    def pairedPulses(self, pulses):\n        value = bytearray(400 * 1024 * 1024)\n        return len(value)\n",
        ),
      );
      expect(judged.verdict).toBe("memory_limit");
    }, 30_000);

    it("blocks outbound network access", async () => {
      const problem = getServerProblem("paired-pulses", 1)!;
      const source = `import socket
class Solution:
    def pairedPulses(self, pulses):
        connection = socket.create_connection(("1.1.1.1", 80), timeout=0.2)
        connection.close()
        return 0
`;
      const judged = await adapter.execute(job(problem, "python", source));
      expect(judged.verdict).toBe("runtime_error");
    }, 30_000);
  },
);
