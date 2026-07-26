export const DIFFICULTIES = ["EASY", "MEDIUM", "HARD"] as const;
export type ProblemDifficulty = (typeof DIFFICULTIES)[number];

export const SUPPORTED_LANGUAGES = ["python", "java"] as const;
export type SupportedLanguage = (typeof SUPPORTED_LANGUAGES)[number];

export type ValueType =
  "int" | "long" | "string" | "int[]" | "string[]" | "int[][]" | "string[][]";

export interface ProblemSample {
  readonly input: string;
  readonly output: string;
  readonly explanation?: string;
}

export interface LanguageContract {
  readonly signature: string;
  readonly notes: string;
}

export interface ExecutionLimits {
  /** Aggregate user-code CPU target. The sandbox also applies a wall-clock kill. */
  readonly runTimeMs: number;
  readonly compileTimeMs: number;
  readonly wallTimeMs: number;
  readonly memoryMb: number;
  readonly maxProcesses: number;
  readonly maxOutputBytes: number;
  readonly maxSourceBytes: number;
  readonly maxWorkspaceMb: number;
}

/**
 * Safe to serialize to a browser. Hidden fixtures, comparators, and reference
 * implementations intentionally do not appear in this type or module tree.
 */
export interface PublicProblem {
  readonly id: string;
  readonly version: number;
  readonly title: string;
  readonly difficulty: ProblemDifficulty;
  readonly description: string;
  readonly constraints: readonly string[];
  readonly functionName: string;
  readonly argumentTypes: readonly ValueType[];
  readonly returnType: ValueType;
  readonly contracts: Readonly<Record<SupportedLanguage, LanguageContract>>;
  readonly starterCode: Readonly<Record<SupportedLanguage, string>>;
  readonly samples: readonly ProblemSample[];
  readonly limits: ExecutionLimits;
  readonly comparison: string;
}
