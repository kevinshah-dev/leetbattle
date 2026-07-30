import { createServer } from "node:http";

import { WebSocket, WebSocketServer } from "ws";

import { requireDistinctInternalSecrets } from "../../src/server/config/secrets";
import { DomainError } from "../../src/server/domain/errors";
import {
  refreshRealtimeSessionHeartbeat,
  type RealtimeHeartbeatResult,
} from "../../src/server/realtime/heartbeat";
import type { MatchSnapshot } from "../../src/server/domain/types";
import {
  admitRealtimeCommand,
  emptyRealtimeCommandRateState,
  hasReachedRealtimeSocketCap,
  type RealtimeCommandRateState,
} from "../../src/server/realtime/limits";
import { getServices } from "../../src/server/services";
import { CoalescedTask } from "./coalesced-task";
import {
  establishRealtimeSession,
  runGuardedRealtimeOperation,
} from "./connection-lifecycle";
import {
  parseClientCommand,
  type ClientCommand,
  type ServerMessage,
} from "./protocol";
import { playerSafeAcknowledgement } from "./safety";

requireDistinctInternalSecrets({
  REALTIME_TICKET_SECRET: process.env.REALTIME_TICKET_SECRET,
  RUNNER_INTERNAL_SECRET: process.env.RUNNER_INTERNAL_SECRET,
  ROOM_INVITE_SECRET: process.env.ROOM_INVITE_SECRET,
});
const services = getServices();
const port = Number(process.env.REALTIME_PORT ?? 3001);
const clients = new Set<Client>();
const connectionSetups = new Set<Promise<void>>();
let shuttingDown = false;
let maintenance: Promise<void> | null = null;
let nextConnectionId = 0;
const operationalErrorTimes = new Map<string, number>();

interface Client {
  ws: WebSocket;
  connectionId: number;
  connectedAt: number;
  generation: number;
  closed: boolean;
  actorUserId: string;
  roomId: string;
  matchId: string;
  sessionId: string;
  cursor: number;
  snapshotReady: boolean;
  queued: string[];
  commandChain: Promise<void>;
  polls: CoalescedTask | null;
  heartbeats: CoalescedTask | null;
  alive: boolean;
  rateState: RealtimeCommandRateState;
}

function isCurrentClient(client: Client, generation: number): boolean {
  return (
    !client.closed &&
    client.generation === generation &&
    clients.has(client) &&
    client.ws.readyState === WebSocket.OPEN
  );
}

function send(client: Client, message: ServerMessage): boolean {
  if (!isCurrentClient(client, client.generation)) return false;
  try {
    client.ws.send(JSON.stringify(message));
    return true;
  } catch {
    return false;
  }
}

function logSocketEvent(
  level: "info" | "warn" | "error",
  event: string,
  client: Client,
  details: Record<string, unknown> = {},
): void {
  const entry = JSON.stringify({
    event,
    connectionId: client.connectionId,
    generation: client.generation,
    matchId: client.matchId,
    sessionEstablished: client.sessionId.length > 0,
    ...details,
  });
  if (level === "error") {
    console.error(entry);
  } else if (level === "warn") {
    console.warn(entry);
  } else {
    console.info(entry);
  }
}

function redactLogMessage(message: string): string {
  return message
    .replace(/([?&]ticket=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/\bBearer\s+\S+/gi, "Bearer [REDACTED]")
    .slice(0, 200);
}

function closeClientLifecycle(client: Client): void {
  if (client.closed) return;
  client.closed = true;
  client.generation += 1;
  client.polls?.stop();
  client.heartbeats?.stop();
}

function reportOperationalFailure(operation: string): void {
  const now = Date.now();
  const previous = operationalErrorTimes.get(operation) ?? 0;
  if (now - previous < 10_000) return;
  operationalErrorTimes.set(operation, now);
  console.error(
    JSON.stringify({
      event: "realtime.operation.failed",
      operation,
      retrying: true,
    }),
  );
}

function rejectUpgrade(
  socket: import("node:stream").Duplex,
  status: number,
  message: string,
): void {
  const body = `${message}\n`;
  const statusText =
    status === 401
      ? "Unauthorized"
      : status === 403
        ? "Forbidden"
        : status === 429
          ? "Too Many Requests"
          : status === 503
            ? "Service Unavailable"
            : "Bad Request";
  socket.end(
    `HTTP/1.1 ${status} ${statusText}\r\n` +
      "Connection: close\r\n" +
      "Content-Type: text/plain; charset=utf-8\r\n" +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n` +
      body,
  );
}

async function respondToHealthcheck(
  response: import("node:http").ServerResponse,
): Promise<void> {
  let healthy = !shuttingDown;
  if (healthy) {
    try {
      await services.db`SELECT 1 AS ready`;
    } catch {
      healthy = false;
    }
  }
  const body = JSON.stringify({ ok: healthy });
  response.writeHead(healthy ? 200 : 503, {
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
    "content-type": "application/json; charset=utf-8",
  });
  response.end(body);
}

const httpServer = createServer((request, response) => {
  if (request.method === "GET" && request.url === "/healthz") {
    void respondToHealthcheck(response).catch(() => response.destroy());
    return;
  }
  response.writeHead(404);
  response.end();
});

const websocketServer = new WebSocketServer({
  noServer: true,
  maxPayload: 96 * 1024,
});

httpServer.on("upgrade", (request, socket, head) => {
  void (async () => {
    if (shuttingDown)
      return rejectUpgrade(socket, 503, "Server is shutting down");
    const requestOrigin = request.headers.origin;
    const configuredOrigin = process.env.APP_ORIGIN;
    if (
      requestOrigin &&
      configuredOrigin &&
      requestOrigin !== new URL(configuredOrigin).origin
    ) {
      return rejectUpgrade(socket, 403, "WebSocket origin is not allowed");
    }
    const url = new URL(
      request.url ?? "/",
      `http://${request.headers.host ?? "localhost"}`,
    );
    if (url.pathname !== "/socket")
      return rejectUpgrade(socket, 400, "Unknown WebSocket endpoint");
    const token = url.searchParams.get("ticket");
    if (!token)
      return rejectUpgrade(socket, 401, "A realtime ticket is required");
    try {
      const claims = await services.realtimeTickets.verifyAndConsume(token);
      if (shuttingDown)
        return rejectUpgrade(socket, 503, "Server is shutting down");
      const activeSocketCount = [...clients].filter(
        (client) =>
          !client.closed &&
          client.actorUserId === claims.userId &&
          client.matchId === claims.matchId &&
          client.ws.readyState === WebSocket.OPEN,
      ).length;
      if (hasReachedRealtimeSocketCap(activeSocketCount)) {
        return rejectUpgrade(socket, 429, "Realtime socket limit reached");
      }
      websocketServer.handleUpgrade(request, socket, head, (ws) => {
        const setup = acceptConnection(ws, claims);
        connectionSetups.add(setup);
        void setup
          .catch(() => ws.close(1011, "Connection setup failed"))
          .finally(() => connectionSetups.delete(setup));
      });
    } catch (error) {
      const status = error instanceof DomainError ? error.status : 401;
      rejectUpgrade(socket, status, "Realtime admission failed");
    }
  })().catch(() => rejectUpgrade(socket, 503, "Realtime admission failed"));
});

async function acceptConnection(
  ws: WebSocket,
  claims: Awaited<ReturnType<typeof services.realtimeTickets.verifyAndConsume>>,
): Promise<void> {
  if (ws.readyState !== WebSocket.OPEN) return;
  const client: Client = {
    ws,
    connectionId: (nextConnectionId += 1),
    connectedAt: Date.now(),
    generation: 1,
    closed: false,
    actorUserId: claims.userId,
    roomId: claims.roomId,
    matchId: claims.matchId,
    sessionId: "",
    cursor: 0,
    snapshotReady: false,
    queued: [],
    commandChain: Promise.resolve(),
    polls: null,
    heartbeats: null,
    alive: true,
    rateState: emptyRealtimeCommandRateState(),
  };
  client.polls = new CoalescedTask(
    () => pollClient(client, client.generation),
    { trailing: true },
  );
  client.heartbeats = new CoalescedTask(() =>
    refreshClientHeartbeat(client, client.generation),
  );
  clients.add(client);
  ws.on("pong", () => {
    if (!isCurrentClient(client, client.generation)) return;
    client.alive = true;
    if (client.sessionId) {
      void requestClientHeartbeat(client).catch(() =>
        reportOperationalFailure("session heartbeat"),
      );
    }
  });
  ws.on("message", (data, binary) => {
    if (!isCurrentClient(client, client.generation)) return;
    if (binary) return ws.close(1003, "Text commands only");
    const raw = data.toString();
    if (!client.snapshotReady) {
      if (client.queued.length >= 100)
        return ws.close(1008, "Too many queued commands");
      client.queued.push(raw);
      return;
    }
    enqueueCommand(client, raw);
  });
  ws.once("error", (error) => {
    logSocketEvent("error", "realtime.socket.transport_error", client, {
      errorName: error.name,
      errorMessage: redactLogMessage(error.message),
    });
  });

  const status = await establishRealtimeSession({
    isOpen: () => ws.readyState === WebSocket.OPEN,
    subscribeToClose: (listener) => {
      ws.once("close", (code, reason) => {
        logSocketEvent("info", "realtime.socket.closed", client, {
          code,
          reasonBytes: reason.byteLength,
          lifetimeMs: Date.now() - client.connectedAt,
          pollInFlight: Boolean(client.polls?.pending),
          heartbeatInFlight: Boolean(client.heartbeats?.pending),
        });
        closeClientLifecycle(client);
        clients.delete(client);
        listener();
      });
    },
    connect: () =>
      services.matches.connectSession({
        actorUserId: claims.userId,
        roomId: claims.roomId,
        matchId: claims.matchId,
      }),
    disconnect: (sessionId) =>
      services.matches.disconnectSession(sessionId, client.actorUserId),
    onDisconnectFailure: () => reportOperationalFailure("session disconnect"),
    activate: (connected) => {
      client.sessionId = connected.sessionId;
      client.cursor = connected.snapshot.version;
      send(client, { type: "SNAPSHOT", snapshot: connected.snapshot });
      client.snapshotReady = true;
      for (const queued of client.queued.splice(0))
        enqueueCommand(client, queued);
    },
  });
  if (status === "CLOSED") {
    closeClientLifecycle(client);
    clients.delete(client);
  }
}

function enqueueCommand(client: Client, raw: string): void {
  client.commandChain = client.commandChain
    .then(() => handleCommand(client, raw))
    .catch(() => undefined);
}

async function handleCommand(client: Client, raw: string): Promise<void> {
  let command: ClientCommand;
  try {
    command = parseClientCommand(raw);
  } catch {
    send(client, {
      type: "ERROR",
      command: null,
      code: "INVALID_COMMAND",
      message: "Command payload is invalid",
    });
    return;
  }
  if (command.type === "PING" || command.type === "SNAPSHOT") {
    const admission = admitRealtimeCommand(client.rateState, command.type);
    if (!admission.allowed) {
      send(client, {
        type: "ERROR",
        command: command.type,
        code: "RATE_LIMITED",
        message: "Realtime command cadence exceeded",
        retryAt: new Date(admission.retryAt).toISOString(),
      });
      return;
    }
    client.rateState = admission.state;
  }
  try {
    let data: unknown;
    switch (command.type) {
      case "PING":
        await requestClientHeartbeat(client);
        send(client, {
          type: "PONG",
          serverTimestamp: new Date().toISOString(),
        });
        return;
      case "SNAPSHOT":
        data = await services.matches.getSnapshotByMatch(
          client.actorUserId,
          client.matchId,
        );
        client.cursor = (
          data as Awaited<
            ReturnType<typeof services.matches.getSnapshotByMatch>
          >
        ).version;
        send(client, {
          type: "SNAPSHOT",
          snapshot: data as Awaited<
            ReturnType<typeof services.matches.getSnapshotByMatch>
          >,
        });
        return;
      case "SET_LANGUAGE":
        data = await services.matches.setLanguage({
          actorUserId: client.actorUserId,
          matchId: client.matchId,
          language: command.language,
          idempotencyKey: command.idempotencyKey,
        });
        break;
      case "SET_READY":
        data = await services.matches.setReady({
          actorUserId: client.actorUserId,
          matchId: client.matchId,
          ready: command.ready,
          idempotencyKey: command.idempotencyKey,
        });
        break;
      case "RUN":
      case "SUBMIT":
        data = await services.executions.execute({
          actorUserId: client.actorUserId,
          matchId: client.matchId,
          idempotencyKey: command.idempotencyKey,
          kind: command.type,
          source: command.source,
        });
        break;
      case "REMATCH":
        data = await services.matches.requestRematch({
          actorUserId: client.actorUserId,
          matchId: client.matchId,
          idempotencyKey: command.idempotencyKey,
        });
        break;
      case "CANCEL":
        data = await services.matches.cancelMatch({
          actorUserId: client.actorUserId,
          matchId: client.matchId,
          idempotencyKey: command.idempotencyKey,
        });
        break;
      case "FORFEIT":
        data = await services.matches.forfeitMatch({
          actorUserId: client.actorUserId,
          matchId: client.matchId,
          idempotencyKey: command.idempotencyKey,
        });
        break;
    }
    send(client, {
      type: "ACK",
      command: command.type,
      data: playerSafeAcknowledgement(data),
    });
    await requestClientPoll(client);
  } catch (error) {
    const domain = error instanceof DomainError ? error : null;
    send(client, {
      type: "ERROR",
      command: command.type,
      code: domain?.code ?? "INTERNAL_ERROR",
      message: domain?.message ?? "The command could not be completed",
      ...(domain?.retryAt ? { retryAt: domain.retryAt } : {}),
    });
  }
}

function requestClientHeartbeat(client: Client): Promise<void> {
  if (
    !client.sessionId ||
    !isCurrentClient(client, client.generation) ||
    !client.heartbeats
  ) {
    return Promise.resolve();
  }
  return client.heartbeats.request();
}

async function compensateClosedHeartbeat(
  sessionId: string,
  actorUserId: string,
): Promise<void> {
  try {
    await services.matches.disconnectSession(sessionId, actorUserId);
  } catch {
    reportOperationalFailure("closed heartbeat compensation");
  }
}

async function refreshClientHeartbeat(
  client: Client,
  generation: number,
): Promise<void> {
  if (!isCurrentClient(client, generation) || !client.sessionId) return;

  const sessionId = client.sessionId;
  const guarded = await runGuardedRealtimeOperation<
    RealtimeHeartbeatResult<MatchSnapshot>
  >({
    isCurrent: () => isCurrentClient(client, generation),
    operation: () =>
      refreshRealtimeSessionHeartbeat(services.matches, {
        actorUserId: client.actorUserId,
        roomId: client.roomId,
        matchId: client.matchId,
        sessionId,
      }),
    compensate: () => compensateClosedHeartbeat(sessionId, client.actorUserId),
  });
  if (!guarded.completed || !isCurrentClient(client, generation)) return;
  const result = guarded.result;
  if (!result.reactivated) return;

  client.cursor = result.snapshot.version;
  send(client, { type: "SNAPSHOT", snapshot: result.snapshot });
}

function requestClientPoll(client: Client): Promise<void> {
  if (
    !client.snapshotReady ||
    !isCurrentClient(client, client.generation) ||
    !client.polls
  ) {
    return Promise.resolve();
  }
  return client.polls.request();
}

async function pollClient(client: Client, generation: number): Promise<void> {
  if (!client.snapshotReady || !isCurrentClient(client, generation)) return;
  const events = await services.matches.eventsSince(
    client.actorUserId,
    client.matchId,
    client.cursor,
    100,
  );
  if (!isCurrentClient(client, generation)) return;
  for (const event of events) {
    if (event.version <= client.cursor) continue;
    send(client, { type: "EVENT", event });
    client.cursor = event.version;
  }
}

const eventPoll = setInterval(() => {
  for (const client of clients) {
    void requestClientPoll(client).catch(() =>
      reportOperationalFailure("event poll"),
    );
  }
}, 250);
eventPoll.unref();

const heartbeat = setInterval(() => {
  for (const client of clients) {
    if (!isCurrentClient(client, client.generation)) continue;
    if (!client.alive) {
      logSocketEvent("warn", "realtime.socket.heartbeat_timeout", client, {
        timeoutMs: 15_000,
      });
      client.ws.terminate();
      continue;
    }
    client.alive = false;
    try {
      client.ws.ping();
    } catch (error) {
      logSocketEvent("error", "realtime.socket.ping_failed", client, {
        errorMessage:
          error instanceof Error ? redactLogMessage(error.message) : "unknown",
      });
      client.ws.terminate();
    }
  }
}, 15_000);
heartbeat.unref();

const maintenanceTimer = setInterval(() => {
  if (maintenance) return;
  maintenance = runMaintenance()
    .catch(() => reportOperationalFailure("maintenance sweep"))
    .finally(() => {
      maintenance = null;
    });
}, 1_000);
maintenanceTimer.unref();

async function runMaintenance(): Promise<void> {
  await services.matches.processDueCountdowns();
  await services.matches.expireStaleSessions();
  await services.matches.processDueDisconnects();
  await services.matches.recoverStaleExecutions();
  await services.matches.purgeOldRealtimeSessions();
  await services.realtimeTickets.purgeExpiredUses();
}

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(eventPoll);
  clearInterval(heartbeat);
  clearInterval(maintenanceTimer);
  httpServer.close();
  const activeClients = [...clients];
  for (const client of activeClients)
    client.ws.close(1001, "Server restarting");
  await Promise.allSettled([...connectionSetups]);
  await Promise.allSettled(activeClients.map((client) => client.commandChain));
  await Promise.allSettled(
    activeClients.flatMap((client) =>
      [client.polls?.pending, client.heartbeats?.pending].filter(
        (task): task is Promise<void> => task !== null && task !== undefined,
      ),
    ),
  );
  await Promise.allSettled(
    activeClients.flatMap((client) =>
      client.sessionId
        ? [
            services.matches.disconnectSession(
              client.sessionId,
              client.actorUserId,
            ),
          ]
        : [],
    ),
  );
  if (maintenance) await maintenance;
  await services.db.end({ timeout: 5 });
}

process.once("SIGTERM", () => {
  void shutdown().catch(() => reportOperationalFailure("shutdown"));
});
process.once("SIGINT", () => {
  void shutdown().catch(() => reportOperationalFailure("shutdown"));
});

httpServer.listen(port, () => {
  console.info(`LeetBattle realtime service listening on :${port}`);
});
