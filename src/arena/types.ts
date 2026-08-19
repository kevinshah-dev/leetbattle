export const AI_ML_DIFFICULTIES = ["EASY", "MEDIUM", "HARD"] as const;
export type AiMlDifficulty = (typeof AI_ML_DIFFICULTIES)[number];

export interface AiMlQuestionRef {
  readonly id: string;
  readonly version: number;
}

export interface AiMlAnswerConstraints {
  readonly maxWords: number;
  readonly maxCharacters: number;
  readonly maxUtf8Bytes: number;
}

/**
 * Safe to serialize to a browser. Reference notes, required concepts, rubric
 * criteria, and misconception guidance deliberately do not appear here.
 */
export interface PublicAiMlQuestion extends AiMlQuestionRef {
  readonly title: string;
  readonly prompt: string;
  readonly difficulty: AiMlDifficulty;
  readonly category: string;
  readonly tags: readonly string[];
  readonly answerConstraints: AiMlAnswerConstraints;
}

export interface AiMlRubricCriterion {
  readonly id:
    | "technical_correctness"
    | "relevant_completeness"
    | "technical_depth"
    | "clarity";
  readonly label: string;
  readonly description: string;
  readonly weight: 45 | 25 | 20 | 10;
}

export interface PrivateAiMlQuestion {
  readonly public: PublicAiMlQuestion;
  readonly referenceAnswerNotes: string;
  readonly requiredConcepts: readonly string[];
  readonly optionalNuances: readonly string[];
  readonly seriousErrors: readonly string[];
  readonly criteria: readonly AiMlRubricCriterion[];
}
