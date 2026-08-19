import { clerk } from "@clerk/testing/playwright";
import {
  expect,
  test,
  type APIRequestContext,
  type Browser,
  type BrowserContext,
  type Page,
} from "@playwright/test";

import { aiMlE2eGateReason } from "./environment";

interface ProfileResponse {
  profile: {
    username: string;
    wins: number;
    losses: number;
  } | null;
}

const gateReason = aiMlE2eGateReason();

async function appAvailabilityReason(
  request: APIRequestContext,
): Promise<string | null> {
  try {
    const response = await request.get("/", {
      failOnStatusCode: false,
      timeout: 8_000,
    });
    return response.ok()
      ? null
      : `E2E_BASE_URL returned HTTP ${response.status()} for GET /.`;
  } catch (error) {
    return `E2E_BASE_URL is unreachable: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
}

async function signIn(page: Page, emailAddress: string): Promise<void> {
  await page.goto("/");
  await clerk.loaded({ page });
  await clerk.signIn({ emailAddress, page });
  await page.goto("/");
  await expect(
    page.getByRole("link", { name: "Create battle", exact: true }).first(),
  ).toBeVisible();
}

async function ensureProfile(page: Page, fallback: string): Promise<string> {
  await page.goto(`/onboarding?returnTo=${encodeURIComponent("/battle/new")}`);
  const usernameInput = page.getByLabel("Unique username");
  await expect
    .poll(
      async () => {
        if (await usernameInput.isVisible()) return "onboarding";
        if (new URL(page.url()).pathname === "/battle/new") return "ready";
        return "waiting";
      },
      { timeout: 20_000 },
    )
    .toMatch(/^(onboarding|ready)$/);

  if (new URL(page.url()).pathname === "/onboarding") {
    await usernameInput.fill(fallback);
    await page.getByRole("button", { name: "Lock callsign" }).click();
  }
  await expect(page).toHaveURL(/\/battle\/new$/);

  const response = await page.context().request.get("/api/profile");
  expect(response.ok()).toBeTruthy();
  const payload = (await response.json()) as ProfileResponse;
  if (!payload.profile)
    throw new Error("Authenticated E2E profile is missing.");
  return payload.profile.username;
}

async function profileRecord(page: Page): Promise<{
  wins: number;
  losses: number;
}> {
  const response = await page.context().request.get("/api/profile");
  expect(response.ok()).toBeTruthy();
  const payload = (await response.json()) as ProfileResponse;
  if (!payload.profile)
    throw new Error("Authenticated E2E profile is missing.");
  return { wins: payload.profile.wins, losses: payload.profile.losses };
}

function roundScopedUsername(role: "host" | "guest"): string {
  return `e2e_ai_${role[0]}_${Date.now().toString(36)}`;
}

async function isolatedPlayers(
  browser: Browser,
  baseURL: string,
): Promise<{
  hostContext: BrowserContext;
  guestContext: BrowserContext;
  hostPage: Page;
  guestPage: Page;
}> {
  const options = { baseURL, viewport: { width: 1440, height: 900 } };
  const hostContext = await browser.newContext(options);
  const guestContext = await browser.newContext(options);
  return {
    hostContext,
    guestContext,
    hostPage: await hostContext.newPage(),
    guestPage: await guestContext.newPage(),
  };
}

async function waitForArenaEditor(page: Page): Promise<void> {
  const editor = page.getByRole("textbox", { name: "AI/ML answer" });
  await expect(editor).toBeVisible({ timeout: 30_000 });
  await expect(editor).toBeEditable({ timeout: 30_000 });
}

async function arenaOutcome(page: Page): Promise<"VICTORY" | "DEFEAT"> {
  const heading = page.getByRole("dialog").getByRole("heading", { level: 1 });
  await expect(heading).toHaveText(/^(VICTORY|DEFEAT)$/, { timeout: 60_000 });
  const value = await heading.innerText();
  if (value !== "VICTORY" && value !== "DEFEAT") {
    throw new Error(`Unexpected AI/ML result heading: ${value}`);
  }
  return value;
}

async function openHistoryDetail(
  page: Page,
  questionTitle: string,
): Promise<void> {
  await expect(page).toHaveURL(/\/history$/);
  const row = page
    .getByRole("row")
    .filter({ hasText: questionTitle })
    .filter({ hasText: "AI/ML Arena" })
    .first();
  await expect(row).toBeVisible();
  await row.getByRole("button", { name: "View" }).click();
  await expect(
    page.getByRole("region", { name: questionTitle, exact: true }),
  ).toBeVisible();
}

test.describe("AI/ML Arena real-browser boundary", () => {
  test.describe.configure({ mode: "serial" });
  test.skip(gateReason !== null, gateReason || "");

  test("two authenticated players complete a judged duel, inspect history, and rematch", async ({
    browser,
    baseURL,
    request,
  }) => {
    const unavailable = await appAvailabilityReason(request);
    expect(
      unavailable,
      unavailable ?? "The configured LeetBattle stack is reachable.",
    ).toBeNull();
    if (!baseURL) throw new Error("Playwright requires an E2E_BASE_URL.");

    const { hostContext, guestContext, hostPage, guestPage } =
      await isolatedPlayers(browser, baseURL);
    try {
      await Promise.all([
        signIn(hostPage, process.env.E2E_CLERK_HOST_EMAIL!),
        signIn(guestPage, process.env.E2E_CLERK_GUEST_EMAIL!),
      ]);
      const [hostUsername, guestUsername] = await Promise.all([
        ensureProfile(hostPage, roundScopedUsername("host")),
        ensureProfile(guestPage, roundScopedUsername("guest")),
      ]);
      expect(hostUsername).not.toBe(guestUsername);
      const [hostRecordBefore, guestRecordBefore] = await Promise.all([
        profileRecord(hostPage),
        profileRecord(guestPage),
      ]);

      await hostPage.goto("/battle/new");
      const aiMlChallenge = hostPage.getByRole("radio", {
        name: /^AI\/ML Arena/,
      });
      await aiMlChallenge.click();
      await expect(aiMlChallenge).toHaveAttribute("aria-checked", "true");
      await hostPage.getByRole("radio", { name: /^Easy/ }).click();
      await hostPage.getByRole("button", { name: "Create battle" }).click();
      await expect(hostPage).toHaveURL(/\/lobby\/[^/?#]+$/);
      await expect(
        hostPage.getByRole("region", { name: "AI/ML Arena rules" }),
      ).toContainText("10:00");
      await expect(
        hostPage.getByRole("button", { name: /Python/ }),
      ).toHaveCount(0);

      const invite = await hostPage.getByLabel("Private invite").inputValue();
      expect(new URL(invite).origin).toBe(new URL(baseURL).origin);
      await guestPage.goto(invite);
      await expect(guestPage).toHaveURL(/\/lobby\/[^/?#]+$/, {
        timeout: 30_000,
      });

      for (const page of [hostPage, guestPage]) {
        const players = page.getByRole("region", { name: "Players" });
        await expect(
          players.getByText(hostUsername, { exact: true }),
        ).toBeVisible();
        await expect(
          players.getByText(guestUsername, { exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("button", { name: "Ready up" }),
        ).toBeEnabled({ timeout: 30_000 });
      }

      await hostPage.getByRole("button", { name: "Ready up" }).click();
      const hostBattle = hostPage.waitForURL(/\/battle\/[^/?#]+$/, {
        timeout: 30_000,
      });
      const guestBattle = guestPage.waitForURL(/\/battle\/[^/?#]+$/, {
        timeout: 30_000,
      });
      await guestPage.getByRole("button", { name: "Ready up" }).click();
      await Promise.all([hostBattle, guestBattle]);
      await Promise.all([
        waitForArenaEditor(hostPage),
        waitForArenaEditor(guestPage),
      ]);

      const hostQuestion = hostPage
        .getByRole("region", { name: "AI/ML question" })
        .getByRole("heading", { level: 1 });
      const questionTitle = await hostQuestion.innerText();
      await expect(
        guestPage
          .getByRole("region", { name: "AI/ML question" })
          .getByRole("heading", { level: 1 }),
      ).toHaveText(questionTitle);

      const hostAnswer =
        "Host explains the core mechanism, assumptions, tradeoffs, and validation strategy. <script>window.e2eLeak=true</script>";
      const guestAnswer =
        "Guest gives a concise definition and one relevant implementation detail.";
      await hostPage
        .getByRole("textbox", { name: "AI/ML answer" })
        .fill(hostAnswer);
      await guestPage
        .getByRole("textbox", { name: "AI/ML answer" })
        .fill(guestAnswer);
      await hostPage
        .getByRole("button", { name: "Submit final answer" })
        .click();
      await expect(
        hostPage.getByRole("button", { name: "Answer submitted" }),
      ).toBeVisible({ timeout: 30_000 });
      await expect(
        guestPage.getByRole("complementary", { name: "Arena round status" }),
      ).toContainText(/Opponent\s*Submitted/, { timeout: 30_000 });
      await expect(
        guestPage.getByText(hostAnswer, { exact: true }),
      ).toHaveCount(0);

      await guestPage
        .getByRole("button", { name: "Submit final answer" })
        .click();
      const [hostOutcome, guestOutcome] = await Promise.all([
        arenaOutcome(hostPage),
        arenaOutcome(guestPage),
      ]);
      expect([hostOutcome, guestOutcome].sort()).toEqual(["DEFEAT", "VICTORY"]);

      for (const page of [hostPage, guestPage]) {
        const dialog = page.getByRole("dialog");
        await expect(
          dialog.getByRole("region", { name: "Official scores" }),
        ).toContainText(/100[\s\S]*90|90[\s\S]*100/);
        await expect(
          dialog.getByRole("region", { name: "Judge explanation" }),
        ).toContainText("Deterministic E2E judge");
        const answers = dialog.getByRole("region", {
          name: "Submitted answers",
        });
        await expect(answers).toContainText(hostAnswer);
        await expect(answers).toContainText(guestAnswer);
      }
      expect(
        await hostPage.evaluate(() =>
          Object.prototype.hasOwnProperty.call(window, "e2eLeak"),
        ),
      ).toBe(false);

      const [hostRecordAfter, guestRecordAfter] = await Promise.all([
        profileRecord(hostPage),
        profileRecord(guestPage),
      ]);
      const expectedHost =
        hostOutcome === "VICTORY"
          ? {
              wins: hostRecordBefore.wins + 1,
              losses: hostRecordBefore.losses,
            }
          : {
              wins: hostRecordBefore.wins,
              losses: hostRecordBefore.losses + 1,
            };
      const expectedGuest =
        guestOutcome === "VICTORY"
          ? {
              wins: guestRecordBefore.wins + 1,
              losses: guestRecordBefore.losses,
            }
          : {
              wins: guestRecordBefore.wins,
              losses: guestRecordBefore.losses + 1,
            };
      expect(hostRecordAfter).toEqual(expectedHost);
      expect(guestRecordAfter).toEqual(expectedGuest);

      await hostPage.getByRole("button", { name: "Run it back" }).click();
      await expect(
        hostPage.getByRole("button", { name: "Vote locked" }),
      ).toBeVisible();
      const rematchHostLobby = hostPage.waitForURL(/\/lobby\/[^/?#]+$/, {
        timeout: 30_000,
      });
      const rematchGuestLobby = guestPage.waitForURL(/\/lobby\/[^/?#]+$/, {
        timeout: 30_000,
      });
      await guestPage.getByRole("button", { name: "Run it back" }).click();
      await Promise.all([rematchHostLobby, rematchGuestLobby]);
      for (const page of [hostPage, guestPage]) {
        await expect(
          page.getByText("AI/ML ARENA", { exact: true }),
        ).toBeVisible();
        await expect(
          page.getByRole("region", { name: "AI/ML Arena rules" }),
        ).toBeVisible();
        await expect(page.getByRole("button", { name: /Python/ })).toHaveCount(
          0,
        );
      }

      hostPage.once("dialog", (dialog) => dialog.accept());
      const cancelledHost = hostPage.waitForURL(/\/battle\/[^/?#]+$/, {
        timeout: 30_000,
      });
      const cancelledGuest = guestPage.waitForURL(/\/battle\/[^/?#]+$/, {
        timeout: 30_000,
      });
      await hostPage.getByRole("button", { name: "Cancel room" }).click();
      await Promise.all([cancelledHost, cancelledGuest]);
      for (const page of [hostPage, guestPage]) {
        await expect(
          page.getByRole("dialog").getByRole("heading", { name: "CANCELLED" }),
        ).toBeVisible();
      }

      await Promise.all([
        hostPage
          .getByRole("dialog")
          .getByRole("link", { name: "Match history" })
          .click(),
        guestPage
          .getByRole("dialog")
          .getByRole("link", { name: "Match history" })
          .click(),
      ]);
      await Promise.all([
        openHistoryDetail(hostPage, questionTitle),
        openHistoryDetail(guestPage, questionTitle),
      ]);
      for (const page of [hostPage, guestPage]) {
        const detail = page.getByRole("region", {
          name: questionTitle,
          exact: true,
        });
        await expect(
          detail.getByRole("region", { name: "Official scores" }),
        ).toContainText(/100[\s\S]*90|90[\s\S]*100/);
        await expect(
          detail.getByRole("region", { name: "Stored answers" }),
        ).toContainText(hostAnswer);
        await expect(
          detail.getByRole("region", { name: "Stored answers" }),
        ).toContainText(guestAnswer);
        await expect(
          detail.getByRole("region", { name: "Judge explanation" }),
        ).toContainText("Deterministic E2E judge");
      }
    } finally {
      await Promise.all([hostContext.close(), guestContext.close()]);
    }
  });

  test("one authenticated player completes scored practice with unchanged records and persisted detail", async ({
    browser,
    baseURL,
    request,
  }) => {
    const unavailable = await appAvailabilityReason(request);
    expect(
      unavailable,
      unavailable ?? "The configured LeetBattle stack is reachable.",
    ).toBeNull();
    if (!baseURL) throw new Error("Playwright requires an E2E_BASE_URL.");

    const context = await browser.newContext({
      baseURL,
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();
    try {
      await signIn(page, process.env.E2E_CLERK_HOST_EMAIL!);
      await ensureProfile(page, roundScopedUsername("host"));
      const recordBefore = await profileRecord(page);

      await page.goto("/battle/new?mode=practice&challenge=ai-ml");
      await expect(
        page.getByRole("radio", { name: /^AI\/ML Arena/ }),
      ).toHaveAttribute("aria-checked", "true");
      await expect(
        page.getByRole("radio", { name: /^Practice mode/ }),
      ).toHaveAttribute("aria-checked", "true");
      await page.getByRole("radio", { name: /^Easy/ }).click();
      await page.getByRole("button", { name: "Start arena practice" }).click();
      await expect(page).toHaveURL(/\/lobby\/[^/?#]+$/);
      await expect(
        page.getByRole("region", { name: "Practice setup" }),
      ).toContainText("There is no rival");
      await expect(page.getByLabel("Private invite")).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: "Start arena" }),
      ).toBeEnabled({ timeout: 30_000 });
      await page.getByRole("button", { name: "Start arena" }).click();
      await expect(page).toHaveURL(/\/battle\/[^/?#]+$/, { timeout: 30_000 });
      await waitForArenaEditor(page);

      const questionTitle = await page
        .getByRole("region", { name: "AI/ML question" })
        .getByRole("heading", { level: 1 })
        .innerText();
      const practiceAnswer =
        "Practice answer covers the mechanism, assumptions, tradeoffs, and evaluation plan. <img src=x onerror=window.practiceLeak=true>";
      await page
        .getByRole("textbox", { name: "AI/ML answer" })
        .fill(practiceAnswer);
      await page.getByRole("button", { name: "Submit final answer" }).click();
      const dialog = page.getByRole("dialog");
      await expect(
        dialog.getByRole("heading", { name: "PRACTICE SCORED" }),
      ).toBeVisible({ timeout: 60_000 });
      await expect(
        dialog.getByRole("region", { name: "Official scores" }),
      ).toContainText("100");
      await expect(
        dialog.getByRole("region", { name: "Feedback" }),
      ).toContainText("Deterministic E2E judge");
      await expect(
        dialog.getByRole("region", { name: "Submitted answers" }),
      ).toContainText(practiceAnswer);
      expect(
        await page.evaluate(() =>
          Object.prototype.hasOwnProperty.call(window, "practiceLeak"),
        ),
      ).toBe(false);
      expect(await profileRecord(page)).toEqual(recordBefore);
      await expect(
        page.getByRole("button", { name: "Run it back" }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("link", { name: "Practice another" }),
      ).toBeVisible();

      await dialog.getByRole("link", { name: "Match history" }).click();
      await openHistoryDetail(page, questionTitle);
      const detail = page.getByRole("region", {
        name: questionTitle,
        exact: true,
      });
      await expect(
        detail.getByRole("region", { name: "Official scores" }),
      ).toContainText("100");
      await expect(
        detail.getByRole("region", { name: "Stored answers" }),
      ).toContainText(practiceAnswer);
      await expect(
        detail.getByRole("region", { name: "Feedback" }),
      ).toContainText("Deterministic E2E judge");
      expect(await profileRecord(page)).toEqual(recordBefore);
    } finally {
      await context.close();
    }
  });
});
