"use client";

import { SignInButton, SignUpButton, UserButton, useUser } from "@clerk/nextjs";
import { usePathname } from "next/navigation";
import { useSyncExternalStore } from "react";

export function ClerkAuthControls({ compact = false }: { compact?: boolean }) {
  const { isLoaded, isSignedIn, user } = useUser();
  const pathname = usePathname();
  const returnUrl = useSyncExternalStore(
    () => () => undefined,
    () => window.location.href,
    () => pathname || "/",
  );

  if (isLoaded && isSignedIn) {
    return (
      <div
        aria-live="polite"
        className={`auth-controls${compact ? " auth-controls--compact" : ""}`}
      >
        {!compact && (
          <span className="auth-controls__name">
            {user?.firstName || user?.username || "Player"}
          </span>
        )}
        <UserButton appearance={{ elements: { avatarBox: "clerk-avatar" } }} />
      </div>
    );
  }

  return (
    <div
      aria-busy={!isLoaded}
      aria-live="polite"
      className={`auth-controls${!isLoaded ? " auth-controls--loading" : ""}`}
    >
      <SignInButton
        fallbackRedirectUrl={returnUrl}
        forceRedirectUrl={returnUrl}
        mode="modal"
        signUpFallbackRedirectUrl={returnUrl}
        signUpForceRedirectUrl={returnUrl}
      >
        <button className="nav-action" disabled={!isLoaded} type="button">
          Sign in
        </button>
      </SignInButton>
      {!compact && (
        <SignUpButton
          fallbackRedirectUrl={returnUrl}
          forceRedirectUrl={returnUrl}
          mode="modal"
          signInFallbackRedirectUrl={returnUrl}
          signInForceRedirectUrl={returnUrl}
        >
          <button
            className="nav-action nav-action--bright"
            disabled={!isLoaded}
            type="button"
          >
            Create account
          </button>
        </SignUpButton>
      )}
    </div>
  );
}
