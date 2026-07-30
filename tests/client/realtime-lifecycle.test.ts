import { describe, expect, it } from "vitest";

import {
  parseRealtimeMessage,
  reconnectDelayMs,
  retryAtTimestamp,
} from "@/components/realtime-lifecycle";

describe("realtime client message envelopes", () => {
  it("reads nested event and snapshot versions", () => {
    expect(
      parseRealtimeMessage(
        JSON.stringify({ type: "EVENT", event: { version: 17 } }),
      ),
    ).toEqual({ kind: "INVALIDATION", version: 17 });
    expect(
      parseRealtimeMessage(
        JSON.stringify({ type: "SNAPSHOT", snapshot: { version: 21 } }),
      ),
    ).toEqual({ kind: "INVALIDATION", version: 21 });
  });

  it("reads heartbeat acknowledgements and errors", () => {
    expect(
      parseRealtimeMessage(
        JSON.stringify({
          type: "PONG",
          serverTimestamp: "2026-07-30T01:00:00.000Z",
        }),
      ),
    ).toEqual({
      kind: "PONG",
      serverTimestamp: "2026-07-30T01:00:00.000Z",
    });
    expect(
      parseRealtimeMessage(
        JSON.stringify({
          type: "ERROR",
          command: "PING",
          code: "RATE_LIMITED",
          retryAt: "2026-07-30T01:00:05.000Z",
        }),
      ),
    ).toEqual({
      kind: "PING_ERROR",
      code: "RATE_LIMITED",
      retryAt: "2026-07-30T01:00:05.000Z",
    });
  });

  it("does not mistake malformed or unrelated messages for room versions", () => {
    expect(parseRealtimeMessage("{")).toEqual({ kind: "MALFORMED" });
    expect(
      parseRealtimeMessage(
        JSON.stringify({ type: "ACK", version: 999, command: "PING" }),
      ),
    ).toEqual({ kind: "IGNORE" });
    expect(
      parseRealtimeMessage(
        JSON.stringify({ type: "EVENT", version: 999, event: {} }),
      ),
    ).toEqual({ kind: "INVALIDATION", version: null });
  });
});

describe("realtime reconnect backoff", () => {
  it("applies bounded exponential backoff and deterministic jitter", () => {
    expect(reconnectDelayMs({ attempt: 0, random: () => 0.5 })).toBe(600);
    expect(reconnectDelayMs({ attempt: 3, random: () => 0.5 })).toBe(4_800);
    expect(reconnectDelayMs({ attempt: 20, random: () => 0.5 })).toBe(8_000);
    expect(reconnectDelayMs({ attempt: 0, random: () => 0 })).toBe(480);
    expect(reconnectDelayMs({ attempt: 0, random: () => 1 })).toBe(720);
  });

  it("never retries before the server-provided retry time", () => {
    const now = Date.parse("2026-07-30T01:00:00.000Z");
    const retryAt = "2026-07-30T01:00:12.000Z";
    expect(
      reconnectDelayMs({
        attempt: 0,
        now,
        random: () => 0.5,
        retryAt: { retryAt },
      }),
    ).toBe(12_000);
    expect(retryAtTimestamp({ retryAt })).toBe(now + 12_000);
    expect(retryAtTimestamp({ retryAt: "not-a-date" })).toBeNull();
  });
});
