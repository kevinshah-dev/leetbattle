import type { PublicProblem, SupportedLanguage } from "../types";

export type JudgeScalar = string | number | boolean | null;
export type JudgeValue = JudgeScalar | JudgeValue[];

export interface JudgeCase {
  readonly args: readonly JudgeValue[];
  readonly expected: JudgeValue;
}

export type ComparatorKind = "exact" | "unordered-string-groups";

/** This entire shape is server-only and must never be serialized to clients. */
export interface ServerProblem {
  readonly public: PublicProblem;
  readonly comparator: ComparatorKind;
  readonly samples: readonly JudgeCase[];
  readonly hidden: readonly JudgeCase[];
  readonly canonical: Readonly<Record<SupportedLanguage, string>>;
}
