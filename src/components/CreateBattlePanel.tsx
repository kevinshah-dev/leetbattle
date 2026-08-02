"use client";

import { useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import {
  ApiError,
  createRoom,
  getProfile,
  type Difficulty,
  type MatchMode,
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

const modes: Array<{
  value: MatchMode;
  label: string;
  description: string;
  marker: string;
}> = [
  {
    value: "DUEL",
    label: "Private battle",
    description: "Invite one rival. The result counts toward your record.",
    marker: "VS",
  },
  {
    value: "PRACTICE",
    label: "Practice mode",
    description: "Solve alone. Clear the hidden suite with no record change.",
    marker: "1P",
  },
];

export function CreateBattlePanel({
  initialMode = "DUEL",
}: {
  initialMode?: MatchMode;
}) {
  const router = useRouter();
  const { isLoaded, isSignedIn } = useUser();
  const [mode, setMode] = useState<MatchMode>(initialMode);
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
      if (!profile) {
        const returnTo =
          mode === "PRACTICE" ? "/battle/new?mode=practice" : "/battle/new";
        router.replace(`/onboarding?returnTo=${encodeURIComponent(returnTo)}`);
      }
    });
  }, [isLoaded, isSignedIn, mode, router]);

  async function handleCreate() {
    setCreating(true);
    setError("");
    try {
      const room = await createRoom(difficulty, mode);
      router.push(`/lobby/${room.roomCode}`);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "PROFILE_REQUIRED") {
        const returnTo =
          mode === "PRACTICE" ? "/battle/new?mode=practice" : "/battle/new";
        router.push(`/onboarding?returnTo=${encodeURIComponent(returnTo)}`);
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
        <p className="eyebrow">
          {mode === "PRACTICE" ? "Solo training run" : "New private room"}
        </p>
        <h1>
          {mode === "PRACTICE"
            ? "Train against the suite."
            : "Choose the terrain."}
        </h1>
        <p>
          {mode === "PRACTICE"
            ? "Pick a difficulty, choose your language, and see whether your solution can clear every hidden test."
            : "You control only the difficulty. The server keeps the problem sealed until both players choose a language and lock in."}
        </p>
        <div
          className="sealed-problem"
          aria-label="Problem selection is sealed"
        >
          <span aria-hidden="true" className="sealed-problem__lock" />
          <div>
            <strong>Problem sealed</strong>
            <small>
              {mode === "PRACTICE"
                ? "Reveals when you start the practice run"
                : "Reveals after both players are ready"}
            </small>
          </div>
        </div>
      </div>
      <PixelPanel className="difficulty-panel" label="CONFIGURE GAME">
        <div aria-label="Game mode" className="mode-options" role="radiogroup">
          {modes.map((option) => (
            <button
              aria-checked={mode === option.value}
              className="mode-option"
              key={option.value}
              onClick={() => setMode(option.value)}
              role="radio"
              type="button"
            >
              <span aria-hidden="true" className="mode-option__marker">
                {option.marker}
              </span>
              <span>
                <strong>{option.label}</strong>
                <small>{option.description}</small>
              </span>
            </button>
          ))}
        </div>
        <p className="config-label">Select difficulty</p>
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
          <StatusLamp
            label={
              mode === "PRACTICE"
                ? "SOLO · RECORD UNCHANGED"
                : "INVITE WILL BE UNLISTED"
            }
            tone="cyan"
          />
          <ArcadeButton
            disabled={creating || !isLoaded || !isSignedIn}
            onClick={handleCreate}
          >
            {creating
              ? mode === "PRACTICE"
                ? "Starting practice…"
                : "Minting room…"
              : mode === "PRACTICE"
                ? "Start practice"
                : "Create battle"}
          </ArcadeButton>
        </div>
        <p aria-live="assertive" className="form-error">
          {error}
        </p>
      </PixelPanel>
    </div>
  );
}
