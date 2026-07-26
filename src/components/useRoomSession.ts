"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import {
  ApiError,
  getRealtimeToken,
  getRoom,
  type RoomSnapshot,
} from "./api-client";
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

export function useRoomSession(roomCode: string): RoomSession {
  const [snapshot, setSnapshot] = useState<RoomSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [realtime, setRealtime] = useState<RoomSession["realtime"]>(() =>
    process.env.NEXT_PUBLIC_REALTIME_URL ? "CONNECTING" : "POLLING",
  );
  const [serverOffsetMs, setServerOffsetMs] = useState(0);
  const versionRef = useRef(-1);
  const matchIdRef = useRef<string | null>(null);
  const roundNumberRef = useRef<number | null>(null);

  const applySnapshot = useCallback((next: RoomSnapshot) => {
    const currentRound = roundNumberRef.current;
    if (currentRound !== null && next.roundNumber < currentRound) return;
    if (currentRound !== null && next.roundNumber === currentRound) {
      if (matchIdRef.current !== next.matchId) return;
      if (next.version < versionRef.current) return;
    }
    roundNumberRef.current = next.roundNumber;
    matchIdRef.current = next.matchId;
    versionRef.current = next.version;
    setServerOffsetMs(Date.parse(next.serverNow) - Date.now());
    setSnapshot(next);
    setError(null);
    setLoading(false);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const response = await getRoom(roomCode);
      applySnapshot(response.snapshot);
    } catch (caught) {
      const message =
        caught instanceof ApiError
          ? caught.message
          : "Could not restore the room snapshot.";
      setError(message);
      setLoading(false);
    }
  }, [applySnapshot, roomCode]);

  useEffect(() => {
    const controller = new AbortController();
    void getRoom(roomCode, controller.signal)
      .then(({ snapshot: firstSnapshot }) => applySnapshot(firstSnapshot))
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError")
          return;
        setError(
          caught instanceof ApiError
            ? caught.message
            : "Could not load this room.",
        );
        setLoading(false);
      });
    return () => controller.abort();
  }, [applySnapshot, roomCode]);

  useEffect(() => {
    const interval = window.setInterval(
      () => void refresh(),
      realtime === "LIVE" ? 12_000 : 2_000,
    );
    return () => window.clearInterval(interval);
  }, [realtime, refresh]);

  useEffect(() => {
    const configuredUrl = process.env.NEXT_PUBLIC_REALTIME_URL;
    if (!configuredUrl) return;

    let socket: WebSocket | null = null;
    let cancelled = false;
    let retryTimer = 0;
    let heartbeatTimer = 0;
    let retryCount = 0;

    const connect = async () => {
      setRealtime("CONNECTING");
      try {
        const { token } = await getRealtimeToken(roomCode);
        if (cancelled) return;
        const socketUrl = buildRealtimeSocketUrl(configuredUrl, token);
        socket = new WebSocket(socketUrl);
        socket.addEventListener("open", () => {
          retryCount = 0;
          setRealtime("LIVE");
          socket?.send(JSON.stringify({ type: "PING" }));
          window.clearInterval(heartbeatTimer);
          heartbeatTimer = window.setInterval(() => {
            if (socket?.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: "PING" }));
            }
          }, 15_000);
          void refresh();
        });
        socket.addEventListener("message", (message) => {
          try {
            const event = JSON.parse(String(message.data)) as {
              type?: string;
              version?: number;
            };
            if (
              event.type === "SNAPSHOT" ||
              event.type === "EVENT" ||
              (event.version ?? 0) > versionRef.current
            ) {
              void refresh();
            }
          } catch {
            void refresh();
          }
        });
        socket.addEventListener("close", () => {
          if (cancelled) return;
          window.clearInterval(heartbeatTimer);
          setRealtime("POLLING");
          retryCount += 1;
          retryTimer = window.setTimeout(
            connect,
            Math.min(8_000, 600 * 2 ** retryCount),
          );
        });
        socket.addEventListener("error", () => socket?.close());
      } catch {
        if (cancelled) return;
        setRealtime("POLLING");
        retryCount += 1;
        retryTimer = window.setTimeout(
          connect,
          Math.min(8_000, 600 * 2 ** retryCount),
        );
      }
    };

    void connect();
    return () => {
      cancelled = true;
      window.clearTimeout(retryTimer);
      window.clearInterval(heartbeatTimer);
      socket?.close();
    };
  }, [applySnapshot, refresh, roomCode, snapshot?.matchId]);

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
