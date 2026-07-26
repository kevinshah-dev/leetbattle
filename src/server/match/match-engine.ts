import { createHmac, randomInt, randomUUID } from "node:crypto";

import type postgres from "postgres";

import { requireInternalSecret } from "@/server/config/secrets";
import type { Database } from "@/server/db/client";
import { hashPayload, sha256 } from "@/server/domain/crypto";
import { DomainError, requireActor } from "@/server/domain/errors";
import {
  assertTransition,
  shouldApplyRecord,
} from "@/server/domain/state-machine";
import type {
  Difficulty,
  EndReason,
  ExecutionKind,
  Language,
  MatchEvent,
  MatchSnapshot,
  MatchState,
  ProblemCatalog,
  PublicProblemRef,
  RunnerResult,
} from "@/server/domain/types";
import { EXECUTION_VERDICTS } from "@/server/domain/types";

type Tx = postgres.TransactionSql;

interface MatchRow {
  id: string;
  room_id: string;
  round_number: number;
  state: MatchState;
  difficulty: Difficulty;
  problem_id: string | null;
  problem_version: number | null;
  problem_title: string | null;
  starts_at: string | null;
  finished_at: string | null;
  rematch_deadline: string | null;
  rematch_created_match_id: string | null;
  winner_user_id: string | null;
  end_reason: EndReason | null;
  records_applied: boolean;
  version: number;
}

interface ParticipantRow {
  clerk_user_id: string;
  slot: 1 | 2;
  username: string;
  language: Language | null;
  ready_at: string | null;
  activity: MatchSnapshot["players"][number]["activity"];
  best_passed_count: number;
  hidden_test_count: number | null;
  cooldown_until: string | null;
  active_execution_id: string | null;
  connected: boolean;
  disconnected_at: string | null;
  reconnect_deadline: string | null;
  outcome: MatchSnapshot["players"][number]["outcome"];
}

interface CommandReservation {
  duplicate: boolean;
  response: Record<string, unknown> | null;
}

export interface ExecutionRecord {
  id: string;
  matchId: string;
  actorUserId: string;
  kind: ExecutionKind;
  language: Language;
  problemId: string;
  problemVersion: number;
  receivedAt: string;
  sequence: number;
  created: boolean;
}

export interface CompletedExecution {
  executionId: string;
  verdict: RunnerResult["verdict"];
  cooldownUntil: string | null;
  winnerUserId: string | null;
  matchState: MatchState;
  duplicate: boolean;
}

export interface MatchEngineOptions {
  countdownMs?: number;
  reconnectGraceSeconds?: number;
  rematchWindowSeconds?: number;
  sampleRateLimitSeconds?: number;
  failedSubmissionCooldownSeconds?: number;
  maxSourceBytes?: number;
  inviteSecret?: string;
  chooseIndex?: (length: number) => number;
}

const DEFAULTS = {
  countdownMs: 4_000,
  reconnectGraceSeconds: 60,
  rematchWindowSeconds: 30,
  sampleRateLimitSeconds: 2,
  failedSubmissionCooldownSeconds: 10,
  maxSourceBytes: 64 * 1024,
} as const;

const MAX_POSTGRES_INTEGER = 2_147_483_647;
const MAX_DURATION_MS = 999_999_999.999;

function asIso(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function assertIdempotencyKey(key: string): void {
  if (!key || key.length > 200) {
    throw new DomainError(
      "IDEMPOTENCY_KEY_REQUIRED",
      "A non-empty idempotency key of at most 200 characters is required",
      422,
    );
  }
}

function assertSafeCount(value: number, label: string): void {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_POSTGRES_INTEGER
  ) {
    throw new Error(`Runner returned an unsafe ${label}`);
  }
}

function assertSafeDuration(value: number | null, label: string): void {
  if (
    value !== null &&
    (typeof value !== "number" ||
      !Number.isFinite(value) ||
      value < 0 ||
      value > MAX_DURATION_MS)
  ) {
    throw new Error(`Runner returned an unsafe ${label}`);
  }
}

export function normalizeRunnerResult(result: RunnerResult): RunnerResult {
  if (
    !result ||
    !EXECUTION_VERDICTS.includes(result.verdict) ||
    typeof result.verdict !== "string"
  ) {
    throw new Error("Runner returned an unsupported verdict");
  }
  assertSafeCount(result.passedCount, "passed count");
  assertSafeCount(result.totalCount, "total count");
  if (result.passedCount > result.totalCount) {
    throw new Error("Runner returned a passed count greater than total count");
  }
  assertSafeDuration(result.runtimeMs, "runtime");
  assertSafeDuration(result.compileMs, "compile duration");
  if (
    result.verdict === "ACCEPTED" &&
    (result.totalCount === 0 ||
      result.passedCount !== result.totalCount ||
      result.runtimeMs === null)
  ) {
    throw new Error(
      "An accepted result requires a positive total, all tests passed, and a measured runtime",
    );
  }
  return result;
}

export function executionCompletedEventPayload(input: {
  slot: 1 | 2;
  kind: ExecutionKind;
  result: RunnerResult;
  activity: string;
  cooldownUntil: string | null;
}): Record<string, unknown> {
  if (input.kind === "RUN") {
    return {
      slot: input.slot,
      kind: input.kind,
      activity: input.activity,
    };
  }
  return {
    slot: input.slot,
    kind: input.kind,
    accepted: input.result.verdict === "ACCEPTED",
    passedCount: input.result.passedCount,
    totalCount: input.result.totalCount,
    activity: input.activity,
    cooldownUntil: input.cooldownUntil,
  };
}

export class MatchEngine {
  private readonly options: Required<Omit<MatchEngineOptions, "inviteSecret">>;
  private readonly inviteSecret: string;

  constructor(
    private readonly sql: Database,
    private readonly catalog: ProblemCatalog,
    options: MatchEngineOptions = {},
  ) {
    this.options = {
      countdownMs: options.countdownMs ?? DEFAULTS.countdownMs,
      reconnectGraceSeconds:
        options.reconnectGraceSeconds ?? DEFAULTS.reconnectGraceSeconds,
      rematchWindowSeconds:
        options.rematchWindowSeconds ?? DEFAULTS.rematchWindowSeconds,
      sampleRateLimitSeconds:
        options.sampleRateLimitSeconds ?? DEFAULTS.sampleRateLimitSeconds,
      failedSubmissionCooldownSeconds:
        options.failedSubmissionCooldownSeconds ??
        DEFAULTS.failedSubmissionCooldownSeconds,
      maxSourceBytes: options.maxSourceBytes ?? DEFAULTS.maxSourceBytes,
      chooseIndex: options.chooseIndex ?? ((length) => randomInt(length)),
    };
    this.inviteSecret = requireInternalSecret(
      "ROOM_INVITE_SECRET",
      options.inviteSecret ?? process.env.ROOM_INVITE_SECRET,
    );
  }

  private inviteToken(actorUserId: string, idempotencyKey: string): string {
    return createHmac("sha256", this.inviteSecret)
      .update(actorUserId)
      .update("\0")
      .update(idempotencyKey)
      .digest("base64url");
  }

  private async assertProfile(tx: Tx, actorUserId: string): Promise<void> {
    const [profile] = await tx<{ exists: boolean }[]>`
      SELECT true AS exists FROM profiles WHERE clerk_user_id = ${actorUserId}
    `;
    if (!profile)
      throw new DomainError("PROFILE_REQUIRED", "Create a username first", 409);
  }

  private async reserveCommand(
    tx: Tx,
    input: {
      actorUserId: string;
      idempotencyKey: string;
      commandType: string;
      matchId?: string;
      payload: unknown;
    },
  ): Promise<CommandReservation> {
    assertIdempotencyKey(input.idempotencyKey);
    const payloadHash = hashPayload(input.payload);
    const inserted = await tx<{ actor_user_id: string }[]>`
      INSERT INTO command_receipts
        (actor_user_id, idempotency_key, command_type, match_id, payload_hash)
      VALUES
        (${input.actorUserId}, ${input.idempotencyKey}, ${input.commandType},
         ${input.matchId ?? null}, ${payloadHash})
      ON CONFLICT DO NOTHING
      RETURNING actor_user_id
    `;
    if (inserted.count > 0) return { duplicate: false, response: null };

    const [existing] = await tx<
      {
        command_type: string;
        match_id: string | null;
        payload_hash: string;
        response: unknown;
      }[]
    >`
      SELECT command_type, match_id, payload_hash, response
      FROM command_receipts
      WHERE actor_user_id = ${input.actorUserId}
        AND idempotency_key = ${input.idempotencyKey}
    `;
    if (
      !existing ||
      existing.command_type !== input.commandType ||
      existing.match_id !== (input.matchId ?? null) ||
      existing.payload_hash !== payloadHash
    ) {
      throw new DomainError(
        "IDEMPOTENCY_CONFLICT",
        "That idempotency key was already used for a different command",
        409,
      );
    }
    return {
      duplicate: true,
      response: (existing.response as Record<string, unknown> | null) ?? null,
    };
  }

  private async completeCommand(
    tx: Tx,
    actorUserId: string,
    idempotencyKey: string,
    response: Record<string, unknown>,
  ): Promise<void> {
    await tx`
      UPDATE command_receipts
      SET response = ${tx.json(response as postgres.JSONValue)}, completed_at = clock_timestamp()
      WHERE actor_user_id = ${actorUserId}
        AND idempotency_key = ${idempotencyKey}
        AND response IS NULL
    `;
  }

  private async appendEvent(
    tx: Tx,
    matchId: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Promise<MatchEvent> {
    const [event] = await tx<{ version: number; server_timestamp: string }[]>`
      WITH bumped AS (
        UPDATE matches
        SET version = version + 1, updated_at = clock_timestamp()
        WHERE id = ${matchId}
        RETURNING version
      )
      INSERT INTO match_events (match_id, version, event_type, payload, server_timestamp)
      SELECT ${matchId}, version, ${eventType}, ${tx.json(payload as postgres.JSONValue)},
             GREATEST(
               clock_timestamp(),
               COALESCE(
                 (SELECT max(server_timestamp) + interval '1 microsecond'
                  FROM match_events WHERE match_id = ${matchId}),
                 '-infinity'::timestamptz
               )
             )
      FROM bumped
      RETURNING version::int8::text::bigint AS version, server_timestamp::text
    `;
    if (!event) throw new Error("Could not append match event");
    return {
      matchId,
      version: Number(event.version),
      type: eventType,
      payload,
      serverTimestamp: event.server_timestamp,
    };
  }

  async createRoom(input: {
    actorUserId: string;
    difficulty: Difficulty;
    idempotencyKey: string;
  }): Promise<{ inviteToken: string; snapshot: MatchSnapshot }> {
    requireActor(input.actorUserId);
    const inviteToken = this.inviteToken(
      input.actorUserId,
      input.idempotencyKey,
    );
    const tokenHash = sha256(inviteToken);

    const roomId = await this.sql.begin(async (tx) => {
      await this.assertProfile(tx, input.actorUserId);
      const reservation = await this.reserveCommand(tx, {
        actorUserId: input.actorUserId,
        idempotencyKey: input.idempotencyKey,
        commandType: "CREATE_ROOM",
        payload: { difficulty: input.difficulty },
      });
      if (reservation.duplicate) {
        const existingRoomId = reservation.response?.roomId;
        if (typeof existingRoomId !== "string") {
          throw new DomainError(
            "IDEMPOTENCY_CONFLICT",
            "Original command is incomplete",
            409,
          );
        }
        return existingRoomId;
      }

      const [room] = await tx<{ id: string }[]>`
        INSERT INTO rooms (invite_token_hash, host_user_id, difficulty)
        VALUES (${tokenHash}, ${input.actorUserId}, ${input.difficulty})
        RETURNING id
      `;
      if (!room) throw new Error("Room insert failed");
      const [match] = await tx<{ id: string }[]>`
        INSERT INTO matches (room_id, round_number, difficulty)
        VALUES (${room.id}, 1, ${input.difficulty})
        RETURNING id
      `;
      if (!match) throw new Error("Match insert failed");
      await tx`
        INSERT INTO room_members (room_id, clerk_user_id, slot)
        VALUES (${room.id}, ${input.actorUserId}, 1)
      `;
      await tx`
        INSERT INTO match_participants (match_id, clerk_user_id, slot)
        VALUES (${match.id}, ${input.actorUserId}, 1)
      `;
      await tx`UPDATE rooms SET active_match_id = ${match.id} WHERE id = ${room.id}`;
      await this.appendEvent(tx, match.id, "MATCH_CREATED", {
        difficulty: input.difficulty,
        roundNumber: 1,
      });
      await this.completeCommand(tx, input.actorUserId, input.idempotencyKey, {
        roomId: room.id,
        matchId: match.id,
      });
      return room.id;
    });

    return {
      inviteToken,
      snapshot: await this.getSnapshot(input.actorUserId, roomId),
    };
  }

  async joinRoom(input: {
    actorUserId: string;
    inviteToken: string;
    idempotencyKey: string;
  }): Promise<MatchSnapshot> {
    requireActor(input.actorUserId);
    const tokenHash = sha256(input.inviteToken);
    const roomId = await this.sql.begin(async (tx) => {
      await this.assertProfile(tx, input.actorUserId);
      const [room] = await tx<
        {
          id: string;
          host_user_id: string;
          active_match_id: string;
          closed_at: string | null;
        }[]
      >`
        SELECT id, host_user_id, active_match_id, closed_at::text
        FROM rooms
        WHERE invite_token_hash = ${tokenHash}
        FOR UPDATE
      `;
      if (!room)
        throw new DomainError(
          "ROOM_NOT_FOUND",
          "Invite is invalid or expired",
          404,
        );
      if (room.host_user_id === input.actorUserId) {
        throw new DomainError(
          "HOST_CANNOT_JOIN_OWN_ROOM",
          "The host cannot occupy the opponent slot",
          409,
        );
      }

      const [existingMember] = await tx<{ slot: 1 | 2 }[]>`
        SELECT slot FROM room_members
        WHERE room_id = ${room.id} AND clerk_user_id = ${input.actorUserId}
      `;
      if (room.closed_at && !existingMember) {
        throw new DomainError(
          "ROOM_NOT_FOUND",
          "Invite is invalid or expired",
          404,
        );
      }
      const reservation = await this.reserveCommand(tx, {
        actorUserId: input.actorUserId,
        idempotencyKey: input.idempotencyKey,
        commandType: "JOIN_ROOM",
        matchId: room.active_match_id,
        payload: { roomId: room.id },
      });
      if (reservation.duplicate) return room.id;

      if (!existingMember) {
        const [occupied] = await tx<{ exists: boolean }[]>`
          SELECT true AS exists FROM room_members WHERE room_id = ${room.id} AND slot = 2
        `;
        if (occupied)
          throw new DomainError(
            "ROOM_FULL",
            "This battle already has two players",
            409,
          );
        await tx`
          INSERT INTO room_members (room_id, clerk_user_id, slot)
          VALUES (${room.id}, ${input.actorUserId}, 2)
        `;
        await tx`
          INSERT INTO match_participants (match_id, clerk_user_id, slot)
          VALUES (${room.active_match_id}, ${input.actorUserId}, 2)
        `;
        await this.appendEvent(tx, room.active_match_id, "PLAYER_JOINED", {
          slot: 2,
        });
      }
      await this.completeCommand(tx, input.actorUserId, input.idempotencyKey, {
        roomId: room.id,
        matchId: room.active_match_id,
      });
      return room.id;
    });
    return this.getSnapshot(input.actorUserId, roomId);
  }

  async assertRoomMembership(
    actorUserId: string,
    roomId: string,
  ): Promise<{ roomId: string; matchId: string; slot: 1 | 2 }> {
    requireActor(actorUserId);
    const [row] = await this.sql<{ active_match_id: string; slot: 1 | 2 }[]>`
      SELECT r.active_match_id, rm.slot
      FROM rooms r
      JOIN room_members rm ON rm.room_id = r.id
      WHERE r.id = ${roomId} AND rm.clerk_user_id = ${actorUserId}
    `;
    if (!row)
      throw new DomainError(
        "NOT_A_PARTICIPANT",
        "You are not a member of this room",
        403,
      );
    return { roomId, matchId: row.active_match_id, slot: row.slot };
  }

  async getRoomIdForInvite(
    actorUserId: string,
    inviteToken: string,
  ): Promise<string> {
    requireActor(actorUserId);
    const [row] = await this.sql<{ id: string }[]>`
      SELECT r.id
      FROM rooms r
      JOIN room_members rm ON rm.room_id = r.id
      WHERE r.invite_token_hash = ${sha256(inviteToken)}
        AND rm.clerk_user_id = ${actorUserId}
    `;
    if (!row)
      throw new DomainError("NOT_A_PARTICIPANT", "Join this room first", 403);
    return row.id;
  }

  private chooseProblem(
    difficulty: Difficulty,
    excludeProblemId: string | null,
  ): PublicProblemRef {
    const all = this.catalog.listByDifficulty(difficulty).filter((problem) => {
      return problem.difficulty === difficulty;
    });
    if (all.length === 0) {
      throw new DomainError(
        "NO_PROBLEM_AVAILABLE",
        "No problem is available for this difficulty",
        503,
      );
    }
    const withoutRepeat = all.filter(
      (problem) => problem.id !== excludeProblemId,
    );
    const candidates = withoutRepeat.length > 0 ? withoutRepeat : all;
    const index = this.options.chooseIndex(candidates.length);
    const selected = candidates[index];
    if (!selected) throw new Error("Problem chooser returned an invalid index");
    return selected;
  }

  async setLanguage(input: {
    actorUserId: string;
    matchId: string;
    language: Language;
    idempotencyKey: string;
  }): Promise<MatchSnapshot> {
    requireActor(input.actorUserId);
    await this.sql.begin(async (tx) => {
      const match = await this.lockMatch(tx, input.matchId);
      const participant = await this.lockParticipant(
        tx,
        input.matchId,
        input.actorUserId,
      );
      const reservation = await this.reserveCommand(tx, {
        actorUserId: input.actorUserId,
        idempotencyKey: input.idempotencyKey,
        commandType: "SET_LANGUAGE",
        matchId: input.matchId,
        payload: { language: input.language },
      });
      if (reservation.duplicate) return;
      if (match.state !== "LOBBY") {
        throw new DomainError(
          "INVALID_STATE",
          "Language is locked after the countdown starts",
          409,
        );
      }

      await tx`
        UPDATE match_participants
        SET language = ${input.language}, ready_at = NULL, updated_at = clock_timestamp()
        WHERE match_id = ${input.matchId} AND clerk_user_id = ${input.actorUserId}
      `;
      await this.appendEvent(tx, input.matchId, "PLAYER_LANGUAGE_CHANGED", {
        slot: participant.slot,
        language: input.language,
        ready: false,
      });
      await this.completeCommand(tx, input.actorUserId, input.idempotencyKey, {
        ok: true,
      });
    });
    return this.getSnapshotByMatch(input.actorUserId, input.matchId);
  }

  async setReady(input: {
    actorUserId: string;
    matchId: string;
    ready: boolean;
    idempotencyKey: string;
  }): Promise<MatchSnapshot> {
    requireActor(input.actorUserId);
    await this.sql.begin(async (tx) => {
      const match = await this.lockMatch(tx, input.matchId);
      const participant = await this.lockParticipant(
        tx,
        input.matchId,
        input.actorUserId,
      );
      const reservation = await this.reserveCommand(tx, {
        actorUserId: input.actorUserId,
        idempotencyKey: input.idempotencyKey,
        commandType: "SET_READY",
        matchId: input.matchId,
        payload: { ready: input.ready },
      });
      if (reservation.duplicate) return;
      if (match.state !== "LOBBY") {
        throw new DomainError(
          "INVALID_STATE",
          "Ready state is locked after countdown",
          409,
        );
      }
      if (input.ready && !participant.language) {
        throw new DomainError(
          "LANGUAGE_REQUIRED",
          "Choose Python or Java first",
          422,
        );
      }
      if (
        input.ready &&
        !(await this.hasLiveRealtimePresence(
          tx,
          input.matchId,
          input.actorUserId,
        ))
      ) {
        throw new DomainError(
          "INVALID_STATE",
          "Reconnect the live battle link before readying up",
          409,
        );
      }

      await tx`
        UPDATE match_participants
        SET ready_at = CASE WHEN ${input.ready} THEN clock_timestamp() ELSE NULL END,
            updated_at = clock_timestamp()
        WHERE match_id = ${input.matchId} AND clerk_user_id = ${input.actorUserId}
      `;
      await this.appendEvent(tx, input.matchId, "PLAYER_READY_CHANGED", {
        slot: participant.slot,
        ready: input.ready,
      });

      const participants = await tx<
        { ready: boolean; language: Language | null; live: boolean }[]
      >`
        SELECT mp.ready_at IS NOT NULL AS ready, mp.language,
               mp.connected AND EXISTS (
                 SELECT 1
                 FROM realtime_sessions rs
                 WHERE rs.match_id = mp.match_id
                   AND rs.clerk_user_id = mp.clerk_user_id
                   AND rs.disconnected_at IS NULL
                   AND rs.last_seen_at > clock_timestamp() - interval '45 seconds'
               ) AS live
        FROM match_participants mp
        WHERE mp.match_id = ${input.matchId}
        ORDER BY mp.slot
      `;
      if (
        participants.length === 2 &&
        participants.every((player) => player.ready && player.language)
      ) {
        if (!participants.every((player) => player.live)) {
          throw new DomainError(
            "INVALID_STATE",
            "Both players need a live battle link before countdown",
            409,
          );
        }
        const [previous] = await tx<{ problem_id: string | null }[]>`
          SELECT problem_id FROM matches
          WHERE room_id = ${match.room_id} AND round_number < ${match.round_number}
          ORDER BY round_number DESC LIMIT 1
        `;
        const problem = this.chooseProblem(
          match.difficulty,
          previous?.problem_id ?? null,
        );
        const [countdown] = await tx<{ starts_at: string }[]>`
          UPDATE matches
          SET state = 'COUNTDOWN', problem_id = ${problem.id},
              problem_version = ${problem.version}, problem_title = ${problem.title},
              starts_at = clock_timestamp() + (${this.options.countdownMs} * interval '1 millisecond'),
              updated_at = clock_timestamp()
          WHERE id = ${input.matchId} AND state = 'LOBBY'
          RETURNING starts_at::text
        `;
        if (countdown) {
          await this.appendEvent(tx, input.matchId, "COUNTDOWN_STARTED", {
            startsAt: countdown.starts_at,
          });
        }
      }
      await this.completeCommand(tx, input.actorUserId, input.idempotencyKey, {
        ok: true,
      });
    });
    return this.getSnapshotByMatch(input.actorUserId, input.matchId);
  }

  private async lockMatch(tx: Tx, matchId: string): Promise<MatchRow> {
    const [match] = await tx<MatchRow[]>`
      SELECT id, room_id, round_number, state, difficulty, problem_id, problem_version,
             problem_title, starts_at::text, finished_at::text, rematch_deadline::text,
             rematch_created_match_id, winner_user_id, end_reason, records_applied,
             version::text::bigint AS version
      FROM matches WHERE id = ${matchId} FOR UPDATE
    `;
    if (!match)
      throw new DomainError("MATCH_NOT_FOUND", "Match not found", 404);
    return { ...match, version: Number(match.version) };
  }

  private async lockParticipant(
    tx: Tx,
    matchId: string,
    actorUserId: string,
  ): Promise<ParticipantRow> {
    const [participant] = await tx<ParticipantRow[]>`
      SELECT mp.clerk_user_id, mp.slot, p.username::text AS username, mp.language,
             mp.ready_at::text, mp.activity, mp.best_passed_count,
             mp.hidden_test_count, mp.cooldown_until::text, mp.active_execution_id,
             mp.connected, mp.disconnected_at::text, mp.reconnect_deadline::text, mp.outcome
      FROM match_participants mp
      JOIN profiles p ON p.clerk_user_id = mp.clerk_user_id
      WHERE mp.match_id = ${matchId} AND mp.clerk_user_id = ${actorUserId}
      FOR UPDATE OF mp
    `;
    if (!participant) {
      throw new DomainError(
        "NOT_A_PARTICIPANT",
        "You are not a participant in this match",
        403,
      );
    }
    return participant;
  }

  private async hasLiveRealtimePresence(
    tx: Tx,
    matchId: string,
    actorUserId: string,
  ): Promise<boolean> {
    const [presence] = await tx<{ live: boolean }[]>`
      SELECT mp.connected AND EXISTS (
        SELECT 1
        FROM realtime_sessions rs
        WHERE rs.match_id = mp.match_id
          AND rs.clerk_user_id = mp.clerk_user_id
          AND rs.disconnected_at IS NULL
          AND rs.last_seen_at > clock_timestamp() - interval '45 seconds'
      ) AS live
      FROM match_participants mp
      WHERE mp.match_id = ${matchId} AND mp.clerk_user_id = ${actorUserId}
    `;
    return presence?.live === true;
  }

  async advanceCountdown(matchId: string): Promise<boolean> {
    return this.sql.begin(async (tx) => {
      const match = await this.lockMatch(tx, matchId);
      if (match.state !== "COUNTDOWN") return false;
      const [advanced] = await tx<
        { problem_id: string; problem_version: number; problem_title: string }[]
      >`
        UPDATE matches
        SET state = 'ACTIVE', updated_at = clock_timestamp()
        WHERE id = ${matchId} AND state = 'COUNTDOWN' AND starts_at <= clock_timestamp()
        RETURNING problem_id, problem_version, problem_title
      `;
      if (!advanced) return false;
      await tx`
        UPDATE match_participants
        SET disconnected_at = GREATEST(
              COALESCE(disconnected_at, ${match.starts_at}::timestamptz),
              ${match.starts_at}::timestamptz
            ),
            reconnect_deadline = GREATEST(
              COALESCE(disconnected_at, ${match.starts_at}::timestamptz),
              ${match.starts_at}::timestamptz
            ) + (${this.options.reconnectGraceSeconds} * interval '1 second'),
            updated_at = clock_timestamp()
        WHERE match_id = ${matchId}
          AND connected = false
          AND reconnect_deadline IS NULL
      `;
      await this.appendEvent(tx, matchId, "MATCH_ACTIVE", {
        problem: {
          id: advanced.problem_id,
          version: advanced.problem_version,
          title: advanced.problem_title,
          difficulty: match.difficulty,
        },
      });
      return true;
    });
  }

  async processDueCountdowns(limit = 100): Promise<number> {
    const rows = await this.sql<{ id: string }[]>`
      SELECT id FROM matches
      WHERE state = 'COUNTDOWN' AND starts_at <= clock_timestamp()
      ORDER BY starts_at
      LIMIT ${Math.max(1, Math.min(500, limit))}
    `;
    let changed = 0;
    for (const row of rows)
      if (await this.advanceCountdown(row.id)) changed += 1;
    return changed;
  }

  async getSnapshot(
    actorUserId: string,
    roomId: string,
  ): Promise<MatchSnapshot> {
    const membership = await this.assertRoomMembership(actorUserId, roomId);
    return this.getSnapshotByMatch(actorUserId, membership.matchId);
  }

  async getSnapshotByMatch(
    actorUserId: string,
    matchId: string,
  ): Promise<MatchSnapshot> {
    requireActor(actorUserId);
    await this.assertMatchParticipant(actorUserId, matchId);
    await this.advanceCountdown(matchId);
    const [clock] = await this.sql<
      { now: string }[]
    >`SELECT clock_timestamp()::text AS now`;
    const [match] = await this.sql<MatchRow[]>`
      SELECT id, room_id, round_number, state, difficulty, problem_id, problem_version,
             problem_title, starts_at::text, finished_at::text, rematch_deadline::text,
             rematch_created_match_id, winner_user_id, end_reason, records_applied,
             version::text::bigint AS version
      FROM matches WHERE id = ${matchId}
    `;
    if (!match || !clock)
      throw new DomainError("MATCH_NOT_FOUND", "Match not found", 404);
    const participants = await this.sql<ParticipantRow[]>`
      SELECT mp.clerk_user_id, mp.slot, p.username::text AS username, mp.language,
             mp.ready_at::text,
             CASE WHEN mp.activity = 'COOLDOWN' AND mp.cooldown_until <= clock_timestamp()
               THEN 'THINKING' ELSE mp.activity END AS activity,
             mp.best_passed_count,
             mp.hidden_test_count, mp.cooldown_until::text, mp.active_execution_id,
             mp.connected, mp.disconnected_at::text, mp.reconnect_deadline::text, mp.outcome
      FROM match_participants mp
      JOIN profiles p ON p.clerk_user_id = mp.clerk_user_id
      WHERE mp.match_id = ${matchId}
      ORDER BY mp.slot
    `;
    if (!participants.some((player) => player.clerk_user_id === actorUserId)) {
      throw new DomainError(
        "NOT_A_PARTICIPANT",
        "You are not a participant in this match",
        403,
      );
    }
    const winner = participants.find(
      (player) => player.clerk_user_id === match.winner_user_id,
    );
    const votes = await this.sql<{ slot: 1 | 2 }[]>`
      SELECT mp.slot
      FROM rematch_votes rv
      JOIN match_participants mp
        ON mp.match_id = rv.match_id AND mp.clerk_user_id = rv.clerk_user_id
      WHERE rv.match_id = ${matchId}
      ORDER BY mp.slot
    `;
    const canRevealProblem =
      match.state === "ACTIVE" || match.finished_at !== null;
    const problem: PublicProblemRef | null =
      canRevealProblem &&
      match.problem_id &&
      match.problem_version &&
      match.problem_title
        ? {
            id: match.problem_id,
            version: match.problem_version,
            title: match.problem_title,
            difficulty: match.difficulty,
          }
        : null;
    return {
      roomId: match.room_id,
      matchId: match.id,
      roundNumber: match.round_number,
      difficulty: match.difficulty,
      state: match.state,
      version: Number(match.version),
      serverTimestamp: clock.now,
      startsAt: asIso(match.starts_at),
      finishedAt: asIso(match.finished_at),
      rematchDeadline: asIso(match.rematch_deadline),
      endReason: match.end_reason,
      winnerUsername: winner?.username ?? null,
      problem,
      players: participants.map((player) => ({
        username: player.username,
        slot: player.slot,
        isSelf: player.clerk_user_id === actorUserId,
        language: player.language,
        ready: player.ready_at !== null,
        connected: player.connected,
        activity: player.activity,
        bestPassedCount: player.best_passed_count,
        hiddenTestCount: player.hidden_test_count,
        cooldownUntil: asIso(player.cooldown_until),
        outcome: player.outcome,
      })),
      rematchVotes: votes.map((vote) => vote.slot),
      rematchCreatedMatchId: match.rematch_created_match_id,
    };
  }

  async eventsSince(
    actorUserId: string,
    matchId: string,
    version: number,
    limit = 100,
  ): Promise<MatchEvent[]> {
    await this.assertMatchParticipant(actorUserId, matchId);
    const rows = await this.sql<
      {
        version: number;
        event_type: string;
        payload: Record<string, unknown>;
        server_timestamp: string;
      }[]
    >`
      SELECT version::text::bigint AS version, event_type, payload, server_timestamp::text
      FROM match_events
      WHERE match_id = ${matchId} AND version > ${Math.max(0, Math.trunc(version))}
      ORDER BY version
      LIMIT ${Math.max(1, Math.min(500, Math.trunc(limit)))}
    `;
    return rows.map((row) => ({
      matchId,
      version: Number(row.version),
      type: row.event_type,
      payload: row.payload,
      serverTimestamp: row.server_timestamp,
    }));
  }

  async assertMatchParticipant(
    actorUserId: string,
    matchId: string,
  ): Promise<{ slot: 1 | 2 }> {
    requireActor(actorUserId);
    const [row] = await this.sql<{ slot: 1 | 2 }[]>`
      SELECT slot FROM match_participants
      WHERE match_id = ${matchId} AND clerk_user_id = ${actorUserId}
    `;
    if (!row)
      throw new DomainError(
        "NOT_A_PARTICIPANT",
        "Not a match participant",
        403,
      );
    return row;
  }

  async cancelMatch(input: {
    actorUserId: string;
    matchId: string;
    idempotencyKey: string;
  }): Promise<MatchSnapshot> {
    requireActor(input.actorUserId);
    await this.sql.begin(async (tx) => {
      const match = await this.lockMatch(tx, input.matchId);
      const participant = await this.lockParticipant(
        tx,
        input.matchId,
        input.actorUserId,
      );
      if (participant.slot !== 1) {
        throw new DomainError(
          "NOT_A_PARTICIPANT",
          "Only the host can cancel the lobby",
          403,
        );
      }
      const reservation = await this.reserveCommand(tx, {
        actorUserId: input.actorUserId,
        idempotencyKey: input.idempotencyKey,
        commandType: "CANCEL_MATCH",
        matchId: input.matchId,
        payload: {},
      });
      if (reservation.duplicate) return;
      if (match.state !== "LOBBY") {
        throw new DomainError(
          "INVALID_STATE",
          "This match can no longer be cancelled",
          409,
        );
      }
      assertTransition(match.state, "FINISHED");
      await tx`
        UPDATE matches
        SET state = 'FINISHED', finished_at = clock_timestamp(), end_reason = 'CANCELLED',
            updated_at = clock_timestamp()
        WHERE id = ${input.matchId}
      `;
      await tx`
        UPDATE match_participants SET outcome = 'CANCELLED', updated_at = clock_timestamp()
        WHERE match_id = ${input.matchId}
      `;
      await tx`
        UPDATE rooms SET closed_at = clock_timestamp() WHERE id = ${match.room_id}
      `;
      await this.appendEvent(tx, input.matchId, "MATCH_FINISHED", {
        endReason: "CANCELLED",
        winnerSlot: null,
      });
      await this.completeCommand(tx, input.actorUserId, input.idempotencyKey, {
        ok: true,
      });
    });
    return this.getSnapshotByMatch(input.actorUserId, input.matchId);
  }

  async startExecution(input: {
    actorUserId: string;
    matchId: string;
    idempotencyKey: string;
    kind: ExecutionKind;
    source: string;
  }): Promise<ExecutionRecord> {
    requireActor(input.actorUserId);
    assertIdempotencyKey(input.idempotencyKey);
    const sourceBytes = Buffer.byteLength(input.source, "utf8");
    if (sourceBytes > this.options.maxSourceBytes) {
      throw new DomainError(
        "SOURCE_TOO_LARGE",
        `Source exceeds the ${this.options.maxSourceBytes}-byte limit`,
        413,
      );
    }
    const sourceHash = sha256(input.source);

    return this.sql.begin(async (tx) => {
      // Capture ordering before waiting on the shared match row. Sequence gaps
      // from rejected or duplicate commands are intentional and harmless.
      const [ingress] = await tx<
        { received_at: string; server_sequence: string }[]
      >`
        SELECT clock_timestamp()::text AS received_at,
               nextval('execution_server_sequence')::text AS server_sequence
      `;
      if (!ingress) throw new Error("Could not allocate execution receipt");
      let match = await this.lockMatch(tx, input.matchId);
      const participant = await this.lockParticipant(
        tx,
        input.matchId,
        input.actorUserId,
      );
      const reservation = await this.reserveCommand(tx, {
        actorUserId: input.actorUserId,
        idempotencyKey: input.idempotencyKey,
        commandType: input.kind,
        matchId: input.matchId,
        payload: { kind: input.kind, sourceHash },
      });
      if (reservation.duplicate) {
        const executionId = reservation.response?.executionId;
        if (typeof executionId !== "string") {
          throw new DomainError(
            "IDEMPOTENCY_CONFLICT",
            "Original execution is incomplete",
            409,
          );
        }
        const [existing] = await tx<
          {
            id: string;
            received_at: string;
            server_sequence: number;
            kind: ExecutionKind;
            language: Language;
            problem_id: string;
            problem_version: number;
          }[]
        >`
          SELECT e.id, e.received_at::text,
                 e.server_sequence::text::bigint AS server_sequence,
                 e.kind, e.language, m.problem_id, m.problem_version
          FROM executions e
          JOIN matches m ON m.id = e.match_id
          WHERE e.id = ${executionId}
        `;
        if (!existing)
          throw new Error("Execution receipt references a missing execution");
        return {
          id: existing.id,
          matchId: input.matchId,
          actorUserId: input.actorUserId,
          kind: existing.kind,
          language: existing.language,
          problemId: existing.problem_id,
          problemVersion: existing.problem_version,
          receivedAt: existing.received_at,
          sequence: Number(existing.server_sequence),
          created: false,
        };
      }
      if (match.state === "COUNTDOWN") {
        const [advanced] = await tx<
          {
            problem_id: string;
            problem_version: number;
            problem_title: string;
          }[]
        >`
          UPDATE matches
          SET state = 'ACTIVE', updated_at = clock_timestamp()
          WHERE id = ${input.matchId} AND state = 'COUNTDOWN' AND starts_at <= clock_timestamp()
          RETURNING problem_id, problem_version, problem_title
        `;
        if (advanced) {
          await this.appendEvent(tx, input.matchId, "MATCH_ACTIVE", {
            problem: {
              id: advanced.problem_id,
              version: advanced.problem_version,
              title: advanced.problem_title,
              difficulty: match.difficulty,
            },
          });
          match = { ...match, state: "ACTIVE" };
        }
      }
      if (
        match.state !== "ACTIVE" ||
        !match.problem_id ||
        !match.problem_version
      ) {
        throw new DomainError(
          "INVALID_STATE",
          "Executions are allowed only during an active match",
          409,
        );
      }
      const [receivedAfterStart] = await tx<{ valid: boolean }[]>`
        SELECT ${ingress.received_at}::timestamptz >= ${match.starts_at}::timestamptz AS valid
      `;
      if (!receivedAfterStart?.valid) {
        throw new DomainError(
          "INVALID_STATE",
          "The submission was received before the authoritative start time",
          409,
        );
      }
      if (!participant.language) {
        throw new DomainError(
          "LANGUAGE_REQUIRED",
          "Choose a language before executing",
          409,
        );
      }

      if (participant.active_execution_id) {
        throw new DomainError(
          "EXECUTION_IN_PROGRESS",
          "Wait for the current execution to finish",
          409,
        );
      }
      if (input.kind === "RUN") {
        const [limited] = await tx<{ retry_at: string }[]>`
          SELECT (last_sample_run_at + (${this.options.sampleRateLimitSeconds} * interval '1 second'))::text AS retry_at
          FROM match_participants
          WHERE match_id = ${input.matchId} AND clerk_user_id = ${input.actorUserId}
            AND last_sample_run_at IS NOT NULL
            AND last_sample_run_at + (${this.options.sampleRateLimitSeconds} * interval '1 second') > clock_timestamp()
        `;
        if (limited) {
          throw new DomainError(
            "RATE_LIMITED",
            "Sample runs are limited to one every two seconds",
            429,
            limited.retry_at,
          );
        }
      } else {
        const [cooldown] = await tx<{ cooldown_until: string }[]>`
          SELECT cooldown_until::text
          FROM match_participants
          WHERE match_id = ${input.matchId} AND clerk_user_id = ${input.actorUserId}
            AND cooldown_until > clock_timestamp()
        `;
        if (cooldown) {
          throw new DomainError(
            "COOLDOWN_ACTIVE",
            "Submission cooldown is still active",
            429,
            cooldown.cooldown_until,
          );
        }
      }

      const [execution] = await tx<
        { id: string; received_at: string; server_sequence: number }[]
      >`
        INSERT INTO executions
          (match_id, clerk_user_id, idempotency_key, kind, language, source_hash, source_bytes,
           received_at, server_sequence)
        VALUES
          (${input.matchId}, ${input.actorUserId}, ${input.idempotencyKey}, ${input.kind},
           ${participant.language}, ${sourceHash}, ${sourceBytes},
           ${ingress.received_at}::timestamptz, ${ingress.server_sequence}::bigint)
        RETURNING id, received_at::text, server_sequence::text::bigint AS server_sequence
      `;
      if (!execution) throw new Error("Execution insert failed");
      await tx`
        UPDATE match_participants
        SET active_execution_id = ${execution.id},
            activity = 'COMPILING',
            last_sample_run_at = CASE WHEN ${input.kind} = 'RUN' THEN clock_timestamp() ELSE last_sample_run_at END,
            updated_at = clock_timestamp()
        WHERE match_id = ${input.matchId} AND clerk_user_id = ${input.actorUserId}
      `;
      await this.appendEvent(tx, input.matchId, "EXECUTION_STARTED", {
        slot: participant.slot,
        kind: input.kind,
        activity: "COMPILING",
      });
      await this.completeCommand(tx, input.actorUserId, input.idempotencyKey, {
        executionId: execution.id,
      });
      return {
        id: execution.id,
        matchId: input.matchId,
        actorUserId: input.actorUserId,
        kind: input.kind,
        language: participant.language,
        problemId: match.problem_id,
        problemVersion: match.problem_version,
        receivedAt: execution.received_at,
        sequence: Number(execution.server_sequence),
        created: true,
      };
    });
  }

  async markExecutionRunning(
    executionId: string,
    infrastructureAttempt: number,
  ): Promise<void> {
    await this.sql.begin(async (tx) => {
      const [identity] = await tx<{ match_id: string }[]>`
        SELECT match_id FROM executions WHERE id = ${executionId}
      `;
      if (!identity) return;
      const match = await this.lockMatch(tx, identity.match_id);
      const [execution] = await tx<
        { match_id: string; clerk_user_id: string; kind: ExecutionKind }[]
      >`
        UPDATE executions
        SET status = 'RUNNING', infrastructure_attempts = ${infrastructureAttempt}
        WHERE id = ${executionId} AND status <> 'COMPLETED'
        RETURNING match_id, clerk_user_id, kind
      `;
      if (!execution) return;
      if (match.state !== "ACTIVE") return;
      const [participant] = await tx<{ slot: 1 | 2 }[]>`
        UPDATE match_participants
        SET activity = ${execution.kind === "SUBMIT" ? "JUDGING" : "COMPILING"},
            updated_at = clock_timestamp()
        WHERE match_id = ${execution.match_id}
          AND clerk_user_id = ${execution.clerk_user_id}
          AND active_execution_id = ${executionId}
        RETURNING slot
      `;
      if (participant) {
        await this.appendEvent(tx, execution.match_id, "EXECUTION_PROGRESS", {
          slot: participant.slot,
          kind: execution.kind,
          activity: execution.kind === "SUBMIT" ? "JUDGING" : "COMPILING",
        });
      }
    });
  }

  private normalizeResult(result: RunnerResult): RunnerResult {
    return normalizeRunnerResult(result);
  }

  async completeExecution(
    executionId: string,
    rawResult: RunnerResult,
  ): Promise<CompletedExecution> {
    const result = this.normalizeResult(rawResult);
    return this.sql.begin(async (tx) => {
      const [identity] = await tx<{ match_id: string }[]>`
        SELECT match_id FROM executions WHERE id = ${executionId}
      `;
      if (!identity)
        throw new DomainError("MATCH_NOT_FOUND", "Execution not found", 404);
      let match = await this.lockMatch(tx, identity.match_id);
      const [execution] = await tx<
        {
          id: string;
          clerk_user_id: string;
          kind: ExecutionKind;
          status: "QUEUED" | "RUNNING" | "COMPLETED";
          verdict: RunnerResult["verdict"] | null;
          result_summary: Record<string, unknown> | null;
        }[]
      >`
        SELECT id, clerk_user_id, kind, status, verdict, result_summary
        FROM executions WHERE id = ${executionId} FOR UPDATE
      `;
      if (!execution) throw new Error("Execution disappeared while locked");
      if (execution.status === "COMPLETED") {
        const summary = execution.result_summary;
        return {
          executionId,
          verdict: execution.verdict!,
          cooldownUntil:
            typeof summary?.cooldownUntil === "string"
              ? summary.cooldownUntil
              : null,
          winnerUserId: match.winner_user_id,
          matchState: match.state,
          duplicate: true,
        };
      }
      const participant = await this.lockParticipant(
        tx,
        match.id,
        execution.clerk_user_id,
      );
      const eligibleForGameplay =
        match.state === "ACTIVE" &&
        participant.active_execution_id === executionId;
      const penalized =
        eligibleForGameplay &&
        execution.kind === "SUBMIT" &&
        result.verdict !== "ACCEPTED" &&
        result.verdict !== "INFRA_ERROR";
      const [timing] = await tx<{ cooldown_until: string | null }[]>`
        SELECT CASE WHEN ${penalized}
          THEN (clock_timestamp() + (${this.options.failedSubmissionCooldownSeconds} * interval '1 second'))::text
          ELSE NULL
        END AS cooldown_until
      `;
      const cooldownUntil = timing?.cooldown_until ?? null;
      const storedSummary: Record<string, unknown> = {
        verdict: result.verdict,
        passedCount: result.passedCount,
        totalCount: result.totalCount,
        runtimeMs: result.runtimeMs,
        compileMs: result.compileMs,
        cooldownUntil,
        ...(execution.kind === "RUN" && result.details
          ? { details: result.details }
          : {}),
      };
      await tx`
        UPDATE executions
        SET status = 'COMPLETED', verdict = ${result.verdict},
            passed_count = ${result.passedCount}, total_count = ${result.totalCount},
            runtime_ms = ${result.runtimeMs}, compile_ms = ${result.compileMs},
            result_summary = ${tx.json(storedSummary as postgres.JSONValue)}, completed_at = clock_timestamp()
        WHERE id = ${executionId} AND status <> 'COMPLETED'
      `;
      if (!eligibleForGameplay) {
        return {
          executionId,
          verdict: result.verdict,
          cooldownUntil: null,
          winnerUserId: match.winner_user_id,
          matchState: match.state,
          duplicate: false,
        };
      }
      const activity =
        result.verdict === "ACCEPTED" && execution.kind === "SUBMIT"
          ? "ACCEPTED"
          : penalized
            ? "COOLDOWN"
            : "THINKING";
      const [updatedParticipant] = await tx<{ slot: 1 | 2 }[]>`
        UPDATE match_participants
        SET active_execution_id = CASE WHEN active_execution_id = ${executionId} THEN NULL ELSE active_execution_id END,
            activity = ${activity},
            best_passed_count = CASE WHEN ${execution.kind} = 'SUBMIT'
              THEN GREATEST(best_passed_count, ${result.passedCount})
              ELSE best_passed_count END,
            hidden_test_count = CASE WHEN ${execution.kind} = 'SUBMIT'
              THEN GREATEST(COALESCE(hidden_test_count, 0), ${result.totalCount})
              ELSE hidden_test_count END,
            cooldown_until = CASE WHEN ${penalized} THEN ${cooldownUntil}::timestamptz ELSE cooldown_until END,
            updated_at = clock_timestamp()
        WHERE match_id = ${match.id} AND clerk_user_id = ${execution.clerk_user_id}
          AND active_execution_id = ${executionId}
        RETURNING slot
      `;
      if (!updatedParticipant) {
        return {
          executionId,
          verdict: result.verdict,
          cooldownUntil: null,
          winnerUserId: match.winner_user_id,
          matchState: match.state,
          duplicate: false,
        };
      }
      const eventPayload = executionCompletedEventPayload({
        slot: updatedParticipant.slot,
        kind: execution.kind,
        result,
        activity,
        cooldownUntil,
      });
      await this.appendEvent(tx, match.id, "EXECUTION_COMPLETED", eventPayload);

      if (execution.kind === "SUBMIT" && match.state === "ACTIVE") {
        await this.maybeFinalizeAccepted(tx, match.id);
        match = await this.lockMatch(tx, match.id);
        if (match.state === "ACTIVE") {
          await this.evaluateDisconnectsTx(tx, match.id);
          match = await this.lockMatch(tx, match.id);
        }
      }
      return {
        executionId,
        verdict: result.verdict,
        cooldownUntil,
        winnerUserId: match.winner_user_id,
        matchState: match.state,
        duplicate: false,
      };
    });
  }

  private async maybeFinalizeAccepted(
    tx: Tx,
    matchId: string,
  ): Promise<boolean> {
    const match = await this.lockMatch(tx, matchId);
    if (match.state !== "ACTIVE" || match.winner_user_id) return false;
    const [candidate] = await tx<
      {
        id: string;
        clerk_user_id: string;
        received_at: string;
        runtime_ms: number;
        server_sequence: number;
      }[]
    >`
      SELECT id, clerk_user_id, received_at::text,
             runtime_ms::float8 AS runtime_ms,
             server_sequence::text::bigint AS server_sequence
      FROM executions
      WHERE match_id = ${matchId} AND kind = 'SUBMIT'
        AND status = 'COMPLETED' AND verdict = 'ACCEPTED'
      ORDER BY received_at ASC, runtime_ms ASC, server_sequence ASC
      LIMIT 1
    `;
    if (!candidate) return false;
    const [blocker] = await tx<{ exists: boolean }[]>`
      SELECT true AS exists
      FROM executions
      WHERE match_id = ${matchId} AND kind = 'SUBMIT'
        AND status IN ('QUEUED', 'RUNNING')
        AND received_at <= ${candidate.received_at}::timestamptz
      LIMIT 1
    `;
    if (blocker) return false;
    await this.finalizeMatchTx(
      tx,
      matchId,
      "ACCEPTED",
      candidate.clerk_user_id,
    );
    return true;
  }

  private async finalizeMatchTx(
    tx: Tx,
    matchId: string,
    endReason: EndReason,
    winnerUserId: string | null,
  ): Promise<boolean> {
    const match = await this.lockMatch(tx, matchId);
    if (
      match.state !== "ACTIVE" &&
      match.state !== "COUNTDOWN" &&
      match.state !== "LOBBY"
    ) {
      return false;
    }
    assertTransition(match.state, "FINISHED");
    const participants = await tx<{ clerk_user_id: string; slot: 1 | 2 }[]>`
      SELECT clerk_user_id, slot FROM match_participants
      WHERE match_id = ${matchId}
      ORDER BY slot
      FOR UPDATE
    `;
    const winner = participants.find(
      (player) => player.clerk_user_id === winnerUserId,
    );
    if (winnerUserId && !winner) throw new Error("Winner is not a participant");
    const appliesRecord = shouldApplyRecord(endReason) && winner !== undefined;
    await tx`
      UPDATE matches
      SET state = 'FINISHED', winner_user_id = ${winnerUserId}, end_reason = ${endReason},
          finished_at = clock_timestamp(), records_applied = ${appliesRecord},
          updated_at = clock_timestamp()
      WHERE id = ${matchId}
    `;
    for (const participant of participants) {
      const outcome =
        endReason === "NO_CONTEST"
          ? "NO_CONTEST"
          : endReason === "CANCELLED"
            ? "CANCELLED"
            : participant.clerk_user_id === winnerUserId
              ? "WIN"
              : "LOSS";
      const terminalActivity =
        endReason === "ACCEPTED" && participant.clerk_user_id === winnerUserId
          ? "ACCEPTED"
          : "THINKING";
      await tx`
        UPDATE match_participants
        SET outcome = ${outcome},
            active_execution_id = NULL,
            activity = ${terminalActivity},
            updated_at = clock_timestamp()
        WHERE match_id = ${matchId} AND clerk_user_id = ${participant.clerk_user_id}
      `;
      if (appliesRecord) {
        await tx`
          UPDATE player_records
          SET wins = wins + ${participant.clerk_user_id === winnerUserId ? 1 : 0},
              losses = losses + ${participant.clerk_user_id === winnerUserId ? 0 : 1},
              updated_at = clock_timestamp()
          WHERE clerk_user_id = ${participant.clerk_user_id}
        `;
      }
    }
    await this.appendEvent(tx, matchId, "MATCH_FINISHED", {
      endReason,
      winnerSlot: winner?.slot ?? null,
    });

    assertTransition("FINISHED", "REMATCH_PENDING");
    const [pending] = await tx<{ rematch_deadline: string }[]>`
      UPDATE matches
      SET state = 'REMATCH_PENDING',
          rematch_deadline = clock_timestamp() + (${this.options.rematchWindowSeconds} * interval '1 second'),
          updated_at = clock_timestamp()
      WHERE id = ${matchId} AND state = 'FINISHED'
      RETURNING rematch_deadline::text
    `;
    if (pending) {
      await this.appendEvent(tx, matchId, "REMATCH_OPENED", {
        deadline: pending.rematch_deadline,
      });
    }
    return true;
  }

  async requestRematch(input: {
    actorUserId: string;
    matchId: string;
    idempotencyKey: string;
  }): Promise<MatchSnapshot> {
    requireActor(input.actorUserId);
    const targetMatchId = await this.sql.begin(async (tx) => {
      const match = await this.lockMatch(tx, input.matchId);
      const participant = await this.lockParticipant(
        tx,
        input.matchId,
        input.actorUserId,
      );
      const reservation = await this.reserveCommand(tx, {
        actorUserId: input.actorUserId,
        idempotencyKey: input.idempotencyKey,
        commandType: "REMATCH_VOTE",
        matchId: input.matchId,
        payload: {},
      });
      if (reservation.duplicate) {
        if (match.rematch_created_match_id)
          return match.rematch_created_match_id;
        const responseMatchId = reservation.response?.matchId;
        return typeof responseMatchId === "string"
          ? responseMatchId
          : input.matchId;
      }
      if (match.state !== "REMATCH_PENDING" || !match.rematch_deadline) {
        throw new DomainError(
          "INVALID_STATE",
          "This match is not accepting rematch votes",
          409,
        );
      }
      if (match.rematch_created_match_id) {
        await this.completeCommand(
          tx,
          input.actorUserId,
          input.idempotencyKey,
          {
            matchId: match.rematch_created_match_id,
          },
        );
        return match.rematch_created_match_id;
      }
      const [withinWindow] = await tx<{ valid: boolean }[]>`
        SELECT ${match.rematch_deadline}::timestamptz > clock_timestamp() AS valid
      `;
      if (!withinWindow?.valid) {
        throw new DomainError(
          "REMATCH_EXPIRED",
          "The 30-second rematch window has closed",
          409,
        );
      }
      const inserted = await tx<{ clerk_user_id: string }[]>`
        INSERT INTO rematch_votes (match_id, clerk_user_id, idempotency_key)
        VALUES (${input.matchId}, ${input.actorUserId}, ${input.idempotencyKey})
        ON CONFLICT (match_id, clerk_user_id) DO NOTHING
        RETURNING clerk_user_id
      `;
      if (inserted.count > 0) {
        await this.appendEvent(tx, input.matchId, "REMATCH_VOTED", {
          slot: participant.slot,
        });
      }
      const [votes] = await tx<{ count: number }[]>`
        SELECT count(*)::int AS count FROM rematch_votes WHERE match_id = ${input.matchId}
      `;
      let createdMatchId: string | null = null;
      if (votes?.count === 2) {
        const [created] = await tx<{ id: string }[]>`
          INSERT INTO matches (room_id, round_number, previous_match_id, difficulty)
          VALUES (${match.room_id}, ${match.round_number + 1}, ${match.id}, ${match.difficulty})
          ON CONFLICT (room_id, round_number) DO NOTHING
          RETURNING id
        `;
        if (created) {
          createdMatchId = created.id;
          await tx`
            INSERT INTO match_participants (match_id, clerk_user_id, slot)
            SELECT ${created.id}, clerk_user_id, slot
            FROM room_members WHERE room_id = ${match.room_id}
            ORDER BY slot
          `;
          await tx`
            UPDATE rooms SET active_match_id = ${created.id} WHERE id = ${match.room_id}
          `;
          await tx`
            UPDATE matches SET rematch_created_match_id = ${created.id}, updated_at = clock_timestamp()
            WHERE id = ${input.matchId} AND rematch_created_match_id IS NULL
          `;
          await this.appendEvent(tx, input.matchId, "REMATCH_CREATED", {
            matchId: created.id,
            roundNumber: match.round_number + 1,
          });
          await this.appendEvent(tx, created.id, "MATCH_CREATED", {
            difficulty: match.difficulty,
            roundNumber: match.round_number + 1,
            previousMatchId: match.id,
          });
        } else {
          const [existing] = await tx<{ id: string }[]>`
            SELECT id FROM matches
            WHERE room_id = ${match.room_id} AND round_number = ${match.round_number + 1}
          `;
          createdMatchId = existing?.id ?? null;
        }
      }
      const resultMatchId = createdMatchId ?? input.matchId;
      await this.completeCommand(tx, input.actorUserId, input.idempotencyKey, {
        matchId: resultMatchId,
      });
      return resultMatchId;
    });
    return this.getSnapshotByMatch(input.actorUserId, targetMatchId);
  }

  async forfeitMatch(input: {
    actorUserId: string;
    matchId: string;
    idempotencyKey: string;
  }): Promise<MatchSnapshot> {
    requireActor(input.actorUserId);
    await this.sql.begin(async (tx) => {
      const match = await this.lockMatch(tx, input.matchId);
      await this.lockParticipant(tx, input.matchId, input.actorUserId);
      const reservation = await this.reserveCommand(tx, {
        actorUserId: input.actorUserId,
        idempotencyKey: input.idempotencyKey,
        commandType: "FORFEIT_MATCH",
        matchId: input.matchId,
        payload: {},
      });
      if (reservation.duplicate) return;
      if (match.state !== "ACTIVE") {
        throw new DomainError(
          "INVALID_STATE",
          "Forfeit is allowed only during an active match",
          409,
        );
      }
      const [ownInflight] = await tx<{ exists: boolean }[]>`
        SELECT true AS exists FROM executions
        WHERE match_id = ${input.matchId} AND clerk_user_id = ${input.actorUserId}
          AND kind = 'SUBMIT' AND status IN ('QUEUED', 'RUNNING')
        LIMIT 1
      `;
      if (ownInflight) {
        throw new DomainError(
          "EXECUTION_IN_PROGRESS",
          "Wait for your in-flight submission before forfeiting",
          409,
        );
      }
      const [opponent] = await tx<{ clerk_user_id: string }[]>`
        SELECT clerk_user_id FROM match_participants
        WHERE match_id = ${input.matchId} AND clerk_user_id <> ${input.actorUserId}
      `;
      if (!opponent) {
        await this.finalizeMatchTx(tx, input.matchId, "CANCELLED", null);
      } else {
        await this.finalizeMatchTx(
          tx,
          input.matchId,
          "FORFEIT",
          opponent.clerk_user_id,
        );
      }
      await this.completeCommand(tx, input.actorUserId, input.idempotencyKey, {
        ok: true,
      });
    });
    return this.getSnapshotByMatch(input.actorUserId, input.matchId);
  }

  private async evaluateDisconnectsTx(
    tx: Tx,
    matchId: string,
  ): Promise<boolean> {
    const match = await this.lockMatch(tx, matchId);
    if (match.state !== "ACTIVE") return false;
    const participants = await tx<
      {
        clerk_user_id: string;
        slot: 1 | 2;
        connected: boolean;
        expired: boolean;
      }[]
    >`
      SELECT clerk_user_id, slot, connected,
             reconnect_deadline IS NOT NULL AND reconnect_deadline <= clock_timestamp() AS expired
      FROM match_participants
      WHERE match_id = ${matchId}
      ORDER BY slot
      FOR UPDATE
    `;
    if (participants.length !== 2) return false;
    const disconnected = participants.filter((player) => !player.connected);
    if (disconnected.length === 0) return false;
    const expired = disconnected.filter((player) => player.expired);
    if (expired.length === 0) return false;

    // A completed acceptance whose ordering is waiting on an earlier execution
    // must remain eligible even after its author disconnects.
    const [acceptedPendingResolution] = await tx<{ exists: boolean }[]>`
      SELECT true AS exists FROM executions
      WHERE match_id = ${matchId} AND kind = 'SUBMIT'
        AND status = 'COMPLETED' AND verdict = 'ACCEPTED'
      LIMIT 1
    `;
    if (acceptedPendingResolution) return false;

    const [inflight] = await tx<{ exists: boolean }[]>`
      SELECT true AS exists FROM executions
      WHERE match_id = ${matchId} AND kind = 'SUBMIT' AND status IN ('QUEUED', 'RUNNING')
        AND clerk_user_id = ANY(${tx.array(expired.map((player) => player.clerk_user_id))})
      LIMIT 1
    `;
    if (inflight) return false;

    if (disconnected.length === 2) {
      if (expired.length < 2) return false;
      return this.finalizeMatchTx(tx, matchId, "NO_CONTEST", null);
    }
    const loser = expired[0];
    const winner = participants.find((player) => player.connected);
    if (!loser || !winner) return false;
    return this.finalizeMatchTx(tx, matchId, "FORFEIT", winner.clerk_user_id);
  }

  async connectSession(input: {
    actorUserId: string;
    roomId: string;
    matchId: string;
    sessionId?: string;
  }): Promise<{ sessionId: string; snapshot: MatchSnapshot }> {
    requireActor(input.actorUserId);
    const membership = await this.assertRoomMembership(
      input.actorUserId,
      input.roomId,
    );
    if (membership.matchId !== input.matchId) {
      throw new DomainError(
        "MATCH_NOT_FOUND",
        "Realtime ticket targets a stale match",
        409,
      );
    }
    const sessionId = input.sessionId ?? randomUUID();
    await this.sql.begin(async (tx) => {
      await this.evaluateDisconnectsTx(tx, input.matchId);
      const participant = await this.lockParticipant(
        tx,
        input.matchId,
        input.actorUserId,
      );
      await tx`
        INSERT INTO realtime_sessions (id, room_id, match_id, clerk_user_id)
        VALUES (${sessionId}, ${input.roomId}, ${input.matchId}, ${input.actorUserId})
        ON CONFLICT (id) DO UPDATE
        SET last_seen_at = clock_timestamp(), disconnected_at = NULL
        WHERE realtime_sessions.clerk_user_id = EXCLUDED.clerk_user_id
      `;
      await tx`
        UPDATE match_participants
        SET connected = true, disconnected_at = NULL, reconnect_deadline = NULL,
            activity = CASE
              WHEN active_execution_id IS NOT NULL THEN 'JUDGING'
              WHEN activity = 'DISCONNECTED' THEN 'THINKING'
              ELSE activity END,
            updated_at = clock_timestamp()
        WHERE match_id = ${input.matchId} AND clerk_user_id = ${input.actorUserId}
      `;
      if (!participant.connected) {
        await this.appendEvent(tx, input.matchId, "CONNECTION_CHANGED", {
          slot: participant.slot,
          connected: true,
        });
      }
    });
    return {
      sessionId,
      snapshot: await this.getSnapshotByMatch(input.actorUserId, input.matchId),
    };
  }

  async touchSession(sessionId: string, actorUserId: string): Promise<boolean> {
    requireActor(actorUserId);
    const [session] = await this.sql<{ id: string }[]>`
      UPDATE realtime_sessions session
      SET last_seen_at = clock_timestamp()
      FROM rooms room, room_members member
      WHERE session.id = ${sessionId}
        AND session.clerk_user_id = ${actorUserId}
        AND session.disconnected_at IS NULL
        AND room.id = session.room_id
        AND room.active_match_id = session.match_id
        AND member.room_id = session.room_id
        AND member.clerk_user_id = session.clerk_user_id
      RETURNING session.id
    `;
    return Boolean(session);
  }

  async disconnectSession(
    sessionId: string,
    actorUserId: string,
  ): Promise<void> {
    requireActor(actorUserId);
    const [session] = await this.sql<{ match_id: string }[]>`
      UPDATE realtime_sessions SET disconnected_at = clock_timestamp()
      WHERE id = ${sessionId} AND clerk_user_id = ${actorUserId} AND disconnected_at IS NULL
      RETURNING match_id
    `;
    if (!session) return;
    await this.reconcileConnection(session.match_id, actorUserId);
  }

  private async reconcileConnection(
    matchId: string,
    actorUserId: string,
  ): Promise<void> {
    await this.sql.begin(async (tx) => {
      const match = await this.lockMatch(tx, matchId);
      const participant = await this.lockParticipant(tx, matchId, actorUserId);
      const [presence] = await tx<
        { active: boolean; disconnected_at: string | null }[]
      >`
        SELECT EXISTS (
                 SELECT 1 FROM realtime_sessions
                 WHERE match_id = ${matchId} AND clerk_user_id = ${actorUserId}
                   AND disconnected_at IS NULL
                   AND last_seen_at > clock_timestamp() - interval '45 seconds'
               ) AS active,
               max(COALESCE(disconnected_at, last_seen_at))::text AS disconnected_at
        FROM realtime_sessions
        WHERE match_id = ${matchId} AND clerk_user_id = ${actorUserId}
      `;
      if (
        presence?.active ||
        !participant.connected ||
        !presence?.disconnected_at
      ) {
        return;
      }
      await tx`
        UPDATE match_participants
        SET connected = false,
            disconnected_at = ${presence.disconnected_at}::timestamptz,
            reconnect_deadline = CASE WHEN ${match.state} = 'ACTIVE'
              THEN ${presence.disconnected_at}::timestamptz
                + (${this.options.reconnectGraceSeconds} * interval '1 second')
              ELSE NULL END,
            activity = 'DISCONNECTED', updated_at = clock_timestamp()
        WHERE match_id = ${matchId} AND clerk_user_id = ${actorUserId}
      `;
      await this.appendEvent(tx, matchId, "CONNECTION_CHANGED", {
        slot: participant.slot,
        connected: false,
        graceSeconds:
          match.state === "ACTIVE" ? this.options.reconnectGraceSeconds : null,
      });
    });
  }

  private async reconcileExpiredSessions(
    sessions: { match_id: string; clerk_user_id: string }[],
  ): Promise<number> {
    const unique = new Map<string, { matchId: string; actorUserId: string }>();
    for (const session of sessions) {
      unique.set(`${session.match_id}:${session.clerk_user_id}`, {
        matchId: session.match_id,
        actorUserId: session.clerk_user_id,
      });
    }
    for (const item of unique.values()) {
      await this.reconcileConnection(item.matchId, item.actorUserId);
    }
    return sessions.length;
  }

  async expireStaleSessions(): Promise<number> {
    const sessions = await this.sql<
      { match_id: string; clerk_user_id: string }[]
    >`
      UPDATE realtime_sessions
      SET disconnected_at = last_seen_at
      WHERE disconnected_at IS NULL
        AND last_seen_at <= clock_timestamp() - interval '45 seconds'
      RETURNING match_id, clerk_user_id
    `;
    return this.reconcileExpiredSessions(sessions);
  }

  async expireStaleSessionsForMatch(matchId: string): Promise<number> {
    const sessions = await this.sql<
      { match_id: string; clerk_user_id: string }[]
    >`
      UPDATE realtime_sessions
      SET disconnected_at = last_seen_at
      WHERE match_id = ${matchId}
        AND disconnected_at IS NULL
        AND last_seen_at <= clock_timestamp() - interval '45 seconds'
      RETURNING match_id, clerk_user_id
    `;
    return this.reconcileExpiredSessions(sessions);
  }

  async processDueDisconnects(limit = 100): Promise<number> {
    const rows = await this.sql<{ match_id: string }[]>`
      SELECT DISTINCT match_id
      FROM match_participants
      WHERE reconnect_deadline IS NOT NULL AND reconnect_deadline <= clock_timestamp()
      ORDER BY match_id
      LIMIT ${Math.max(1, Math.min(500, Math.trunc(limit)))}
    `;
    let finalized = 0;
    for (const row of rows) {
      const changed = await this.sql.begin((tx) =>
        this.evaluateDisconnectsTx(tx, row.match_id),
      );
      if (changed) finalized += 1;
    }
    return finalized;
  }

  async processDueDisconnectForMatch(matchId: string): Promise<number> {
    const [due] = await this.sql<{ exists: boolean }[]>`
      SELECT true AS exists
      FROM match_participants
      WHERE match_id = ${matchId}
        AND reconnect_deadline IS NOT NULL
        AND reconnect_deadline <= clock_timestamp()
      LIMIT 1
    `;
    if (!due) return 0;
    const changed = await this.sql.begin((tx) =>
      this.evaluateDisconnectsTx(tx, matchId),
    );
    return changed ? 1 : 0;
  }

  async purgeOldRealtimeSessions(
    retentionSeconds = 86_400,
    limit = 1_000,
  ): Promise<number> {
    const boundedRetention = Math.max(
      60,
      Math.min(31_536_000, Math.trunc(retentionSeconds)),
    );
    const boundedLimit = Math.max(1, Math.min(5_000, Math.trunc(limit)));
    const deleted = await this.sql`
      WITH expired AS (
        SELECT id
        FROM realtime_sessions
        WHERE disconnected_at IS NOT NULL
          AND disconnected_at <= clock_timestamp()
            - (${boundedRetention} * interval '1 second')
        ORDER BY disconnected_at, id
        LIMIT ${boundedLimit}
        FOR UPDATE SKIP LOCKED
      )
      DELETE FROM realtime_sessions session
      USING expired
      WHERE session.id = expired.id
    `;
    return deleted.count;
  }

  async getExecutionResult(
    actorUserId: string,
    executionId: string,
  ): Promise<{
    status: "QUEUED" | "RUNNING" | "COMPLETED";
    result: RunnerResult | null;
  }> {
    requireActor(actorUserId);
    const [row] = await this.sql<
      {
        status: "QUEUED" | "RUNNING" | "COMPLETED";
        result_summary: Record<string, unknown> | null;
      }[]
    >`
      SELECT status, result_summary
      FROM executions
      WHERE id = ${executionId} AND clerk_user_id = ${actorUserId}
    `;
    if (!row)
      throw new DomainError("NOT_A_PARTICIPANT", "Execution is not yours", 403);
    if (row.status !== "COMPLETED" || !row.result_summary) {
      return { status: row.status, result: null };
    }
    const summary = row.result_summary;
    return {
      status: "COMPLETED",
      result: {
        verdict: summary.verdict as RunnerResult["verdict"],
        passedCount: Number(summary.passedCount ?? 0),
        totalCount: Number(summary.totalCount ?? 0),
        runtimeMs:
          summary.runtimeMs === null ? null : Number(summary.runtimeMs),
        compileMs:
          summary.compileMs === null ? null : Number(summary.compileMs),
        ...(summary.details && typeof summary.details === "object"
          ? { details: summary.details as Record<string, unknown> }
          : {}),
      },
    };
  }

  async recoverStaleExecutions(staleAfterSeconds = 120): Promise<number> {
    const rows = await this.sql<{ id: string }[]>`
      SELECT id FROM executions
      WHERE status IN ('QUEUED', 'RUNNING')
        AND created_at <= clock_timestamp() - (${Math.max(30, staleAfterSeconds)} * interval '1 second')
      ORDER BY created_at
      LIMIT 100
    `;
    for (const row of rows) {
      await this.completeExecution(row.id, {
        verdict: "INFRA_ERROR",
        passedCount: 0,
        totalCount: 0,
        runtimeMs: null,
        compileMs: null,
      });
    }
    return rows.length;
  }

  async recoverStaleExecutionsForMatch(
    matchId: string,
    staleAfterSeconds = 120,
  ): Promise<number> {
    const rows = await this.sql<{ id: string }[]>`
      SELECT id FROM executions
      WHERE match_id = ${matchId}
        AND status IN ('QUEUED', 'RUNNING')
        AND created_at <= clock_timestamp()
          - (${Math.max(30, staleAfterSeconds)} * interval '1 second')
      ORDER BY created_at
      LIMIT 100
    `;
    for (const row of rows) {
      await this.completeExecution(row.id, {
        verdict: "INFRA_ERROR",
        passedCount: 0,
        totalCount: 0,
        runtimeMs: null,
        compileMs: null,
      });
    }
    return rows.length;
  }
}
