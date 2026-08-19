"use client";

import { SignInButton, useUser } from "@clerk/nextjs";
import { Fragment, useEffect, useRef, useState } from "react";

import {
  ApiError,
  getHistory,
  getHistoryDetail,
  type MatchHistoryDetail,
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
  if (match.outcome === "COMPLETED") return "Scored";
  return match.outcome[0] + match.outcome.slice(1).toLowerCase();
}

function challengeLabel(match: Pick<MatchHistoryItem, "challengeType">) {
  return match.challengeType === "AI_ML" ? "AI/ML Arena" : "Coding";
}

function HistoryDetailPanel({
  detail,
  onClose,
}: {
  detail: MatchHistoryDetail;
  onClose: () => void;
}) {
  const arena = detail.aiMl;
  return (
    <section
      aria-labelledby={`history-detail-title-${detail.id}`}
      className="history-detail"
      id={`history-detail-${detail.id}`}
    >
      <header className="history-detail__header">
        <div>
          <p className="eyebrow">
            {challengeLabel(detail)} ·{" "}
            {detail.mode === "PRACTICE" ? "Solo practice" : "Private duel"}
          </p>
          <h2 id={`history-detail-title-${detail.id}`}>
            {detail.problemTitle}
          </h2>
        </div>
        <button onClick={onClose} type="button">
          Close details
        </button>
      </header>

      {arena ? (
        <>
          <section aria-label="Question" className="history-detail__question">
            <div>
              <span>{arena.question.category}</span>
              <span
                className={`difficulty-tag difficulty-tag--${arena.question.difficulty.toLowerCase()}`}
              >
                {arena.question.difficulty}
              </span>
            </div>
            <p>{arena.question.prompt}</p>
          </section>

          <section
            aria-label="Official scores"
            className="arena-scoreboard history-detail__scores"
          >
            {arena.answers.map((answer) => (
              <article
                className={
                  arena.winnerUsername === answer.username
                    ? "arena-score--winner"
                    : ""
                }
                key={answer.username}
              >
                <span>{answer.username}</span>
                <strong className="tabular">
                  {answer.score === null ? "—" : answer.score}
                </strong>
                <small>
                  {answer.score === null ? "Not scored" : "out of 100"}
                </small>
              </article>
            ))}
          </section>

          {(arena.explanation ||
            detail.mode === "DUEL" ||
            arena.automaticBlank) && (
            <section
              aria-label={
                detail.mode === "PRACTICE" ? "Feedback" : "Judge explanation"
              }
              className="arena-explanation history-detail__explanation"
            >
              <h3>
                {detail.mode === "PRACTICE" ? "Feedback" : "Judge explanation"}
              </h3>
              {arena.explanation && <p>{arena.explanation}</p>}
              {arena.tieBreakReason && arena.tieBreakReason !== "none" && (
                <small>
                  Tie-break applied: {arena.tieBreakReason.replaceAll("_", " ")}
                  .
                </small>
              )}
              {detail.mode === "DUEL" &&
                (!arena.tieBreakReason || arena.tieBreakReason === "none") && (
                  <small>No tie-break was applied.</small>
                )}
              {arena.automaticBlank && (
                <small>The automatic blank-answer rule was applied.</small>
              )}
            </section>
          )}

          <section
            aria-label="Stored answers"
            className="arena-result-answers history-detail__answers"
          >
            {arena.answers.map((answer) => (
              <article key={answer.username}>
                <header>
                  <strong>{answer.username}</strong>
                  <span className="tabular">
                    {answer.score === null
                      ? "Not scored"
                      : `${answer.score}/100`}
                  </span>
                </header>
                <pre>{answer.answer || "No answer submitted."}</pre>
              </article>
            ))}
          </section>
        </>
      ) : (
        <div className="history-detail__coding">
          <p>
            This coding result stores the outcome and round metadata. Player
            source code is not retained in match history.
          </p>
        </div>
      )}
    </section>
  );
}

export function HistoryView() {
  const { isLoaded, isSignedIn } = useUser();
  const [profile, setProfile] = useState<PlayerProfile | null>(null);
  const [matches, setMatches] = useState<MatchHistoryItem[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [detail, setDetail] = useState<MatchHistoryDetail | null>(null);
  const [detailLoadingId, setDetailLoadingId] = useState<string | null>(null);
  const [detailError, setDetailError] = useState("");
  const detailController = useRef<AbortController | null>(null);
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

  useEffect(
    () => () => {
      detailController.current?.abort();
    },
    [],
  );

  async function openDetail(matchId: string) {
    if (detail?.id === matchId) {
      setDetail(null);
      setDetailError("");
      return;
    }
    detailController.current?.abort();
    const controller = new AbortController();
    detailController.current = controller;
    setDetail(null);
    setDetailLoadingId(matchId);
    setDetailError("");
    try {
      const response = await getHistoryDetail(matchId, controller.signal);
      if (!controller.signal.aborted) setDetail(response.match);
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError")
        return;
      setDetailError(
        caught instanceof ApiError
          ? caught.message
          : "Could not load the authorized match details.",
      );
    } finally {
      if (detailController.current === controller) {
        detailController.current = null;
        setDetailLoadingId(null);
      }
    }
  }

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
          Practice, draws, and no-contests do not change this record. Forfeit
          losses do.
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
              without storing source code. AI/ML answers remain available only
              to round participants.
            </p>
          </div>
        ) : (
          <div className="history-table-wrap">
            <table className="history-table">
              <thead>
                <tr>
                  <th>Result</th>
                  <th>Opponent / challenge</th>
                  <th>Setup</th>
                  <th>Score / duration</th>
                  <th>Played</th>
                  <th>
                    <span className="sr-only">Details</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {matches.map((match) => (
                  <Fragment key={match.id}>
                    <tr>
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
                        <strong>
                          {match.mode === "PRACTICE"
                            ? "Solo practice"
                            : match.opponentUsername || "Private rival"}
                        </strong>
                        <small>{match.problemTitle}</small>
                      </td>
                      <td>
                        <span
                          className={`difficulty-tag difficulty-tag--${match.difficulty.toLowerCase()}`}
                        >
                          {match.difficulty}
                        </span>
                        <small>
                          {challengeLabel(match)} ·{" "}
                          {match.mode === "PRACTICE" ? "Practice" : "Duel"}
                          {match.language
                            ? ` · ${match.language === "PYTHON" ? "Python" : "Java"}`
                            : ""}
                        </small>
                      </td>
                      <td className="tabular">
                        {typeof match.score === "number" && (
                          <strong>{match.score}/100</strong>
                        )}
                        <small>{formatDuration(match.durationMs)}</small>
                      </td>
                      <td>
                        <time dateTime={match.playedAt}>
                          {formatDate(match.playedAt)}
                        </time>
                      </td>
                      <td className="history-table__action">
                        <button
                          aria-controls={`history-detail-${match.id}`}
                          aria-expanded={detail?.id === match.id}
                          disabled={detailLoadingId !== null}
                          onClick={() => void openDetail(match.id)}
                          type="button"
                        >
                          {detailLoadingId === match.id
                            ? "Loading…"
                            : detail?.id === match.id
                              ? "Hide"
                              : "View"}
                        </button>
                      </td>
                    </tr>
                    {detail?.id === match.id && (
                      <tr className="history-table__detail-row">
                        <td colSpan={6}>
                          <HistoryDetailPanel
                            detail={detail}
                            onClose={() => setDetail(null)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p aria-live="assertive" className="history-detail-error">
          {detailError}
        </p>
      </section>
    </div>
  );
}
