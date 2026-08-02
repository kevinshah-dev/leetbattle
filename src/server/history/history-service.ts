import type { Database } from "@/server/db/client";
import { requireActor } from "@/server/domain/errors";
import type { Difficulty, EndReason, Language } from "@/server/domain/types";

export interface HistoryEntry {
  matchId: string;
  roomId: string;
  playedAt: string;
  opponent: string;
  problemId: string;
  problemTitle: string;
  difficulty: Difficulty;
  language: Language;
  outcome: "WIN" | "LOSS" | "DRAW" | "NO_CONTEST" | "CANCELLED";
  durationSeconds: number;
  endReason: EndReason;
}

export class HistoryService {
  constructor(private readonly sql: Database) {}

  async recent(
    actorUserId: string,
    requestedLimit = 20,
  ): Promise<HistoryEntry[]> {
    requireActor(actorUserId);
    const limit = Math.max(1, Math.min(50, Math.trunc(requestedLimit)));
    const rows = await this.sql<
      {
        match_id: string;
        room_id: string;
        played_at: string;
        opponent: string;
        problem_id: string;
        problem_title: string;
        difficulty: Difficulty;
        language: Language;
        outcome: HistoryEntry["outcome"];
        duration_seconds: number;
        end_reason: EndReason;
      }[]
    >`
      SELECT m.id AS match_id, m.room_id, m.finished_at::text AS played_at,
             opponent_profile.username::text AS opponent,
             m.problem_id, m.problem_title, m.difficulty,
             self.language, self.outcome,
             GREATEST(0, EXTRACT(EPOCH FROM (m.finished_at - m.starts_at)))::float8 AS duration_seconds,
             m.end_reason
      FROM matches m
      JOIN rooms room ON room.id = m.room_id AND room.mode = 'DUEL'
      JOIN match_participants self
        ON self.match_id = m.id AND self.clerk_user_id = ${actorUserId}
      JOIN match_participants opponent
        ON opponent.match_id = m.id AND opponent.clerk_user_id <> ${actorUserId}
      JOIN profiles opponent_profile ON opponent_profile.clerk_user_id = opponent.clerk_user_id
      WHERE m.finished_at IS NOT NULL
        AND m.problem_id IS NOT NULL
        AND self.language IS NOT NULL
        AND self.outcome IS NOT NULL
      ORDER BY m.finished_at DESC
      LIMIT ${limit}
    `;
    return rows.map((row) => ({
      matchId: row.match_id,
      roomId: row.room_id,
      playedAt: row.played_at,
      opponent: row.opponent,
      problemId: row.problem_id,
      problemTitle: row.problem_title,
      difficulty: row.difficulty,
      language: row.language,
      outcome: row.outcome,
      durationSeconds: row.duration_seconds,
      endReason: row.end_reason,
    }));
  }
}
