import { clerk } from "@clerk/testing/playwright";
import {
  expect,
  test,
  type APIRequestContext,
  type Page,
} from "@playwright/test";

import { listServerProblems } from "../../src/problems/server/bank.server";
import { e2eGateReason } from "./environment";

interface ProfileResponse {
  profile: {
    username: string;
    wins: number;
    losses: number;
  } | null;
}

interface HistoryResponse {
  matches: unknown[];
}

const gateReason = e2eGateReason();
const canonicalByTitle = new Map(
  listServerProblems().map((problem) => [
    problem.public.title,
    problem.canonical,
  ]),
);

async function appAvailabilityReason(
  request: APIRequestContext,
): Promise<string | null> {
  try {
    const response = await request.get("/", {
      failOnStatusCode: false,
      timeout: 8_000,
    });
    if (!response.ok()) {
      return `E2E_BASE_URL returned HTTP ${response.status()} for GET /.`;
    }
    return null;
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
    await expect(usernameInput).toBeVisible();
    await usernameInput.fill(fallback);
    await page.getByRole("button", { name: "Lock callsign" }).click();
  }

  await expect(page).toHaveURL(/\/battle\/new$/);

  const response = await page.context().request.get("/api/profile");
  expect(
    response.ok(),
    `Authenticated profile request returned HTTP ${response.status()}.`,
  ).toBeTruthy();
  const payload = (await response.json()) as ProfileResponse;
  expect(payload.profile?.username).toBeTruthy();
  return payload.profile!.username;
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

async function historyCount(page: Page): Promise<number> {
  const response = await page.context().request.get("/api/history");
  expect(response.ok()).toBeTruthy();
  const payload = (await response.json()) as HistoryResponse;
  return payload.matches.length;
}

function roundScopedUsername(role: "host" | "guest"): string {
  return `e2e_${role[0]}_${Date.now().toString(36)}`;
}

async function hasStoredDraft(page: Page, expected: string): Promise<boolean> {
  return page.evaluate((source) => {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (
        key?.startsWith("leetbattle:draft:") &&
        window.localStorage.getItem(key) === source
      ) {
        return true;
      }
    }
    return false;
  }, expected);
}

async function replaceEditorSource(
  page: Page,
  language: "Python" | "Java",
  source: string,
): Promise<void> {
  const editor = page.getByRole("textbox", {
    name: `${language} solution editor`,
  });
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.press("Backspace");
  await expect.poll(() => hasStoredDraft(page, "")).toBe(true);
  await page.keyboard.insertText(source);
  await expect.poll(() => hasStoredDraft(page, source)).toBe(true);
}

async function acceptedResultTitle(page: Page): Promise<"VICTORY" | "DEFEAT"> {
  const heading = page.getByRole("dialog").getByRole("heading", { level: 1 });
  await expect(heading).toHaveText(/^(VICTORY|DEFEAT)$/, {
    timeout: 90_000,
  });
  const title = await heading.innerText();
  if (title !== "VICTORY" && title !== "DEFEAT") {
    throw new Error(`Unexpected accepted-round title: ${title}`);
  }
  return title;
}

test.describe("real two-player duel", () => {
  test.skip(gateReason !== null, gateReason || "");

  test("two independent Clerk sessions exercise the real room and judge flow", async ({
    browser,
    baseURL,
    request,
  }) => {
    const unavailable = await appAvailabilityReason(request);
    expect(
      unavailable,
      unavailable ?? "The configured LeetBattle stack is reachable.",
    ).toBeNull();

    if (!baseURL) {
      throw new Error("Playwright requires an E2E_BASE_URL.");
    }
    const contextOptions = {
      baseURL,
      viewport: { width: 1440, height: 900 },
    };
    const hostContext = await browser.newContext(contextOptions);
    const guestContext = await browser.newContext(contextOptions);
    const hostPage = await hostContext.newPage();
    const guestPage = await guestContext.newPage();

    try {
      await test.step("authenticate two real, isolated Clerk users", async () => {
        await Promise.all([
          signIn(hostPage, process.env.E2E_CLERK_HOST_EMAIL!),
          signIn(guestPage, process.env.E2E_CLERK_GUEST_EMAIL!),
        ]);
      });

      const [hostUsername, guestUsername] =
        await test.step("create or restore both LeetBattle profiles", async () =>
          Promise.all([
            ensureProfile(hostPage, roundScopedUsername("host")),
            ensureProfile(guestPage, roundScopedUsername("guest")),
          ]));
      expect(hostUsername).not.toBe(guestUsername);

      const inviteURL =
        await test.step("host creates an unlisted Easy room", async () => {
          await hostPage.goto("/battle/new");
          await hostPage.getByRole("radio", { name: /^Easy/ }).click();
          await hostPage.getByRole("button", { name: "Create battle" }).click();
          await expect(hostPage).toHaveURL(/\/lobby\/[^/?#]+$/);

          const invite = await hostPage
            .getByLabel("Private invite")
            .inputValue();
          const parsed = new URL(invite);
          expect(parsed.pathname).toMatch(/^\/join\/[^/]+$/);
          expect(
            parsed.origin,
            "APP_ORIGIN must match E2E_BASE_URL so the real Clerk session stays on the invite origin.",
          ).toBe(new URL(baseURL).origin);
          return invite;
        });

      await test.step("challenger claims the invite in a separate context", async () => {
        await guestPage.goto(inviteURL);
        await expect(guestPage).toHaveURL(/\/lobby\/[^/?#]+$/, {
          timeout: 30_000,
        });

        for (const page of [hostPage, guestPage]) {
          const roster = page.getByRole("region", { name: "Players" });
          await expect(
            roster.getByText(hostUsername, { exact: true }),
          ).toBeVisible();
          await expect(
            roster.getByText(guestUsername, { exact: true }),
          ).toBeVisible();
        }
      });

      await test.step("players choose different runtimes and lock in", async () => {
        const hostLanguage = hostPage.getByRole("button", { name: /Python/ });
        const guestLanguage = guestPage.getByRole("button", { name: /Java/ });
        await hostLanguage.click();
        await guestLanguage.click();
        await expect(hostLanguage).toHaveAttribute("aria-pressed", "true");
        await expect(guestLanguage).toHaveAttribute("aria-pressed", "true");

        await hostPage.getByRole("button", { name: "Ready up" }).click();
        await expect(
          hostPage.getByRole("button", { name: "Unlock loadout" }),
        ).toBeVisible();

        const hostBattle = hostPage.waitForURL(/\/battle\/[^/?#]+$/, {
          timeout: 30_000,
        });
        const guestBattle = guestPage.waitForURL(/\/battle\/[^/?#]+$/, {
          timeout: 30_000,
        });
        await guestPage.getByRole("button", { name: "Ready up" }).click();
        await Promise.all([hostBattle, guestBattle]);
      });

      const canonical =
        await test.step("both clients reveal the same server-selected problem", async () => {
          const hostRun = hostPage.getByRole("button", {
            name: /Run samples/,
          });
          const guestRun = guestPage.getByRole("button", {
            name: /Run samples/,
          });
          await expect(hostRun).toBeEnabled({ timeout: 30_000 });
          await expect(guestRun).toBeEnabled({ timeout: 30_000 });

          const hostHeading = hostPage
            .getByRole("tabpanel")
            .getByRole("heading", { level: 1 });
          const guestHeading = guestPage
            .getByRole("tabpanel")
            .getByRole("heading", { level: 1 });
          await expect(hostHeading).toBeVisible();
          const title = await hostHeading.innerText();
          await expect(guestHeading).toHaveText(title);

          const selected = canonicalByTitle.get(title);
          if (!selected) {
            throw new Error(
              `The private E2E problem bank has no canonical source for ${title}.`,
            );
          }
          return selected;
        });

      await test.step("both canonical sources pass their public samples", async () => {
        await Promise.all([
          replaceEditorSource(hostPage, "Python", canonical.python),
          replaceEditorSource(guestPage, "Java", canonical.java),
        ]);
        await Promise.all([
          hostPage.getByRole("button", { name: /Run samples/ }).click(),
          guestPage.getByRole("button", { name: /Run samples/ }).click(),
        ]);

        for (const page of [hostPage, guestPage]) {
          const judge = page.getByRole("region", { name: "Judge console" });
          await expect(judge).toContainText("Sample 1", { timeout: 60_000 });
          await expect(judge).toContainText("Sample 2");
          await expect(judge).toContainText("Sample 3");
        }
      });

      const [hostOutcome, guestOutcome] =
        await test.step("near-simultaneous accepted submissions choose exactly one winner", async () => {
          await Promise.all([
            guestPage.getByRole("button", { name: /Submit solution/ }).click(),
            hostPage.getByRole("button", { name: /Submit solution/ }).click(),
          ]);

          const outcomes = await Promise.all([
            acceptedResultTitle(hostPage),
            acceptedResultTitle(guestPage),
          ]);
          expect([...outcomes].sort()).toEqual(["DEFEAT", "VICTORY"]);
          for (const page of [hostPage, guestPage]) {
            await expect(
              page.getByRole("button", { name: /Submitting/ }),
            ).toHaveCount(0, { timeout: 90_000 });
          }
          return outcomes;
        });

      await test.step("mutual rematch creates a clean second lobby", async () => {
        await hostPage.getByRole("button", { name: "Run it back" }).click();
        await expect(
          hostPage.getByRole("button", { name: "Vote locked" }),
        ).toBeVisible();

        const hostLobby = hostPage.waitForURL(/\/lobby\/[^/?#]+$/, {
          timeout: 30_000,
        });
        const guestLobby = guestPage.waitForURL(/\/lobby\/[^/?#]+$/, {
          timeout: 30_000,
        });
        await guestPage.getByRole("button", { name: "Run it back" }).click();
        await Promise.all([hostLobby, guestLobby]);

        await expect(
          hostPage.getByRole("button", { name: "Ready up" }),
        ).toBeDisabled();
        await expect(
          guestPage.getByRole("button", { name: "Ready up" }),
        ).toBeDisabled();
      });

      await test.step("host cancels the unused rematch room", async () => {
        hostPage.once("dialog", (dialog) => dialog.accept());
        const hostCancelled = hostPage.waitForURL(/\/battle\/[^/?#]+$/, {
          timeout: 30_000,
        });
        const guestCancelled = guestPage.waitForURL(/\/battle\/[^/?#]+$/, {
          timeout: 30_000,
        });
        await hostPage.getByRole("button", { name: "Cancel room" }).click();
        await Promise.all([hostCancelled, guestCancelled]);

        for (const page of [hostPage, guestPage]) {
          await expect(
            page
              .getByRole("dialog")
              .getByRole("heading", { name: "CANCELLED" }),
          ).toBeVisible();
        }
      });

      await test.step("the accepted result appears in both histories", async () => {
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
        await expect(hostPage).toHaveURL(/\/history$/);
        await expect(guestPage).toHaveURL(/\/history$/);

        const hostRow = hostPage
          .getByRole("row")
          .filter({ hasText: guestUsername })
          .first();
        const guestRow = guestPage
          .getByRole("row")
          .filter({ hasText: hostUsername })
          .first();
        await expect(hostRow).toContainText(
          hostOutcome === "VICTORY" ? "Win" : "Loss",
        );
        await expect(hostRow).toContainText("accepted");
        await expect(hostRow).toContainText("Python");
        await expect(guestRow).toContainText(
          guestOutcome === "VICTORY" ? "Win" : "Loss",
        );
        await expect(guestRow).toContainText("accepted");
        await expect(guestRow).toContainText("Java");
      });
    } finally {
      await Promise.all([hostContext.close(), guestContext.close()]);
    }
  });
});

test.describe("real single-player practice", () => {
  test.skip(gateReason !== null, gateReason || "");

  test("one Clerk session clears the real judge without changing its record", async ({
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
      const historyBefore = await historyCount(page);

      await page.goto("/battle/new?mode=practice");
      await expect(
        page.getByRole("radio", { name: /^Practice mode/ }),
      ).toHaveAttribute("aria-checked", "true");
      await page.getByRole("radio", { name: /^Easy/ }).click();
      await page.getByRole("button", { name: "Start practice" }).click();
      await expect(page).toHaveURL(/\/lobby\/[^/?#]+$/);
      await expect(
        page.getByRole("region", { name: "Practice setup" }),
      ).toContainText("There is no rival");
      await expect(page.getByLabel("Private invite")).toHaveCount(0);

      await page.getByRole("button", { name: /Python/ }).click();
      await page.getByRole("button", { name: "Start practice" }).click();
      await expect(page).toHaveURL(/\/battle\/[^/?#]+$/, { timeout: 30_000 });
      await expect(
        page.getByRole("button", { name: "End practice" }),
      ).toBeVisible();
      await expect(page.getByRole("button", { name: "Forfeit" })).toHaveCount(
        0,
      );

      const runSamples = page.getByRole("button", { name: /Run samples/ });
      await expect(runSamples).toBeEnabled({ timeout: 30_000 });
      const title = await page
        .getByRole("tabpanel")
        .getByRole("heading", { level: 1 })
        .innerText();
      const canonical = canonicalByTitle.get(title);
      if (!canonical) {
        throw new Error(`No canonical E2E source exists for ${title}.`);
      }

      await replaceEditorSource(page, "Python", canonical.python);
      await runSamples.click();
      await expect(
        page.getByRole("region", { name: "Judge console" }),
      ).toContainText("Sample 3", { timeout: 60_000 });

      await page.reload();
      const submit = page.getByRole("button", { name: /Submit solution/ });
      await expect(submit).toBeEnabled({ timeout: 30_000 });
      await submit.click();
      await expect(
        page
          .getByRole("dialog")
          .getByRole("heading", { name: "PRACTICE COMPLETE" }),
      ).toBeVisible({ timeout: 90_000 });
      await expect(
        page.getByRole("button", { name: "Run it back" }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("link", { name: "Practice another" }),
      ).toBeVisible();

      const stripTimer = page
        .getByRole("region", { name: "Practice status" })
        .locator(".pit-center-mark .tabular");
      const frozenTime = await stripTimer.innerText();
      await page.waitForTimeout(1_200);
      await expect(stripTimer).toHaveText(frozenTime);
      expect(await profileRecord(page)).toEqual(recordBefore);
      expect(await historyCount(page)).toBe(historyBefore);
    } finally {
      await context.close();
    }
  });
});
