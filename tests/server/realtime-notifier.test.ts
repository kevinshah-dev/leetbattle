import { afterEach, describe, expect, it, vi } from "vitest";

import { RealtimeNotifier } from "@/server/realtime/notifier";

const secret = `notify-${"a".repeat(40)}`;

afterEach(() => {
  vi.restoreAllMocks();
});

describe("RealtimeNotifier", () => {
  it("bounds the latency of a best-effort notification", async () => {
    const fetch =
      vi.fn<
        (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
      >();
    fetch.mockReturnValue(new Promise<Response>(() => undefined));
    const service = { fetch };
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const notifier = new RealtimeNotifier(service, secret, 10);

    const started = Date.now();
    await notifier.matchUpdated({ matchId: "match_123", version: 7 });

    expect(Date.now() - started).toBeLessThan(250);
    expect(service.fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
    expect(console.warn).toHaveBeenCalledWith(
      "Realtime invalidation failed",
      "Realtime invalidation deadline exceeded",
    );
  });

  it("sends the signed notification payload", async () => {
    const fetch =
      vi.fn<
        (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
      >();
    fetch.mockResolvedValue(new Response(null, { status: 202 }));
    const service = { fetch };
    const notifier = new RealtimeNotifier(service, secret);
    const notification = { matchId: "match_123", version: 7 };

    await notifier.matchUpdated(notification);

    const [, init] = service.fetch.mock.calls[0]!;
    expect(init).toMatchObject({
      method: "POST",
      body: JSON.stringify(notification),
    });
    expect(new Headers(init?.headers).get("authorization")).toBe(
      `Bearer ${secret}`,
    );
  });
});
