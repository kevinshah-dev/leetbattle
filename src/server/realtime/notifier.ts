import type { ServiceBinding } from "@/server/cloudflare/context";
import { requireInternalSecret } from "@/server/config/secrets";

export interface MatchNotification {
  matchId: string;
  version?: number;
  startsAt?: string | null;
  wakeAt?: string | null;
}

/**
 * Best-effort invalidation channel. PostgreSQL remains authoritative and the
 * browser still polls, so a failed notification must never roll back a match
 * mutation that already committed.
 */
export class RealtimeNotifier {
  private readonly secret: string | null;
  private readonly deadlineMs: number;

  constructor(
    private readonly service: ServiceBinding | null = null,
    secret?: string | null,
    deadlineMs = 1_000,
  ) {
    this.secret =
      service === null
        ? null
        : requireInternalSecret("REALTIME_NOTIFY_SECRET", secret);
    this.deadlineMs = Number.isFinite(deadlineMs)
      ? Math.max(10, Math.min(5_000, Math.trunc(deadlineMs)))
      : 1_000;
  }

  async matchUpdated(notification: MatchNotification): Promise<void> {
    if (!this.service || !this.secret) return;
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      const deadline = new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          controller.abort();
          reject(new Error("Realtime invalidation deadline exceeded"));
        }, this.deadlineMs);
      });
      const response = await Promise.race([
        this.service.fetch(
          "https://leetbattle-realtime.internal/internal/notify",
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${this.secret}`,
              "content-type": "application/json",
            },
            body: JSON.stringify(notification),
            signal: controller.signal,
          },
        ),
        deadline,
      ]);
      if (!response.ok) {
        console.warn("Realtime invalidation was not accepted", response.status);
      }
    } catch (error) {
      console.warn(
        "Realtime invalidation failed",
        error instanceof Error ? error.message : "unknown error",
      );
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}
