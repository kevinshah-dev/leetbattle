import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PUBLIC_PROBLEMS } from "../../src/problems/public/catalog";
import {
  PUBLIC_PROBLEM_CATALOG,
  listByDifficulty,
} from "../../src/problems/public";
import { compareJudgeOutput } from "../../src/problems/server/compare.server";
import { listServerProblems } from "../../src/problems/server/bank.server";
import type { JudgeValue } from "../../src/problems/server/types.server";

const MOD = 1_000_000_007;

function independentSolution(
  id: string,
  args: readonly JudgeValue[],
): JudgeValue {
  switch (id) {
    case "paired-pulses": {
      const counts = new Map<number, number>();
      for (const value of args[0] as number[])
        counts.set(value, (counts.get(value) ?? 0) + 1);
      return [...counts.values()].reduce(
        (sum, count) => sum + Math.floor(count / 2),
        0,
      );
    }
    case "longest-clear-channel":
      return Math.max(
        0,
        ...(args[0] as string).split("#").map((part) => part.length),
      );
    case "minimum-charge-window": {
      const values = args[0] as number[];
      const threshold = args[1] as number;
      let best = Number.POSITIVE_INFINITY;
      let sum = 0;
      let left = 0;
      for (let right = 0; right < values.length; right += 1) {
        sum += values[right]!;
        while (sum >= threshold) {
          best = Math.min(best, right - left + 1);
          sum -= values[left++]!;
        }
      }
      return Number.isFinite(best) ? best : 0;
    }
    case "archipelago-relays": {
      const map = args[0] as string[];
      const seen = new Set<string>();
      let count = 0;
      for (let row = 0; row < map.length; row += 1) {
        for (let column = 0; column < (map[0]?.length ?? 0); column += 1) {
          const key = `${row},${column}`;
          if (map[row]![column] !== "X" || seen.has(key)) continue;
          count += 1;
          const stack: [number, number][] = [[row, column]];
          seen.add(key);
          while (stack.length > 0) {
            const [currentRow, currentColumn] = stack.pop()!;
            for (const [dr, dc] of [
              [-1, 0],
              [1, 0],
              [0, -1],
              [0, 1],
            ] as const) {
              const nextRow = currentRow + dr;
              const nextColumn = currentColumn + dc;
              const nextKey = `${nextRow},${nextColumn}`;
              if (
                nextRow >= 0 &&
                nextRow < map.length &&
                nextColumn >= 0 &&
                nextColumn < map[0]!.length &&
                map[nextRow]![nextColumn] === "X" &&
                !seen.has(nextKey)
              ) {
                seen.add(nextKey);
                stack.push([nextRow, nextColumn]);
              }
            }
          }
        }
      }
      return count;
    }
    case "callsign-families": {
      const groups = new Map<string, string[]>();
      for (const value of args[0] as string[]) {
        const key = [...value].sort().join("");
        groups.set(key, [...(groups.get(key) ?? []), value]);
      }
      return [...groups.values()];
    }
    case "crystal-vault-route": {
      const vault = args[0] as number[][];
      const columns = vault[0]!.length;
      const dp = Array<number>(columns + 1).fill(Number.POSITIVE_INFINITY);
      dp[columns - 1] = 1;
      for (let row = vault.length - 1; row >= 0; row -= 1) {
        for (let column = columns - 1; column >= 0; column -= 1) {
          dp[column] = Math.max(
            1,
            Math.min(dp[column]!, dp[column + 1]!) - vault[row]![column]!,
          );
        }
      }
      return dp[0]!;
    }
    case "phase-aligned-subsequence": {
      const source = args[0] as string;
      const target = args[1] as string;
      const ways = Array<number>(target.length + 1).fill(0);
      ways[0] = 1;
      for (const character of source) {
        for (let index = target.length - 1; index >= 0; index -= 1) {
          if (target[index] === character)
            ways[index + 1] = (ways[index + 1]! + ways[index]!) % MOD;
        }
      }
      return ways[target.length]!;
    }
    default:
      throw new Error(`Unknown fixture problem ${id}`);
  }
}

describe("public problem catalog", () => {
  it("contains exactly the requested stable difficulty distribution", () => {
    expect(PUBLIC_PROBLEMS).toHaveLength(7);
    expect(listByDifficulty("EASY")).toHaveLength(2);
    expect(listByDifficulty("MEDIUM")).toHaveLength(3);
    expect(listByDifficulty("HARD")).toHaveLength(2);
    expect(
      new Set(PUBLIC_PROBLEMS.map(({ id, version }) => `${id}@${version}`))
        .size,
    ).toBe(7);
    expect(PUBLIC_PROBLEMS.every((problem) => problem.version === 1)).toBe(
      true,
    );
  });

  it("publishes complete contracts, limits, starters, constraints, and three samples", () => {
    for (const problem of PUBLIC_PROBLEMS) {
      expect(problem.description.length).toBeGreaterThan(80);
      expect(problem.constraints.length).toBeGreaterThanOrEqual(3);
      expect(problem.samples.length).toBeGreaterThanOrEqual(3);
      expect(problem.contracts.python.signature).toContain(
        problem.functionName,
      );
      expect(problem.contracts.java.signature).toContain(problem.functionName);
      expect(problem.starterCode.python).toContain("class Solution");
      expect(problem.starterCode.java).toContain("class Solution");
      expect(problem.limits.runTimeMs).toBeGreaterThan(0);
      expect(problem.limits.compileTimeMs).toBeGreaterThan(
        problem.limits.runTimeMs,
      );
      expect(problem.limits.maxSourceBytes).toBeLessThanOrEqual(64 * 1024);
    }
  });

  it("exposes only the client-safe language-key adapter", () => {
    for (const problem of PUBLIC_PROBLEM_CATALOG) {
      expect(problem.contracts.PYTHON.signature).toContain(
        problem.functionName,
      );
      expect(problem.contracts.JAVA.signature).toContain(problem.functionName);
      expect(problem.samples.map((sample) => sample.id)).toEqual([
        "sample-1",
        "sample-2",
        "sample-3",
      ]);
    }
    const serialized = JSON.stringify(PUBLIC_PROBLEM_CATALOG);
    expect(serialized).not.toContain('"hidden"');
    expect(serialized).not.toContain('"canonical"');
    const privatePerformanceInput = listServerProblems()
      .flatMap((problem) => problem.hidden)
      .flatMap((testCase) => testCase.args)
      .find((value) => typeof value === "string" && value.length > 1_000);
    expect(typeof privatePerformanceInput).toBe("string");
    expect(serialized).not.toContain(
      (privatePerformanceInput as string).slice(0, 1_000),
    );
  });

  it("keeps client-safe modules free of server-bank imports", async () => {
    const paths = [
      "../../src/problems/public.ts",
      "../../src/problems/public/catalog.ts",
      "../../src/problems/types.ts",
    ];
    for (const relative of paths) {
      const source = await readFile(
        fileURLToPath(new URL(relative, import.meta.url)),
        "utf8",
      );
      expect(source).not.toMatch(/server\//);
      expect(source).not.toMatch(/bank\.server/);
    }
  });
});

describe("private fixtures", () => {
  it("has at least ten hidden boundary/performance cases per problem", () => {
    const serverProblems = listServerProblems();
    expect(serverProblems).toHaveLength(7);
    for (const problem of serverProblems) {
      expect(problem.samples).toHaveLength(problem.public.samples.length);
      expect(problem.hidden.length).toBeGreaterThanOrEqual(10);
      expect(problem.canonical.python).toContain("class Solution");
      expect(problem.canonical.java).toContain("class Solution");
    }
  });

  it("matches every stored expected value with an independent implementation", () => {
    for (const problem of listServerProblems()) {
      for (const testCase of [...problem.samples, ...problem.hidden]) {
        const actual = independentSolution(problem.public.id, testCase.args);
        expect(
          compareJudgeOutput(problem.comparator, actual, testCase.expected),
          `${problem.public.id} fixture ${JSON.stringify(testCase.args).slice(0, 200)}`,
        ).toBe(true);
      }
    }
  });

  it("normalizes both group order and member order while preserving multiplicity", () => {
    const expected = [["arc", "car"], ["jet"], ["rat", "tar"]];
    expect(
      compareJudgeOutput(
        "unordered-string-groups",
        [["tar", "rat"], ["car", "arc"], ["jet"]],
        expected,
      ),
    ).toBe(true);
    expect(
      compareJudgeOutput(
        "unordered-string-groups",
        [["arc"], ["jet"], ["rat", "tar"]],
        expected,
      ),
    ).toBe(false);
  });
});
