import { createHash } from "node:crypto";

import postgres from "postgres";

import { PRIVATE_AI_ML_QUESTION_BANK } from "../src/arena/server/private-bank.seed";
import { AI_ML_EXEMPLAR_ANSWERS } from "../src/arena/server/exemplar-answers.seed";
import { AI_ML_JUDGE_PROMPT } from "../src/arena/server/judge-prompts.seed";
import { PUBLIC_PROBLEMS } from "../src/problems/public/catalog";
import { measureAiMlAnswer } from "../src/shared/ai-ml-answer";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to seed challenge catalogs");
}

const counts = { EASY: 0, MEDIUM: 0, HARD: 0 };
for (const problem of PUBLIC_PROBLEMS) counts[problem.difficulty] += 1;
if (
  PUBLIC_PROBLEMS.length !== 7 ||
  counts.EASY !== 2 ||
  counts.MEDIUM !== 3 ||
  counts.HARD !== 2
) {
  throw new Error(
    "The public problem catalog must contain exactly 2 Easy, 3 Medium, and 2 Hard problems",
  );
}

const aiMlCounts = { EASY: 0, MEDIUM: 0, HARD: 0 };
const aiMlIds = new Set<string>();
const exemplarAnswers = new Map(
  AI_ML_EXEMPLAR_ANSWERS.map((exemplar) => [
    `${exemplar.id}@${exemplar.version}`,
    exemplar.answer,
  ]),
);
for (const question of PRIVATE_AI_ML_QUESTION_BANK) {
  aiMlCounts[question.public.difficulty] += 1;
  if (question.public.version !== 1) {
    throw new Error(`AI/ML question ${question.public.id} must be version 1`);
  }
  if (aiMlIds.has(question.public.id)) {
    throw new Error(`Duplicate AI/ML question ID: ${question.public.id}`);
  }
  aiMlIds.add(question.public.id);

  const exemplarKey = `${question.public.id}@${question.public.version}`;
  const exemplarAnswer = exemplarAnswers.get(exemplarKey);
  if (!exemplarAnswer) {
    throw new Error(`Missing AI/ML exemplar answer: ${exemplarKey}`);
  }
  const exemplarMeasurement = measureAiMlAnswer(
    exemplarAnswer,
    question.public.answerConstraints,
  );
  if (
    !exemplarMeasurement.withinLimits ||
    exemplarMeasurement.wordCount !== question.public.answerConstraints.maxWords
  ) {
    throw new Error(
      `AI/ML exemplar ${exemplarKey} must be exactly ${question.public.answerConstraints.maxWords} words and within all answer limits`,
    );
  }

  const weights = question.criteria.map((criterion) => criterion.weight);
  if (
    question.criteria.length !== 4 ||
    weights.join(",") !== "45,25,20,10" ||
    weights.reduce((sum, weight) => sum + weight, 0) !== 100
  ) {
    throw new Error(
      `AI/ML question ${question.public.id} must use the 45/25/20/10 rubric`,
    );
  }
}
if (
  PRIVATE_AI_ML_QUESTION_BANK.length !== 20 ||
  aiMlCounts.EASY !== 7 ||
  aiMlCounts.MEDIUM !== 7 ||
  aiMlCounts.HARD !== 6
) {
  throw new Error(
    "The AI/ML catalog must contain exactly 7 Easy, 7 Medium, and 6 Hard questions",
  );
}
if (
  exemplarAnswers.size !== PRIVATE_AI_ML_QUESTION_BANK.length ||
  AI_ML_EXEMPLAR_ANSWERS.length !== exemplarAnswers.size
) {
  throw new Error(
    "AI/ML exemplar answers must map one-to-one to the versioned question bank",
  );
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function jsonValue(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

const sql = postgres(databaseUrl, { max: 1 });
try {
  await sql.begin(async (tx) => {
    await tx`UPDATE problem_registry SET active = false`;
    for (const problem of PUBLIC_PROBLEMS) {
      // This import tree is intentionally public-only. Hidden fixtures and
      // canonical solutions never cross into the application database.
      const metadata = JSON.parse(JSON.stringify(problem)) as Record<
        string,
        unknown
      >;
      await tx`
        INSERT INTO problem_registry
          (problem_id, version, title, difficulty, active, public_metadata)
        VALUES
          (${problem.id}, ${problem.version}, ${problem.title}, ${problem.difficulty}, true,
           ${tx.json(metadata as postgres.JSONValue)})
        ON CONFLICT (problem_id, version) DO UPDATE
        SET title = EXCLUDED.title,
            difficulty = EXCLUDED.difficulty,
            active = true,
            public_metadata = EXCLUDED.public_metadata
      `;
    }

    await tx`
      UPDATE ai_ml_question_registry
      SET active = false,
          archived_at = COALESCE(archived_at, clock_timestamp()),
          updated_at = clock_timestamp()
    `;
    for (const question of PRIVATE_AI_ML_QUESTION_BANK) {
      const privateMaterial = {
        referenceAnswerNotes: question.referenceAnswerNotes,
        requiredConcepts: question.requiredConcepts,
        optionalNuances: question.optionalNuances,
        seriousErrors: question.seriousErrors,
        criteria: question.criteria,
      };
      const rubricHash = createHash("sha256")
        .update(canonicalJson(privateMaterial), "utf8")
        .digest("hex");

      await tx`
        INSERT INTO ai_ml_question_registry
          (question_id, version, title, prompt, difficulty, category, tags,
           answer_constraints, private_material, rubric_hash, active, archived_at)
        VALUES
          (${question.public.id}, ${question.public.version},
           ${question.public.title}, ${question.public.prompt},
           ${question.public.difficulty}, ${question.public.category},
           ${tx.json(jsonValue(question.public.tags))},
           ${tx.json(jsonValue(question.public.answerConstraints))},
           ${tx.json(jsonValue(privateMaterial))}, ${rubricHash}, true, NULL)
        ON CONFLICT (question_id, version) DO UPDATE
        SET title = EXCLUDED.title,
            prompt = EXCLUDED.prompt,
            difficulty = EXCLUDED.difficulty,
            category = EXCLUDED.category,
            tags = EXCLUDED.tags,
            answer_constraints = EXCLUDED.answer_constraints,
            private_material = EXCLUDED.private_material,
            rubric_hash = EXCLUDED.rubric_hash,
            active = true,
            archived_at = NULL,
            updated_at = clock_timestamp()
      `;

      const exemplar = exemplarAnswers.get(
        `${question.public.id}@${question.public.version}`,
      )!;
      const measurement = measureAiMlAnswer(
        exemplar,
        question.public.answerConstraints,
      );
      await tx`
        INSERT INTO ai_ml_exemplar_answers
          (question_id, question_version, answer, word_count,
           character_count, utf8_byte_count)
        VALUES
          (${question.public.id}, ${question.public.version},
           ${measurement.normalized}, ${measurement.wordCount},
           ${measurement.characterCount}, ${measurement.utf8ByteCount})
        ON CONFLICT (question_id, question_version) DO UPDATE
        SET answer = EXCLUDED.answer,
            word_count = EXCLUDED.word_count,
            character_count = EXCLUDED.character_count,
            utf8_byte_count = EXCLUDED.utf8_byte_count,
            updated_at = clock_timestamp()
      `;
    }

    await tx`UPDATE ai_ml_judge_prompts SET active = false`;
    await tx`
      INSERT INTO ai_ml_judge_prompts
        (version, duel_instructions, practice_instructions, schema_version, active)
      VALUES
        (${AI_ML_JUDGE_PROMPT.version}, ${AI_ML_JUDGE_PROMPT.duelInstructions},
         ${AI_ML_JUDGE_PROMPT.practiceInstructions},
         ${AI_ML_JUDGE_PROMPT.schemaVersion}, true)
      ON CONFLICT (version) DO UPDATE
      SET duel_instructions = EXCLUDED.duel_instructions,
          practice_instructions = EXCLUDED.practice_instructions,
          schema_version = EXCLUDED.schema_version,
          active = true
    `;
  });
  console.info(
    `Seeded ${PUBLIC_PROBLEMS.length} coding problems, ` +
      `${PRIVATE_AI_ML_QUESTION_BANK.length} AI/ML questions, and ` +
      `AI/ML judge prompt v${AI_ML_JUDGE_PROMPT.version}`,
  );
} finally {
  await sql.end();
}
