import { getPublicProblem } from "../public/catalog";
import type { JudgeCase, JudgeValue, ServerProblem } from "./types.server";

const MOD = 1_000_000_007;

function fixture(args: readonly JudgeValue[], expected: JudgeValue): JudgeCase {
  return Object.freeze({ args: Object.freeze(args), expected });
}

function requiredPublic(id: string) {
  const problem = getPublicProblem(id, 1);
  if (!problem) throw new Error(`Missing public problem metadata for ${id}@1`);
  return problem;
}

function pairedReference(values: readonly number[]): number {
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  let pairs = 0;
  for (const count of counts.values()) pairs += Math.floor(count / 2);
  return pairs;
}

function longestReference(scan: string): number {
  let best = 0;
  let current = 0;
  for (const character of scan) {
    if (character === "#") current = 0;
    else best = Math.max(best, ++current);
  }
  return best;
}

function windowReference(cells: readonly number[], threshold: number): number {
  let left = 0;
  let sum = 0;
  let best = cells.length + 1;
  for (let right = 0; right < cells.length; right += 1) {
    sum += cells[right]!;
    while (sum >= threshold) {
      best = Math.min(best, right - left + 1);
      sum -= cells[left++]!;
    }
  }
  return best > cells.length ? 0 : best;
}

function islandsReference(relayMap: readonly string[]): number {
  if (relayMap.length === 0) return 0;
  const rows = relayMap.length;
  const columns = relayMap[0]!.length;
  const seen = Array.from({ length: rows }, () =>
    Array<boolean>(columns).fill(false),
  );
  let islands = 0;
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      if (relayMap[row]![column] !== "X" || seen[row]![column]) continue;
      islands += 1;
      seen[row]![column] = true;
      const queue: [number, number][] = [[row, column]];
      for (let index = 0; index < queue.length; index += 1) {
        const [currentRow, currentColumn] = queue[index]!;
        for (const [dr, dc] of [
          [-1, 0],
          [1, 0],
          [0, -1],
          [0, 1],
        ] as const) {
          const nextRow = currentRow + dr;
          const nextColumn = currentColumn + dc;
          if (
            nextRow >= 0 &&
            nextRow < rows &&
            nextColumn >= 0 &&
            nextColumn < columns &&
            !seen[nextRow]![nextColumn] &&
            relayMap[nextRow]![nextColumn] === "X"
          ) {
            seen[nextRow]![nextColumn] = true;
            queue.push([nextRow, nextColumn]);
          }
        }
      }
    }
  }
  return islands;
}

function callsignReference(callsigns: readonly string[]): string[][] {
  const groups = new Map<string, string[]>();
  for (const callsign of callsigns) {
    const counts = Array<number>(26).fill(0);
    for (const character of callsign) {
      const index = character.charCodeAt(0) - 97;
      counts[index] = counts[index]! + 1;
    }
    const key = counts.join(",");
    const group = groups.get(key) ?? [];
    group.push(callsign);
    groups.set(key, group);
  }
  return [...groups.values()];
}

function shieldReference(vault: readonly (readonly number[])[]): number {
  const rows = vault.length;
  const columns = vault[0]!.length;
  const needed = Array.from({ length: rows }, () =>
    Array<number>(columns).fill(0),
  );
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let column = columns - 1; column >= 0; column -= 1) {
      const next =
        row === rows - 1 && column === columns - 1
          ? 1
          : Math.min(
              row + 1 < rows
                ? needed[row + 1]![column]!
                : Number.POSITIVE_INFINITY,
              column + 1 < columns
                ? needed[row]![column + 1]!
                : Number.POSITIVE_INFINITY,
            );
      needed[row]![column] = Math.max(1, next - vault[row]![column]!);
    }
  }
  return needed[0]![0]!;
}

function phaseReference(transmission: string, phase: string): number {
  const ways = Array<number>(phase.length + 1).fill(0);
  ways[0] = 1;
  for (const character of transmission) {
    for (let index = phase.length - 1; index >= 0; index -= 1) {
      if (phase[index] === character)
        ways[index + 1] = (ways[index + 1]! + ways[index]!) % MOD;
    }
  }
  return ways[phase.length]!;
}

const pairedCanonical = {
  python: `class Solution:\n    def pairedPulses(self, pulses: list[int]) -> int:\n        counts = {}\n        for pulse in pulses:\n            counts[pulse] = counts.get(pulse, 0) + 1\n        return sum(count // 2 for count in counts.values())\n`,
  java: `import java.util.*;\n\nclass Solution {\n    public int pairedPulses(int[] pulses) {\n        Map<Integer, Integer> counts = new HashMap<>();\n        for (int pulse : pulses) counts.merge(pulse, 1, Integer::sum);\n        int answer = 0;\n        for (int count : counts.values()) answer += count / 2;\n        return answer;\n    }\n}\n`,
} as const;

const longestCanonical = {
  python: `class Solution:\n    def longestClearChannel(self, scan: str) -> int:\n        best = current = 0\n        for character in scan:\n            if character == '#':\n                current = 0\n            else:\n                current += 1\n                best = max(best, current)\n        return best\n`,
  java: `class Solution {\n    public int longestClearChannel(String scan) {\n        int best = 0, current = 0;\n        for (int i = 0; i < scan.length(); i++) {\n            if (scan.charAt(i) == '#') current = 0;\n            else best = Math.max(best, ++current);\n        }\n        return best;\n    }\n}\n`,
} as const;

const windowCanonical = {
  python: `class Solution:\n    def minimumChargeWindow(self, cells: list[int], threshold: int) -> int:\n        left = total = 0\n        best = len(cells) + 1\n        for right, value in enumerate(cells):\n            total += value\n            while total >= threshold:\n                best = min(best, right - left + 1)\n                total -= cells[left]\n                left += 1\n        return 0 if best > len(cells) else best\n`,
  java: `class Solution {\n    public int minimumChargeWindow(int[] cells, int threshold) {\n        int left = 0, best = cells.length + 1;\n        long total = 0;\n        for (int right = 0; right < cells.length; right++) {\n            total += cells[right];\n            while (total >= threshold) {\n                best = Math.min(best, right - left + 1);\n                total -= cells[left++];\n            }\n        }\n        return best > cells.length ? 0 : best;\n    }\n}\n`,
} as const;

const islandsCanonical = {
  python: `from collections import deque\n\nclass Solution:\n    def countRelayIslands(self, relayMap: list[str]) -> int:\n        if not relayMap:\n            return 0\n        rows, columns = len(relayMap), len(relayMap[0])\n        seen = set()\n        answer = 0\n        for row in range(rows):\n            for column in range(columns):\n                if relayMap[row][column] != 'X' or (row, column) in seen:\n                    continue\n                answer += 1\n                seen.add((row, column))\n                queue = deque([(row, column)])\n                while queue:\n                    current_row, current_column = queue.popleft()\n                    for dr, dc in ((-1, 0), (1, 0), (0, -1), (0, 1)):\n                        nr, nc = current_row + dr, current_column + dc\n                        if 0 <= nr < rows and 0 <= nc < columns and relayMap[nr][nc] == 'X' and (nr, nc) not in seen:\n                            seen.add((nr, nc))\n                            queue.append((nr, nc))\n        return answer\n`,
  java: `import java.util.*;\n\nclass Solution {\n    public int countRelayIslands(String[] relayMap) {\n        if (relayMap.length == 0) return 0;\n        int rows = relayMap.length, columns = relayMap[0].length(), answer = 0;\n        boolean[][] seen = new boolean[rows][columns];\n        int[][] directions = {{-1, 0}, {1, 0}, {0, -1}, {0, 1}};\n        for (int row = 0; row < rows; row++) {\n            for (int column = 0; column < columns; column++) {\n                if (relayMap[row].charAt(column) != 'X' || seen[row][column]) continue;\n                answer++;\n                ArrayDeque<int[]> queue = new ArrayDeque<>();\n                queue.add(new int[]{row, column});\n                seen[row][column] = true;\n                while (!queue.isEmpty()) {\n                    int[] current = queue.remove();\n                    for (int[] direction : directions) {\n                        int nr = current[0] + direction[0], nc = current[1] + direction[1];\n                        if (nr >= 0 && nr < rows && nc >= 0 && nc < columns && !seen[nr][nc] && relayMap[nr].charAt(nc) == 'X') {\n                            seen[nr][nc] = true;\n                            queue.add(new int[]{nr, nc});\n                        }\n                    }\n                }\n            }\n        }\n        return answer;\n    }\n}\n`,
} as const;

const callsignCanonical = {
  python: `class Solution:\n    def groupCallsigns(self, callsigns: list[str]) -> list[list[str]]:\n        groups = {}\n        for callsign in callsigns:\n            counts = [0] * 26\n            for character in callsign:\n                counts[ord(character) - ord('a')] += 1\n            groups.setdefault(tuple(counts), []).append(callsign)\n        return list(groups.values())\n`,
  java: `import java.util.*;\n\nclass Solution {\n    public List<List<String>> groupCallsigns(String[] callsigns) {\n        Map<String, List<String>> groups = new LinkedHashMap<>();\n        for (String callsign : callsigns) {\n            int[] counts = new int[26];\n            for (int i = 0; i < callsign.length(); i++) counts[callsign.charAt(i) - 'a']++;\n            groups.computeIfAbsent(Arrays.toString(counts), ignored -> new ArrayList<>()).add(callsign);\n        }\n        return new ArrayList<>(groups.values());\n    }\n}\n`,
} as const;

const shieldCanonical = {
  python: `class Solution:\n    def minimumInitialShield(self, vault: list[list[int]]) -> int:\n        rows, columns = len(vault), len(vault[0])\n        needed = [float('inf')] * (columns + 1)\n        needed[columns - 1] = 1\n        for row in range(rows - 1, -1, -1):\n            for column in range(columns - 1, -1, -1):\n                needed[column] = max(1, min(needed[column], needed[column + 1]) - vault[row][column])\n        return needed[0]\n`,
  java: `import java.util.*;\n\nclass Solution {\n    public int minimumInitialShield(int[][] vault) {\n        int columns = vault[0].length;\n        int[] needed = new int[columns + 1];\n        Arrays.fill(needed, Integer.MAX_VALUE / 2);\n        needed[columns - 1] = 1;\n        for (int row = vault.length - 1; row >= 0; row--) {\n            for (int column = columns - 1; column >= 0; column--) {\n                needed[column] = Math.max(1, Math.min(needed[column], needed[column + 1]) - vault[row][column]);\n            }\n        }\n        return needed[0];\n    }\n}\n`,
} as const;

const phaseCanonical = {
  python: `class Solution:\n    def countPhaseAlignments(self, transmission: str, phase: str) -> int:\n        modulus = 1_000_000_007\n        ways = [0] * (len(phase) + 1)\n        ways[0] = 1\n        for character in transmission:\n            for index in range(len(phase) - 1, -1, -1):\n                if phase[index] == character:\n                    ways[index + 1] = (ways[index + 1] + ways[index]) % modulus\n        return ways[-1]\n`,
  java: `class Solution {\n    public int countPhaseAlignments(String transmission, String phase) {\n        final long modulus = 1_000_000_007L;\n        long[] ways = new long[phase.length() + 1];\n        ways[0] = 1;\n        for (int source = 0; source < transmission.length(); source++) {\n            for (int target = phase.length() - 1; target >= 0; target--) {\n                if (phase.charAt(target) == transmission.charAt(source)) {\n                    ways[target + 1] = (ways[target + 1] + ways[target]) % modulus;\n                }\n            }\n        }\n        return (int) ways[phase.length()];\n    }\n}\n`,
} as const;

const pairedLarge = Array<number>(100_000).fill(8);
const pairedDoubles = Array.from({ length: 20_000 }, (_, index) =>
  Math.floor(index / 2),
);
const longClear = "A".repeat(200_000);
const longSplit = `${"Q".repeat(99_999)}#${"Z".repeat(100_000)}`;
const longCells = Array<number>(200_000).fill(1);
const checkerboard = Array.from({ length: 60 }, (_, row) =>
  Array.from({ length: 60 }, (_, column) =>
    (row + column) % 2 === 0 ? "X" : ".",
  ).join(""),
);
const solidMap = Array<string>(200).fill("X".repeat(200));
// Large enough to catch quadratic grouping while keeping a valid return value
// below the judge's intentionally small output ceiling.
const manyCallsigns = Array.from({ length: 3_000 }, (_, index) =>
  index % 3 === 0 ? "algorithm" : index % 3 === 1 ? "logarithm" : "rhythms",
);
const harshVault = Array.from({ length: 200 }, () =>
  Array<number>(200).fill(-1_000),
);
const generousVault = Array.from({ length: 200 }, () =>
  Array<number>(200).fill(1_000),
);
const longTransmission = "A".repeat(4_000);
const longPhase = "A".repeat(300);

const SERVER_PROBLEMS = [
  {
    public: requiredPublic("paired-pulses"),
    comparator: "exact",
    samples: [
      fixture([[4, 9, 4, 2, 9, 9]], 2),
      fixture([[]], 0),
      fixture([[7, 7, 7, 7, 7]], 2),
    ],
    hidden: [
      fixture([[1]], 0),
      fixture([[0, 0]], 1),
      fixture([[-1, -1, -1, 2, 2, 2, 2]], 3),
      fixture([[1, 2, 3, 4, 5, 6]], 0),
      fixture(
        [[-1_000_000_000, -1_000_000_000, 1_000_000_000, 1_000_000_000]],
        2,
      ),
      fixture([[5, 5, 5, 6, 6, 7, 7, 7, 7, 7]], 4),
      fixture([[3, 3, 4, 4, 5, 5, 6]], 3),
      fixture([[10, -10, 10, -10, 0, 0, 0]], 3),
      fixture([pairedLarge], pairedReference(pairedLarge)),
      fixture([pairedDoubles], pairedReference(pairedDoubles)),
      fixture([[42, 42, 42]], 1),
      fixture([[9, 8, 9, 8, 9, 8, 9, 8]], 4),
    ],
    canonical: pairedCanonical,
  },
  {
    public: requiredPublic("longest-clear-channel"),
    comparator: "exact",
    samples: [
      fixture(["AB7#Q2#SIGNAL"], 6),
      fixture(["#####"], 0),
      fixture(["CLEAR9"], 6),
    ],
    hidden: [
      fixture([""], 0),
      fixture(["#"], 0),
      fixture(["A"], 1),
      fixture(["#ABC"], 3),
      fixture(["ABC#"], 3),
      fixture(["A##BC###D"], 2),
      fixture(["1#22#333#44"], 3),
      fixture(["A#BCDE#FGH"], 4),
      fixture([longClear], longestReference(longClear)),
      fixture([longSplit], longestReference(longSplit)),
      fixture(["#A#B#C#D#"], 1),
      fixture(["AB12CD34##Z"], 8),
    ],
    canonical: longestCanonical,
  },
  {
    public: requiredPublic("minimum-charge-window"),
    comparator: "exact",
    samples: [
      fixture([[2, 1, 5, 2, 3], 7], 2),
      fixture([[1, 1, 1], 8], 0),
      fixture([[9, 1, 1], 9], 1),
    ],
    hidden: [
      fixture([[1], 1], 1),
      fixture([[1], 2], 0),
      fixture([[2, 3, 1, 2, 4, 3], 7], 2),
      fixture([[5, 1, 1, 1, 5], 8], 4),
      fixture([[1, 2, 3, 4, 5], 15], 5),
      fixture([[100, 1, 1], 99], 1),
      fixture([[1_000_000, 1_000_000], 1_000_000_000], 0),
      fixture([[6, 1, 1, 1, 6], 7], 2),
      fixture([longCells, 200_000], windowReference(longCells, 200_000)),
      fixture([longCells, 199_999], windowReference(longCells, 199_999)),
      fixture([[10, 2, 3], 5], 1),
      fixture([[3, 1, 3, 1, 3], 6], 3),
    ],
    canonical: windowCanonical,
  },
  {
    public: requiredPublic("archipelago-relays"),
    comparator: "exact",
    samples: [
      fixture([["XX..", ".X..", "...X"]], 2),
      fixture([["...."]], 0),
      fixture([["X.X", ".X.", "X.X"]], 5),
    ],
    hidden: [
      fixture([[]], 0),
      fixture([["X"]], 1),
      fixture([["."]], 0),
      fixture([["XX", "XX"]], 1),
      fixture([["X.", ".X"]], 2),
      fixture([["XXX", "...", "XXX"]], 2),
      fixture([["X.X.X"]], 3),
      fixture([["X", ".", "X", "X"]], 2),
      fixture([checkerboard], islandsReference(checkerboard)),
      fixture([solidMap], islandsReference(solidMap)),
      fixture([["XXXXX", "X...X", "X.X.X", "X...X", "XXXXX"]], 2),
      fixture([[".XX.", "XX..", "..XX", ".XX."]], 2),
    ],
    canonical: islandsCanonical,
  },
  {
    public: requiredPublic("callsign-families"),
    comparator: "unordered-string-groups",
    samples: [
      fixture(
        [["arc", "car", "jet", "rat", "tar"]],
        [["arc", "car"], ["jet"], ["rat", "tar"]],
      ),
      fixture([[]], []),
      fixture([["aa", "aa", "a"]], [["aa", "aa"], ["a"]]),
    ],
    hidden: [
      fixture([["a"]], [["a"]]),
      fixture([["ab", "ba"]], [["ab", "ba"]]),
      fixture([["ab", "abc", "cab", "b"]], [["ab"], ["abc", "cab"], ["b"]]),
      fixture([["zzz", "zzz", "zzz"]], [["zzz", "zzz", "zzz"]]),
      fixture(
        [["listen", "silent", "enlist", "stone", "tones"]],
        [
          ["listen", "silent", "enlist"],
          ["stone", "tones"],
        ],
      ),
      fixture([["x", "y", "z"]], [["x"], ["y"], ["z"]]),
      fixture([["abb", "bab", "bba", "ab"]], [["abb", "bab", "bba"], ["ab"]]),
      fixture([["abc", "cba", "abc", "bac"]], [["abc", "cba", "abc", "bac"]]),
      fixture([manyCallsigns], callsignReference(manyCallsigns)),
      fixture(
        [["abcdefghijklmnopqrstuvwxyz", "zyxwvutsrqponmlkjihgfedcba"]],
        [["abcdefghijklmnopqrstuvwxyz", "zyxwvutsrqponmlkjihgfedcba"]],
      ),
      fixture(
        [["aaab", "abaa", "baaa", "aaaa"]],
        [["aaab", "abaa", "baaa"], ["aaaa"]],
      ),
      fixture(
        [["orbit", "robot", "broom", "room", "moor"]],
        [["orbit"], ["robot"], ["broom"], ["room", "moor"]],
      ),
    ],
    canonical: callsignCanonical,
  },
  {
    public: requiredPublic("crystal-vault-route"),
    comparator: "exact",
    samples: [
      fixture(
        [
          [
            [-2, -3, 3],
            [-5, -10, 1],
            [10, 30, -5],
          ],
        ],
        7,
      ),
      fixture([[[5]]], 1),
      fixture([[[-8]]], 9),
    ],
    hidden: [
      fixture([[[0]]], 1),
      fixture([[[-1, -2, -3]]], 7),
      fixture([[[-1], [-2], [-3]]], 7),
      fixture(
        [
          [
            [1, -5],
            [2, -2],
          ],
        ],
        1,
      ),
      fixture(
        [
          [
            [-5, 100],
            [-2, -2],
          ],
        ],
        6,
      ),
      fixture(
        [
          [
            [0, 0],
            [0, 0],
          ],
        ],
        1,
      ),
      fixture(
        [
          [
            [-1000, 1000],
            [-1000, -1000],
          ],
        ],
        1001,
      ),
      fixture(
        [
          [
            [10, -20, 10],
            [-5, -5, -5],
            [20, 20, -30],
          ],
        ],
        1,
      ),
      fixture([harshVault], shieldReference(harshVault)),
      fixture([generousVault], shieldReference(generousVault)),
      fixture(
        [
          [
            [-2, 10],
            [-20, -1],
          ],
        ],
        3,
      ),
      fixture(
        [
          [
            [3, -4, -5],
            [-2, 8, -10],
          ],
        ],
        2,
      ),
    ],
    canonical: shieldCanonical,
  },
  {
    public: requiredPublic("phase-aligned-subsequence"),
    comparator: "exact",
    samples: [
      fixture(["ABAC", "AC"], 2),
      fixture(["AAAA", "AA"], 6),
      fixture(["SIGNAL", "ZZ"], 0),
    ],
    hidden: [
      fixture(["", ""], 1),
      fixture(["ABC", ""], 1),
      fixture(["", "A"], 0),
      fixture(["ABC", "ABC"], 1),
      fixture(["ABC", "ABCD"], 0),
      fixture(["ABCABC", "ABC"], phaseReference("ABCABC", "ABC")),
      fixture(["AAAAAAAAAA", "AAAAA"], 252),
      fixture(["BANANAS", "ANA"], phaseReference("BANANAS", "ANA")),
      fixture(["XYZXYZXYZ", "XYZ"], phaseReference("XYZXYZXYZ", "XYZ")),
      fixture(
        [longTransmission, longPhase],
        phaseReference(longTransmission, longPhase),
      ),
      fixture(
        ["AB".repeat(2_000), "AB".repeat(150)],
        phaseReference("AB".repeat(2_000), "AB".repeat(150)),
      ),
      fixture(["MISSISSIPPI", "ISI"], phaseReference("MISSISSIPPI", "ISI")),
    ],
    canonical: phaseCanonical,
  },
] as const satisfies readonly ServerProblem[];

const byKey = new Map(
  SERVER_PROBLEMS.map((problem) => [
    `${problem.public.id}@${problem.public.version}`,
    problem,
  ]),
);

export function getServerProblem(
  id: string,
  version: number,
): ServerProblem | undefined {
  return byKey.get(`${id}@${version}`);
}

/** Exported only for trusted runner and server-side fixture verification. */
export function listServerProblems(): readonly ServerProblem[] {
  return SERVER_PROBLEMS;
}
