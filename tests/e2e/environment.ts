const PLACEHOLDER_MARKERS = ["replace_me", "replace_with_"];

function isPlaceholder(value: string | undefined): boolean {
  const normalized = value?.trim().toLowerCase() || "";
  return (
    normalized.length === 0 ||
    PLACEHOLDER_MARKERS.some((marker) => normalized.includes(marker))
  );
}

export function clerkPublishableKey(
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  return (
    environment.CLERK_PUBLISHABLE_KEY ||
    environment.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY
  );
}

export function e2eGateReason(
  environment: NodeJS.ProcessEnv = process.env,
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
