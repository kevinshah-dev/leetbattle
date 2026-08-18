import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it, vi } from "vitest";

import {
  GLOBAL_RECOVERY_CRON,
  runMaintenanceOperations,
  shouldRunDailyCleanup,
  type MaintenanceServices,
} from "@/server/realtime/maintenance";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));

function maintenanceServices() {
  return {
    matches: {
      processDueCountdowns: vi.fn(async () => 1),
      expireStaleSessions: vi.fn(async () => 2),
      processDueDisconnects: vi.fn(async () => 3),
      recoverStaleExecutions: vi.fn(async () => 4),
      purgeOldRealtimeSessions: vi.fn(async () => 6),
    },
    tickets: {
      purgeExpiredUses: vi.fn(async () => 5),
    },
  } satisfies MaintenanceServices;
}

describe("Cloudflare realtime maintenance schedule", () => {
  it("checks global recovery every six hours instead of every minute", () => {
    const wrangler = readFileSync(
      `${repositoryRoot}/cloudflare/realtime/wrangler.jsonc`,
      "utf8",
    );

    expect(wrangler).toContain(`"crons": ["${GLOBAL_RECOVERY_CRON}"]`);
    expect(wrangler).not.toContain('"crons": ["* * * * *"]');
  });

  it("selects the midnight UTC recovery run for daily cleanup", () => {
    expect(shouldRunDailyCleanup(Date.parse("2026-08-18T00:17:00.000Z"))).toBe(
      true,
    );
    expect(shouldRunDailyCleanup(Date.parse("2026-08-18T06:17:00.000Z"))).toBe(
      false,
    );
    expect(shouldRunDailyCleanup(Number.NaN)).toBe(false);
  });

  it("runs only recovery operations on ordinary scheduled wakes", async () => {
    const services = maintenanceServices();

    await expect(
      runMaintenanceOperations(services, { includeCleanup: false }),
    ).resolves.toEqual({
      recovery: {
        countdowns: 1,
        staleSessions: 2,
        disconnects: 3,
        staleExecutions: 4,
      },
      cleanup: null,
    });
    expect(services.tickets.purgeExpiredUses).not.toHaveBeenCalled();
    expect(services.matches.purgeOldRealtimeSessions).not.toHaveBeenCalled();
  });

  it("folds both cleanup operations into the daily recovery wake", async () => {
    const services = maintenanceServices();

    await expect(
      runMaintenanceOperations(services, { includeCleanup: true }),
    ).resolves.toEqual({
      recovery: {
        countdowns: 1,
        staleSessions: 2,
        disconnects: 3,
        staleExecutions: 4,
      },
      cleanup: {
        expiredTickets: 5,
        expiredSessionRecords: 6,
      },
    });
    expect(services.tickets.purgeExpiredUses).toHaveBeenCalledOnce();
    expect(services.matches.purgeOldRealtimeSessions).toHaveBeenCalledOnce();
  });
});
