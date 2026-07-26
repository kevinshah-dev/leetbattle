import { defineConfig, devices } from "@playwright/test";

import { e2eGateReason } from "./tests/e2e/environment";

const baseURL = process.env.E2E_BASE_URL || "http://localhost:3000";
const gateReason = e2eGateReason();

if (gateReason) {
  process.stderr.write(`[LeetBattle E2E skipped] ${gateReason}\n`);
}

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 180_000,
  expect: {
    timeout: 30_000,
  },
  outputDir: "output/playwright/e2e-results",
  reporter: process.env.CI
    ? [
        ["line"],
        [
          "html",
          {
            open: "never",
            outputFolder: "output/playwright/e2e-report",
          },
        ],
      ]
    : "line",
  use: {
    baseURL,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "clerk-setup",
      testMatch: /clerk\.setup\.ts/,
    },
    {
      name: "chromium",
      dependencies: ["clerk-setup"],
      testMatch: /duel\.e2e\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
      },
    },
  ],
});
