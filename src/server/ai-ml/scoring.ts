import type {
  AiMlCriterionScore,
  AiMlDuelJudgeSuccess,
  AiMlEvaluationSnapshot,
  AiMlPracticeJudgeSuccess,
} from "./contracts";
import type {
  AiMlDuelProviderOutput,
  AiMlPracticeProviderOutput,
} from "./schemas";

export type AiMlSemanticErrorCode =
  | "MODE_MISMATCH"
  | "SCHEMA_VERSION_MISMATCH"
  | "CRITERION_SET_MISMATCH"
  | "CRITERION_SCORE_OUT_OF_RANGE"
  | "BLANK_ANSWER_INVARIANT"
  | "WINNER_INCONSISTENT"
  | "TIE_BREAK_INCONSISTENT"
  | "EXACT_EQUIVALENCE_INCONSISTENT";

export class AiMlSemanticValidationError extends Error {
  constructor(readonly code: AiMlSemanticErrorCode) {
    super(`Invalid AI/ML judge semantics: ${code}`);
    this.name = "AiMlSemanticValidationError";
  }
}

export interface AiMlOfficialDuelScores {
  readonly officialScoreA: number;
  readonly officialScoreB: number;
}

export interface AiMlOfficialDuelScoreInput {
  readonly rawScoreA: number;
  readonly rawScoreB: number;
  readonly winnerLabel: "A" | "B";
  readonly blankLabel?: "A" | "B";
}

/** Applies the product's winner-visible one-point adjustment without mutation. */
export function computeOfficialDuelScores({
  rawScoreA,
  rawScoreB,
  winnerLabel,
  blankLabel,
}: AiMlOfficialDuelScoreInput): AiMlOfficialDuelScores {
  if (
    !Number.isInteger(rawScoreA) ||
    !Number.isInteger(rawScoreB) ||
    rawScoreA < 0 ||
    rawScoreA > 100 ||
    rawScoreB < 0 ||
    rawScoreB > 100
  ) {
    throw new AiMlSemanticValidationError("CRITERION_SCORE_OUT_OF_RANGE");
  }

  if (blankLabel !== undefined) {
    const blankScore = blankLabel === "A" ? rawScoreA : rawScoreB;
    if (blankScore !== 0 || winnerLabel === blankLabel) {
      throw new AiMlSemanticValidationError("BLANK_ANSWER_INVARIANT");
    }
    return blankLabel === "A"
      ? { officialScoreA: 0, officialScoreB: Math.max(1, rawScoreB) }
      : { officialScoreA: Math.max(1, rawScoreA), officialScoreB: 0 };
  }

  if (rawScoreA !== rawScoreB) {
    const expectedWinner = rawScoreA > rawScoreB ? "A" : "B";
    if (winnerLabel !== expectedWinner) {
      throw new AiMlSemanticValidationError("WINNER_INCONSISTENT");
    }
    return {
      officialScoreA: rawScoreA,
      officialScoreB: rawScoreB,
    };
  }

  const winnerScore = rawScoreA === 100 ? 100 : rawScoreA + 1;
  const loserScore = rawScoreA === 100 ? 99 : rawScoreA;
  return winnerLabel === "A"
    ? { officialScoreA: winnerScore, officialScoreB: loserScore }
    : { officialScoreA: loserScore, officialScoreB: winnerScore };
}

type AiMlDuelScoringResult = Omit<AiMlDuelJudgeSuccess, "provider">;
type AiMlPracticeScoringResult = Omit<AiMlPracticeJudgeSuccess, "provider">;

function normalizeCriterionScores(
  snapshot: AiMlEvaluationSnapshot,
  scores: readonly AiMlCriterionScore[],
): AiMlCriterionScore[] {
  const submitted = new Map<string, number>();
  for (const criterionScore of scores) {
    if (submitted.has(criterionScore.criterionId)) {
      throw new AiMlSemanticValidationError("CRITERION_SET_MISMATCH");
    }
    submitted.set(criterionScore.criterionId, criterionScore.score);
  }

  if (submitted.size !== snapshot.question.criteria.length) {
    throw new AiMlSemanticValidationError("CRITERION_SET_MISMATCH");
  }

  return snapshot.question.criteria.map((criterion) => {
    const score = submitted.get(criterion.id);
    if (score === undefined) {
      throw new AiMlSemanticValidationError("CRITERION_SET_MISMATCH");
    }
    if (!Number.isInteger(score) || score < 0 || score > criterion.maxScore) {
      throw new AiMlSemanticValidationError("CRITERION_SCORE_OUT_OF_RANGE");
    }
    return { criterionId: criterion.id, score };
  });
}

function total(scores: readonly AiMlCriterionScore[]): number {
  return scores.reduce((sum, criterion) => sum + criterion.score, 0);
}

function equalCriterionScores(
  scoresA: readonly AiMlCriterionScore[],
  scoresB: readonly AiMlCriterionScore[],
): boolean {
  return scoresA.every(
    (scoreA, index) => scoreA.score === scoresB[index]?.score,
  );
}

function requiredTieBreakFromScores(
  scoresA: readonly AiMlCriterionScore[],
  scoresB: readonly AiMlCriterionScore[],
): {
  winner: "A" | "B";
  reason: AiMlDuelProviderOutput["tieBreakReason"];
} | null {
  const byIdA = new Map(
    scoresA.map((score) => [score.criterionId, score.score]),
  );
  const byIdB = new Map(
    scoresB.map((score) => [score.criterionId, score.score]),
  );
  const orderedStages = [
    ["technical_correctness", "correctness"],
    ["relevant_completeness", "completeness_or_specificity"],
    ["technical_depth", "completeness_or_specificity"],
    ["clarity", "clarity"],
  ] as const;

  for (const [criterionId, reason] of orderedStages) {
    const scoreA = byIdA.get(criterionId);
    const scoreB = byIdB.get(criterionId);
    if (scoreA === undefined || scoreB === undefined || scoreA === scoreB)
      continue;
    return { winner: scoreA > scoreB ? "A" : "B", reason };
  }
  return null;
}

export function validateAiMlDuelScoring(
  snapshot: AiMlEvaluationSnapshot,
  output: AiMlDuelProviderOutput,
): AiMlDuelScoringResult {
  if (snapshot.mode !== "DUEL" || snapshot.answers.B === undefined) {
    throw new AiMlSemanticValidationError("MODE_MISMATCH");
  }
  if (output.schemaVersion !== snapshot.schemaVersion) {
    throw new AiMlSemanticValidationError("SCHEMA_VERSION_MISMATCH");
  }

  const scoresA = normalizeCriterionScores(snapshot, output.scoresA);
  const scoresB = normalizeCriterionScores(snapshot, output.scoresB);
  const rawScoreA = total(scoresA);
  const rawScoreB = total(scoresB);
  const blankA = snapshot.answers.A === "";
  const blankB = snapshot.answers.B === "";
  const identicalAnswers = snapshot.answers.A === snapshot.answers.B;

  if (blankA && blankB) {
    throw new AiMlSemanticValidationError("BLANK_ANSWER_INVARIANT");
  }

  let official: AiMlOfficialDuelScores;
  if (blankA || blankB) {
    const blankScores = blankA ? scoresA : scoresB;
    const blankLabel = blankA ? "A" : "B";
    const nonblankLabel = blankA ? "B" : "A";
    if (
      blankScores.some((criterion) => criterion.score !== 0) ||
      output.winner !== nonblankLabel ||
      output.tieBreakReason !== "blank_forfeit"
    ) {
      throw new AiMlSemanticValidationError("BLANK_ANSWER_INVARIANT");
    }
    official = computeOfficialDuelScores({
      rawScoreA,
      rawScoreB,
      winnerLabel: output.winner,
      blankLabel,
    });
  } else if (identicalAnswers) {
    if (
      rawScoreA !== rawScoreB ||
      !equalCriterionScores(scoresA, scoresB) ||
      output.tieBreakReason !== "exact_equivalence" ||
      output.winner !== "A"
    ) {
      throw new AiMlSemanticValidationError("EXACT_EQUIVALENCE_INCONSISTENT");
    }
    official = computeOfficialDuelScores({
      rawScoreA,
      rawScoreB,
      winnerLabel: output.winner,
    });
  } else if (rawScoreA !== rawScoreB) {
    const expectedWinner = rawScoreA > rawScoreB ? "A" : "B";
    if (output.winner !== expectedWinner || output.tieBreakReason !== "none") {
      throw new AiMlSemanticValidationError("WINNER_INCONSISTENT");
    }
    official = computeOfficialDuelScores({
      rawScoreA,
      rawScoreB,
      winnerLabel: output.winner,
    });
  } else {
    if (
      output.tieBreakReason === "none" ||
      output.tieBreakReason === "blank_forfeit"
    ) {
      throw new AiMlSemanticValidationError("TIE_BREAK_INCONSISTENT");
    }

    const identicalScores = equalCriterionScores(scoresA, scoresB);
    const requiredTieBreak = requiredTieBreakFromScores(scoresA, scoresB);
    if (
      requiredTieBreak &&
      (output.winner !== requiredTieBreak.winner ||
        output.tieBreakReason !== requiredTieBreak.reason)
    ) {
      throw new AiMlSemanticValidationError("TIE_BREAK_INCONSISTENT");
    }
    if (
      output.tieBreakReason === "exact_equivalence" &&
      (output.winner !== "A" || !identicalScores)
    ) {
      throw new AiMlSemanticValidationError("EXACT_EQUIVALENCE_INCONSISTENT");
    }

    official = computeOfficialDuelScores({
      rawScoreA,
      rawScoreB,
      winnerLabel: output.winner,
    });
  }

  return Object.freeze({
    kind: "DUEL" as const,
    scoresA,
    scoresB,
    rawScoreA,
    rawScoreB,
    officialScoreA: official.officialScoreA,
    officialScoreB: official.officialScoreB,
    winnerLabel: output.winner,
    tieBreakReason: output.tieBreakReason,
    explanation: output.explanation,
  });
}

export function validateAiMlPracticeScoring(
  snapshot: AiMlEvaluationSnapshot,
  output: AiMlPracticeProviderOutput,
): AiMlPracticeScoringResult {
  if (snapshot.mode !== "PRACTICE" || snapshot.answers.B !== undefined) {
    throw new AiMlSemanticValidationError("MODE_MISMATCH");
  }
  if (snapshot.answers.A === "") {
    throw new AiMlSemanticValidationError("BLANK_ANSWER_INVARIANT");
  }
  if (output.schemaVersion !== snapshot.schemaVersion) {
    throw new AiMlSemanticValidationError("SCHEMA_VERSION_MISMATCH");
  }

  const scoresA = normalizeCriterionScores(snapshot, output.scoresA);
  const rawScoreA = total(scoresA);
  return Object.freeze({
    kind: "PRACTICE" as const,
    scoresA,
    rawScoreA,
    officialScoreA: rawScoreA,
    tieBreakReason: "none" as const,
    explanation: output.feedback,
  });
}
