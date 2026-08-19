/**
 * Seed-only 500-word exemplar answers. Runtime services load these from
 * PostgreSQL after a result is finalized; this module must never be imported
 * by an application or Worker entry point.
 */
import { EASY_AI_ML_EXEMPLAR_ANSWERS } from "./exemplar-answers/easy.seed";
import { HARD_AI_ML_EXEMPLAR_ANSWERS } from "./exemplar-answers/hard.seed";
import { MEDIUM_AI_ML_EXEMPLAR_ANSWERS } from "./exemplar-answers/medium.seed";

export interface AiMlExemplarAnswer {
  readonly id: string;
  readonly version: number;
  readonly answer: string;
}

export const AI_ML_EXEMPLAR_ANSWERS = Object.freeze([
  ...EASY_AI_ML_EXEMPLAR_ANSWERS,
  ...MEDIUM_AI_ML_EXEMPLAR_ANSWERS,
  ...HARD_AI_ML_EXEMPLAR_ANSWERS,
] satisfies readonly AiMlExemplarAnswer[]);

export function getAiMlExemplarAnswer(
  id: string,
  version: number,
): AiMlExemplarAnswer | undefined {
  return AI_ML_EXEMPLAR_ANSWERS.find(
    (exemplar) => exemplar.id === id && exemplar.version === version,
  );
}
