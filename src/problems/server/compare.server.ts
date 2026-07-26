import type { ComparatorKind, JudgeValue } from "./types.server";

function isJudgeValue(value: unknown, depth = 0): value is JudgeValue {
  if (depth > 100) return false;
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isSafeInteger(value))
  ) {
    return true;
  }
  return (
    Array.isArray(value) &&
    value.every((entry) => isJudgeValue(entry, depth + 1))
  );
}

function exactKey(value: JudgeValue): string {
  return JSON.stringify(value);
}

function unorderedStringGroupsKey(value: JudgeValue): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const normalized: string[][] = [];
  for (const group of value) {
    if (
      !Array.isArray(group) ||
      !group.every((entry) => typeof entry === "string")
    ) {
      return undefined;
    }
    normalized.push([...group].sort());
  }
  normalized.sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
  return JSON.stringify(normalized);
}

export function isValidJudgeOutput(value: unknown): value is JudgeValue {
  return isJudgeValue(value);
}

export function compareJudgeOutput(
  comparator: ComparatorKind,
  actual: unknown,
  expected: JudgeValue,
): boolean {
  if (!isJudgeValue(actual)) return false;
  if (comparator === "unordered-string-groups") {
    const actualKey = unorderedStringGroupsKey(actual);
    const expectedKey = unorderedStringGroupsKey(expected);
    return actualKey !== undefined && actualKey === expectedKey;
  }
  return exactKey(actual) === exactKey(expected);
}
