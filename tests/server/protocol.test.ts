import { describe, expect, it } from "vitest";

import { parseClientCommand } from "../../services/realtime/protocol";

describe("realtime command protocol", () => {
  it("accepts a bounded authenticated command shape", () => {
    expect(
      parseClientCommand(
        JSON.stringify({
          type: "SET_LANGUAGE",
          idempotencyKey: "cmd-1",
          language: "PYTHON",
        }),
      ),
    ).toEqual({
      type: "SET_LANGUAGE",
      idempotencyKey: "cmd-1",
      language: "PYTHON",
    });
  });

  it("rejects missing idempotency keys and unsupported languages", () => {
    expect(() =>
      parseClientCommand(JSON.stringify({ type: "SET_READY", ready: true })),
    ).toThrow();
    expect(() =>
      parseClientCommand(
        JSON.stringify({
          type: "SET_LANGUAGE",
          idempotencyKey: "x",
          language: "javascript",
        }),
      ),
    ).toThrow();
  });
});
