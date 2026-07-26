import { DurableObject } from "cloudflare:workers";

import { DomainError } from "@/server/domain/errors";
import { refreshRealtimeSessionHeartbeat } from "@/server/realtime/heartbeat";
import {
  admitRealtimeCommand,
  emptyRealtimeCommandRateState,
  hasReachedRealtimeSocketCap,
  readRealtimeCommandRateState,
} from "@/server/realtime/limits";
import {
  parseClientCommand,
  type ServerMessage,
} from "../../../services/realtime/protocol";

import {
  assertDistinctRealtimeSecrets,
  nextMatchWakeAt,
  runGlobalMaintenance,
  withRealtimeRuntime,
} from "./runtime";
import {
  hasValidNotifySecret,
  isAllowedWebSocketOrigin,
  isWebSocketUpgrade,
  matchIdFromVerifiedTicket,
  normalizeMatchId,
  readRoomNotification,
  RequestFault,
  type RoomNotification,
} from "./validation";

const MATCH_ID_HEADER = "x-leetbattle-match-id";
const MATCH_ID_STORAGE_KEY = "matchId";
const MAX_SOCKET_MESSAGE_BYTES = 96 * 1024;
const MIN_ALARM_DELAY_MS = 250;

interface SocketAttachment {
  readonly schema: 1;
  readonly userId: string;
  readonly roomId: string;
  readonly matchId: string;
  readonly sessionId: string;
  readonly slot: 1 | 2;
  cursor: number;
  commandNotBefore: number;
  pingNotBefore: number;
  snapshotNotBefore: number;
}

interface NotificationResult {
  readonly connectedSockets: number;
}

function noStoreHeaders(contentType: string): Headers {
  const headers = new Headers({
    "cache-control": "no-store",
    "content-type": contentType,
    "x-content-type-options": "nosniff",
  });
  return headers;
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: noStoreHeaders("application/json; charset=utf-8"),
  });
}

function textResponse(message: string, status: number): Response {
  return new Response(`${message}\n`, {
    status,
    headers: noStoreHeaders("text/plain; charset=utf-8"),
  });
}

function requestFaultResponse(error: RequestFault): Response {
  return jsonResponse(
    {
      error: {
        code: error.code,
        message: error.message,
      },
    },
    error.status,
  );
}

function logFailure(event: string, error: unknown, details = {}): void {
  console.error(
    JSON.stringify({
      event,
      error: error instanceof Error ? error.message : String(error),
      ...details,
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function readAttachment(socket: WebSocket): SocketAttachment | null {
  const value: unknown = socket.deserializeAttachment();
  if (
    !isRecord(value) ||
    value.schema !== 1 ||
    typeof value.userId !== "string" ||
    typeof value.roomId !== "string" ||
    typeof value.matchId !== "string" ||
    typeof value.sessionId !== "string" ||
    (value.slot !== 1 && value.slot !== 2) ||
    typeof value.cursor !== "number" ||
    !Number.isSafeInteger(value.cursor) ||
    value.cursor < 0
  ) {
    return null;
  }

  return {
    schema: 1,
    userId: value.userId,
    roomId: value.roomId,
    matchId: value.matchId,
    sessionId: value.sessionId,
    slot: value.slot,
    cursor: value.cursor,
    ...readRealtimeCommandRateState(value),
  };
}

function sendMessage(socket: WebSocket, message: ServerMessage): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function closeSocket(socket: WebSocket, code: number, reason: string): void {
  try {
    socket.close(code, reason);
  } catch {
    // The peer may already have completed the close handshake.
  }
}

function domainErrorMessage(
  error: unknown,
  command: string | null,
): ServerMessage {
  const domain = error instanceof DomainError ? error : null;
  return {
    type: "ERROR",
    command,
    code: domain?.code ?? "INTERNAL_ERROR",
    message: domain?.message ?? "Realtime operation failed",
    ...(domain?.retryAt ? { retryAt: domain.retryAt } : {}),
  };
}

async function handleSocketAtEdge(
  request: Request,
  env: Env,
): Promise<Response> {
  if (!isWebSocketUpgrade(request)) {
    return textResponse("A WebSocket upgrade is required", 426);
  }
  if (!isAllowedWebSocketOrigin(request, env.APP_ORIGIN)) {
    return textResponse("WebSocket origin is not allowed", 403);
  }

  const url = new URL(request.url);
  const tickets = url.searchParams.getAll("ticket");
  if (tickets.length !== 1 || !tickets[0]) {
    return textResponse("A realtime ticket is required", 401);
  }

  let matchId: string;
  try {
    // Verify before allocating a named Durable Object. RoomHub verifies again
    // and atomically consumes the one-use JTI with current room membership.
    matchId = await matchIdFromVerifiedTicket(
      tickets[0],
      env.REALTIME_TICKET_SECRET,
    );
  } catch (error) {
    return error instanceof RequestFault
      ? requestFaultResponse(error)
      : textResponse("Realtime ticket is invalid", 401);
  }

  const headers = new Headers(request.headers);
  headers.set(MATCH_ID_HEADER, matchId);
  const stub = env.ROOM_HUB.getByName(matchId);

  try {
    return await stub.fetch(new Request(request, { headers }));
  } catch (error) {
    logFailure("realtime.socket.route_failed", error, { matchId });
    return textResponse("Realtime service is temporarily unavailable", 503);
  }
}

async function handleNotify(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return textResponse("Method not allowed", 405);
  }
  assertDistinctRealtimeSecrets(env);
  if (!(await hasValidNotifySecret(request, env.REALTIME_NOTIFY_SECRET))) {
    return textResponse("Unauthorized", 401);
  }

  const notification = await readRoomNotification(request);
  const room = env.ROOM_HUB.getByName(
    notification.matchId,
  ) as DurableObjectStub<RoomHub>;
  const result = await room.notify(notification);
  return jsonResponse({ ok: true, ...result });
}

function handleHealthcheck(): Response {
  // Keep this public liveness check database-free so it cannot manufacture
  // Hyperdrive traffic. Socket admission and cron maintenance test readiness.
  return jsonResponse({ ok: true });
}

export class RoomHub extends DurableObject<Env> {
  private async ensureMatchIdentity(matchId: string): Promise<void> {
    const stored = await this.ctx.storage.get<string>(MATCH_ID_STORAGE_KEY);
    if (stored && stored !== matchId) {
      throw new Error("Durable Object match identity mismatch");
    }
    if (!stored) {
      await this.ctx.storage.put(MATCH_ID_STORAGE_KEY, matchId);
    }
  }

  private async scheduleAt(
    timestamp: number | null | undefined,
  ): Promise<void> {
    if (timestamp === null || timestamp === undefined) return;
    if (!Number.isFinite(timestamp) || timestamp < 0) return;

    const requested = Math.max(
      Date.now() + MIN_ALARM_DELAY_MS,
      Math.trunc(timestamp),
    );
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null || requested < existing) {
      await this.ctx.storage.setAlarm(requested);
    }
  }

  private broadcastInvalidation(
    matchId: string,
    reason: string,
    version?: number,
  ): number {
    const message: ServerMessage = {
      type: "EVENT",
      event: {
        matchId,
        version: version ?? 0,
        type: "INVALIDATED",
        payload: { reason },
        serverTimestamp: new Date().toISOString(),
      },
    };

    let sent = 0;
    for (const socket of this.ctx.getWebSockets()) {
      if (sendMessage(socket, message)) sent += 1;
    }
    return sent;
  }

  override async fetch(request: Request): Promise<Response> {
    if (!isWebSocketUpgrade(request)) {
      return textResponse("A WebSocket upgrade is required", 426);
    }
    if (!isAllowedWebSocketOrigin(request, this.env.APP_ORIGIN)) {
      return textResponse("WebSocket origin is not allowed", 403);
    }

    const routeMatchId = request.headers.get(MATCH_ID_HEADER);
    const tickets = new URL(request.url).searchParams.getAll("ticket");
    if (!routeMatchId || tickets.length !== 1 || !tickets[0]) {
      return textResponse("Realtime admission failed", 401);
    }

    try {
      return await withRealtimeRuntime(
        this.env,
        async ({ db, matches, tickets: ticketService }) => {
          const claims = await ticketService.verifyAndConsume(tickets[0]!);
          const verifiedMatchId = normalizeMatchId(claims.matchId);
          if (verifiedMatchId !== normalizeMatchId(routeMatchId)) {
            throw new DomainError(
              "TICKET_INVALID",
              "Realtime ticket was routed to the wrong match",
              401,
            );
          }

          await this.ensureMatchIdentity(verifiedMatchId);

          let sessionId: string | null = null;
          let serverSocket: WebSocket | null = null;
          try {
            const connected = await matches.connectSession({
              actorUserId: claims.userId,
              roomId: claims.roomId,
              matchId: verifiedMatchId,
            });
            sessionId = connected.sessionId;

            const activeSocketCount = this.ctx
              .getWebSockets(`user:${claims.userId}`)
              .filter((socket) => socket.readyState === WebSocket.OPEN).length;
            if (hasReachedRealtimeSocketCap(activeSocketCount)) {
              throw new DomainError(
                "RATE_LIMITED",
                "Realtime socket limit reached",
                429,
              );
            }

            const pair = new WebSocketPair();
            const clientSocket = pair[0];
            serverSocket = pair[1];
            this.ctx.acceptWebSocket(serverSocket, [
              `slot:${claims.slot}`,
              `user:${claims.userId}`,
            ]);

            const attachment: SocketAttachment = {
              schema: 1,
              userId: claims.userId,
              roomId: claims.roomId,
              matchId: verifiedMatchId,
              sessionId,
              slot: claims.slot,
              cursor: connected.snapshot.version,
              ...emptyRealtimeCommandRateState(),
            };
            serverSocket.serializeAttachment(attachment);
            if (
              !sendMessage(serverSocket, {
                type: "SNAPSHOT",
                snapshot: connected.snapshot,
              })
            ) {
              throw new Error("Socket closed during realtime setup");
            }

            await this.scheduleAt(await nextMatchWakeAt(db, verifiedMatchId));
            return new Response(null, {
              status: 101,
              webSocket: clientSocket,
            });
          } catch (error) {
            if (serverSocket) {
              closeSocket(serverSocket, 1011, "Connection setup failed");
            }
            if (sessionId) {
              try {
                await matches.disconnectSession(sessionId, claims.userId);
              } catch (disconnectError) {
                logFailure(
                  "realtime.socket.setup_disconnect_failed",
                  disconnectError,
                  { matchId: verifiedMatchId },
                );
              }
            }
            throw error;
          }
        },
      );
    } catch (error) {
      const status = error instanceof DomainError ? error.status : 503;
      if (!(error instanceof DomainError)) {
        logFailure("realtime.socket.admission_failed", error, {
          matchId: routeMatchId,
        });
      }
      return textResponse("Realtime admission failed", status);
    }
  }

  async notify(notification: RoomNotification): Promise<NotificationResult> {
    const matchId = normalizeMatchId(notification.matchId);
    await this.ensureMatchIdentity(matchId);
    await this.scheduleAt(notification.wakeAt);
    await this.scheduleAt(notification.startsAt);
    return {
      connectedSockets: this.broadcastInvalidation(
        matchId,
        notification.reason,
        notification.version,
      ),
    };
  }

  override async webSocketMessage(
    socket: WebSocket,
    raw: string | ArrayBuffer,
  ): Promise<void> {
    if (typeof raw !== "string") {
      closeSocket(socket, 1003, "Text commands only");
      return;
    }
    if (
      raw.length > MAX_SOCKET_MESSAGE_BYTES ||
      new TextEncoder().encode(raw).byteLength > MAX_SOCKET_MESSAGE_BYTES
    ) {
      closeSocket(socket, 1009, "Message is too large");
      return;
    }

    const attachment = readAttachment(socket);
    if (!attachment) {
      closeSocket(socket, 1008, "Realtime session metadata is invalid");
      return;
    }

    let command: ReturnType<typeof parseClientCommand>;
    try {
      command = parseClientCommand(raw);
    } catch {
      sendMessage(socket, {
        type: "ERROR",
        command: null,
        code: "INVALID_COMMAND",
        message: "Command payload is invalid",
      });
      return;
    }

    if (command.type !== "PING" && command.type !== "SNAPSHOT") {
      sendMessage(socket, {
        type: "ERROR",
        command: command.type,
        code: "COMMAND_OVER_HTTP",
        message: "Gameplay commands must use the authenticated HTTP API",
      });
      return;
    }

    const admission = admitRealtimeCommand(attachment, command.type);
    if (!admission.allowed) {
      sendMessage(socket, {
        type: "ERROR",
        command: command.type,
        code: "RATE_LIMITED",
        message: "Realtime command cadence exceeded",
        retryAt: new Date(admission.retryAt).toISOString(),
      });
      return;
    }
    Object.assign(attachment, admission.state);
    // Persist before the first await so hibernation cannot reset cadence.
    socket.serializeAttachment(attachment);

    try {
      await withRealtimeRuntime(this.env, async ({ db, matches }) => {
        if (command.type === "PING") {
          const heartbeat = await refreshRealtimeSessionHeartbeat(matches, {
            actorUserId: attachment.userId,
            roomId: attachment.roomId,
            matchId: attachment.matchId,
            sessionId: attachment.sessionId,
          });
          if (heartbeat.reactivated) {
            attachment.cursor = heartbeat.snapshot.version;
            if (
              !sendMessage(socket, {
                type: "SNAPSHOT",
                snapshot: heartbeat.snapshot,
              })
            ) {
              return;
            }
          } else {
            const events = await matches.eventsSince(
              attachment.userId,
              attachment.matchId,
              attachment.cursor,
              100,
            );
            for (const event of events) {
              if (event.version <= attachment.cursor) continue;
              if (!sendMessage(socket, { type: "EVENT", event })) return;
              attachment.cursor = event.version;
            }
          }
          socket.serializeAttachment(attachment);
          sendMessage(socket, {
            type: "PONG",
            serverTimestamp: new Date().toISOString(),
          });
        } else {
          const connected = await matches.connectSession({
            actorUserId: attachment.userId,
            roomId: attachment.roomId,
            matchId: attachment.matchId,
            sessionId: attachment.sessionId,
          });
          attachment.cursor = connected.snapshot.version;
          socket.serializeAttachment(attachment);
          sendMessage(socket, {
            type: "SNAPSHOT",
            snapshot: connected.snapshot,
          });
        }

        await this.scheduleAt(await nextMatchWakeAt(db, attachment.matchId));
      });
    } catch (error) {
      if (!(error instanceof DomainError)) {
        logFailure("realtime.socket.command_failed", error, {
          matchId: attachment.matchId,
          command: command.type,
        });
      }
      sendMessage(socket, domainErrorMessage(error, command.type));
    }
  }

  private async disconnectSocket(
    socket: WebSocket,
    event: "close" | "error",
  ): Promise<void> {
    const attachment = readAttachment(socket);
    if (!attachment) return;

    try {
      await withRealtimeRuntime(this.env, async ({ db, matches }) => {
        await matches.disconnectSession(
          attachment.sessionId,
          attachment.userId,
        );
        await this.scheduleAt(await nextMatchWakeAt(db, attachment.matchId));
      });
      this.broadcastInvalidation(attachment.matchId, "presence-changed");
    } catch (error) {
      logFailure(`realtime.socket.${event}_failed`, error, {
        matchId: attachment.matchId,
      });
    }
  }

  override async webSocketClose(
    socket: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean,
  ): Promise<void> {
    void code;
    void reason;
    void wasClean;
    await this.disconnectSocket(socket, "close");
  }

  override async webSocketError(
    socket: WebSocket,
    error: unknown,
  ): Promise<void> {
    logFailure("realtime.socket.transport_error", error);
    await this.disconnectSocket(socket, "error");
    closeSocket(socket, 1011, "Realtime transport failed");
  }

  override async alarm(): Promise<void> {
    const matchId = await this.ctx.storage.get<string>(MATCH_ID_STORAGE_KEY);
    if (!matchId) return;

    try {
      let nextWakeAt: number | null = null;
      await withRealtimeRuntime(this.env, async ({ db, matches }) => {
        try {
          await matches.advanceCountdown(matchId);
        } catch (error) {
          if (
            !(error instanceof DomainError) ||
            error.code !== "MATCH_NOT_FOUND"
          ) {
            throw error;
          }
        }

        await matches.expireStaleSessionsForMatch(matchId);
        await matches.processDueDisconnectForMatch(matchId);
        await matches.recoverStaleExecutionsForMatch(matchId);
        nextWakeAt = await nextMatchWakeAt(db, matchId);
      });

      this.broadcastInvalidation(matchId, "maintenance");
      await this.scheduleAt(nextWakeAt);
    } catch (error) {
      logFailure("realtime.room_alarm.failed", error, { matchId });
      throw error;
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === "/socket") {
        return handleSocketAtEdge(request, env);
      }
      if (url.pathname === "/internal/notify") {
        return handleNotify(request, env);
      }
      if (url.pathname === "/healthz" && request.method === "GET") {
        return handleHealthcheck();
      }
      return textResponse("Not found", 404);
    } catch (error) {
      if (error instanceof RequestFault) return requestFaultResponse(error);
      logFailure("realtime.request.failed", error, {
        method: request.method,
        path: url.pathname,
      });
      return jsonResponse(
        {
          error: {
            code: "INTERNAL_ERROR",
            message: "Realtime service is temporarily unavailable",
          },
        },
        503,
      );
    }
  },

  scheduled(
    _controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): void {
    ctx.waitUntil(
      runGlobalMaintenance(env).catch((error) => {
        logFailure("realtime.maintenance.failed", error);
        throw error;
      }),
    );
  },
} satisfies ExportedHandler<Env>;
