import type { Database } from "@/server/db/client";
import { DomainError, requireActor } from "@/server/domain/errors";
import type {
  ChallengeType,
  Difficulty,
  EndReason,
  Language,
  MatchMode,
} from "@/server/domain/types";

export type HistoryOutcome =
  "WIN" | "LOSS" | "DRAW" | "NO_CONTEST" | "CANCELLED" | "COMPLETED";

export interface HistoryEntry {
  matchId: string;
  roomId: string;
  playedAt: string;
  challengeType: ChallengeType;
  mode: MatchMode;
  opponent: string | null;
  problemId: string;
  problemTitle: string;
  difficulty: Difficulty;
  language: Language | null;
  outcome: HistoryOutcome;
  score: number | null;
  durationSeconds: number;
  endReason: EndReason;
}

export interface HistoryAiMlAnswer {
  username: string;
  answer: string;
  score: number | null;
}

export interface HistoryAiMlDetail {
  question: {
    title: string;
    prompt: string;
    difficulty: Difficulty;
    category: string;
    answerConstraints: {
      maxWords: number;
      maxCharacters: number;
      maxUtf8Bytes: number;
    };
  };
  answers: HistoryAiMlAnswer[];
  winnerUsername: string | null;
  explanation: string | null;
  tieBreakReason: string | null;
  automaticBlank: boolean;
}

export interface HistoryDetail {
  matchId: string;
  playedAt: string;
  challengeType: ChallengeType;
  mode: MatchMode;
  opponent: string | null;
  problemTitle: string;
  difficulty: Difficulty;
  language: Language | null;
  outcome: HistoryOutcome;
  durationSeconds: number;
  endReason: EndReason;
  aiMl: HistoryAiMlDetail | null;
}

interface HistoryRow {
  match_id: string;
  room_id: string;
  played_at: string;
  challenge_type: ChallengeType;
  mode: MatchMode;
  opponent: string | null;
  problem_id: string;
  problem_title: string;
  difficulty: Difficulty;
  language: Language | null;
  outcome: Exclude<HistoryOutcome, "COMPLETED">;
  score: number | null;
  duration_seconds: number;
  end_reason: EndReason;
}

interface DetailRow extends HistoryRow {
  question_prompt: string | null;
  question_category: string | null;
  answer_constraints: unknown;
  evaluation_status: "COMPLETED" | "SKIPPED" | null;
  answer_a_user_id: string | null;
  answer_b_user_id: string | null;
  winner_username: string | null;
  explanation: string | null;
  tie_break_reason: string | null;
}

const DEFAULT_ANSWER_CONSTRAINTS = Object.freeze({
  maxWords: 500,
  maxCharacters: 12_000,
  maxUtf8Bytes: 24_000,
});

function displayedOutcome(row: HistoryRow): HistoryOutcome {
  const scoredPracticeReasons = new Set<EndReason>([
    "JUDGED",
    "ANSWER_TIMEOUT",
    "NO_CONTEST",
  ]);
  return row.challenge_type === "AI_ML" &&
    row.mode === "PRACTICE" &&
    scoredPracticeReasons.has(row.end_reason)
    ? "COMPLETED"
    : row.outcome;
}

function parseAnswerConstraints(
  value: unknown,
): HistoryAiMlDetail["question"]["answerConstraints"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ...DEFAULT_ANSWER_CONSTRAINTS };
  }
  const candidate = value as Record<string, unknown>;
  const maxWords = candidate.maxWords;
  const maxCharacters = candidate.maxCharacters;
  const maxUtf8Bytes = candidate.maxUtf8Bytes;
  if (
    typeof maxWords !== "number" ||
    typeof maxCharacters !== "number" ||
    typeof maxUtf8Bytes !== "number"
  ) {
    return { ...DEFAULT_ANSWER_CONSTRAINTS };
  }
  return { maxWords, maxCharacters, maxUtf8Bytes };
}

export class HistoryService {
  constructor(private readonly sql: Database) {}

  async recent(
    actorUserId: string,
    requestedLimit = 20,
  ): Promise<HistoryEntry[]> {
    requireActor(actorUserId);
    const limit = Math.max(1, Math.min(50, Math.trunc(requestedLimit)));
    const rows = await this.sql<HistoryRow[]>`
      SELECT m.id AS match_id,
             m.room_id,
             m.finished_at::text AS played_at,
             m.challenge_type,
             m.mode,
             opponent_profile.username::text AS opponent,
             m.problem_id,
             m.problem_title,
             m.difficulty,
             self.language,
             self.outcome,
             CASE
               WHEN evaluation.answer_a_user_id = ${actorUserId}
                 THEN evaluation.official_score_a
               WHEN evaluation.answer_b_user_id = ${actorUserId}
                 THEN evaluation.official_score_b
               ELSE NULL
             END::int AS score,
             GREATEST(
               0,
               EXTRACT(EPOCH FROM (m.finished_at - COALESCE(m.starts_at, m.created_at)))
             )::float8 AS duration_seconds,
             m.end_reason
      FROM matches m
      JOIN match_participants self
        ON self.match_id = m.id AND self.clerk_user_id = ${actorUserId}
      LEFT JOIN match_participants opponent
        ON opponent.match_id = m.id AND opponent.clerk_user_id <> ${actorUserId}
      LEFT JOIN profiles opponent_profile
        ON opponent_profile.clerk_user_id = opponent.clerk_user_id
      LEFT JOIN ai_ml_evaluations evaluation
        ON evaluation.match_id = m.id
       AND evaluation.status IN ('COMPLETED', 'SKIPPED')
      WHERE m.finished_at IS NOT NULL
        AND m.problem_id IS NOT NULL
        AND m.problem_title IS NOT NULL
        AND self.outcome IS NOT NULL
        AND (
          m.challenge_type = 'AI_ML'
          OR (m.challenge_type = 'CODING' AND m.mode = 'DUEL' AND self.language IS NOT NULL)
        )
      ORDER BY m.finished_at DESC, m.id DESC
      LIMIT ${limit}
    `;

    return rows.map((row) => ({
      matchId: row.match_id,
      roomId: row.room_id,
      playedAt: row.played_at,
      challengeType: row.challenge_type,
      mode: row.mode,
      opponent: row.opponent,
      problemId: row.problem_id,
      problemTitle: row.problem_title,
      difficulty: row.difficulty,
      language: row.language,
      outcome: displayedOutcome(row),
      score: row.score,
      durationSeconds: row.duration_seconds,
      endReason: row.end_reason,
    }));
  }

  async detail(actorUserId: string, matchId: string): Promise<HistoryDetail> {
    requireActor(actorUserId);
    const [row] = await this.sql<DetailRow[]>`
      SELECT m.id AS match_id,
             m.room_id,
             m.finished_at::text AS played_at,
             m.challenge_type,
             m.mode,
             opponent_profile.username::text AS opponent,
             m.problem_id,
             m.problem_title,
             m.difficulty,
             self.language,
             self.outcome,
             CASE
               WHEN evaluation.answer_a_user_id = ${actorUserId}
                 THEN evaluation.official_score_a
               WHEN evaluation.answer_b_user_id = ${actorUserId}
                 THEN evaluation.official_score_b
               ELSE NULL
             END::int AS score,
             GREATEST(
               0,
               EXTRACT(EPOCH FROM (m.finished_at - COALESCE(m.starts_at, m.created_at)))
             )::float8 AS duration_seconds,
             m.end_reason,
             question.prompt AS question_prompt,
             question.category AS question_category,
             question.answer_constraints,
             evaluation.status AS evaluation_status,
             evaluation.answer_a_user_id,
             evaluation.answer_b_user_id,
             winner_profile.username::text AS winner_username,
             evaluation.explanation,
             evaluation.tie_break_reason
      FROM matches m
      JOIN match_participants self
        ON self.match_id = m.id AND self.clerk_user_id = ${actorUserId}
      LEFT JOIN match_participants opponent
        ON opponent.match_id = m.id AND opponent.clerk_user_id <> ${actorUserId}
      LEFT JOIN profiles opponent_profile
        ON opponent_profile.clerk_user_id = opponent.clerk_user_id
      LEFT JOIN ai_ml_evaluations evaluation
        ON evaluation.match_id = m.id
       AND evaluation.status IN ('COMPLETED', 'SKIPPED')
      LEFT JOIN profiles winner_profile
        ON winner_profile.clerk_user_id = evaluation.winner_user_id
      LEFT JOIN ai_ml_question_registry question
        ON question.question_id = m.problem_id
       AND question.version = m.problem_version
      WHERE m.id = ${matchId}
        AND m.finished_at IS NOT NULL
        AND m.problem_id IS NOT NULL
        AND m.problem_title IS NOT NULL
        AND self.outcome IS NOT NULL
      LIMIT 1
    `;
    if (!row) {
      // Deliberately do not distinguish a missing match from a private match
      // owned by someone else.
      throw new DomainError("MATCH_NOT_FOUND", "Match not found", 404);
    }

    let aiMl: HistoryAiMlDetail | null = null;
    if (row.challenge_type === "AI_ML") {
      if (!row.question_prompt || !row.question_category) {
        throw new Error("Stored AI/ML question metadata is incomplete");
      }
      const answers = await this.sql<
        {
          clerk_user_id: string;
          username: string;
          normalized_answer: string;
          official_score: number | null;
          slot: 1 | 2;
        }[]
      >`
        SELECT answer.clerk_user_id,
               profile.username::text AS username,
               answer.normalized_answer,
               CASE
                 WHEN evaluation.answer_a_user_id = answer.clerk_user_id
                   THEN evaluation.official_score_a
                 WHEN evaluation.answer_b_user_id = answer.clerk_user_id
                   THEN evaluation.official_score_b
                 ELSE NULL
               END::int AS official_score,
               participant.slot
        FROM ai_ml_answers answer
        JOIN match_participants participant
          ON participant.match_id = answer.match_id
         AND participant.clerk_user_id = answer.clerk_user_id
        JOIN profiles profile ON profile.clerk_user_id = answer.clerk_user_id
        LEFT JOIN ai_ml_evaluations evaluation
          ON evaluation.match_id = answer.match_id
         AND evaluation.status IN ('COMPLETED', 'SKIPPED')
        WHERE answer.match_id = ${matchId}
        ORDER BY participant.slot
      `;
      aiMl = {
        question: {
          title: row.problem_title,
          prompt: row.question_prompt,
          difficulty: row.difficulty,
          category: row.question_category,
          answerConstraints: parseAnswerConstraints(row.answer_constraints),
        },
        answers: answers.map((answer) => ({
          username: answer.username,
          answer: answer.normalized_answer,
          score: answer.official_score,
        })),
        winnerUsername: row.winner_username,
        explanation: row.explanation,
        tieBreakReason: row.tie_break_reason,
        automaticBlank:
          row.tie_break_reason === "blank_forfeit" ||
          row.evaluation_status === "SKIPPED",
      };
    }

    return {
      matchId: row.match_id,
      playedAt: row.played_at,
      challengeType: row.challenge_type,
      mode: row.mode,
      opponent: row.opponent,
      problemTitle: row.problem_title,
      difficulty: row.difficulty,
      language: row.language,
      outcome: displayedOutcome(row),
      durationSeconds: row.duration_seconds,
      endReason: row.end_reason,
      aiMl,
    };
  }
}
