import type { ProblemDifficulty, PublicProblem } from "../types";

const standardLimits = {
  compileTimeMs: 12_000,
  wallTimeMs: 4_000,
  memoryMb: 256,
  maxProcesses: 48,
  maxOutputBytes: 64 * 1024,
  maxSourceBytes: 64 * 1024,
  maxWorkspaceMb: 32,
} as const;

const problems = [
  {
    id: "paired-pulses",
    version: 1,
    title: "Paired Pulses",
    difficulty: "EASY",
    description:
      "A relay stores integer pulse codes. Two pulses with the same code can power one link, and each pulse can be used at most once. Return the maximum number of links the relay can power.",
    constraints: [
      "0 <= pulses.length <= 100,000",
      "-1,000,000,000 <= pulses[i] <= 1,000,000,000",
      "The input array may contain repeated and negative codes.",
    ],
    functionName: "pairedPulses",
    argumentTypes: ["int[]"],
    returnType: "int",
    contracts: {
      python: {
        signature: "def pairedPulses(self, pulses: list[int]) -> int",
        notes:
          "Implement the method on class Solution. Do not read stdin or print the result.",
      },
      java: {
        signature: "public int pairedPulses(int[] pulses)",
        notes: "Implement the method on class Solution in the default package.",
      },
    },
    starterCode: {
      python: `class Solution:\n    def pairedPulses(self, pulses: list[int]) -> int:\n        # Return the maximum number of disjoint equal-code pairs.\n        pass\n`,
      java: `class Solution {\n    public int pairedPulses(int[] pulses) {\n        // Return the maximum number of disjoint equal-code pairs.\n        return 0;\n    }\n}\n`,
    },
    samples: [
      {
        input: "pulses = [4, 9, 4, 2, 9, 9]",
        output: "2",
        explanation: "One pair uses code 4 and one uses code 9.",
      },
      { input: "pulses = []", output: "0" },
      {
        input: "pulses = [7, 7, 7, 7, 7]",
        output: "2",
        explanation: "Four of the five pulses form two links.",
      },
    ],
    limits: { ...standardLimits, runTimeMs: 1_200, wallTimeMs: 3_000 },
    comparison: "The returned integer must match exactly.",
  },
  {
    id: "longest-clear-channel",
    version: 1,
    title: "Longest Clear Channel",
    difficulty: "EASY",
    description:
      "A scan is written as uppercase letters and digits, with # marking jammed positions. Return the length of the longest contiguous stretch containing no jammed position.",
    constraints: [
      "0 <= scan.length <= 200,000",
      "scan contains only A-Z, 0-9, and #.",
      "An empty scan has a clear-channel length of 0.",
    ],
    functionName: "longestClearChannel",
    argumentTypes: ["string"],
    returnType: "int",
    contracts: {
      python: {
        signature: "def longestClearChannel(self, scan: str) -> int",
        notes:
          "Implement the method on class Solution. Treat every # as a separator.",
      },
      java: {
        signature: "public int longestClearChannel(String scan)",
        notes: "Implement the method on class Solution in the default package.",
      },
    },
    starterCode: {
      python: `class Solution:\n    def longestClearChannel(self, scan: str) -> int:\n        # Return the longest run that contains no '#'.\n        pass\n`,
      java: `class Solution {\n    public int longestClearChannel(String scan) {\n        // Return the longest run that contains no '#'.\n        return 0;\n    }\n}\n`,
    },
    samples: [
      { input: 'scan = "AB7#Q2#SIGNAL"', output: "6" },
      { input: 'scan = "#####"', output: "0" },
      { input: 'scan = "CLEAR9"', output: "6" },
    ],
    limits: { ...standardLimits, runTimeMs: 1_000, wallTimeMs: 3_000 },
    comparison: "The returned integer must match exactly.",
  },
  {
    id: "minimum-charge-window",
    version: 1,
    title: "Minimum Charge Window",
    difficulty: "MEDIUM",
    description:
      "Positive charge cells are arranged in a line. Find the shortest contiguous window whose total charge reaches at least the requested threshold. Return 0 when no window can reach it.",
    constraints: [
      "1 <= cells.length <= 200,000",
      "1 <= cells[i] <= 1,000,000",
      "1 <= threshold <= 1,000,000,000",
    ],
    functionName: "minimumChargeWindow",
    argumentTypes: ["int[]", "int"],
    returnType: "int",
    contracts: {
      python: {
        signature:
          "def minimumChargeWindow(self, cells: list[int], threshold: int) -> int",
        notes:
          "Implement the method on class Solution and return a window length.",
      },
      java: {
        signature: "public int minimumChargeWindow(int[] cells, int threshold)",
        notes: "Implement the method on class Solution in the default package.",
      },
    },
    starterCode: {
      python: `class Solution:\n    def minimumChargeWindow(self, cells: list[int], threshold: int) -> int:\n        # Return the shortest qualifying contiguous window, or 0.\n        pass\n`,
      java: `class Solution {\n    public int minimumChargeWindow(int[] cells, int threshold) {\n        // Return the shortest qualifying contiguous window, or 0.\n        return 0;\n    }\n}\n`,
    },
    samples: [
      { input: "cells = [2, 1, 5, 2, 3], threshold = 7", output: "2" },
      { input: "cells = [1, 1, 1], threshold = 8", output: "0" },
      { input: "cells = [9, 1, 1], threshold = 9", output: "1" },
    ],
    limits: { ...standardLimits, runTimeMs: 1_500, wallTimeMs: 3_500 },
    comparison: "The returned integer must match exactly.",
  },
  {
    id: "archipelago-relays",
    version: 1,
    title: "Archipelago Relays",
    difficulty: "MEDIUM",
    description:
      "A map uses X for relay-capable land and . for water. Land cells connected vertically or horizontally share one relay network. Return the number of separate networks.",
    constraints: [
      "0 <= map.length <= 300",
      "When nonempty, 1 <= map[i].length <= 300 and all rows have equal length.",
      "Every character is X or .; diagonal cells are not connected.",
    ],
    functionName: "countRelayIslands",
    argumentTypes: ["string[]"],
    returnType: "int",
    contracts: {
      python: {
        signature: "def countRelayIslands(self, relayMap: list[str]) -> int",
        notes:
          "Implement the method on class Solution. The input strings are immutable.",
      },
      java: {
        signature: "public int countRelayIslands(String[] relayMap)",
        notes: "Implement the method on class Solution in the default package.",
      },
    },
    starterCode: {
      python: `class Solution:\n    def countRelayIslands(self, relayMap: list[str]) -> int:\n        # Count 4-directionally connected groups of 'X'.\n        pass\n`,
      java: `class Solution {\n    public int countRelayIslands(String[] relayMap) {\n        // Count 4-directionally connected groups of 'X'.\n        return 0;\n    }\n}\n`,
    },
    samples: [
      { input: 'relayMap = ["XX..", ".X..", "...X"]', output: "2" },
      { input: 'relayMap = ["...."]', output: "0" },
      { input: 'relayMap = ["X.X", ".X.", "X.X"]', output: "5" },
    ],
    limits: { ...standardLimits, runTimeMs: 1_800, wallTimeMs: 4_000 },
    comparison: "The returned integer must match exactly.",
  },
  {
    id: "callsign-families",
    version: 1,
    title: "Callsign Families",
    difficulty: "MEDIUM",
    description:
      "Pilots belong to the same callsign family when their lowercase callsigns use exactly the same letters with the same multiplicities. Group every callsign by family.",
    constraints: [
      "0 <= callsigns.length <= 20,000",
      "1 <= callsigns[i].length <= 40",
      "Each callsign contains only lowercase a-z; duplicate callsigns remain duplicate entries.",
    ],
    functionName: "groupCallsigns",
    argumentTypes: ["string[]"],
    returnType: "string[][]",
    contracts: {
      python: {
        signature:
          "def groupCallsigns(self, callsigns: list[str]) -> list[list[str]]",
        notes:
          "Groups and entries within each group may be returned in any order.",
      },
      java: {
        signature:
          "public java.util.List<java.util.List<String>> groupCallsigns(String[] callsigns)",
        notes:
          "Groups and entries within each group may be returned in any order.",
      },
    },
    starterCode: {
      python: `class Solution:\n    def groupCallsigns(self, callsigns: list[str]) -> list[list[str]]:\n        # Groups and group members may be returned in any order.\n        pass\n`,
      java: `import java.util.*;\n\nclass Solution {\n    public List<List<String>> groupCallsigns(String[] callsigns) {\n        // Groups and group members may be returned in any order.\n        return new ArrayList<>();\n    }\n}\n`,
    },
    samples: [
      {
        input: 'callsigns = ["arc", "car", "jet", "rat", "tar"]',
        output:
          '[["arc", "car"], ["jet"], ["rat", "tar"]] (group order ignored)',
      },
      { input: "callsigns = []", output: "[]" },
      {
        input: 'callsigns = ["aa", "aa", "a"]',
        output: '[["aa", "aa"], ["a"]]',
      },
    ],
    limits: { ...standardLimits, runTimeMs: 2_000, wallTimeMs: 4_000 },
    comparison:
      "Order is irrelevant both between groups and within each group. Multiplicity is significant.",
  },
  {
    id: "crystal-vault-route",
    version: 1,
    title: "Crystal Vault Route",
    difficulty: "HARD",
    description:
      "A vault is a rectangular grid. Entering a room changes your shield by that room's signed value. Starting at the upper-left, move only right or down to the lower-right. Find the smallest initial shield that allows one route while the shield stays at least 1 after every room.",
    constraints: [
      "1 <= vault.length, vault[i].length <= 200",
      "All rows have equal length.",
      "-1,000 <= vault[i][j] <= 1,000",
    ],
    functionName: "minimumInitialShield",
    argumentTypes: ["int[][]"],
    returnType: "int",
    contracts: {
      python: {
        signature:
          "def minimumInitialShield(self, vault: list[list[int]]) -> int",
        notes:
          "Implement the method on class Solution. Shield is adjusted in the first room too.",
      },
      java: {
        signature: "public int minimumInitialShield(int[][] vault)",
        notes: "Implement the method on class Solution in the default package.",
      },
    },
    starterCode: {
      python: `class Solution:\n    def minimumInitialShield(self, vault: list[list[int]]) -> int:\n        # Return the minimum shield before entering the first room.\n        pass\n`,
      java: `class Solution {\n    public int minimumInitialShield(int[][] vault) {\n        // Return the minimum shield before entering the first room.\n        return 0;\n    }\n}\n`,
    },
    samples: [
      {
        input: "vault = [[-2, -3, 3], [-5, -10, 1], [10, 30, -5]]",
        output: "7",
      },
      { input: "vault = [[5]]", output: "1" },
      { input: "vault = [[-8]]", output: "9" },
    ],
    limits: { ...standardLimits, runTimeMs: 2_000, wallTimeMs: 4_000 },
    comparison: "The returned integer must match exactly.",
  },
  {
    id: "phase-aligned-subsequence",
    version: 1,
    title: "Phase-Aligned Subsequences",
    difficulty: "HARD",
    description:
      "Count how many index subsequences of a transmission spell a target phase code. Indices must increase, but need not be adjacent. Return the count modulo 1,000,000,007.",
    constraints: [
      "0 <= transmission.length <= 4,000",
      "0 <= phase.length <= 300",
      "Both strings contain only uppercase A-Z.",
      "The empty phase occurs once in every transmission.",
    ],
    functionName: "countPhaseAlignments",
    argumentTypes: ["string", "string"],
    returnType: "int",
    contracts: {
      python: {
        signature:
          "def countPhaseAlignments(self, transmission: str, phase: str) -> int",
        notes:
          "Implement the method on class Solution and return the result modulo 1,000,000,007.",
      },
      java: {
        signature:
          "public int countPhaseAlignments(String transmission, String phase)",
        notes:
          "Implement the method on class Solution and return the result modulo 1,000,000,007.",
      },
    },
    starterCode: {
      python: `class Solution:\n    def countPhaseAlignments(self, transmission: str, phase: str) -> int:\n        # Count matching index subsequences modulo 1_000_000_007.\n        pass\n`,
      java: `class Solution {\n    public int countPhaseAlignments(String transmission, String phase) {\n        // Count matching index subsequences modulo 1_000_000_007.\n        return 0;\n    }\n}\n`,
    },
    samples: [
      { input: 'transmission = "ABAC", phase = "AC"', output: "2" },
      { input: 'transmission = "AAAA", phase = "AA"', output: "6" },
      { input: 'transmission = "SIGNAL", phase = "ZZ"', output: "0" },
    ],
    limits: { ...standardLimits, runTimeMs: 2_500, wallTimeMs: 4_500 },
    comparison: "The returned integer modulo 1,000,000,007 must match exactly.",
  },
] as const satisfies readonly PublicProblem[];

export const PUBLIC_PROBLEMS: readonly PublicProblem[] =
  Object.freeze(problems);

export function listPublicProblemsByDifficulty(
  difficulty: ProblemDifficulty,
): readonly PublicProblem[] {
  return PUBLIC_PROBLEMS.filter((problem) => problem.difficulty === difficulty);
}

export function getPublicProblem(
  id: string,
  version?: number,
): PublicProblem | undefined {
  return PUBLIC_PROBLEMS.find(
    (problem) =>
      problem.id === id &&
      (version === undefined || problem.version === version),
  );
}
