"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import {
  ApiError,
  sendRoomCommand,
  type ChallengeType,
  type Language,
  type PlayerHud,
} from "./api-client";
import {
  ArcadeButton,
  ArcadeLink,
  PixelPanel,
  StatusLamp,
} from "./ArcadePrimitives";
import { BattleStrip } from "./BattleStrip";
import { RoomError, RoomLoading } from "./RoomState";
import { useRoomSession } from "./useRoomSession";

function PlayerSlot({
  challengeType,
  player,
  self = false,
}: {
  challengeType: ChallengeType;
  player: PlayerHud | null;
  self?: boolean;
}) {
  return (
    <div
      className={`lobby-player${self ? " lobby-player--self" : ""}${!player ? " lobby-player--empty" : ""}`}
    >
      <div className="lobby-player__top">
        <span>
          {self
            ? `${player?.role === "HOST" ? "HOST" : "CHALLENGER"} / YOU`
            : player?.role === "HOST"
              ? "HOST"
              : "CHALLENGER"}
        </span>
        <StatusLamp
          label={
            player?.connected
              ? "CONNECTED"
              : player
                ? "RECONNECTING"
                : "WAITING"
          }
          tone={player?.connected ? "cyan" : "dim"}
        />
      </div>
      <div className="lobby-player__identity">
        <span aria-hidden="true" className="lobby-avatar">
          <i />
        </span>
        <div>
          <strong>{player?.username || "Open slot"}</strong>
          <small>
            {player
              ? player.ready
                ? challengeType === "AI_ML"
                  ? "Ready for question reveal"
                  : "Loadout locked"
                : challengeType === "AI_ML"
                  ? "Reviewing arena rules"
                  : "Choosing loadout"
              : "Share the invite to fill this seat"}
          </small>
        </div>
      </div>
      <dl>
        <div>
          <dt>{challengeType === "AI_ML" ? "Challenge" : "Language"}</dt>
          <dd>
            {challengeType === "AI_ML"
              ? "AI/ML Arena"
              : player?.language === "PYTHON"
                ? "Python"
                : player?.language === "JAVA"
                  ? "Java"
                  : "Not selected"}
          </dd>
        </div>
        <div>
          <dt>Ready</dt>
          <dd>{player?.ready ? "Yes" : "No"}</dd>
        </div>
      </dl>
    </div>
  );
}

function PracticeObjective({ aiMl }: { aiMl: boolean }) {
  return (
    <div className="practice-objective">
      <p className="eyebrow">Solo objective</p>
      <div aria-hidden="true" className="practice-objective__target">
        <i />
        <i />
        <span>&gt;_</span>
      </div>
      <h2>{aiMl ? "Build a complete answer." : "Clear the hidden suite."}</h2>
      <p>
        {aiMl
          ? "There is no rival. Submit one final prose answer and receive a score against the same private rubric used in duels."
          : "There is no race against a rival. Submit when your solution is ready; every hidden test must pass."}
      </p>
      <small>Wins and losses stay unchanged.</small>
    </div>
  );
}

export function LobbyView({ roomCode }: { roomCode: string }) {
  const router = useRouter();
  const { snapshot, error, loading, realtime, refresh, applySnapshot } =
    useRoomSession(roomCode);
  const [pending, setPending] = useState(false);
  const [actionError, setActionError] = useState("");
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (snapshot && snapshot.state !== "LOBBY")
      router.replace(`/battle/${snapshot.roomCode}`);
  }, [router, snapshot]);

  const inviteUrl = useMemo(() => {
    if (snapshot?.inviteUrl) return snapshot.inviteUrl;
    if (typeof window === "undefined") return `/join/${roomCode}`;
    return `${window.location.origin}/join/${roomCode}`;
  }, [roomCode, snapshot?.inviteUrl]);

  if (loading || !snapshot)
    return error ? (
      <RoomError message={error} />
    ) : (
      <RoomLoading label="Opening your game lobby…" />
    );
  if (error) return <RoomError message={error} />;
  const currentSnapshot = snapshot;
  const practice = snapshot.mode === "PRACTICE";
  const aiMl = snapshot.challengeType === "AI_ML";

  async function command(
    type: "SELECT_LANGUAGE" | "SET_READY",
    payload: { language: Language } | { ready: boolean },
  ) {
    setPending(true);
    setActionError("");
    try {
      const response = await sendRoomCommand(
        roomCode,
        currentSnapshot.matchId,
        currentSnapshot.version,
        { type, payload } as Parameters<typeof sendRoomCommand>[3],
      );
      if (response.snapshot) applySnapshot(response.snapshot);
      else await refresh();
    } catch (caught) {
      setActionError(
        caught instanceof ApiError
          ? caught.message
          : "The server did not accept that lobby action.",
      );
    } finally {
      setPending(false);
    }
  }

  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setActionError(
        "Copy was blocked. Select the invite URL and copy it manually.",
      );
    }
  }

  async function cancelRoom() {
    if (
      !window.confirm(
        practice
          ? "Cancel this practice session?"
          : "Cancel this private room? The invite will close for both players.",
      )
    )
      return;
    setPending(true);
    setActionError("");
    try {
      const response = await sendRoomCommand(
        roomCode,
        currentSnapshot.matchId,
        currentSnapshot.version,
        { type: "CANCEL", payload: {} },
      );
      if (response.snapshot) applySnapshot(response.snapshot);
      else await refresh();
    } catch (caught) {
      setActionError(
        caught instanceof ApiError
          ? caught.message
          : "The room could not be cancelled.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="lobby-page" id="main-content">
      <header className="room-toolbar">
        <div>
          <span>{practice ? "MODE" : "ROOM"}</span>
          <strong>{practice ? "PRACTICE" : snapshot.roomCode}</strong>
        </div>
        <span className="room-toolbar__challenge">
          {aiMl ? "AI/ML ARENA" : "CODING"}
        </span>
        {practice ? (
          <div className="room-toolbar__practice">
            <span>SOLO SESSION</span>
            <strong>NO OPPONENT · NO RECORD CHANGE</strong>
          </div>
        ) : (
          <div className="room-toolbar__invite">
            <label htmlFor="invite-url">Private invite</label>
            <input id="invite-url" readOnly value={inviteUrl} />
            <button onClick={copyInvite} type="button">
              {copied ? "Copied" : "Copy invite"}
            </button>
          </div>
        )}
        <StatusLamp
          label={
            realtime === "LIVE"
              ? "LIVE LINK"
              : realtime === "CONNECTING"
                ? "CONNECTING"
                : "SYNCING"
          }
          tone={realtime === "LIVE" ? "cyan" : "gold"}
        />
      </header>

      <BattleStrip
        challengeType={snapshot.challengeType}
        centerLabel={practice ? "SOLO" : "STANDBY"}
        mode={snapshot.mode}
        opponent={snapshot.opponent}
        self={snapshot.self}
        state={snapshot.state}
        timer="--:--"
      />

      <div className="lobby-content">
        <section
          className={`lobby-roster${practice ? " lobby-roster--practice" : ""}`}
          aria-label={practice ? "Practice setup" : "Players"}
        >
          <PlayerSlot
            challengeType={snapshot.challengeType}
            player={snapshot.self}
            self
          />
          {practice ? (
            <PracticeObjective aiMl={aiMl} />
          ) : (
            <>
              <div className="versus-divider" aria-hidden="true">
                <span>VS</span>
              </div>
              <PlayerSlot
                challengeType={snapshot.challengeType}
                player={snapshot.opponent}
              />
            </>
          )}
        </section>

        <PixelPanel
          className="loadout-panel"
          label={
            aiMl
              ? practice
                ? "ARENA PRACTICE"
                : "ARENA CHECK-IN"
              : practice
                ? "PRACTICE LOADOUT"
                : "YOUR LOADOUT"
          }
        >
          <div className="loadout-panel__header">
            <div>
              <p className="eyebrow">
                {aiMl ? "AI/ML Arena · difficulty locked" : "Difficulty locked"}
              </p>
              <h1>
                {snapshot.difficulty[0] +
                  snapshot.difficulty.slice(1).toLowerCase()}
              </h1>
            </div>
            <span
              className={`difficulty-badge difficulty-badge--${snapshot.difficulty.toLowerCase()}`}
            >
              {snapshot.difficulty}
            </span>
          </div>
          {aiMl ? (
            <div aria-label="AI/ML Arena rules" className="arena-briefing">
              <div>
                <strong>10:00</strong>
                <span>Server-timed round</span>
              </div>
              <div>
                <strong>500</strong>
                <span>Maximum words</span>
              </div>
              <div>
                <strong>1×</strong>
                <span>Immutable final answer</span>
              </div>
            </div>
          ) : (
            <fieldset disabled={pending || snapshot.self.ready}>
              <legend>Choose a language</legend>
              <div className="language-switch">
                {(["PYTHON", "JAVA"] as Language[]).map((language) => (
                  <button
                    aria-pressed={snapshot.self.language === language}
                    key={language}
                    onClick={() =>
                      void command("SELECT_LANGUAGE", { language })
                    }
                    type="button"
                  >
                    <span
                      aria-hidden="true"
                      className={`language-glyph language-glyph--${language.toLowerCase()}`}
                    >
                      {language === "PYTHON" ? "py" : "{}"}
                    </span>
                    <span>
                      <strong>
                        {language === "PYTHON" ? "Python" : "Java"}
                      </strong>
                      <small>
                        {language === "PYTHON" ? "Python 3" : "Java LTS"}
                      </small>
                    </span>
                  </button>
                ))}
              </div>
            </fieldset>
          )}
          <div className="ready-row">
            <div>
              <StatusLamp
                label={
                  practice
                    ? realtime === "LIVE"
                      ? "SOLO LINK READY"
                      : "LINKING SESSION"
                    : snapshot.opponent?.ready
                      ? "RIVAL READY"
                      : snapshot.opponent
                        ? "RIVAL CHOOSING"
                        : "WAITING FOR RIVAL"
                }
                tone={
                  practice
                    ? realtime === "LIVE"
                      ? "cyan"
                      : "dim"
                    : snapshot.opponent?.ready
                      ? "cyan"
                      : "dim"
                }
              />
              <p>
                {aiMl
                  ? practice
                    ? "The server reveals one sealed question when you start."
                    : "The question remains sealed until both players are ready."
                  : practice
                    ? "The server selects and seals one problem when you start."
                    : "The server selects and seals one problem after both players lock in."}
              </p>
            </div>
            <ArcadeButton
              disabled={
                pending ||
                (!aiMl && !snapshot.self.language) ||
                realtime !== "LIVE"
              }
              onClick={() =>
                void command("SET_READY", { ready: !snapshot.self.ready })
              }
              tone={snapshot.self.ready ? "ghost" : "gold"}
            >
              {realtime !== "LIVE"
                ? "Linking live session…"
                : snapshot.self.ready
                  ? aiMl
                    ? "Cancel ready"
                    : "Unlock loadout"
                  : practice
                    ? aiMl
                      ? "Start arena"
                      : "Start practice"
                    : "Ready up"}
            </ArcadeButton>
          </div>
          <p aria-live="assertive" className="form-error">
            {actionError}
          </p>
        </PixelPanel>
      </div>
      <footer className="lobby-footer">
        {snapshot.self.role === "HOST" ? (
          <ArcadeButton
            disabled={pending}
            onClick={() => void cancelRoom()}
            tone="ghost"
          >
            {practice ? "Cancel practice" : "Cancel room"}
          </ArcadeButton>
        ) : (
          <ArcadeLink href="/" tone="ghost">
            Return home
          </ArcadeLink>
        )}
        <p>
          <kbd>Tab</kbd> moves controls <span />
          {practice
            ? " Practice does not change your record"
            : aiMl
              ? " Answers stay private until the result"
              : " Both players choose independently"}
        </p>
      </footer>
    </main>
  );
}
