export type ParsedRealtimeMessage =
  | {
      kind: "PONG";
      serverTimestamp: string | null;
    }
  | {
      kind: "INVALIDATION";
      version: number | null;
    }
  | {
      kind: "PING_ERROR";
      code: string | null;
      retryAt: string | null;
    }
  | {
      kind: "IGNORE";
    }
  | {
      kind: "MALFORMED";
    };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function version(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

/**
 * Reads only the small, public envelope needed by the browser. Room state
 * remains authoritative through the authenticated HTTP snapshot endpoint.
 */
export function parseRealtimeMessage(raw: string): ParsedRealtimeMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { kind: "MALFORMED" };
  }

  const message = record(parsed);
  if (!message || typeof message.type !== "string") {
    return { kind: "MALFORMED" };
  }

  switch (message.type) {
    case "PONG":
      return {
        kind: "PONG",
        serverTimestamp:
          typeof message.serverTimestamp === "string"
            ? message.serverTimestamp
            : null,
      };
    case "EVENT":
      return {
        kind: "INVALIDATION",
        version: version(record(message.event)?.version),
      };
    case "SNAPSHOT":
      return {
        kind: "INVALIDATION",
        version: version(record(message.snapshot)?.version),
      };
    case "ERROR":
      if (message.command !== "PING") return { kind: "IGNORE" };
      return {
        kind: "PING_ERROR",
        code: typeof message.code === "string" ? message.code : null,
        retryAt: typeof message.retryAt === "string" ? message.retryAt : null,
      };
    default:
      return { kind: "IGNORE" };
  }
}

export function retryAtTimestamp(value: unknown): number | null {
  const valueRecord = record(value);
  const candidate =
    typeof value === "string"
      ? value
      : typeof valueRecord?.retryAt === "string"
        ? valueRecord.retryAt
        : null;
  if (!candidate) return null;
  const timestamp = Date.parse(candidate);
  return Number.isFinite(timestamp) ? timestamp : null;
}

export function reconnectDelayMs(input: {
  attempt: number;
  retryAt?: unknown;
  now?: number;
  random?: () => number;
  baseMs?: number;
  maximumMs?: number;
  jitterRatio?: number;
}): number {
  const now = input.now ?? Date.now();
  const baseMs = Math.max(1, Math.trunc(input.baseMs ?? 600));
  const maximumMs = Math.max(baseMs, Math.trunc(input.maximumMs ?? 8_000));
  const attempt = Math.max(0, Math.min(20, Math.trunc(input.attempt)));
  const exponential = Math.min(maximumMs, baseMs * 2 ** attempt);
  const jitterRatio = Math.max(0, Math.min(0.5, input.jitterRatio ?? 0.2));
  const rawRandom = input.random?.() ?? Math.random();
  const random = Number.isFinite(rawRandom)
    ? Math.max(0, Math.min(1, rawRandom))
    : 0.5;
  const jittered = exponential * (1 - jitterRatio + random * jitterRatio * 2);
  const retryAt = retryAtTimestamp(input.retryAt);
  const serverDelay = retryAt === null ? 0 : Math.max(0, retryAt - now);
  return Math.max(Math.round(jittered), Math.ceil(serverDelay));
}
