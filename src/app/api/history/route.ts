import { requireAuthenticatedUserId } from "@/server/auth";
import { DomainError } from "@/server/domain/errors";
import { apiRoute, json } from "@/server/http";
import { withServices } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return apiRoute(async () => {
    const actorUserId = await requireAuthenticatedUserId();
    return withServices(async (services) => {
      const profile = await services.profiles.get(actorUserId);
      if (!profile)
        throw new DomainError(
          "PROFILE_REQUIRED",
          "Create a username first",
          409,
        );
      const history = await services.history.recent(actorUserId, 30);
      return json({
        profile: {
          username: profile.username,
          wins: profile.wins,
          losses: profile.losses,
        },
        matches: history.map((match) => ({
          id: match.matchId,
          roomCode: "",
          playedAt: match.playedAt,
          challengeType: match.challengeType,
          mode: match.mode,
          opponentUsername: match.opponent,
          problemTitle: match.problemTitle,
          difficulty: match.difficulty,
          language: match.language,
          outcome: match.outcome,
          score: match.score,
          durationMs: Math.round(match.durationSeconds * 1_000),
          endReason: match.endReason,
        })),
      });
    });
  });
}
