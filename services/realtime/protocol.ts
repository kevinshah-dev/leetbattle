import type {
  Language,
  MatchEvent,
  MatchSnapshot,
} from "../../src/server/domain/types";

export type ClientCommand =
  | { type: "SNAPSHOT" }
  | { type: "PING" }
  | { type: "SET_LANGUAGE"; idempotencyKey: string; language: Language }
  | { type: "SET_READY"; idempotencyKey: string; ready: boolean }
  | { type: "RUN" | "SUBMIT"; idempotencyKey: string; source: string }
  | { type: "REMATCH" | "CANCEL" | "FORFEIT"; idempotencyKey: string };

export type ServerMessage =
  | { type: "SNAPSHOT"; snapshot: MatchSnapshot }
  | { type: "EVENT"; event: MatchEvent }
  | { type: "ACK"; command: ClientCommand["type"]; data: unknown }
  | {
      type: "ERROR";
      command: string | null;
      code: string;
      message: string;
      retryAt?: string;
    }
  | { type: "PONG"; serverTimestamp: string };

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function key(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new Error("idempotencyKey is required");
  }
  return value;
}

export function parseClientCommand(raw: string): ClientCommand {
  const value: unknown = JSON.parse(raw);
  if (!object(value) || typeof value.type !== "string")
    throw new Error("Invalid command");
  switch (value.type) {
    case "SNAPSHOT":
    case "PING":
      return { type: value.type };
    case "SET_LANGUAGE":
      if (value.language !== "PYTHON" && value.language !== "JAVA") {
        throw new Error("language must be PYTHON or JAVA");
      }
      return {
        type: value.type,
        idempotencyKey: key(value.idempotencyKey),
        language: value.language,
      };
    case "SET_READY":
      if (typeof value.ready !== "boolean")
        throw new Error("ready must be boolean");
      return {
        type: value.type,
        idempotencyKey: key(value.idempotencyKey),
        ready: value.ready,
      };
    case "RUN":
    case "SUBMIT":
      if (typeof value.source !== "string")
        throw new Error("source must be text");
      return {
        type: value.type,
        idempotencyKey: key(value.idempotencyKey),
        source: value.source,
      };
    case "REMATCH":
    case "CANCEL":
    case "FORFEIT":
      return { type: value.type, idempotencyKey: key(value.idempotencyKey) };
    default:
      throw new Error("Unknown command");
  }
}
