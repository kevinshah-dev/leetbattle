import { requireAuthenticatedUserId } from "@/server/auth";
import { apiRoute, appOrigin, json } from "@/server/http";
import { presentRoomSnapshot } from "@/server/presentation";
import { withServices } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ roomCode: string }> },
) {
  return apiRoute(async () => {
    const actorUserId = await requireAuthenticatedUserId();
    const { roomCode } = await context.params;
    return withServices(async (services) => {
      const roomId = await services.matches.getRoomIdForInvite(
        actorUserId,
        roomCode,
      );
      let authoritative = await services.matches.getSnapshot(
        actorUserId,
        roomId,
      );
      if (
        authoritative.challengeType === "AI_ML" &&
        authoritative.state === "ACTIVE" &&
        (await services.arena.processAnswerDeadlineForMatch(
          authoritative.matchId,
        ))
      ) {
        authoritative = await services.matches.getSnapshotByMatch(
          actorUserId,
          authoritative.matchId,
        );
      }
      const snapshot = await presentRoomSnapshot({
        actorUserId,
        inviteToken: roomCode,
        snapshot: authoritative,
        db: services.db,
        matches: services.matches,
        appOrigin: appOrigin(request),
      });
      return json({ snapshot });
    });
  });
}
