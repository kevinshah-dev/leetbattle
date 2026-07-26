import { describe, expect, it } from "vitest";

import { DomainError } from "../../src/server/domain/errors";
import {
  assertTransition,
  canTransition,
  compareWinnerCandidates,
  shouldApplyRecord,
} from "../../src/server/domain/state-machine";

describe("authoritative state machine", () => {
  it("permits only the documented forward transitions", () => {
    expect(canTransition("LOBBY", "COUNTDOWN")).toBe(true);
    expect(canTransition("COUNTDOWN", "ACTIVE")).toBe(true);
    expect(canTransition("ACTIVE", "FINISHED")).toBe(true);
    expect(canTransition("FINISHED", "REMATCH_PENDING")).toBe(true);
    expect(canTransition("ACTIVE", "LOBBY")).toBe(false);
    expect(canTransition("REMATCH_PENDING", "ACTIVE")).toBe(false);
    expect(() => assertTransition("ACTIVE", "COUNTDOWN")).toThrow(DomainError);
  });

  it("orders winners by receipt, then runtime, then immutable sequence", () => {
    const early = {
      receivedAt: "2026-01-01T00:00:00.000Z",
      runtimeMs: 99,
      sequence: 8,
    };
    const later = {
      receivedAt: "2026-01-01T00:00:00.001Z",
      runtimeMs: 1,
      sequence: 1,
    };
    expect(compareWinnerCandidates(early, later)).toBeLessThan(0);

    const fast = { ...early, runtimeMs: 20, sequence: 9 };
    expect(compareWinnerCandidates(fast, early)).toBeLessThan(0);

    const firstSequence = { ...fast, sequence: 2 };
    const secondSequence = { ...fast, sequence: 3 };
    expect(compareWinnerCandidates(firstSequence, secondSequence)).toBeLessThan(
      0,
    );
  });

  it("changes records only for accepted wins and forfeits", () => {
    expect(shouldApplyRecord("ACCEPTED")).toBe(true);
    expect(shouldApplyRecord("FORFEIT")).toBe(true);
    expect(shouldApplyRecord("NO_CONTEST")).toBe(false);
    expect(shouldApplyRecord("CANCELLED")).toBe(false);
  });
});
