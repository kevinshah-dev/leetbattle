"use client";

import { useUser } from "@clerk/nextjs";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import {
  ApiError,
  createRoom,
  getProfile,
  type ChallengeType,
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
    description: "Foundational thinking and a quick opening round.",
    ticks: 1,
  },
  {
    value: "MEDIUM",
    label: "Medium",
    description: "Layered reasoning with room for a comeback.",
    ticks: 2,
  },
  {
    value: "HARD",
    label: "Hard",
    description: "Deep tradeoffs. Every minute matters.",
    ticks: 3,
  },
];

const challenges: Array<{
  value: ChallengeType;
  label: string;
  description: string;
  marker: string;
}> = [
  {
    value: "CODING",
    label: "Coding",
    description: "Write code and clear the server's hidden test suite.",
    marker: "</>",
  },
  {
    value: "AI_ML",
    label: "AI/ML Arena",
    description: "Explain an AI or ML concept in a scored prose answer.",
    marker: "AI",
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
    label: "Private Duel",
    description: "Invite one rival. The result counts toward your record.",
    marker: "VS",
  },
  {
    value: "PRACTICE",
    label: "Solo Practice",
    description: "Solve alone. Clear the hidden suite with no record change.",
    marker: "1P",
  },
];

function createReturnTo(mode: MatchMode, challengeType: ChallengeType) {
  const query = new URLSearchParams();
  if (mode === "PRACTICE") query.set("mode", "practice");
  if (challengeType === "AI_ML") query.set("challenge", "ai-ml");
  const suffix = query.toString();
  return suffix ? `/battle/new?${suffix}` : "/battle/new";
}

export function CreateBattlePanel({
  initialMode = "DUEL",
}: {
  initialMode?: MatchMode;
}) {
  const router = useRouter();
  const { isLoaded, isSignedIn } = useUser();
  const [challengeType, setChallengeType] = useState<ChallengeType>("CODING");
  const [mode, setMode] = useState<MatchMode>(initialMode);
  const [difficulty, setDifficulty] = useState<Difficulty>("MEDIUM");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (
      new URLSearchParams(window.location.search).get("challenge") !== "ai-ml"
    )
      return;
    const timer = window.setTimeout(() => setChallengeType("AI_ML"), 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!isLoaded) return;
    if (!isSignedIn) {
      router.replace("/?signIn=1");
      return;
    }
    void getProfile().then(({ profile }) => {
      if (!profile) {
        const returnTo = createReturnTo(mode, challengeType);
        router.replace(`/onboarding?returnTo=${encodeURIComponent(returnTo)}`);
      }
    });
  }, [challengeType, isLoaded, isSignedIn, mode, router]);

  async function handleCreate() {
    setCreating(true);
    setError("");
    try {
      const room = await createRoom({ challengeType, difficulty, mode });
      router.push(`/lobby/${room.roomCode}`);
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === "PROFILE_REQUIRED") {
        const returnTo = createReturnTo(mode, challengeType);
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
          {challengeType === "AI_ML"
            ? "AI/ML Arena"
            : mode === "PRACTICE"
              ? "Solo training run"
              : "New private room"}
        </p>
        <h1>
          {challengeType === "AI_ML"
            ? "Make the strongest case."
            : mode === "PRACTICE"
              ? "Train against the suite."
              : "Choose the terrain."}
        </h1>
        <p>
          {challengeType === "AI_ML"
            ? mode === "PRACTICE"
              ? "Answer one theoretical AI or ML question in 500 words or fewer. The server scores your final answer against a private rubric."
              : "Both players receive the same sealed AI or ML question and ten minutes to submit one final answer."
            : mode === "PRACTICE"
              ? "Pick a difficulty, choose your language, and see whether your solution can clear every hidden test."
              : "You control only the difficulty. The server keeps the problem sealed until both players choose a language and lock in."}
        </p>
        <div
          className="sealed-problem"
          aria-label={`${challengeType === "AI_ML" ? "Question" : "Problem"} selection is sealed`}
        >
          <span aria-hidden="true" className="sealed-problem__lock" />
          <div>
            <strong>
              {challengeType === "AI_ML" ? "Question sealed" : "Problem sealed"}
            </strong>
            <small>
              {mode === "PRACTICE"
                ? `Reveals when you start the ${challengeType === "AI_ML" ? "arena run" : "practice run"}`
                : `Reveals after both players are ready`}
            </small>
          </div>
        </div>
      </div>
      <PixelPanel className="difficulty-panel" label="CONFIGURE GAME">
        <p className="config-label">Select challenge</p>
        <div
          aria-label="Challenge"
          className="mode-options challenge-options"
          role="radiogroup"
        >
          {challenges.map((option) => (
            <button
              aria-checked={challengeType === option.value}
              className="mode-option"
              key={option.value}
              onClick={() => setChallengeType(option.value)}
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
        <p className="config-label">Select mode</p>
        <div aria-label="Game mode" className="mode-options" role="radiogroup">
          {modes.map((option) => (
            <button
              aria-checked={mode === option.value}
              aria-label={
                option.value === "PRACTICE"
                  ? "Practice mode — Solo Practice"
                  : "Private Duel"
              }
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
                <small>
                  {challengeType === "AI_ML" && option.value === "PRACTICE"
                    ? "Answer alone for a rubric score with no record change."
                    : option.description}
                </small>
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
                ? challengeType === "AI_ML"
                  ? "SOLO SCORE · RECORD UNCHANGED"
                  : "SOLO · RECORD UNCHANGED"
                : challengeType === "AI_ML"
                  ? "PRIVATE ARENA · RECORD COUNTS"
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
                ? challengeType === "AI_ML"
                  ? "Start arena practice"
                  : "Start practice"
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
