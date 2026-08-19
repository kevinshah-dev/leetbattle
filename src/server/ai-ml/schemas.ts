import { z } from "zod";

import { AI_ML_ANSWER_LIMITS, measureAiMlAnswer } from "@/shared/ai-ml-answer";

import {
  AI_ML_TIE_BREAK_REASONS,
  type AiMlEvaluationSnapshot,
} from "./contracts";

const boundedText = (max: number) => z.string().trim().min(1).max(max);

const shortExplanation = boundedText(1_200).superRefine((value, context) => {
  const sentenceCount = value
    .split(/(?<=[.!?])\s+/u)
    .filter((sentence) => sentence.trim().length > 0).length;
  if (sentenceCount > 3) {
    context.addIssue({
      code: "custom",
      message: "Judge explanations must contain one to three sentences",
    });
  }
});

const normalizedAnswerSchema = z.string().transform((answer, context) => {
  const measurement = measureAiMlAnswer(answer);
  for (const violation of measurement.violations) {
    const limit =
      violation === "TOO_MANY_WORDS"
        ? AI_ML_ANSWER_LIMITS.maxWords
        : violation === "TOO_MANY_CHARACTERS"
          ? AI_ML_ANSWER_LIMITS.maxCharacters
          : AI_ML_ANSWER_LIMITS.maxUtf8Bytes;
    context.addIssue({
      code: "custom",
      message: `${violation}:${limit}`,
    });
  }
  return measurement.normalized;
});

export const AiMlEvaluationCriterionSchema = z
  .object({
    id: boundedText(100),
    label: boundedText(200),
    description: boundedText(2_000),
    maxScore: z.number().int().min(1).max(100),
  })
  .strict();

export const AiMlEvaluationQuestionSchema = z
  .object({
    id: boundedText(200),
    version: z.number().int().positive(),
    title: boundedText(500),
    prompt: boundedText(8_000),
    difficulty: z.enum(["EASY", "MEDIUM", "HARD"]),
    category: boundedText(300),
    referenceAnswerNotes: boundedText(8_000),
    requiredConcepts: z.array(boundedText(2_000)).min(1).max(20),
    optionalNuances: z.array(boundedText(2_000)).max(20),
    seriousErrors: z.array(boundedText(2_000)).max(20),
    criteria: z.array(AiMlEvaluationCriterionSchema).min(3).max(5),
  })
  .strict()
  .superRefine((question, context) => {
    const ids = new Set(question.criteria.map((criterion) => criterion.id));
    if (ids.size !== question.criteria.length) {
      context.addIssue({
        code: "custom",
        path: ["criteria"],
        message: "Rubric criterion IDs must be unique",
      });
    }

    const total = question.criteria.reduce(
      (sum, criterion) => sum + criterion.maxScore,
      0,
    );
    if (total !== 100) {
      context.addIssue({
        code: "custom",
        path: ["criteria"],
        message: "Rubric criteria must total exactly 100 points",
      });
    }
  });

export const AiMlEvaluationSnapshotSchema = z
  .object({
    mode: z.enum(["DUEL", "PRACTICE"]),
    schemaVersion: boundedText(128),
    instructions: boundedText(30_000),
    question: AiMlEvaluationQuestionSchema,
    answers: z
      .object({
        A: normalizedAnswerSchema,
        B: normalizedAnswerSchema.optional(),
      })
      .strict(),
  })
  .strict()
  .superRefine((snapshot, context) => {
    if (snapshot.mode === "DUEL") {
      if (snapshot.answers.B === undefined) {
        context.addIssue({
          code: "custom",
          path: ["answers", "B"],
          message: "Duel evaluations require Answer B",
        });
      } else if (snapshot.answers.A === "" && snapshot.answers.B === "") {
        context.addIssue({
          code: "custom",
          path: ["answers"],
          message: "Two blank answers must be resolved without a judge call",
        });
      }
      return;
    }

    if (snapshot.answers.B !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["answers", "B"],
        message: "Practice evaluations cannot contain Answer B",
      });
    }
    if (snapshot.answers.A === "") {
      context.addIssue({
        code: "custom",
        path: ["answers", "A"],
        message: "Blank practice answers must be resolved without a judge call",
      });
    }
  });

export const AiMlCriterionScoreSchema = z
  .object({
    criterionId: boundedText(100),
    score: z.number().int().min(0).max(100),
  })
  .strict();

const criterionScoresSchema = z.array(AiMlCriterionScoreSchema).min(3).max(5);

export const AiMlDuelProviderOutputSchema = z
  .object({
    schemaVersion: boundedText(128),
    scoresA: criterionScoresSchema,
    scoresB: criterionScoresSchema,
    winner: z.enum(["A", "B"]),
    tieBreakReason: z.enum(AI_ML_TIE_BREAK_REASONS),
    explanation: shortExplanation,
  })
  .strict();

export const AiMlPracticeProviderOutputSchema = z
  .object({
    schemaVersion: boundedText(128),
    scoresA: criterionScoresSchema,
    feedback: shortExplanation,
  })
  .strict();

export type AiMlDuelProviderOutput = z.infer<
  typeof AiMlDuelProviderOutputSchema
>;
export type AiMlPracticeProviderOutput = z.infer<
  typeof AiMlPracticeProviderOutputSchema
>;

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** Validates, normalizes, copies, and deeply freezes a persisted snapshot. */
export function parseAiMlEvaluationSnapshot(
  input: unknown,
): AiMlEvaluationSnapshot {
  return deepFreeze(AiMlEvaluationSnapshotSchema.parse(input));
}
