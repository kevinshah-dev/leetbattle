"use client";

import { useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import {
  ApiError,
  createRoom,
  getProfile,
  type Difficulty,
} from "./api-client";
import { ArcadeButton, PixelPanel, StatusLamp } from "./ArcadePrimitives";

const difficulties: Array<{
  value: Difficulty;
  label: string;
  description: string;
  ticks: number;
}> = [
  {
    value: "EASY",
    label: "Easy",
    description: "Clean fundamentals and a quick opening round.",
    ticks: 1,
  },
  {
    value: "MEDIUM",
    label: "Medium",
    description: "Layered logic with room for a comeback.",
    ticks: 2,
  },
  {
    value: "HARD",
    label: "Hard",
    description: "Deep constraints. Every minute matters.",
    ticks: 3,
  },
];

export function CreateBattlePanel() {
  const router = useRouter();
  const { isLoaded, isSignedIn } = useUser();
  const [difficulty, setDifficulty] = useState<Difficulty>("MEDIUM");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      router.replace("/?signIn=1");
      return;
    }
    void getProfile().then(({ profile }) => {
      if (!profile) router.replace("/onboarding?returnTo=%2Fbattle%2Fnew");
    });
  }, [isLoaded, isSignedIn, router]);

  async function handleCreate() {
    setCreating(true);
    setError("");
    try {
      const room = await createRoom(difficulty);
      router.push(`/lobby/${room.roomCode}`);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "PROFILE_REQUIRED") {
        router.push("/onboarding?returnTo=%2Fbattle%2Fnew");
        return;
      }
      setError(
        caught instanceof Error
          ? caught.message
          : "The room could not be created.",
      );
      setCreating(false);
    }
  }

  return (
    <div className="create-layout">
      <div className="create-layout__intro">
        <p className="eyebrow">New private room</p>
        <h1>Choose the terrain.</h1>
        <p>
          You control only the difficulty. The server keeps the problem sealed
          until both players choose a language and lock in.
        </p>
        <div
          className="sealed-problem"
          aria-label="Problem selection is sealed"
        >
          <span aria-hidden="true" className="sealed-problem__lock" />
          <div>
            <strong>Problem sealed</strong>
            <small>Reveals after both players are ready</small>
          </div>
        </div>
      </div>
      <PixelPanel className="difficulty-panel" label="SELECT DIFFICULTY">
        <div
          className="difficulty-options"
          role="radiogroup"
          aria-label="Difficulty"
        >
          {difficulties.map((option) => (
            <button
              aria-checked={difficulty === option.value}
              className="difficulty-option"
              key={option.value}
              onClick={() => setDifficulty(option.value)}
              role="radio"
              type="button"
            >
              <span className="difficulty-option__cursor" aria-hidden="true">
                ›
              </span>
              <span className="difficulty-option__copy">
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
              <span
                aria-label={`${option.ticks} of 3 difficulty`}
                className="difficulty-pips"
              >
                {[1, 2, 3].map((tick) => (
                  <i
                    className={tick <= option.ticks ? "is-on" : ""}
                    key={tick}
                  />
                ))}
              </span>
            </button>
          ))}
        </div>
        <div className="difficulty-panel__footer">
          <StatusLamp label="INVITE WILL BE UNLISTED" tone="cyan" />
          <ArcadeButton
            disabled={creating || !isLoaded || !isSignedIn}
            onClick={handleCreate}
          >
            {creating ? "Minting room…" : "Create battle"}
          </ArcadeButton>
        </div>
        <p aria-live="assertive" className="form-error">
          {error}
        </p>
      </PixelPanel>
    </div>
  );
}
