import { z } from "zod";

import { requireAuthenticatedUserId } from "@/server/auth";
import { apiRoute, json, readJson, requireMutationOrigin } from "@/server/http";
import { withServices } from "@/server/services";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return apiRoute(async () => {
    const actorUserId = await requireAuthenticatedUserId();
    return withServices(async (services) => {
      const profile = await services.profiles.get(actorUserId);
      return json({
        profile: profile
          ? {
              username: profile.username,
              wins: profile.wins,
              losses: profile.losses,
            }
          : null,
      });
    });
  });
}

const profileInput = z.object({ username: z.string() }).strict();

export async function POST(request: Request) {
  return apiRoute(async () => {
    requireMutationOrigin(request);
    const actorUserId = await requireAuthenticatedUserId();
    const body = profileInput.parse(await readJson(request, 4 * 1024));
    return withServices(async (services) => {
      const profile = await services.profiles.create(
        actorUserId,
        body.username,
      );
      return json(
        {
          profile: {
            username: profile.username,
            wins: profile.wins,
            losses: profile.losses,
          },
        },
        { status: 201 },
      );
    });
  });
}
