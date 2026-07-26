"use client";

import { SignInButton, useUser } from "@clerk/nextjs";
import { useEffect, useState } from "react";

import {
  ApiError,
  getHistory,
  type MatchHistoryItem,
  type PlayerProfile,
} from "./api-client";
import { ArcadeLink, PixelPanel, StatusLamp } from "./ArcadePrimitives";

function formatDuration(durationMs: number) {
  const totalSeconds = Math.max(0, Math.round(durationMs / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  return `${minutes}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(new Date(value));
}

function outcomeLabel(match: MatchHistoryItem) {
  if (match.outcome === "NO_CONTEST") return "No contest";
  return match.outcome[0] + match.outcome.slice(1).toLowerCase();
}

export function HistoryView() {
  const { isLoaded, isSignedIn } = useUser();
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [matches, setMatches] = useState<MatchHistoryItem[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const returnUrl =
    typeof window === "undefined" ? "/history" : window.location.href;

  useEffect(() => {
    if (!isLoaded || !isSignedIn) return;
    const controller = new AbortController();
    void getHistory(controller.signal)
      .then((response) => {
        setProfile(response.profile);
        setMatches(response.matches);
        setLoading(false);
      })
      .catch((caught: unknown) => {
        if (caught instanceof DOMException && caught.name === "AbortError")
          return;
        setError(
          caught instanceof ApiError
            ? caught.message
            : "Could not load your match log.",
        );
        setLoading(false);
      });
    return () => controller.abort();
  }, [isLoaded, isSignedIn]);

  if (!isLoaded) {
    return (
      <div className="history-loading" aria-live="polite">
        <span className="pixel-loader" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
        <p>Reading match memory…</p>
      </div>
    );
  }

  if (!isSignedIn) {
    return (
      <PixelPanel className="history-signin" label="MATCH MEMORY LOCKED">
        <h1>Sign in to read your history.</h1>
        <p>
          Your record and recent private matches are attached to your account.
        </p>
        <SignInButton
          fallbackRedirectUrl={returnUrl}
          forceRedirectUrl={returnUrl}
          mode="modal"
        >
          <button className="arcade-button arcade-button--gold" type="button">
            <span>Sign in</span>
          </button>
        </SignInButton>
      </PixelPanel>
    );
  }

  if (loading) {
    return (
      <div className="history-loading" aria-live="polite">
        <span className="pixel-loader" aria-hidden="true">
          <i />
          <i />
          <i />
          <i />
          <i />
        </span>
        <p>Reading match memory…</p>
      </div>
    );
  }

  if (error || !profile) {
    return (
      <PixelPanel className="history-signin" label="READ ERROR">
        <h1>Match memory unavailable.</h1>
        <p>{error || "Finish setting your callsign before opening history."}</p>
        <ArcadeLink href="/onboarding?returnTo=%2Fhistory">Continue</ArcadeLink>
      </PixelPanel>
    );
  }

  return (
    <div className="history-layout">
      <aside className="profile-sidebar">
        <p className="eyebrow">Player record</p>
        <div className="profile-avatar" aria-hidden="true">
          <span />
          <i />
        </div>
        <h1>{profile.username}</h1>
        <StatusLamp label="PROFILE ACTIVE" tone="cyan" />
        <dl className="record-blocks">
          <div>
            <dt>Wins</dt>
            <dd>{profile.wins}</dd>
          </div>
          <div>
            <dt>Losses</dt>
            <dd>{profile.losses}</dd>
          </div>
        </dl>
        <p className="profile-sidebar__note">
          Draws and no-contests do not change this record. Forfeit losses do.
        </p>
        <ArcadeLink href="/battle/new">Create battle</ArcadeLink>
      </aside>
      <section className="match-log">
        <header>
          <div>
            <p className="eyebrow">Local archive</p>
            <h2>Recent matches</h2>
          </div>
          <span>{matches.length} shown</span>
        </header>
        {matches.length === 0 ? (
          <div className="empty-log">
            <span aria-hidden="true" className="empty-log__trace" />
            <h3>No rounds recorded yet.</h3>
            <p>
              Create a private battle. Completed matches will appear here
              without storing either player’s source code.
            </p>
          </div>
        ) : (
          <div className="history-table-wrap">
            <table className="history-table">
              <thead>
                <tr>
                  <th>Result</th>
                  <th>Opponent / problem</th>
                  <th>Loadout</th>
                  <th>Duration</th>
                  <th>Played</th>
                </tr>
              </thead>
              <tbody>
                {matches.map((match) => (
                  <tr key={match.id}>
                    <td>
                      <span
                        className={`outcome outcome--${match.outcome.toLowerCase().replace("_", "-")}`}
                      >
                        {outcomeLabel(match)}
                      </span>
                      <small>
                        {match.endReason.replaceAll("_", " ").toLowerCase()}
                      </small>
                    </td>
                    <td>
                      <strong>{match.opponentUsername}</strong>
                      <small>{match.problemTitle}</small>
                    </td>
                    <td>
                      <span
                        className={`difficulty-tag difficulty-tag--${match.difficulty.toLowerCase()}`}
                      >
                        {match.difficulty}
                      </span>
                      <small>
                        {match.language === "PYTHON" ? "Python" : "Java"}
                      </small>
                    </td>
                    <td className="tabular">
                      {formatDuration(match.durationMs)}
                    </td>
                    <td>
                      <time dateTime={match.playedAt}>
                        {formatDate(match.playedAt)}
                      </time>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
