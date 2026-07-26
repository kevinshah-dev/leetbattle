import { describe, expect, it } from "vitest";

import { INTERNAL_SECRET_PLACEHOLDERS } from "../../src/server/config/secrets";
import type { Database } from "../../src/server/db/client";
import type { ProblemCatalog } from "../../src/server/domain/types";
import { MatchEngine } from "../../src/server/match/match-engine";

const unusedDatabase = null as unknown as Database;
const emptyCatalog: ProblemCatalog = { listByDifficulty: () => [] };

describe("server secret validation", () => {
  it("rejects an absent or short room invite secret", () => {
    expect(
      () => new MatchEngine(unusedDatabase, emptyCatalog, { inviteSecret: "" }),
    ).toThrow(/ROOM_INVITE_SECRET/);
    expect(
      () =>
        new MatchEngine(unusedDatabase, emptyCatalog, {
          inviteSecret: "x".repeat(31),
        }),
    ).toThrow(/ROOM_INVITE_SECRET/);
  });

  it("accepts a room invite secret with at least 32 bytes", () => {
    expect(
      () =>
        new MatchEngine(unusedDatabase, emptyCatalog, {
          inviteSecret: "x".repeat(32),
        }),
    ).not.toThrow();
  });

  it("rejects the published room invite placeholder despite its length", () => {
    expect(
      () =>
        new MatchEngine(unusedDatabase, emptyCatalog, {
          inviteSecret: INTERNAL_SECRET_PLACEHOLDERS.ROOM_INVITE_SECRET,
        }),
    ).toThrow(/placeholder/);
  });
});
