const PLACEHOLDER_MARKERS = ["replace_me", "replace_with_"];

export const AI_ML_E2E_FAKE_JUDGE_ENV =
  "LEETBATTLE_E2E_FAKE_AI_ML_JUDGE" as const;

type E2eEnvironment = Readonly<
  Partial<
    Record<
      | typeof AI_ML_E2E_FAKE_JUDGE_ENV
      | "APP_ORIGIN"
      | "CLERK_PUBLISHABLE_KEY"
      | "CLERK_SECRET_KEY"
      | "E2E_BASE_URL"
      | "E2E_CLERK_GUEST_EMAIL"
      | "E2E_CLERK_HOST_EMAIL"
      | "NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY"
      | "RUN_REAL_E2E",
      string | undefined
    >
  >
>;

function isLoopbackHostname(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
}

function isPlaceholder(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() || "";
  return (
    normalized.length === 0 ||
    PLACEHOLDER_MARKERS.some((marker) => normalized.includes(marker))
  );
}

export function clerkPublishableKey(
  environment: E2eEnvironment = process.env,
): string | undefined {
  return (
    environment.CLERK_PUBLISHABLE_KEY ||
    environment.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
  );
}

export function e2eGateReason(
  environment: E2eEnvironment = process.env,
): string | null {
  if (environment.RUN_REAL_E2E !== "1") {
    return (
      "Real browser E2E is disabled: set RUN_REAL_E2E=1 only after the " +
      "PostgreSQL, web, realtime, Docker runner, judge images, and two Clerk " +
      "test accounts are ready."
    );
  }

  const missing: string[] = [];
  if (isPlaceholder(clerkPublishableKey(environment))) {
    missing.push(
      "CLERK_PUBLISHABLE_KEY (or NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY)",
    );
  }
  if (isPlaceholder(environment.CLERK_SECRET_KEY)) {
    missing.push("CLERK_SECRET_KEY");
  }
  if (isPlaceholder(environment.E2E_CLERK_HOST_EMAIL)) {
    missing.push("E2E_CLERK_HOST_EMAIL");
  }
  if (isPlaceholder(environment.E2E_CLERK_GUEST_EMAIL)) {
    missing.push("E2E_CLERK_GUEST_EMAIL");
  }

  if (missing.length > 0) {
    return `Real browser E2E is missing required environment values: ${missing.join(", ")}.`;
  }

  if (environment.E2E_CLERK_HOST_EMAIL === environment.E2E_CLERK_GUEST_EMAIL) {
    return (
      "Real browser E2E requires two different Clerk users; " +
      "E2E_CLERK_HOST_EMAIL and E2E_CLERK_GUEST_EMAIL are identical."
    );
  }

  const baseURL = environment.E2E_BASE_URL || "http://localhost:3000";
  try {
    const parsed = new URL(baseURL);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return "E2E_BASE_URL must use http:// or https://.";
    }
  } catch {
    return "E2E_BASE_URL must be an absolute http(s) URL.";
  }

  return null;
}

export function aiMlE2eGateReason(
  environment: E2eEnvironment = process.env,
): string | null {
  const sharedReason = e2eGateReason(environment);
  if (sharedReason) return sharedReason;
  if (environment[AI_ML_E2E_FAKE_JUDGE_ENV] !== "1") {
    return (
      "AI/ML browser E2E requires the guarded deterministic judge: set " +
      `${AI_ML_E2E_FAKE_JUDGE_ENV}=1 in the local web runtime and Playwright environment.`
    );
  }

  const baseURL = environment.E2E_BASE_URL || "http://localhost:3000";
  try {
    if (!environment.APP_ORIGIN?.trim()) {
      return "AI/ML browser E2E requires APP_ORIGIN to be set.";
    }
    const baseOrigin = new URL(baseURL);
    const appOrigin = new URL(environment.APP_ORIGIN);
    if (
      !isLoopbackHostname(baseOrigin.hostname) ||
      !isLoopbackHostname(appOrigin.hostname)
    ) {
      return "AI/ML browser E2E is restricted to loopback application origins.";
    }
    if (appOrigin.origin !== baseOrigin.origin) {
      return "AI/ML browser E2E requires APP_ORIGIN and E2E_BASE_URL to match.";
    }
  } catch {
    return "AI/ML browser E2E requires valid absolute APP_ORIGIN and E2E_BASE_URL values.";
  }
  return null;
}
