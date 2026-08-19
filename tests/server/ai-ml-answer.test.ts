import { describe, expect, it } from "vitest";

import {
  AI_ML_ANSWER_LIMITS,
  AiMlAnswerLimitError,
  assertAiMlAnswerWithinLimits,
  measureAiMlAnswer,
  normalizeAiMlAnswer,
} from "@/server/ai-ml";

describe("AI/ML answer normalization and limits", () => {
  it("normalizes NFC, line endings, and Unicode whitespace deterministically", () => {
    const input = "  e\u0301\u00a0answer\r\n next\u2028paragraph\t  ";

    expect(normalizeAiMlAnswer(input)).toBe("é answer\nnext\nparagraph");
    expect(measureAiMlAnswer(input)).toMatchObject({
      normalized: "é answer\nnext\nparagraph",
      wordCount: 4,
      characterCount: 23,
      utf8ByteCount: 24,
      isBlank: false,
      withinLimits: true,
    });
  });

  it("accepts 500 words and rejects 501 without truncating", () => {
    const atLimit = Array.from({ length: 500 }, () => "word").join(" ");
    const overLimit = `${atLimit} word`;

    expect(assertAiMlAnswerWithinLimits(atLimit).wordCount).toBe(500);
    expect(() => assertAiMlAnswerWithinLimits(overLimit)).toThrow(
      AiMlAnswerLimitError,
    );
    try {
      assertAiMlAnswerWithinLimits(overLimit);
    } catch (error) {
      expect(error).toBeInstanceOf(AiMlAnswerLimitError);
      expect((error as AiMlAnswerLimitError).measurement).toMatchObject({
        normalized: overLimit,
        wordCount: 501,
        violations: ["TOO_MANY_WORDS"],
      });
    }
  });

  it("enforces exact code-point character and UTF-8 byte ceilings", () => {
    expect(AI_ML_ANSWER_LIMITS).toEqual({
      maxWords: 500,
      maxCharacters: 12_000,
      maxUtf8Bytes: 24_000,
    });
    expect(measureAiMlAnswer("a".repeat(12_000)).withinLimits).toBe(true);
    expect(measureAiMlAnswer("a".repeat(12_001)).violations).toContain(
      "TOO_MANY_CHARACTERS",
    );
    expect(measureAiMlAnswer("😀".repeat(6_000))).toMatchObject({
      characterCount: 6_000,
      utf8ByteCount: 24_000,
      withinLimits: true,
    });
    expect(measureAiMlAnswer("😀".repeat(6_001)).violations).toEqual([
      "TOO_MANY_UTF8_BYTES",
    ]);
  });
});
