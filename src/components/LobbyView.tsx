"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";

import {
  ApiError,
  sendRoomCommand,
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
  player,
  self = false,
}: {
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
                ? "Loadout locked"
                : "Choosing loadout"
              : "Share the invite to fill this seat"}
          </small>
        </div>
      </div>
      <dl>
        <div>
          <dt>Language</dt>
          <dd>
            {player?.language === "PYTHON"
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
      <RoomLoading label="Opening the pre-fight lobby…" />
    );
  if (error) return <RoomError message={error} />;
  const currentSnapshot = snapshot;

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
        "Cancel this private room? The invite will close for both players.",
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
          <span>ROOM</span>
          <strong>{snapshot.roomCode}</strong>
        </div>
        <div className="room-toolbar__invite">
          <label htmlFor="invite-url">Private invite</label>
          <input id="invite-url" readOnly value={inviteUrl} />
          <button onClick={copyInvite} type="button">
            {copied ? "Copied" : "Copy invite"}
          </button>
        </div>
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
        centerLabel="STANDBY"
        opponent={snapshot.opponent}
        self={snapshot.self}
        state={snapshot.state}
        timer="--:--"
      />

      <div className="lobby-content">
        <section className="lobby-roster" aria-label="Players">
          <PlayerSlot player={snapshot.self} self />
          <div className="versus-divider" aria-hidden="true">
            <span>VS</span>
          </div>
          <PlayerSlot player={snapshot.opponent} />
        </section>

        <PixelPanel className="loadout-panel" label="YOUR LOADOUT">
          <div className="loadout-panel__header">
            <div>
              <p className="eyebrow">Difficulty locked</p>
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
          <fieldset disabled={pending || snapshot.self.ready}>
            <legend>Choose a language</legend>
            <div className="language-switch">
              {(["PYTHON", "JAVA"] as Language[]).map((language) => (
                <button
                  aria-pressed={snapshot.self.language === language}
                  key={language}
                  onClick={() => void command("SELECT_LANGUAGE", { language })}
                  type="button"
                >
                  <span
                    aria-hidden="true"
                    className={`language-glyph language-glyph--${language.toLowerCase()}`}
                  >
                    {language === "PYTHON" ? "py" : "{}"}
                  </span>
                  <span>
                    <strong>{language === "PYTHON" ? "Python" : "Java"}</strong>
                    <small>
                      {language === "PYTHON" ? "Python 3" : "Java LTS"}
                    </small>
                  </span>
                </button>
              ))}
            </div>
          </fieldset>
          <div className="ready-row">
            <div>
              <StatusLamp
                label={
                  snapshot.opponent?.ready
                    ? "RIVAL READY"
                    : snapshot.opponent
                      ? "RIVAL CHOOSING"
                      : "WAITING FOR RIVAL"
                }
                tone={snapshot.opponent?.ready ? "cyan" : "dim"}
              />
              <p>
                The server selects and seals one problem after both players lock
                in.
              </p>
            </div>
            <ArcadeButton
              disabled={
                pending || !snapshot.self.language || realtime !== "LIVE"
              }
              onClick={() =>
                void command("SET_READY", { ready: !snapshot.self.ready })
              }
              tone={snapshot.self.ready ? "ghost" : "gold"}
            >
              {realtime !== "LIVE"
                ? "Linking live session…"
                : snapshot.self.ready
                  ? "Unlock loadout"
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
            Cancel room
          </ArcadeButton>
        ) : (
          <ArcadeLink href="/" tone="ghost">
            Return home
          </ArcadeLink>
        )}
        <p>
          <kbd>Tab</kbd> moves controls <span /> Both players choose
          independently
        </p>
      </footer>
    </main>
  );
}
