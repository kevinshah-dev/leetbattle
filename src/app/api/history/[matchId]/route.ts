import { requireAuthenticatedUserId } from "@/server/auth";
import { apiRoute, json } from "@/server/http";
import { withServices } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ matchId: string }>;
}

export async function GET(_request: Request, context: RouteContext) {
  return apiRoute(async () => {
    const actorUserId = await requireAuthenticatedUserId();
    const { matchId } = await context.params;
    return withServices(async (services) => {
      const match = await services.history.detail(actorUserId, matchId);
      return json({
        match: {
          id: match.matchId,
          challengeType: match.challengeType,
          mode: match.mode,
          playedAt: match.playedAt,
          difficulty: match.difficulty,
          opponentUsername: match.opponent,
          problemTitle: match.problemTitle,
          language: match.language,
          outcome: match.outcome,
          endReason: match.endReason,
          durationMs: Math.round(match.durationSeconds * 1_000),
          aiMl: match.aiMl,
        },
      });
    });
  });
}
