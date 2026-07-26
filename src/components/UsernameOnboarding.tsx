"use client";

import { useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { FormEvent, useEffect, useMemo, useState } from "react";

import { ApiError, getProfile, saveProfile } from "./api-client";
import { ArcadeButton, PixelPanel } from "./ArcadePrimitives";

const usernamePattern = /^[A-Za-z0-9_]{3,20}$/;

export function UsernameOnboarding({ returnTo }: { returnTo: string }) {
  const router = useRouter();
  const { isLoaded, isSignedIn } = useUser();
  const [username, setUsername] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const isValid = useMemo(() => usernamePattern.test(username), [username]);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      router.replace("/");
      return;
    }
    void getProfile().then(({ profile }) => {
      if (profile) router.replace(returnTo);
    });
  }, [isLoaded, isSignedIn, returnTo, router]);

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!isValid) {
      setError("Use 3–20 letters, digits, or underscores.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      await saveProfile(username);
      router.replace(returnTo);
    } catch (caught) {
      if (
        caught instanceof ApiError &&
        (caught.status === 409 || caught.code === "USERNAME_TAKEN")
      ) {
        setError("That callsign is already taken. Try another.");
      } else {
        setError(
          caught instanceof Error
            ? caught.message
            : "Could not save your callsign.",
        );
      }
      setSaving(false);
    }
  }

  return (
    <div className="onboarding-layout">
      <div className="onboarding-layout__art" aria-hidden="true">
        <span className="callsign-grid" />
        <span className="callsign-cursor">_</span>
      </div>
      <PixelPanel className="onboarding-panel" label="PLAYER REGISTRATION">
        <p className="eyebrow">One-time setup</p>
        <h1>Choose your callsign.</h1>
        <p>
          This is the name your opponent sees in the lobby, battle HUD, and
          match history.
        </p>
        <form onSubmit={handleSubmit}>
          <label htmlFor="username">Unique username</label>
          <div className="input-shell input-shell--large">
            <span aria-hidden="true">PLAYER&gt;</span>
            <input
              aria-describedby="username-help username-error"
              autoCapitalize="none"
              autoComplete="username"
              autoFocus
              id="username"
              maxLength={20}
              onChange={(event) => {
                setUsername(event.target.value);
                setError("");
              }}
              pattern="[A-Za-z0-9_]{3,20}"
              placeholder="circuit_sage"
              spellCheck={false}
              value={username}
            />
            <small>{username.length}/20</small>
          </div>
          <p className="field-help" id="username-help">
            3–20 letters, numbers, or underscores. Names are case-insensitive.
          </p>
          <p aria-live="assertive" className="form-error" id="username-error">
            {error}
          </p>
          <ArcadeButton disabled={saving || !isValid} type="submit">
            {saving ? "Saving…" : "Lock callsign"}
          </ArcadeButton>
        </form>
      </PixelPanel>
    </div>
  );
}
