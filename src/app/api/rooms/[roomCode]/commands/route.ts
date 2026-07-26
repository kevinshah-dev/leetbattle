import { z } from "zod";

import { requireAuthenticatedUserId } from "@/server/auth";
import { DomainError } from "@/server/domain/errors";
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

const idempotencyKey = z.string().min(1).max(200);
const language = z.enum(["PYTHON", "JAVA"]);
const commandContext = {
  matchId: z.string().uuid(),
  expectedVersion: z.number().int().nonnegative(),
};
const commandInput = z.discriminatedUnion("type", [
  z
    .object({
      ...commandContext,
      type: z.literal("SELECT_LANGUAGE"),
      idempotencyKey,
      payload: z.object({ language }).strict(),
    })
    .strict(),
  z
    .object({
      ...commandContext,
      type: z.literal("SET_READY"),
      idempotencyKey,
      payload: z.object({ ready: z.boolean() }).strict(),
    })
    .strict(),
  z
    .object({
      ...commandContext,
      type: z.literal("RUN_SAMPLES"),
      idempotencyKey,
      payload: z.object({ language, source: z.string() }).strict(),
    })
    .strict(),
  z
    .object({
      ...commandContext,
      type: z.literal("SUBMIT"),
      idempotencyKey,
      payload: z.object({ language, source: z.string() }).strict(),
    })
    .strict(),
  z
    .object({
      ...commandContext,
      type: z.literal("REMATCH_VOTE"),
      idempotencyKey,
      payload: z.object({ vote: z.literal(true) }).strict(),
    })
    .strict(),
  z
    .object({
      ...commandContext,
      type: z.literal("FORFEIT"),
      idempotencyKey,
      payload: z.object({}).strict(),
    })
    .strict(),
  z
    .object({
      ...commandContext,
      type: z.literal("CANCEL"),
      idempotencyKey,
      payload: z.object({}).strict(),
    })
    .strict(),
]);

export async function POST(
  request: Request,
  context: { params: Promise<{ roomCode: string }> },
) {
  return apiRoute(async () => {
    requireMutationOrigin(request);
    const actorUserId = await requireAuthenticatedUserId();
    const { roomCode } = await context.params;
    const input = commandInput.parse(await readJson(request));
    return withServices(async (services) => {
      const roomId = await services.matches.getRoomIdForInvite(
        actorUserId,
        roomCode,
      );
      let authoritative = await services.matches.getSnapshot(
        actorUserId,
        roomId,
      );
      if (authoritative.matchId !== input.matchId) {
        throw new DomainError(
          "MATCH_NOT_FOUND",
          "This command belongs to an earlier round. Refresh the room and try again.",
          409,
        );
      }
      if (input.expectedVersion > authoritative.version) {
        throw new DomainError(
          "INVALID_STATE",
          "The command references a match version the server has not published.",
          409,
        );
      }
      const matchId = authoritative.matchId;

      switch (input.type) {
        case "SELECT_LANGUAGE":
          authoritative = await services.matches.setLanguage({
            actorUserId,
            matchId,
            language: input.payload.language,
            idempotencyKey: input.idempotencyKey,
          });
          break;
        case "SET_READY":
          authoritative = await services.matches.setReady({
            actorUserId,
            matchId,
            ready: input.payload.ready,
            idempotencyKey: input.idempotencyKey,
          });
          break;
        case "RUN_SAMPLES":
        case "SUBMIT": {
          // The selected server-side language remains authoritative.
          const self = authoritative.players.find((player) => player.isSelf);
          if (!self || self.language !== input.payload.language) {
            throw new DomainError(
              "INVALID_LANGUAGE",
              "Editor language does not match the locked loadout",
              409,
            );
          }
          await services.executions.execute({
            actorUserId,
            matchId,
            idempotencyKey: input.idempotencyKey,
            kind: input.type === "RUN_SAMPLES" ? "RUN" : "SUBMIT",
            source: input.payload.source,
          });
          authoritative = await services.matches.getSnapshotByMatch(
            actorUserId,
            matchId,
          );
          break;
        }
        case "REMATCH_VOTE":
          authoritative = await services.matches.requestRematch({
            actorUserId,
            matchId,
            idempotencyKey: input.idempotencyKey,
          });
          break;
        case "FORFEIT":
          authoritative = await services.matches.forfeitMatch({
            actorUserId,
            matchId,
            idempotencyKey: input.idempotencyKey,
          });
          break;
        case "CANCEL":
          authoritative = await services.matches.cancelMatch({
            actorUserId,
            matchId,
            idempotencyKey: input.idempotencyKey,
          });
          break;
      }

      const snapshot = await presentRoomSnapshot({
        actorUserId,
        inviteToken: roomCode,
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
      return json({
        accepted: true as const,
        version: snapshot.version,
        snapshot,
      });
    });
  });
}
