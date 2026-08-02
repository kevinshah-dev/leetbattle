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

const createRoomInput = z
  .object({
    difficulty: z.enum(["EASY", "MEDIUM", "HARD"]),
    mode: z.enum(["DUEL", "PRACTICE"]).default("DUEL"),
    idempotencyKey: z.string().min(1).max(200),
  })
  .strict();

export async function POST(request: Request) {
  return apiRoute(async () => {
    requireMutationOrigin(request);
    const actorUserId = await requireAuthenticatedUserId();
    const input = createRoomInput.parse(await readJson(request, 8 * 1024));
    return withServices(async (services) => {
      const created = await services.matches.createRoom({
        actorUserId,
        ...input,
      });
      const snapshot = await presentRoomSnapshot({
        actorUserId,
        inviteToken: created.inviteToken,
        snapshot: created.snapshot,
        db: services.db,
        matches: services.matches,
        appOrigin: appOrigin(request),
      });
      await services.realtime.matchUpdated({
        matchId: snapshot.matchId,
        version: snapshot.version,
        startsAt: snapshot.startsAt,
      });
      return json(
        {
          roomCode: created.inviteToken,
          ...(snapshot.inviteUrl ? { inviteUrl: snapshot.inviteUrl } : {}),
          snapshot,
        },
        { status: 201 },
      );
    });
  });
}
