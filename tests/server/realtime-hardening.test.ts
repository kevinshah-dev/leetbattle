import { describe, expect, it, vi } from "vitest";

import { buildRealtimeSocketUrl } from "@/components/realtime-url";
import { refreshRealtimeSessionHeartbeat } from "@/server/realtime/heartbeat";
import {
  admitRealtimeCommand,
  emptyRealtimeCommandRateState,
  hasReachedRealtimeSocketCap,
  readRealtimeCommandRateState,
} from "@/server/realtime/limits";
import {
  REALTIME_SESSION_STALE_AFTER_SECONDS,
  REALTIME_SOCKET_LEASE_RENEW_AFTER_SECONDS,
} from "@/server/realtime/timing";
import { CoalescedTask } from "../../services/realtime/coalesced-task";
import {
  establishRealtimeSession,
  runGuardedRealtimeOperation,
} from "../../services/realtime/connection-lifecycle";
import { playerSafeAcknowledgement } from "../../services/realtime/safety";

describe("realtime client URL construction", () => {
  it.each([
    ["https://realtime.example.test", "wss:"],
    ["http://localhost:3001", "ws:"],
    ["wss://realtime.example.test/base", "wss:"],
    ["ws://localhost:3001/base/", "ws:"],
  ])("preserves or safely upgrades %s", (configuredUrl, protocol) => {
    const result = buildRealtimeSocketUrl(configuredUrl, "signed ticket");
    expect(result.protocol).toBe(protocol);
    expect(result.pathname).toMatch(/\/socket$/);
    expect(result.searchParams.get("ticket")).toBe("signed ticket");
  });

  it("rejects unsupported realtime URL schemes", () => {
    expect(() =>
      buildRealtimeSocketUrl("ftp://realtime.example.test", "ticket"),
    ).toThrow(/HTTP\(S\) or WebSocket/);
  });
});

describe("realtime response safety", () => {
  it("allowlists ACK data instead of forwarding internal command results", () => {
    const internal = {
      winnerUserId: "clerk_winner_private",
      opponent: { clerkUserId: "clerk_opponent_private" },
      executionId: "internal-execution-id",
    };
    const acknowledgement = playerSafeAcknowledgement(internal);
    expect(acknowledgement).toEqual({ accepted: true });
    expect(JSON.stringify(acknowledgement)).not.toContain("clerk_");
    expect(JSON.stringify(acknowledgement)).not.toContain("execution-id");
  });
});

describe("realtime heartbeat recovery", () => {
  const input = {
    actorUserId: "user_123",
    roomId: "room_123",
    matchId: "match_123",
    sessionId: "session_123",
  };

  it("only touches an active session", async () => {
    const store = {
      touchSession: vi.fn(async () => true),
      connectSession: vi.fn(async () => ({
        sessionId: input.sessionId,
        snapshot: { version: 1 },
      })),
    };

    await expect(
      refreshRealtimeSessionHeartbeat(store, input),
    ).resolves.toEqual({ reactivated: false, snapshot: null });
    expect(store.connectSession).not.toHaveBeenCalled();
  });

  it("reactivates a stale session through normal connection validation", async () => {
    const snapshot = { version: 7 };
    const store = {
      touchSession: vi.fn(async () => false),
      connectSession: vi.fn(async () => ({
        sessionId: input.sessionId,
        snapshot,
      })),
    };

    await expect(
      refreshRealtimeSessionHeartbeat(store, input),
    ).resolves.toEqual({ reactivated: true, snapshot });
    expect(store.connectSession).toHaveBeenCalledWith(input);
  });

  it("does not hide membership or deadline errors during reactivation", async () => {
    const expected = new Error("deadline elapsed");
    const store = {
      touchSession: vi.fn(async () => false),
      connectSession: vi.fn(async () => {
        throw expected;
      }),
    };

    await expect(refreshRealtimeSessionHeartbeat(store, input)).rejects.toBe(
      expected,
    );
  });
});

describe("realtime presence timing", () => {
  it("renews an attached socket lease before database presence can expire", () => {
    expect(REALTIME_SOCKET_LEASE_RENEW_AFTER_SECONDS).toBeLessThan(
      REALTIME_SESSION_STALE_AFTER_SECONDS,
    );
  });

  it("does not let the database lease expire between socket renewals", () => {
    expect(REALTIME_SESSION_STALE_AFTER_SECONDS).toBeGreaterThan(
      REALTIME_SOCKET_LEASE_RENEW_AFTER_SECONDS,
    );
  });
});

describe("realtime resource bounds", () => {
  it("enforces the per-user socket cap", () => {
    expect(hasReachedRealtimeSocketCap(1)).toBe(false);
    expect(hasReachedRealtimeSocketCap(2)).toBe(true);
  });

  it("rate-limits PING and SNAPSHOT independently and globally", () => {
    const start = 10_000;
    const first = admitRealtimeCommand(
      emptyRealtimeCommandRateState(),
      "PING",
      start,
    );
    expect(first.allowed).toBe(true);
    if (!first.allowed) throw new Error("expected admission");

    const immediateSnapshot = admitRealtimeCommand(
      first.state,
      "SNAPSHOT",
      start + 100,
    );
    expect(immediateSnapshot).toMatchObject({
      allowed: false,
      retryAt: start + 500,
    });

    const laterSnapshot = admitRealtimeCommand(
      first.state,
      "SNAPSHOT",
      start + 500,
    );
    expect(laterSnapshot.allowed).toBe(true);

    const repeatedPing = admitRealtimeCommand(
      first.state,
      "PING",
      start + 1_000,
    );
    expect(repeatedPing).toMatchObject({
      allowed: false,
      retryAt: start + 5_000,
    });
  });

  it("safely restores missing hibernation attachment fields", () => {
    expect(readRealtimeCommandRateState({ commandNotBefore: 123 })).toEqual({
      commandNotBefore: 123,
      pingNotBefore: 0,
      snapshotNotBefore: 0,
    });
  });
});

describe("realtime connection lifecycle", () => {
  it("disconnects a DB session created after the socket already closed", async () => {
    let resolveConnection:
      ((value: { sessionId: string; snapshot: string }) => void) | undefined;
    const connection = new Promise<{
      sessionId: string;
      snapshot: string;
    }>((resolve) => {
      resolveConnection = resolve;
    });
    let open = true;
    let closeListener: () => void = () => undefined;
    const disconnect = vi.fn(async () => undefined);
    const activate = vi.fn();

    const establishing = establishRealtimeSession({
      isOpen: () => open,
      subscribeToClose: (listener) => {
        closeListener = listener;
      },
      connect: () => connection,
      disconnect,
      activate,
    });
    open = false;
    closeListener();
    resolveConnection?.({
      sessionId: "session-created-after-close",
      snapshot: "must-not-be-sent",
    });

    await expect(establishing).resolves.toBe("CLOSED");
    expect(disconnect).toHaveBeenCalledOnce();
    expect(disconnect).toHaveBeenCalledWith("session-created-after-close");
    expect(activate).not.toHaveBeenCalled();
  });

  it("activates an open session and disconnects it once on a later close", async () => {
    let open = true;
    let closeListener: () => void = () => undefined;
    const disconnect = vi.fn(async () => undefined);
    const activate = vi.fn();

    await expect(
      establishRealtimeSession({
        isOpen: () => open,
        subscribeToClose: (listener) => {
          closeListener = listener;
        },
        connect: async () => ({ sessionId: "active-session" }),
        disconnect,
        activate,
      }),
    ).resolves.toBe("ACTIVE");
    expect(activate).toHaveBeenCalledOnce();

    open = false;
    closeListener();
    closeListener();
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledOnce());
  });

  it("compensates when a heartbeat finishes after its socket generation closes", async () => {
    let resolveHeartbeat: ((value: string) => void) | undefined;
    const heartbeat = new Promise<string>((resolve) => {
      resolveHeartbeat = resolve;
    });
    let current = true;
    const compensate = vi.fn(async () => undefined);

    const guarded = runGuardedRealtimeOperation({
      isCurrent: () => current,
      operation: () => heartbeat,
      compensate,
    });
    current = false;
    resolveHeartbeat?.("reactivated");

    await expect(guarded).resolves.toEqual({
      completed: false,
      result: null,
    });
    expect(compensate).toHaveBeenCalledOnce();
  });

  it("compensates and preserves an operation error after the socket closes", async () => {
    const expected = new Error("heartbeat failed");
    let rejectHeartbeat: ((reason: Error) => void) | undefined;
    const heartbeat = new Promise<never>((_, reject) => {
      rejectHeartbeat = reject;
    });
    let current = true;
    const compensate = vi.fn(async () => undefined);

    const guarded = runGuardedRealtimeOperation({
      isCurrent: () => current,
      operation: () => heartbeat,
      compensate,
    });
    current = false;
    rejectHeartbeat?.(expected);

    await expect(guarded).rejects.toBe(expected);
    expect(compensate).toHaveBeenCalledOnce();
  });
});

describe("realtime asynchronous task coalescing", () => {
  it("shares one heartbeat operation across concurrent requests", async () => {
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const operation = vi.fn(() => blocked);
    const task = new CoalescedTask(operation);

    const first = task.request();
    const second = task.request();

    expect(second).toBe(first);
    expect(operation).toHaveBeenCalledOnce();
    release?.();
    await first;
    expect(operation).toHaveBeenCalledOnce();
    expect(task.pending).toBeNull();
  });

  it("coalesces overlapping poll requests into one trailing pass", async () => {
    const releases: (() => void)[] = [];
    const operation = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          releases.push(resolve);
        }),
    );
    const task = new CoalescedTask(operation, { trailing: true });

    const draining = task.request();
    expect(operation).toHaveBeenCalledOnce();
    expect(task.request()).toBe(draining);
    expect(task.request()).toBe(draining);

    releases.shift()?.();
    await vi.waitFor(() => expect(operation).toHaveBeenCalledTimes(2));
    releases.shift()?.();
    await draining;

    expect(operation).toHaveBeenCalledTimes(2);
    expect(task.pending).toBeNull();
  });

  it("does not start queued work after the client lifecycle stops", async () => {
    let release: (() => void) | undefined;
    const operation = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const task = new CoalescedTask(operation, { trailing: true });

    const active = task.request();
    task.request();
    task.stop();
    release?.();
    await active;
    await task.request();

    expect(operation).toHaveBeenCalledOnce();
    expect(task.pending).toBeNull();
  });
});
