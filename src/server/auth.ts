import "server-only";

import { auth } from "@clerk/nextjs/server";

import { DomainError } from "@/server/domain/errors";

/**
 * The single authentication boundary for protected App Router handlers.
 * Callers must still perform the room/participant authorization relevant to
 * their action; the match service does that on every command.
 */
export async function requireAuthenticatedUserId(): Promise<string> {
  const { userId } = await auth();
  if (!userId)
    throw new DomainError("AUTH_REQUIRED", "Authentication is required", 401);
  return userId;
}
