"use client";

import { SignInButton, SignUpButton, useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { ApiError, getProfile, joinRoom } from "./api-client";
import { ArcadeLink, PixelPanel, StatusLamp } from "./ArcadePrimitives";

export function JoinRoomGate({ roomCode }: { roomCode: string }) {
  const router = useRouter();
  const { isLoaded, isSignedIn } = useUser();
  const [error, setError] = useState("");
  const attempted = useRef(false);
  const returnUrl =
    typeof window === "undefined" ? `/join/${roomCode}` : window.location.href;

  useEffect(() => {
    if (!isLoaded || !isSignedIn || attempted.current) return;
    attempted.current = true;
    void getProfile()
      .then(async ({ profile }) => {
        if (!profile) {
          router.replace(
            `/onboarding?returnTo=${encodeURIComponent(`/join/${roomCode}`)}`,
          );
          return;
        }
        const { snapshot } = await joinRoom(roomCode);
        router.replace(
          snapshot.state === "LOBBY"
            ? `/lobby/${snapshot.roomCode}`
            : `/battle/${snapshot.roomCode}`,
        );
      })
      .catch((caught: unknown) => {
        if (caught instanceof ApiError && caught.code === "PROFILE_REQUIRED") {
          router.replace(
            `/onboarding?returnTo=${encodeURIComponent(`/join/${roomCode}`)}`,
          );
          return;
        }
        if (caught instanceof ApiError && caught.status === 404)
          setError("This invite does not point to an active room.");
        else if (caught instanceof ApiError && caught.status === 409)
          setError(caught.message);
        else
          setError(
            caught instanceof Error
              ? caught.message
              : "Could not claim the challenger slot.",
          );
      });
  }, [isLoaded, isSignedIn, roomCode, router]);

  return (
    <div className="join-layout">
      <div className="join-layout__signal" aria-hidden="true">
        <span />
        <span />
        <span />
        <span />
        <i />
      </div>
      <PixelPanel className="join-panel" label="PRIVATE INVITE">
        <StatusLamp
          label={error ? "LINK REJECTED" : "LINK VERIFIED"}
          tone={error ? "coral" : "cyan"}
        />
        <p className="eyebrow">Room {roomCode}</p>
        <h1>
          {error ? "Could not enter the pit." : "A challenger slot is waiting."}
        </h1>
        {error ? (
          <>
            <p>{error}</p>
            <div className="join-panel__actions">
              <ArcadeLink href="/" tone="ghost">
                Return home
              </ArcadeLink>
            </div>
          </>
        ) : isLoaded && isSignedIn ? (
          <div aria-live="polite" className="linking-state">
            <span className="pixel-loader" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
              <i />
            </span>
            <div>
              <strong>Claiming your slot…</strong>
              <small>
                Checking room membership and restoring the latest snapshot.
              </small>
            </div>
          </div>
        ) : (
          <>
            <p>
              Sign in to claim the second seat. You will return to this exact
              invite after authentication.
            </p>
            <div className="join-panel__actions">
              <SignInButton
                fallbackRedirectUrl={returnUrl}
                forceRedirectUrl={returnUrl}
                mode="modal"
              >
                <button
                  className="arcade-button arcade-button--gold"
                  type="button"
                >
                  <span>Sign in to join</span>
                </button>
              </SignInButton>
              <SignUpButton
                fallbackRedirectUrl={returnUrl}
                forceRedirectUrl={returnUrl}
                mode="modal"
              >
                <button
                  className="arcade-button arcade-button--ghost"
                  type="button"
                >
                  <span>Create account</span>
                </button>
              </SignUpButton>
            </div>
          </>
        )}
        <div className="privacy-note">
          <span aria-hidden="true" className="privacy-note__mark" />
          <p>
            <strong>Unlisted room</strong>
            <br />
            Only players with this cryptographic invite can request access.
          </p>
        </div>
      </PixelPanel>
    </div>
  );
}
