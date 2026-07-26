import { describe, expect, it } from "vitest";

import { executionIntegrityVerdict } from "../../cloudflare/runner/src/execution-integrity";

describe("Cloudflare runner execution integrity", () => {
  it("classifies a user-controlled early clean exit as a runtime error", () => {
    expect(
      executionIntegrityVerdict({
        executionSucceeded: true,
        exitCode: 0,
        completedCases: 0,
        expectedCases: 12,
      }),
    ).toBe("runtime_error");
  });

  it("reserves infrastructure failures for the trusted outer command", () => {
    expect(
      executionIntegrityVerdict({
        executionSucceeded: false,
        exitCode: 1,
        completedCases: 0,
        expectedCases: 12,
      }),
    ).toBe("infrastructure_error");
  });

  it("accepts a complete successful protocol", () => {
    expect(
      executionIntegrityVerdict({
        executionSucceeded: true,
        exitCode: 0,
        completedCases: 12,
        expectedCases: 12,
      }),
    ).toBeUndefined();
  });
});
