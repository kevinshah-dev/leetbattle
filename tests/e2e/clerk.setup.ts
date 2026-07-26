import { clerkSetup } from "@clerk/testing/playwright";
import { test as setup } from "@playwright/test";

import { clerkPublishableKey, e2eGateReason } from "./environment";

const gateReason = e2eGateReason();

setup.describe("Clerk E2E boundary", () => {
  setup.describe.configure({ mode: "serial" });
  setup.skip(gateReason !== null, gateReason || "");

  setup("obtain an official Clerk testing token", async () => {
    await clerkSetup({
      publishableKey: clerkPublishableKey(),
    });
  });
});
