import { randomUUID } from "node:crypto";

import { jwtVerify, SignJWT } from "jose";

import { requireInternalSecret } from "@/server/config/secrets";
import type { Database } from "@/server/db/client";
import { DomainError, requireActor } from "@/server/domain/errors";
import type { MatchEngine } from "@/server/match/match-engine";

export interface RealtimeClaims {
  userId: string;
  roomId: string;
  matchId: string;
  slot: 1 | 2;
  jti: string;
  expiresAt: string;
}

function signingKey(secret: string): Uint8Array {
  return new TextEncoder().encode(
    requireInternalSecret("REALTIME_TICKET_SECRET", secret),
  );
}

const MAX_OUTSTANDING_TICKETS = 3;
const MAX_TICKETS_PER_MINUTE = 12;

/** Issues short-lived, audience-bound, one-use WebSocket admission tickets. */
export class RealtimeTicketService {
  private readonly key: Uint8Array;

  constructor(
    private readonly sql: Database,
    private readonly engine: MatchEngine,
    secret: string,
    private readonly lifetimeSeconds = 45,
  ) {
    this.key = signingKey(secret);
  }

  async issue(
    actorUserId: string,
    roomId: string,
  ): Promise<{ token: string; expiresAt: string }> {
    requireActor(actorUserId);
    const membership = await this.engine.assertRoomMembership(
      actorUserId,
      roomId,
    );
    const jti = randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const expires = now + this.lifetimeSeconds;
    await this.sql.begin(async (tx) => {
      // Serialize issuance across every room owned by this user so the
      // per-minute bound remains atomic across Worker isolates.
      const [profile] = await tx<{ clerk_user_id: string }[]>`
        SELECT clerk_user_id
        FROM profiles
        WHERE clerk_user_id = ${actorUserId}
        FOR UPDATE
      `;
      if (!profile) {
        throw new DomainError(
          "PROFILE_REQUIRED",
          "Create a profile before requesting realtime access",
          409,
        );
      }

      const [current] = await tx<
        {
          slot: 1 | 2;
          active_match_id: string | null;
        }[]
      >`
        SELECT rm.slot, r.active_match_id
        FROM room_members rm
        JOIN rooms r ON r.id = rm.room_id
        WHERE rm.room_id = ${roomId} AND rm.clerk_user_id = ${actorUserId}
        FOR SHARE OF rm, r
      `;
      if (
        !current ||
        current.slot !== membership.slot ||
        current.active_match_id !== membership.matchId
      ) {
        throw new DomainError(
          "MATCH_NOT_FOUND",
          "Realtime room membership changed",
          409,
        );
      }

      const [usage] = await tx<
        {
          recent: number;
          outstanding: number;
          oldest_recent: string | null;
          earliest_expiration: string | null;
        }[]
      >`
        SELECT
          count(*) FILTER (
            WHERE issued_at > clock_timestamp() - interval '1 minute'
          )::int AS recent,
          count(*) FILTER (
            WHERE room_id = ${roomId}
              AND consumed_at IS NULL
              AND expires_at > clock_timestamp()
          )::int AS outstanding,
          (min(issued_at) FILTER (
            WHERE issued_at > clock_timestamp() - interval '1 minute'
          ))::text AS oldest_recent,
          (min(expires_at) FILTER (
            WHERE room_id = ${roomId}
              AND consumed_at IS NULL
              AND expires_at > clock_timestamp()
          ))::text AS earliest_expiration
        FROM realtime_ticket_issues
        WHERE clerk_user_id = ${actorUserId}
      `;
      if (
        (usage?.recent ?? 0) >= MAX_TICKETS_PER_MINUTE ||
        (usage?.outstanding ?? 0) >= MAX_OUTSTANDING_TICKETS
      ) {
        const retryCandidates: number[] = [];
        if (
          (usage?.recent ?? 0) >= MAX_TICKETS_PER_MINUTE &&
          usage?.oldest_recent
        ) {
          retryCandidates.push(Date.parse(usage.oldest_recent) + 60_000);
        }
        if (
          (usage?.outstanding ?? 0) >= MAX_OUTSTANDING_TICKETS &&
          usage?.earliest_expiration
        ) {
          retryCandidates.push(Date.parse(usage.earliest_expiration));
        }
        const retryAt = new Date(
          Math.max(Date.now() + 1_000, ...retryCandidates),
        ).toISOString();
        throw new DomainError(
          "RATE_LIMITED",
          "Too many realtime tickets have been requested",
          429,
          retryAt,
        );
      }

      await tx`
        INSERT INTO realtime_ticket_issues
          (jti, clerk_user_id, room_id, match_id, issued_at, expires_at)
        VALUES (
          ${jti},
          ${actorUserId},
          ${roomId},
          ${membership.matchId},
          to_timestamp(${now}),
          to_timestamp(${expires})
        )
      `;
    });
    const token = await new SignJWT({
      roomId,
      matchId: membership.matchId,
      slot: membership.slot,
    })
      .setProtectedHeader({ alg: "HS256", typ: "JWT" })
      .setSubject(actorUserId)
      .setJti(jti)
      .setIssuer("leetbattle-web")
      .setAudience("leetbattle-realtime")
      .setIssuedAt(now)
      .setExpirationTime(expires)
      .sign(this.key);
    return { token, expiresAt: new Date(expires * 1000).toISOString() };
  }

  async verifyAndConsume(token: string): Promise<RealtimeClaims> {
    let payload: Awaited<ReturnType<typeof jwtVerify>>["payload"];
    try {
      ({ payload } = await jwtVerify(token, this.key, {
        algorithms: ["HS256"],
        issuer: "leetbattle-web",
        audience: "leetbattle-realtime",
        clockTolerance: 2,
      }));
    } catch {
      throw new DomainError(
        "TICKET_INVALID",
        "Realtime ticket is invalid or expired",
        401,
      );
    }
    const { sub, jti, exp, roomId, matchId, slot } = payload;
    if (
      typeof sub !== "string" ||
      typeof jti !== "string" ||
      typeof exp !== "number" ||
      typeof roomId !== "string" ||
      typeof matchId !== "string" ||
      (slot !== 1 && slot !== 2)
    ) {
      throw new DomainError(
        "TICKET_INVALID",
        "Realtime ticket claims are invalid",
        401,
      );
    }
    try {
      await this.sql.begin(async (tx) => {
        const [membership] = await tx<
          { slot: 1 | 2; active_match_id: string }[]
        >`
          SELECT rm.slot, r.active_match_id
          FROM room_members rm
          JOIN rooms r ON r.id = rm.room_id
          WHERE rm.room_id = ${roomId} AND rm.clerk_user_id = ${sub}
          FOR SHARE OF rm, r
        `;
        if (
          !membership ||
          membership.slot !== slot ||
          membership.active_match_id !== matchId
        ) {
          throw new DomainError(
            "TICKET_INVALID",
            "Realtime room membership changed",
            403,
          );
        }
        await tx`
          INSERT INTO realtime_ticket_uses
            (jti, clerk_user_id, room_id, expires_at)
          VALUES (${jti}, ${sub}, ${roomId}, to_timestamp(${exp}))
        `;
        await tx`
          UPDATE realtime_ticket_issues
          SET consumed_at = clock_timestamp()
          WHERE jti = ${jti}
            AND clerk_user_id = ${sub}
            AND room_id = ${roomId}
            AND consumed_at IS NULL
        `;
      });
    } catch (error) {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "23505"
      ) {
        throw new DomainError(
          "TICKET_REPLAYED",
          "Realtime ticket has already been used",
          401,
        );
      }
      throw error;
    }
    return {
      userId: sub,
      roomId,
      matchId,
      slot,
      jti,
      expiresAt: new Date(exp * 1000).toISOString(),
    };
  }

  async purgeExpiredUses(): Promise<number> {
    return this.sql.begin(async (tx) => {
      const deletedUses = await tx`
        DELETE FROM realtime_ticket_uses
        WHERE expires_at < clock_timestamp() - interval '1 minute'
      `;
      const deletedIssues = await tx`
        DELETE FROM realtime_ticket_issues
        WHERE expires_at < clock_timestamp() - interval '1 minute'
      `;
      return deletedUses.count + deletedIssues.count;
    });
  }
}
