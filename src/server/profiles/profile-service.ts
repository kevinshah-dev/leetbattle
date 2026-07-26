import type { Database } from "@/server/db/client";
import { DomainError, requireActor } from "@/server/domain/errors";

export interface ProfileView {
  userId: string;
  username: string;
  wins: number;
  losses: number;
}

function validateUsername(username: string): string {
  const normalized = username.trim();
  if (!/^[A-Za-z0-9_]{3,20}$/.test(normalized)) {
    throw new DomainError(
      "USERNAME_INVALID",
      "Username must be 3–20 letters, digits, or underscores",
      422,
    );
  }
  return normalized;
}

function isUniqueViolation(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === "23505",
  );
}

export class ProfileService {
  constructor(private readonly sql: Database) {}

  async create(actorUserId: string, username: string): Promise<ProfileView> {
    requireActor(actorUserId);
    const validUsername = validateUsername(username);
    try {
      await this.sql.begin(async (tx) => {
        await tx`
          INSERT INTO profiles (clerk_user_id, username)
          VALUES (${actorUserId}, ${validUsername})
          ON CONFLICT (clerk_user_id) DO NOTHING
        `;
        const [existing] = await tx<{ username: string }[]>`
          SELECT username::text AS username FROM profiles WHERE clerk_user_id = ${actorUserId}
        `;
        if (!existing) throw new Error("Profile insert failed");
        if (
          existing.username.toLocaleLowerCase() !==
          validUsername.toLocaleLowerCase()
        ) {
          throw new DomainError(
            "USERNAME_TAKEN",
            "A profile already exists for this account",
            409,
          );
        }
        await tx`
          INSERT INTO player_records (clerk_user_id)
          VALUES (${actorUserId})
          ON CONFLICT DO NOTHING
        `;
      });
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DomainError(
          "USERNAME_TAKEN",
          "That username is already taken",
          409,
        );
      }
      throw error;
    }
    return (await this.get(actorUserId))!;
  }

  async rename(actorUserId: string, username: string): Promise<ProfileView> {
    requireActor(actorUserId);
    const validUsername = validateUsername(username);
    try {
      const result = await this.sql`
        UPDATE profiles
        SET username = ${validUsername}, updated_at = clock_timestamp()
        WHERE clerk_user_id = ${actorUserId}
        RETURNING clerk_user_id
      `;
      if (result.count === 0)
        throw new DomainError(
          "PROFILE_REQUIRED",
          "Create a profile first",
          409,
        );
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new DomainError(
          "USERNAME_TAKEN",
          "That username is already taken",
          409,
        );
      }
      throw error;
    }
    return (await this.get(actorUserId))!;
  }

  async get(actorUserId: string): Promise<ProfileView | null> {
    requireActor(actorUserId);
    const [row] = await this.sql<
      {
        clerk_user_id: string;
        username: string;
        wins: number;
        losses: number;
      }[]
    >`
      SELECT p.clerk_user_id, p.username::text AS username,
             COALESCE(r.wins, 0)::int AS wins, COALESCE(r.losses, 0)::int AS losses
      FROM profiles p
      LEFT JOIN player_records r ON r.clerk_user_id = p.clerk_user_id
      WHERE p.clerk_user_id = ${actorUserId}
    `;
    if (!row) return null;
    return {
      userId: row.clerk_user_id,
      username: row.username,
      wins: row.wins,
      losses: row.losses,
    };
  }
}
