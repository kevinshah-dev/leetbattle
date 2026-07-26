import { z } from "zod";

import { requireAuthenticatedUserId } from "@/server/auth";
import {
  apiRoute,
  appOrigin,
  json,
  readJson,
  requireMutationOrigin,
} from "@/server/http";
import { presentRoomSnapshot } from "@/server/presentation";
import { withServices } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const roomCode = z
  .string()
  .min(32)
  .max(128)
  .regex(/^[A-Za-z0-9_-]+$/);
const joinInput = z
  .object({
    roomCode,
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();

export async function POST(request: Request) {
  return apiRoute(async () => {
    requireMutationOrigin(request);
    const actorUserId = await requireAuthenticatedUserId();
    const input = joinInput.parse(await readJson(request, 8 * 1024));
    return withServices(async (services) => {
      const authoritative = await services.matches.joinRoom({
        actorUserId,
        inviteToken: input.roomCode,
        idempotencyKey: input.idempotencyKey,
      });
      const snapshot = await presentRoomSnapshot({
        actorUserId,
        inviteToken: input.roomCode,
        snapshot: authoritative,
        db: services.db,
        matches: services.matches,
        appOrigin: appOrigin(request),
      });
      await services.realtime.matchUpdated({
        matchId: snapshot.matchId,
        version: snapshot.version,
        startsAt: snapshot.startsAt,
      });
      return json({ snapshot });
    });
  });
}
