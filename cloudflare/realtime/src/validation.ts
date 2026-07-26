import { jwtVerify } from "jose";

import { requireInternalSecret } from "@/server/config/secrets";

const MAX_TICKET_BYTES = 8 * 1024;
const MAX_NOTIFY_BODY_BYTES = 16 * 1024;
const MATCH_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class RequestFault extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "RequestFault";
  }
}

export interface RoomNotification {
  readonly matchId: string;
  readonly reason: string;
  readonly version?: number;
  readonly wakeAt?: number;
  readonly startsAt?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function normalizeMatchId(value: unknown): string {
  if (typeof value !== "string" || !MATCH_ID_PATTERN.test(value)) {
    throw new RequestFault(400, "INVALID_MATCH_ID", "matchId must be a UUID");
  }
  return value.toLowerCase();
}

export async function matchIdFromVerifiedTicket(
  token: string,
  secret: string,
): Promise<string> {
  if (token.length === 0 || token.length > MAX_TICKET_BYTES) {
    throw new RequestFault(401, "TICKET_INVALID", "Realtime ticket is invalid");
  }
  const signingKey = new TextEncoder().encode(
    requireInternalSecret("REALTIME_TICKET_SECRET", secret),
  );

  try {
    const { payload } = await jwtVerify(token, signingKey, {
      algorithms: ["HS256"],
      issuer: "leetbattle-web",
      audience: "leetbattle-realtime",
      clockTolerance: 2,
    });
    return normalizeMatchId(payload.matchId);
  } catch {
    throw new RequestFault(401, "TICKET_INVALID", "Realtime ticket is invalid");
  }
}

export function isWebSocketUpgrade(request: Request): boolean {
  return (
    request.method === "GET" &&
    request.headers.get("upgrade")?.toLowerCase() === "websocket"
  );
}

export function isAllowedWebSocketOrigin(
  request: Request,
  appOrigin: string,
): boolean {
  const supplied = request.headers.get("origin");
  if (!supplied) return false;

  try {
    return supplied === new URL(appOrigin).origin;
  } catch {
    return false;
  }
}

async function fixedLengthDigest(value: string): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
  );
}

async function constantTimeSecretEqual(
  supplied: string,
  expected: string,
): Promise<boolean> {
  const [left, right] = await Promise.all([
    fixedLengthDigest(supplied),
    fixedLengthDigest(expected),
  ]);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

export async function hasValidNotifySecret(
  request: Request,
  expected: string,
): Promise<boolean> {
  const validatedExpected = requireInternalSecret(
    "REALTIME_NOTIFY_SECRET",
    expected,
  );

  const authorization = request.headers.get("authorization");
  const match = authorization?.match(/^Bearer ([^\s]+)$/);
  if (!match?.[1]) return false;
  return constantTimeSecretEqual(match[1], validatedExpected);
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(contentLength) && contentLength > MAX_NOTIFY_BODY_BYTES) {
    throw new RequestFault(
      413,
      "BODY_TOO_LARGE",
      "Notification body is too large",
    );
  }

  if (!request.body) {
    throw new RequestFault(
      400,
      "INVALID_NOTIFICATION",
      "Notification body is required",
    );
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytesRead += value.byteLength;
    if (bytesRead > MAX_NOTIFY_BODY_BYTES) {
      await reader.cancel("Notification body is too large");
      throw new RequestFault(
        413,
        "BODY_TOO_LARGE",
        "Notification body is too large",
      );
    }
    text += decoder.decode(value, { stream: true });
  }
  text += decoder.decode();

  try {
    const parsed: unknown = JSON.parse(text);
    return parsed;
  } catch {
    throw new RequestFault(
      400,
      "INVALID_NOTIFICATION",
      "Notification body must be valid JSON",
    );
  }
}

function optionalTimestamp(
  value: unknown,
  field: "wakeAt" | "startsAt",
): number | undefined {
  if (value === undefined || value === null) return undefined;

  let timestamp: number;
  if (typeof value === "number") {
    timestamp = value;
  } else if (typeof value === "string" && value.length <= 64) {
    timestamp = Date.parse(value);
  } else {
    throw new RequestFault(
      400,
      "INVALID_NOTIFICATION",
      `${field} must be an ISO timestamp or epoch milliseconds`,
    );
  }

  if (!Number.isFinite(timestamp) || timestamp < 0) {
    throw new RequestFault(
      400,
      "INVALID_NOTIFICATION",
      `${field} is not a valid timestamp`,
    );
  }
  return Math.trunc(timestamp);
}

export async function readRoomNotification(
  request: Request,
): Promise<RoomNotification> {
  const value = await readBoundedJson(request);
  if (!isRecord(value)) {
    throw new RequestFault(
      400,
      "INVALID_NOTIFICATION",
      "Notification body must be an object",
    );
  }

  const allowedKeys = new Set([
    "matchId",
    "reason",
    "version",
    "wakeAt",
    "startsAt",
  ]);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw new RequestFault(
      400,
      "INVALID_NOTIFICATION",
      "Notification body contains an unknown field",
    );
  }

  const reason = value.reason ?? "state-changed";
  if (
    typeof reason !== "string" ||
    reason.length === 0 ||
    reason.length > 100
  ) {
    throw new RequestFault(
      400,
      "INVALID_NOTIFICATION",
      "reason must contain 1 to 100 characters",
    );
  }

  const version = value.version;
  if (
    version !== undefined &&
    (typeof version !== "number" ||
      !Number.isSafeInteger(version) ||
      version < 0)
  ) {
    throw new RequestFault(
      400,
      "INVALID_NOTIFICATION",
      "version must be a non-negative safe integer",
    );
  }

  const wakeAt = optionalTimestamp(value.wakeAt, "wakeAt");
  const startsAt = optionalTimestamp(value.startsAt, "startsAt");
  return {
    matchId: normalizeMatchId(value.matchId),
    reason,
    ...(version === undefined ? {} : { version }),
    ...(wakeAt === undefined ? {} : { wakeAt }),
    ...(startsAt === undefined ? {} : { startsAt }),
  };
}
