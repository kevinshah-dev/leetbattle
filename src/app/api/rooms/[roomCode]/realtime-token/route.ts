import { requireAuthenticatedUserId } from "@/server/auth";
import { apiRoute, json, requireMutationOrigin } from "@/server/http";
import { withServices } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ roomCode: string }> },
) {
  return apiRoute(async () => {
    requireMutationOrigin(request);
    const actorUserId = await requireAuthenticatedUserId();
    const { roomCode } = await context.params;
    return withServices(async (services) => {
      const roomId = await services.matches.getRoomIdForInvite(
        actorUserId,
        roomCode,
      );
      const ticket = await services.realtimeTickets.issue(actorUserId, roomId);
      return json({ token: ticket.token, expiresAt: ticket.expiresAt });
    });
  });
}
