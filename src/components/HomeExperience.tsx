"use client";

import { SignInButton, useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useState } from "react";

import {
  ApiError,
  getProfile,
  joinRoom,
  type PlayerProfile,
} from "./api-client";
import { ArcadeLink, StatusLamp } from "./ArcadePrimitives";

function extractRoomCode(value: string) {
  const trimmed = value.trim();
  try {
    const parsed = new URL(trimmed);
    return parsed.pathname.split("/").filter(Boolean).at(-1) ?? "";
  } catch {
    return trimmed.split("/").filter(Boolean).at(-1) ?? "";
  }
}

function CircuitDuelPreview() {
  return (
    <div
      aria-label="Two pixel compiler pilots trade charged code blasts in the Circuit Pit"
      className="duel-preview"
      role="img"
    >
      <div aria-hidden="true" className="duel-preview__exchange">
        <span className="duel-preview__packet duel-preview__packet--left" />
        <span className="duel-preview__packet duel-preview__packet--right" />
        <span className="duel-preview__hit duel-preview__hit--left" />
        <span className="duel-preview__hit duel-preview__hit--right" />
      </div>
      <div className="duel-preview__fighter duel-preview__fighter--left">
        <span className="pixel-fighter__shadow" />
        <span className="pixel-fighter__body">
          <span className="pixel-fighter__antenna" />
          <span className="pixel-fighter__head">
            <i />
          </span>
          <span className="pixel-fighter__core" />
          <span className="pixel-fighter__arm pixel-fighter__arm--front" />
          <span className="pixel-fighter__arm pixel-fighter__arm--back" />
          <span className="pixel-fighter__feet" />
        </span>
      </div>
      <div className="duel-preview__fighter duel-preview__fighter--right">
        <span className="pixel-fighter__shadow" />
        <span className="pixel-fighter__body">
          <span className="pixel-fighter__antenna" />
          <span className="pixel-fighter__head">
            <i />
          </span>
          <span className="pixel-fighter__core" />
          <span className="pixel-fighter__arm pixel-fighter__arm--front" />
          <span className="pixel-fighter__arm pixel-fighter__arm--back" />
          <span className="pixel-fighter__feet" />
        </span>
      </div>
      <div className="duel-preview__floor">
        <span />
        <span />
        <span />
        <span />
        <span />
        <span />
        <span />
        <span />
      </div>
      <div className="duel-preview__caption">
        <span>THE CIRCUIT PIT</span>
        <small>server clock armed</small>
      </div>
    </div>
  );
}

export function HomeExperience() {
  const router = useRouter();
  const { isLoaded, isSignedIn } = useUser();
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [roomInput, setRoomInput] = useState("");
  const [joinError, setJoinError] = useState("");
  const [joining, setJoining] = useState(false);
  const returnUrl = typeof window === "undefined" ? "/" : window.location.href;

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    const controller = new AbortController();
    void getProfile(controller.signal)
      .then(({ profile: loadedProfile }) => setProfile(loadedProfile))
      .catch(() => undefined);
    return () => controller.abort();
  }, [isLoaded, isSignedIn]);

  async function handleJoin(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const roomCode = extractRoomCode(roomInput);
    if (!roomCode) {
      setJoinError("Paste the invite URL or cryptographic room token.");
      return;
    }
    setJoinError("");
    setJoining(true);
    try {
      const { snapshot } = await joinRoom(roomCode);
      router.push(
        snapshot.state === "LOBBY"
          ? `/lobby/${snapshot.roomCode}`
          : `/battle/${snapshot.roomCode}`,
      );
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "PROFILE_REQUIRED") {
        router.push(
          `/onboarding?returnTo=${encodeURIComponent(`/join/${roomCode}`)}`,
        );
        return;
      }
      if (caught instanceof ApiError && caught.status === 404)
        setJoinError(
          "That invite is not active. Check the code and try again.",
        );
      else if (caught instanceof ApiError && caught.status === 409)
        setJoinError(caught.message);
      else
        setJoinError(
          caught instanceof Error
            ? caught.message
            : "Could not join this battle.",
        );
    } finally {
      setJoining(false);
    }
  }

  return (
    <main className="landing" id="main-content">
      <section className="landing__hero">
        <div className="landing__copy">
          <h1>
            Code first.
            <br />
            <span>Strike first.</span>
          </h1>
          <p className="landing__lede">
            Pick a difficulty, invite one friend, and race on the same original
            challenge. The first solution through every hidden test lands the
            final hit.
          </p>
          <div className="landing__actions">
            {isLoaded && isSignedIn ? (
              <ArcadeLink
                href={
                  profile
                    ? "/battle/new"
                    : "/onboarding?returnTo=%2Fbattle%2Fnew"
                }
              >
                Create battle
              </ArcadeLink>
            ) : (
              <SignInButton
                fallbackRedirectUrl={returnUrl}
                forceRedirectUrl={returnUrl}
                mode="modal"
              >
                <button
                  className="arcade-button arcade-button--gold"
                  type="button"
                >
                  <span>Create battle</span>
                </button>
              </SignInButton>
            )}
            <ArcadeLink href="/how-to-play" tone="ghost">
              How it works
            </ArcadeLink>
          </div>
          {profile && (
            <div
              className="player-card"
              aria-label={`${profile.username}, ${profile.wins} wins and ${profile.losses} losses`}
            >
              <div>
                <span className="player-card__prompt">PLAYER&gt;</span>
                <strong>{profile.username}</strong>
              </div>
              <dl>
                <div>
                  <dt>Wins</dt>
                  <dd>{profile.wins}</dd>
                </div>
                <div>
                  <dt>Losses</dt>
                  <dd>{profile.losses}</dd>
                </div>
              </dl>
              <a href="/history">
                Open match log <span aria-hidden="true">→</span>
              </a>
            </div>
          )}
        </div>

        <div className="landing__cabinet">
          <CircuitDuelPreview />
          <div className="quick-match">
            <div className="quick-match__topline">
              <span>QUICK MATCH</span>
              <StatusLamp label="SYSTEM READY" tone="cyan" />
            </div>
            <ol className="arcade-menu" aria-label="Match menu">
              <li>
                {isLoaded && isSignedIn ? (
                  <a
                    href={
                      profile
                        ? "/battle/new"
                        : "/onboarding?returnTo=%2Fbattle%2Fnew"
                    }
                  >
                    Create a private battle
                  </a>
                ) : (
                  <SignInButton
                    fallbackRedirectUrl={returnUrl}
                    forceRedirectUrl={returnUrl}
                    mode="modal"
                  >
                    <button type="button">Create a private battle</button>
                  </SignInButton>
                )}
              </li>
              <li className="arcade-menu__join">
                {isSignedIn ? (
                  <form onSubmit={handleJoin}>
                    <label htmlFor="room-code-home">Join with invite</label>
                    <div>
                      <input
                        autoCapitalize="none"
                        autoComplete="off"
                        id="room-code-home"
                        onChange={(event) => setRoomInput(event.target.value)}
                        placeholder="invite URL or room token"
                        spellCheck={false}
                        value={roomInput}
                      />
                      <button disabled={joining} type="submit">
                        {joining ? "Linking…" : "Join"}
                      </button>
                    </div>
                  </form>
                ) : (
                  <SignInButton
                    fallbackRedirectUrl={returnUrl}
                    forceRedirectUrl={returnUrl}
                    mode="modal"
                  >
                    <button type="button">Join with invite</button>
                  </SignInButton>
                )}
              </li>
              <li>
                <a href="/how-to-play">Read the rules</a>
              </li>
            </ol>
            <p aria-live="polite" className="form-error">
              {joinError}
            </p>
          </div>
        </div>
      </section>
    </main>
  );
}
