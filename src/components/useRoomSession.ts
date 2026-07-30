"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  ApiError,
  getRealtimeToken,
  getRoom,
  type RoomSnapshot,
} from "./api-client";
import {
  parseRealtimeMessage,
  reconnectDelayMs,
  retryAtTimestamp,
} from "./realtime-lifecycle";
import { buildRealtimeSocketUrl } from "./realtime-url";

interface RoomSession {
  snapshot: RoomSnapshot | null;
  error: string | null;
  loading: boolean;
  realtime: "CONNECTING" | "LIVE" | "POLLING";
  serverOffsetMs: number;
  refresh: () => Promise<void>;
  applySnapshot: (snapshot: RoomSnapshot) => void;
}

const ROOM_REFRESH_TIMEOUT_MS = 10_000;
const REALTIME_TOKEN_TIMEOUT_MS = 10_000;
const SOCKET_HANDSHAKE_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 10_000;
const PONG_TIMEOUT_MS = 30_000;
const STABLE_CONNECTION_MS = 10_000;
const INVALIDATION_DEBOUNCE_MS = 50;
/*
 * A replacement route can spend two room-refresh windows fetching its first
 * snapshot before it even starts the ticket fetch and WebSocket handshake.
 * Keep the proven transport around for the whole bounded setup path.
 */
const HANDOFF_CLOSE_DELAY_MS =
  ROOM_REFRESH_TIMEOUT_MS * 2 +
  REALTIME_TOKEN_TIMEOUT_MS +
  SOCKET_HANDSHAKE_TIMEOUT_MS +
  10_000;

interface DeferredSocketClose {
  socket: WebSocket;
  timer: number;
}

/*
 * Lobby and battle are separate routes. Keep the old transport present for a
 * short handoff window while the next route obtains its own socket, but detach
 * every callback immediately so an obsolete page can never update current UI.
 */
const deferredSocketCloses = new Map<string, DeferredSocketClose>();

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  if (
    socket.readyState === WebSocket.CLOSING ||
    socket.readyState === WebSocket.CLOSED
  ) {
    return;
  }
  try {
    socket.close(code, reason);
  } catch {
    try {
      socket.close();
    } catch {
      // The browser may already be completing the close handshake.
    }
  }
}

function deferSocketClose(key: string, socket: WebSocket): void {
  if (
    socket.readyState === WebSocket.CLOSING ||
    socket.readyState === WebSocket.CLOSED
  ) {
    return;
  }

  const previous = deferredSocketCloses.get(key);
  if (previous && previous.socket !== socket) {
    window.clearTimeout(previous.timer);
    closeSocket(previous.socket, 1000, "Superseded room handoff");
  }

  const timer = window.setTimeout(() => {
    const pending = deferredSocketCloses.get(key);
    if (pending?.socket === socket) deferredSocketCloses.delete(key);
    closeSocket(socket, 1000, "Room handoff complete");
  }, HANDOFF_CLOSE_DELAY_MS);
  deferredSocketCloses.set(key, { socket, timer });
}

function completeSocketHandoff(key: string): void {
  const pending = deferredSocketCloses.get(key);
  if (!pending) return;
  deferredSocketCloses.delete(key);
  window.clearTimeout(pending.timer);
  closeSocket(pending.socket, 1000, "New room link established");
}

function isAbortError(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "name" in error &&
    error.name === "AbortError",
  );
}

function roomErrorMessage(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export function useRoomSession(roomCode: string): RoomSession {
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [realtime, setRealtime] = useState<RoomSession["realtime"]>(() =>
    process.env.NEXT_PUBLIC_REALTIME_URL ? "CONNECTING" : "POLLING",
  );
  const [serverOffsetMs, setServerOffsetMs] = useState(0);

  const activeRoomCodeRef = useRef(roomCode);
  const snapshotRef = useRef<RoomSnapshot | null>(null);
  const versionRef = useRef(-1);
  const matchIdRef = useRef<string | null>(null);
  const roundNumberRef = useRef<number | null>(null);
  const roomGenerationRef = useRef(0);
  const refreshInFlightRef = useRef<Promise<void> | null>(null);
  const refreshQueuedRef = useRef(false);
  const refreshControllerRef = useRef<AbortController | null>(null);
  const refreshDebounceTimerRef = useRef(0);

  useEffect(() => {
    activeRoomCodeRef.current = roomCode;
  }, [roomCode]);

  const applySnapshot = useCallback((next: RoomSnapshot) => {
    if (next.roomCode !== activeRoomCodeRef.current) return;

    const currentRound = roundNumberRef.current;
    if (currentRound !== null && next.roundNumber < currentRound) return;
    if (currentRound !== null && next.roundNumber === currentRound) {
      if (matchIdRef.current !== next.matchId) return;
      if (next.version < versionRef.current) return;
    }

    roundNumberRef.current = next.roundNumber;
    matchIdRef.current = next.matchId;
    versionRef.current = next.version;
    snapshotRef.current = next;
    setServerOffsetMs(Date.parse(next.serverNow) - Date.now());
    setSnapshot(next);
    setError(null);
    setLoading(false);
  }, []);

  const refresh = useCallback((): Promise<void> => {
    const existing = refreshInFlightRef.current;
    if (existing) {
      refreshQueuedRef.current = true;
      return existing;
    }

    const generation = roomGenerationRef.current;
    const requestedRoomCode = roomCode;
    const operation = (async () => {
      do {
        refreshQueuedRef.current = false;
        const controller = new AbortController();
        let timedOut = false;
        const timeout = window.setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, ROOM_REFRESH_TIMEOUT_MS);
        refreshControllerRef.current = controller;

        try {
          const response = await getRoom(requestedRoomCode, controller.signal);
          if (
            generation !== roomGenerationRef.current ||
            requestedRoomCode !== activeRoomCodeRef.current
          ) {
            return;
          }
          applySnapshot(response.snapshot);
        } catch (caught) {
          if (
            generation !== roomGenerationRef.current ||
            requestedRoomCode !== activeRoomCodeRef.current ||
            (isAbortError(caught) && !timedOut)
          ) {
            return;
          }

          const hasSnapshot = snapshotRef.current !== null;
          const terminal =
            caught instanceof ApiError &&
            (caught.status === 401 ||
              caught.status === 403 ||
              caught.status === 404);
          if (!hasSnapshot || terminal) {
            setError(
              roomErrorMessage(
                caught,
                hasSnapshot
                  ? "The room link is no longer available."
                  : "Could not load this room.",
              ),
            );
            setLoading(false);
          }
        } finally {
          window.clearTimeout(timeout);
          if (refreshControllerRef.current === controller) {
            refreshControllerRef.current = null;
          }
        }
      } while (
        refreshQueuedRef.current &&
        generation === roomGenerationRef.current &&
        requestedRoomCode === activeRoomCodeRef.current
      );
    })();

    refreshInFlightRef.current = operation;
    void operation.then(() => {
      if (refreshInFlightRef.current !== operation) return;
      refreshInFlightRef.current = null;
    });
    return operation;
  }, [applySnapshot, roomCode]);

  const scheduleRoomRefresh = useCallback(
    (delayMs = INVALIDATION_DEBOUNCE_MS) => {
      if (refreshDebounceTimerRef.current) {
        if (delayMs > 0) return;
        window.clearTimeout(refreshDebounceTimerRef.current);
      }
      const generation = roomGenerationRef.current;
      refreshDebounceTimerRef.current = window.setTimeout(
        () => {
          refreshDebounceTimerRef.current = 0;
          if (generation === roomGenerationRef.current) void refresh();
        },
        Math.max(0, delayMs),
      );
    },
    [refresh],
  );

  useEffect(() => {
    const generation = roomGenerationRef.current + 1;
    roomGenerationRef.current = generation;
    refreshControllerRef.current?.abort();
    refreshControllerRef.current = null;
    refreshInFlightRef.current = null;
    refreshQueuedRef.current = false;
    window.clearTimeout(refreshDebounceTimerRef.current);
    refreshDebounceTimerRef.current = 0;

    snapshotRef.current = null;
    versionRef.current = -1;
    matchIdRef.current = null;
    roundNumberRef.current = null;
    queueMicrotask(() => {
      if (roomGenerationRef.current !== generation) return;
      setSnapshot(null);
      setError(null);
      setLoading(true);
      setServerOffsetMs(0);
      setRealtime(
        process.env.NEXT_PUBLIC_REALTIME_URL ? "CONNECTING" : "POLLING",
      );
      void refresh();
    });

    return () => {
      if (roomGenerationRef.current === generation) {
        roomGenerationRef.current += 1;
      }
      refreshControllerRef.current?.abort();
      refreshControllerRef.current = null;
      refreshInFlightRef.current = null;
      refreshQueuedRef.current = false;
      window.clearTimeout(refreshDebounceTimerRef.current);
      refreshDebounceTimerRef.current = 0;
    };
  }, [refresh, roomCode]);

  useEffect(() => {
    let cancelled = false;
    let timer = 0;
    const delay = realtime === "LIVE" ? 12_000 : 2_000;

    const poll = async () => {
      await refresh();
      if (!cancelled) timer = window.setTimeout(poll, delay);
    };
    timer = window.setTimeout(poll, delay);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [realtime, refresh]);

  const currentMatchId =
    snapshot?.roomCode === roomCode ? snapshot.matchId : null;

  useEffect(() => {
    const configuredUrl = process.env.NEXT_PUBLIC_REALTIME_URL;
    if (!configuredUrl || !currentMatchId) return;
    const realtimeUrl = configuredUrl;

    try {
      buildRealtimeSocketUrl(realtimeUrl, "url-validation");
    } catch {
      const timer = window.setTimeout(() => setRealtime("POLLING"), 0);
      return () => window.clearTimeout(timer);
    }

    const handoffKey = `${roomCode}:${currentMatchId}`;
    let disposed = false;
    let connecting = false;
    let socketGeneration = 0;
    let currentSocket: WebSocket | null = null;
    let removeCurrentListeners: (() => void) | null = null;
    let reconnectAttempt = 0;
    let openedAt = 0;
    let receivedPong = false;
    let awaitingPong = false;
    let lastPingAt = 0;
    let heartbeatFailures = 0;
    let reconnectTimer: number | null = null;
    let tokenTimeout: number | null = null;
    let handshakeTimer: number | null = null;
    let heartbeatTimer: number | null = null;
    let pongWatchdogTimer: number | null = null;
    let stabilityTimer: number | null = null;
    let tokenController: AbortController | null = null;

    function clearTimer(timer: number | null): null {
      if (timer !== null) window.clearTimeout(timer);
      return null;
    }

    function isCurrent(candidate: WebSocket, generation: number): boolean {
      return (
        !disposed &&
        currentSocket === candidate &&
        socketGeneration === generation
      );
    }

    function stopTransportTimers(): void {
      handshakeTimer = clearTimer(handshakeTimer);
      heartbeatTimer = clearTimer(heartbeatTimer);
      pongWatchdogTimer = clearTimer(pongWatchdogTimer);
      stabilityTimer = clearTimer(stabilityTimer);
    }

    function armPongWatchdog(candidate: WebSocket, generation: number): void {
      pongWatchdogTimer = clearTimer(pongWatchdogTimer);

      const check = () => {
        pongWatchdogTimer = null;
        if (!isCurrent(candidate, generation) || !awaitingPong) return;

        if (document.visibilityState === "hidden") {
          pongWatchdogTimer = window.setTimeout(check, PONG_TIMEOUT_MS);
          return;
        }

        const remaining = PONG_TIMEOUT_MS - (Date.now() - lastPingAt);
        if (remaining > 0) {
          pongWatchdogTimer = window.setTimeout(check, remaining);
          return;
        }
        closeSocket(candidate, 4000, "Realtime heartbeat timed out");
      };

      pongWatchdogTimer = window.setTimeout(check, PONG_TIMEOUT_MS);
    }

    function scheduleHeartbeat(
      candidate: WebSocket,
      generation: number,
      delayMs = HEARTBEAT_INTERVAL_MS,
    ): void {
      heartbeatTimer = clearTimer(heartbeatTimer);
      heartbeatTimer = window.setTimeout(
        () => {
          heartbeatTimer = null;
          if (
            !isCurrent(candidate, generation) ||
            candidate.readyState !== WebSocket.OPEN
          ) {
            return;
          }
          if (awaitingPong) {
            scheduleHeartbeat(candidate, generation, HEARTBEAT_INTERVAL_MS);
            return;
          }
          sendPing(candidate, generation);
        },
        Math.max(250, delayMs),
      );
    }

    function sendPing(
      candidate: WebSocket,
      generation: number,
      force = false,
    ): void {
      if (
        !isCurrent(candidate, generation) ||
        candidate.readyState !== WebSocket.OPEN
      ) {
        return;
      }
      if (awaitingPong && !force) {
        scheduleHeartbeat(candidate, generation);
        return;
      }

      try {
        candidate.send(JSON.stringify({ type: "PING" }));
        awaitingPong = true;
        lastPingAt = Date.now();
        armPongWatchdog(candidate, generation);
        scheduleHeartbeat(candidate, generation);
      } catch {
        closeSocket(candidate, 4001, "Realtime heartbeat send failed");
      }
    }

    function scheduleStabilityReset(
      candidate: WebSocket,
      generation: number,
    ): void {
      stabilityTimer = clearTimer(stabilityTimer);
      const remaining = Math.max(
        0,
        STABLE_CONNECTION_MS - (Date.now() - openedAt),
      );
      stabilityTimer = window.setTimeout(() => {
        stabilityTimer = null;
        if (isCurrent(candidate, generation) && receivedPong) {
          reconnectAttempt = 0;
        }
      }, remaining);
    }

    function scheduleReconnect(retryAt?: unknown): void {
      if (
        disposed ||
        connecting ||
        reconnectTimer !== null ||
        navigator.onLine === false
      ) {
        return;
      }
      if (
        currentSocket &&
        (currentSocket.readyState === WebSocket.OPEN ||
          currentSocket.readyState === WebSocket.CONNECTING)
      ) {
        return;
      }

      const delay = reconnectDelayMs({
        attempt: reconnectAttempt,
        retryAt,
      });
      reconnectAttempt += 1;
      reconnectTimer = window.setTimeout(() => {
        reconnectTimer = null;
        void connect();
      }, delay);
    }

    function detachCurrentSocket(): void {
      removeCurrentListeners?.();
      removeCurrentListeners = null;
      stopTransportTimers();
    }

    async function connect(): Promise<void> {
      if (
        disposed ||
        connecting ||
        navigator.onLine === false ||
        (currentSocket &&
          (currentSocket.readyState === WebSocket.OPEN ||
            currentSocket.readyState === WebSocket.CONNECTING))
      ) {
        return;
      }

      connecting = true;
      reconnectTimer = clearTimer(reconnectTimer);
      if (reconnectAttempt === 0) setRealtime("CONNECTING");

      const generation = socketGeneration + 1;
      socketGeneration = generation;
      const controller = new AbortController();
      tokenController = controller;
      let timedOut = false;
      tokenTimeout = window.setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, REALTIME_TOKEN_TIMEOUT_MS);

      try {
        const { token, expiresAt } = await getRealtimeToken(
          roomCode,
          controller.signal,
        );
        tokenTimeout = clearTimer(tokenTimeout);
        if (disposed || generation !== socketGeneration) {
          return;
        }
        if (controller.signal.aborted) {
          connecting = false;
          if (timedOut) {
            setRealtime("POLLING");
            scheduleReconnect();
          }
          return;
        }

        const expiration = Date.parse(expiresAt);
        if (!Number.isFinite(expiration) || expiration <= Date.now() + 1_000) {
          connecting = false;
          setRealtime("POLLING");
          scheduleReconnect();
          return;
        }

        const candidate = new WebSocket(
          buildRealtimeSocketUrl(realtimeUrl, token),
        );
        currentSocket = candidate;
        connecting = false;
        openedAt = 0;
        receivedPong = false;
        awaitingPong = false;
        lastPingAt = 0;
        heartbeatFailures = 0;

        const onOpen = () => {
          if (!isCurrent(candidate, generation)) return;
          handshakeTimer = clearTimer(handshakeTimer);
          openedAt = Date.now();
          scheduleRoomRefresh(0);
          sendPing(candidate, generation, true);
        };

        const onMessage = (message: MessageEvent) => {
          if (!isCurrent(candidate, generation)) return;
          const parsed = parseRealtimeMessage(String(message.data));

          if (parsed.kind === "PONG") {
            awaitingPong = false;
            heartbeatFailures = 0;
            receivedPong = true;
            pongWatchdogTimer = clearTimer(pongWatchdogTimer);
            if (parsed.serverTimestamp) {
              const serverNow = Date.parse(parsed.serverTimestamp);
              if (Number.isFinite(serverNow)) {
                setServerOffsetMs(serverNow - Date.now());
              }
            }
            setRealtime("LIVE");
            completeSocketHandoff(handoffKey);
            scheduleStabilityReset(candidate, generation);
            scheduleHeartbeat(candidate, generation);
            return;
          }

          if (parsed.kind === "PING_ERROR") {
            awaitingPong = false;
            pongWatchdogTimer = clearTimer(pongWatchdogTimer);
            if (parsed.code === "RATE_LIMITED") {
              const retryAt = retryAtTimestamp(parsed.retryAt);
              scheduleHeartbeat(
                candidate,
                generation,
                retryAt === null ? 5_000 : Math.max(250, retryAt - Date.now()),
              );
              return;
            }

            heartbeatFailures += 1;
            if (
              heartbeatFailures >= 2 &&
              document.visibilityState !== "hidden"
            ) {
              closeSocket(candidate, 4002, "Realtime heartbeat was rejected");
            } else {
              scheduleHeartbeat(candidate, generation, 5_000);
            }
            return;
          }

          if (parsed.kind === "INVALIDATION") {
            if (
              parsed.version === null ||
              parsed.version > versionRef.current
            ) {
              scheduleRoomRefresh();
            }
            return;
          }

          if (parsed.kind === "MALFORMED") scheduleRoomRefresh();
        };

        const onClose = () => {
          if (!isCurrent(candidate, generation)) return;
          detachCurrentSocket();
          if (currentSocket === candidate) currentSocket = null;
          connecting = false;
          setRealtime("POLLING");
          scheduleReconnect();
        };

        const onError = () => {
          if (!isCurrent(candidate, generation)) return;
          closeSocket(candidate, 4003, "Realtime transport error");
        };

        candidate.addEventListener("open", onOpen);
        candidate.addEventListener("message", onMessage);
        candidate.addEventListener("close", onClose);
        candidate.addEventListener("error", onError);
        removeCurrentListeners = () => {
          candidate.removeEventListener("open", onOpen);
          candidate.removeEventListener("message", onMessage);
          candidate.removeEventListener("close", onClose);
          candidate.removeEventListener("error", onError);
        };

        handshakeTimer = window.setTimeout(() => {
          if (
            isCurrent(candidate, generation) &&
            candidate.readyState !== WebSocket.OPEN
          ) {
            closeSocket(candidate, 4004, "Realtime handshake timed out");
          }
        }, SOCKET_HANDSHAKE_TIMEOUT_MS);
      } catch (caught) {
        tokenTimeout = clearTimer(tokenTimeout);
        if (
          disposed ||
          generation !== socketGeneration ||
          (isAbortError(caught) && !timedOut)
        ) {
          return;
        }
        connecting = false;
        setRealtime("POLLING");
        scheduleReconnect(caught instanceof ApiError ? caught.details : null);
      } finally {
        if (tokenController === controller) tokenController = null;
      }
    }

    const reconnectImmediately = () => {
      if (disposed) return;
      scheduleRoomRefresh(0);
      if (currentSocket && currentSocket.readyState === WebSocket.OPEN) {
        sendPing(currentSocket, socketGeneration, true);
        return;
      }
      reconnectTimer = clearTimer(reconnectTimer);
      void connect();
    };

    const onOnline = () => reconnectImmediately();
    const onOffline = () => {
      reconnectTimer = clearTimer(reconnectTimer);
      if (!disposed) setRealtime("POLLING");
    };
    const onVisibilityChange = () => {
      if (document.visibilityState !== "hidden") reconnectImmediately();
    };

    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    document.addEventListener("visibilitychange", onVisibilityChange);
    void connect();

    return () => {
      disposed = true;
      socketGeneration += 1;
      reconnectTimer = clearTimer(reconnectTimer);
      tokenTimeout = clearTimer(tokenTimeout);
      tokenController?.abort();
      tokenController = null;
      window.removeEventListener("online", onOnline);
      window.removeEventListener("offline", onOffline);
      document.removeEventListener("visibilitychange", onVisibilityChange);

      const socket = currentSocket;
      detachCurrentSocket();
      currentSocket = null;
      if (socket) deferSocketClose(handoffKey, socket);
    };
  }, [currentMatchId, roomCode, scheduleRoomRefresh]);

  return {
    snapshot,
    error,
    loading,
    realtime,
    serverOffsetMs,
    refresh,
    applySnapshot,
  };
}
