export interface AiMlAnswerConstraints {
  maxWords: number;
  maxCharacters: number;
  maxUtf8Bytes: number;
}

export const AI_ML_ANSWER_LIMITS = {
  maxWords: 500,
  maxCharacters: 12_000,
  maxUtf8Bytes: 24_000,
} as const satisfies AiMlAnswerConstraints;

export type AiMlAnswerLimitCode =
  "TOO_MANY_WORDS" | "TOO_MANY_CHARACTERS" | "TOO_MANY_UTF8_BYTES";

export interface AiMlAnswerMeasurement {
  normalized: string;
  wordCount: number;
  characterCount: number;
  utf8ByteCount: number;
  isBlank: boolean;
  violations: AiMlAnswerLimitCode[];
  withinLimits: boolean;
}

/**
 * Produces the exact prose representation stored and judged by the server.
 * Paragraph breaks are retained, while platform line endings and horizontal
 * Unicode whitespace are made deterministic.
 */
export function normalizeAiMlAnswer(answer: string): string {
  return answer
    .normalize("NFC")
    .replace(/\r\n?|[\u0085\u2028\u2029]/gu, "\n")
    .replace(/[^\S\n]+/gu, " ")
    .replace(/ *\n */gu, "\n")
    .trim();
}

export function measureAiMlAnswer(
  answer: string,
  constraints: AiMlAnswerConstraints = AI_ML_ANSWER_LIMITS,
): AiMlAnswerMeasurement {
  const normalized = normalizeAiMlAnswer(answer);
  const wordCount = normalized ? normalized.split(/\s+/u).length : 0;
  const characterCount = Array.from(normalized).length;
  const utf8ByteCount = new TextEncoder().encode(normalized).byteLength;
  const violations: AiMlAnswerLimitCode[] = [];
  if (wordCount > constraints.maxWords) violations.push("TOO_MANY_WORDS");
  if (characterCount > constraints.maxCharacters)
    violations.push("TOO_MANY_CHARACTERS");
  if (utf8ByteCount > constraints.maxUtf8Bytes)
    violations.push("TOO_MANY_UTF8_BYTES");

  return {
    normalized,
    wordCount,
    characterCount,
    utf8ByteCount,
    isBlank: normalized.length === 0,
    violations,
    withinLimits: violations.length === 0,
  };
}

export class AiMlAnswerLimitError extends Error {
  constructor(readonly measurement: AiMlAnswerMeasurement) {
    super("AI/ML answer exceeds its allowed size");
    this.name = "AiMlAnswerLimitError";
  }
}

export function assertAiMlAnswerWithinLimits(
  answer: string,
  constraints: AiMlAnswerConstraints = AI_ML_ANSWER_LIMITS,
): AiMlAnswerMeasurement {
  const measurement = measureAiMlAnswer(answer, constraints);
  if (!measurement.withinLimits) throw new AiMlAnswerLimitError(measurement);
  return measurement;
}
