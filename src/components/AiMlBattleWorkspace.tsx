"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";

import { AI_ML_ANSWER_LIMITS, measureAiMlAnswer } from "@/shared/ai-ml-answer";

import {
  ApiError,
  sendRoomCommand,
  type AiMlResult,
  type PublicAiMlQuestion,
  type RoomSnapshot,
} from "./api-client";
import { ArcadeButton, ArcadeLink, StatusLamp } from "./ArcadePrimitives";
import { BattleStrip } from "./BattleStrip";
import { BrandMark } from "./BrandMark";
import { ClerkAuthControls } from "./ClerkAuthControls";
import { RoomLoading } from "./RoomState";
import { usePersistentDraft } from "./usePersistentDraft";

function useAuthoritativeNow(serverOffsetMs: number) {
  const [localNow, setLocalNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setLocalNow(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, []);
  return localNow + serverOffsetMs;
}

function formatClock(ms: number) {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function ArenaCountdown({
  now,
  startsAt,
}: {
  now: number;
  startsAt: string | null;
}) {
  const remaining = startsAt ? Date.parse(startsAt) - now : 3_000;
  const count = Math.ceil(remaining / 1000);
  const label = count > 0 ? String(Math.min(3, count)) : "THINK!";
  return (
    <div
      aria-live="assertive"
      className={`countdown-overlay${label === "THINK!" ? " countdown-overlay--fight" : ""}`}
      role="status"
    >
      <div aria-hidden="true" className="countdown-overlay__rays">
        <i />
        <i />
        <i />
        <i />
      </div>
      <p>Question reveal armed</p>
      <strong key={label}>{label}</strong>
      <small>
        {label === "THINK!"
          ? "Synchronizing the ten-minute clock…"
          : "Answers stay sealed until the result"}
      </small>
    </div>
  );
}

function ArenaQuestionPane({ question }: { question: PublicAiMlQuestion }) {
  return (
    <section aria-label="AI/ML question" className="arena-question-pane">
      <header className="arena-question-pane__header">
        <span>QUESTION</span>
        <span
          className={`difficulty-tag difficulty-tag--${question.difficulty.toLowerCase()}`}
        >
          {question.difficulty}
        </span>
      </header>
      <article className="arena-question-pane__scroll">
        <p className="problem-copy__id">{question.category}</p>
        <h1>{question.title}</h1>
        <div className="arena-question-pane__prompt">
          {question.prompt.split(/\n\n+/u).map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
        </div>
        <aside aria-label="Answer constraints" className="arena-constraints">
          <strong>Answer constraints</strong>
          <dl>
            <div>
              <dt>Words</dt>
              <dd>Up to {question.answerConstraints.maxWords}</dd>
            </div>
            <div>
              <dt>Format</dt>
              <dd>Plain text prose</dd>
            </div>
            <div>
              <dt>Submission</dt>
              <dd>One immutable final answer</dd>
            </div>
          </dl>
        </aside>
      </article>
    </section>
  );
}

function limitMessage(
  measurement: ReturnType<typeof measureAiMlAnswer>,
  question: PublicAiMlQuestion,
) {
  if (measurement.violations.includes("TOO_MANY_WORDS"))
    return `Reduce the answer to ${question.answerConstraints.maxWords} words or fewer.`;
  if (measurement.violations.includes("TOO_MANY_CHARACTERS"))
    return `Reduce the answer to ${question.answerConstraints.maxCharacters.toLocaleString()} characters or fewer.`;
  if (measurement.violations.includes("TOO_MANY_UTF8_BYTES"))
    return `Reduce the answer to ${question.answerConstraints.maxUtf8Bytes.toLocaleString()} UTF-8 bytes or fewer.`;
  return "";
}

function ArenaActivityFeed({ snapshot }: { snapshot: RoomSnapshot }) {
  const items = snapshot.activity.slice(-5).reverse();
  return (
    <div className="arena-activity">
      <header>
        <span>ACTIVITY</span>
        <small>latest first</small>
      </header>
      <ol aria-live="polite">
        {items.length === 0 ? (
          <li className="activity-feed__empty">The arena is ready.</li>
        ) : (
          items.map((item) => (
            <li
              className={`activity-feed__item activity-feed__item--${item.tone.toLowerCase()}`}
              key={item.id}
            >
              <time dateTime={item.serverTimestamp}>
                {new Date(item.serverTimestamp).toLocaleTimeString([], {
                  minute: "2-digit",
                  second: "2-digit",
                })}
              </time>
              <span>{item.message}</span>
            </li>
          ))
        )}
      </ol>
    </div>
  );
}

function ArenaStatusPanel({
  onRetry,
  pending,
  retrySeconds,
  snapshot,
}: {
  onRetry: () => void;
  pending: boolean;
  retrySeconds: number;
  snapshot: RoomSnapshot;
}) {
  const arena = snapshot.aiMl;
  if (!arena) return null;
  const practice = snapshot.mode === "PRACTICE";
  const terminalJudgeFailure = snapshot.result?.endReason === "JUDGE_FAILED";
  const judgeLabel =
    arena.judgeStatus === "JUDGING"
      ? "JUDGING"
      : arena.judgeStatus === "FAILED"
        ? terminalJudgeFailure
          ? "NO CONTEST"
          : "TEMPORARILY UNAVAILABLE"
        : arena.judgeStatus === "COMPLETED"
          ? "COMPLETE"
          : arena.judgeStatus === "SKIPPED"
            ? "NO MODEL CALL"
            : "STANDBY";
  return (
    <aside aria-label="Arena round status" className="arena-status-panel">
      <section className="arena-signal-card">
        <header>ROUND SIGNAL</header>
        <dl>
          <div>
            <dt>Your answer</dt>
            <dd>{arena.selfSubmission.submitted ? "Submitted" : "Thinking"}</dd>
          </div>
          {!practice && (
            <div>
              <dt>Opponent</dt>
              <dd>{arena.opponentSubmitted ? "Submitted" : "Thinking"}</dd>
            </div>
          )}
          <div>
            <dt>Evaluation</dt>
            <dd>{judgeLabel}</dd>
          </div>
        </dl>
      </section>

      {arena.judgeStatus === "JUDGING" && (
        <section aria-live="polite" className="arena-judge-state">
          <span className="pixel-loader" aria-hidden="true">
            <i />
            <i />
            <i />
            <i />
            <i />
          </span>
          <strong>Answers locked</strong>
          <p>The judge is evaluating the final answers against the rubric.</p>
        </section>
      )}

      {arena.judgeStatus === "FAILED" && (
        <section
          aria-live="assertive"
          className="arena-judge-state arena-judge-state--failed"
        >
          <strong>
            {terminalJudgeFailure
              ? "Judging ended without a result"
              : "Judging is temporarily unavailable"}
          </strong>
          <p>
            {terminalJudgeFailure
              ? "The judge could not safely score this round. Your answer remains available in history, and no record changed."
              : "Your answer is safe and remains locked. Recovery reuses the exact same evaluation."}
          </p>
          {!terminalJudgeFailure && (
            <ArcadeButton
              disabled={!arena.canRetry || retrySeconds > 0 || pending}
              onClick={onRetry}
              tone="cyan"
            >
              {pending
                ? "Requesting recovery…"
                : retrySeconds > 0
                  ? `Try again in ${retrySeconds}s`
                  : arena.canRetry
                    ? "Try judging again"
                    : "Recovery paused"}
            </ArcadeButton>
          )}
        </section>
      )}

      <ArenaActivityFeed snapshot={snapshot} />
    </aside>
  );
}

function tieBreakLabel(reason: string | null) {
  if (!reason || reason === "none") return null;
  const labels: Record<string, string> = {
    blank_forfeit: "A blank-answer rule decided the round.",
    correctness: "Technical correctness broke a raw-score tie.",
    completeness_or_specificity:
      "Completeness and relevant specificity broke a raw-score tie.",
    clarity: "Clarity and directness broke a raw-score tie.",
    exact_equivalence: "The exact-equivalence fallback broke the tie.",
  };
  return labels[reason] || "A rubric tie-break decided the round.";
}

function ArenaResultOverlay({
  now,
  onRematch,
  pending,
  result,
  snapshot,
}: {
  now: number;
  onRematch: () => void;
  pending: boolean;
  result: AiMlResult | null;
  snapshot: RoomSnapshot;
}) {
  const practice = snapshot.mode === "PRACTICE";
  const terminal = snapshot.result;
  const winner = result?.winnerUsername ?? terminal?.winnerUsername ?? null;
  const cancelled = terminal?.outcome === "CANCELLED";
  const judgeFailed = terminal?.endReason === "JUDGE_FAILED";
  const noContest =
    terminal?.outcome === "NO_CONTEST" || (!winner && !practice);
  const won = terminal?.outcome === "WIN" || winner === snapshot.self.username;
  const outcomeClass = practice
    ? "win"
    : noContest || cancelled || judgeFailed
      ? "no-contest"
      : won
        ? "win"
        : "loss";
  const title = practice
    ? result
      ? "PRACTICE SCORED"
      : "PRACTICE ENDED"
    : judgeFailed
      ? "JUDGING UNAVAILABLE"
      : cancelled
        ? "ROUND CANCELLED"
        : noContest
          ? "NO CONTEST"
          : won
            ? "VICTORY"
            : "DEFEAT";
  const rematchSeconds = snapshot.rematchDeadline
    ? Math.max(
        0,
        Math.ceil((Date.parse(snapshot.rematchDeadline) - now) / 1000),
      )
    : 0;
  const tieBreak = tieBreakLabel(result?.tieBreakReason ?? null);

  return (
    <div
      aria-labelledby="arena-result-title"
      aria-modal="true"
      className={`result-overlay result-overlay--${outcomeClass} arena-result-overlay`}
      role="dialog"
    >
      <div className="result-card arena-result-card">
        <header className="arena-result-card__header">
          <div>
            <p className="eyebrow">
              {practice ? "Solo evaluation" : "AI/ML Arena complete"}
            </p>
            <h1 id="arena-result-title">{title}</h1>
          </div>
          {!practice && winner && (
            <p>
              Winner <strong>{winner}</strong>
            </p>
          )}
        </header>

        {result ? (
          <div className="arena-result-card__scroll">
            {snapshot.aiMl?.question && (
              <section aria-label="Question" className="arena-result-question">
                <div>
                  <span>{snapshot.aiMl.question.category}</span>
                  <span
                    className={`difficulty-tag difficulty-tag--${snapshot.aiMl.question.difficulty.toLowerCase()}`}
                  >
                    {snapshot.aiMl.question.difficulty}
                  </span>
                </div>
                <h2>{snapshot.aiMl.question.title}</h2>
                <p>{snapshot.aiMl.question.prompt}</p>
              </section>
            )}
            <section aria-label="Official scores" className="arena-scoreboard">
              {result.answers.map((answer) => (
                <article
                  className={
                    winner === answer.username ? "arena-score--winner" : ""
                  }
                  key={answer.username}
                >
                  <span>{answer.username}</span>
                  <strong className="tabular">{answer.score}</strong>
                  <small>out of 100</small>
                </article>
              ))}
            </section>

            {(result.explanation || !practice || result.automaticBlank) && (
              <section
                aria-label={practice ? "Feedback" : "Judge explanation"}
                className="arena-explanation"
              >
                <h2>{practice ? "Feedback" : "Judge explanation"}</h2>
                {result.explanation && <p>{result.explanation}</p>}
                {tieBreak && <small>{tieBreak}</small>}
                {!practice && !tieBreak && (
                  <small>No tie-break was applied.</small>
                )}
                {result.automaticBlank && (
                  <small>
                    The result applied the automatic blank-answer rule.
                  </small>
                )}
              </section>
            )}

            <section
              aria-label="Submitted answers"
              className="arena-result-answers"
            >
              {result.answers.map((answer) => (
                <article key={answer.username}>
                  <header>
                    <strong>{answer.username}</strong>
                    <span className="tabular">{answer.score}/100</span>
                  </header>
                  <pre>{answer.answer || "No answer submitted."}</pre>
                </article>
              ))}
            </section>

            <section
              aria-label="100/100 exemplar answer"
              className="arena-exemplar-answer"
            >
              <header>
                <div>
                  <span>ANSWER KEY</span>
                  <h2>Rubric-perfect exemplar</h2>
                </div>
                <dl aria-label="Exemplar answer facts">
                  <div>
                    <dt>Target</dt>
                    <dd className="tabular">100/100</dd>
                  </div>
                  <div>
                    <dt>Length</dt>
                    <dd className="tabular">500 words</dd>
                  </div>
                </dl>
              </header>
              <div className="arena-exemplar-answer__copy">
                {result.exemplarAnswer
                  .split(/\n\n+/u)
                  .map((paragraph, index) => (
                    <p key={index}>{paragraph}</p>
                  ))}
              </div>
            </section>
          </div>
        ) : (
          <p className="result-card__summary">
            {practice
              ? "The practice round ended before scoring. Your record is unchanged."
              : terminal?.endReason === "FORFEIT" && winner
                ? `${winner} won by forfeit. No answers were revealed or scored.`
                : judgeFailed
                  ? "Judging could not be completed. No score was fabricated and no record changed."
                  : cancelled
                    ? "The room was cancelled before a judged result. No record changed."
                    : "The round ended without a judged result. No record changed."}
          </p>
        )}

        {!practice && snapshot.rematchDeadline && rematchSeconds > 0 && (
          <div className="rematch-box">
            <div>
              <span>REMATCH WINDOW</span>
              <strong className="tabular">
                0:{String(rematchSeconds).padStart(2, "0")}
              </strong>
            </div>
            <p>
              {snapshot.self.rematchVoted
                ? "Rematch requested. Waiting for your rival."
                : "Both players must opt in. A fresh question is selected when possible."}
            </p>
            <ArcadeButton
              disabled={pending || snapshot.self.rematchVoted}
              onClick={onRematch}
              tone={snapshot.self.rematchVoted ? "ghost" : "gold"}
            >
              {snapshot.self.rematchVoted ? "Vote locked" : "Run it back"}
            </ArcadeButton>
          </div>
        )}

        <div className="result-card__actions arena-result-card__actions">
          <ArcadeLink href="/" tone="ghost">
            Return home
          </ArcadeLink>
          <ArcadeLink href="/history" tone="cyan">
            Match history
          </ArcadeLink>
          {practice && (
            <ArcadeLink
              href="/battle/new?mode=practice&challenge=ai-ml"
              tone="gold"
            >
              Practice another
            </ArcadeLink>
          )}
        </div>
      </div>
    </div>
  );
}

export function AiMlBattleWorkspace({
  applySnapshot,
  refresh,
  realtime,
  serverOffsetMs,
  snapshot,
}: {
  applySnapshot: (snapshot: RoomSnapshot) => void;
  refresh: () => Promise<void>;
  realtime: "CONNECTING" | "LIVE" | "POLLING";
  serverOffsetMs: number;
  snapshot: RoomSnapshot;
}) {
  const router = useRouter();
  const now = useAuthoritativeNow(serverOffsetMs);
  const arena = snapshot.aiMl;
  const question = arena?.question ?? null;
  const constraints = question?.answerConstraints ?? AI_ML_ANSWER_LIMITS;
  const draftScope = `${snapshot.matchId}:ai-ml:${snapshot.roundNumber}`;
  const [draft, setDraft] = usePersistentDraft(
    snapshot.roomCode,
    draftScope,
    "AI_ML",
    arena?.selfSubmission.answer ?? "",
  );
  const [pending, setPending] = useState<
    "SUBMIT" | "RETRY" | "REMATCH" | "FORFEIT" | null
  >(null);
  const [localSubmissionStatus, setLocalSubmissionStatus] = useState<
    "IDLE" | "UNCERTAIN" | "ACCEPTED"
  >("IDLE");
  const [submissionAttempt, setSubmissionAttempt] = useState<{
    answer: string;
    idempotencyKey: string;
  } | null>(null);
  const [actionError, setActionError] = useState("");
  const retryKey = useRef<string | null>(null);
  const practice = snapshot.mode === "PRACTICE";
  const submitted = arena?.selfSubmission.submitted === true;
  const locallyLocked = submitted || localSubmissionStatus !== "IDLE";
  const displayedAnswer =
    submitted && arena?.selfSubmission.answer !== null
      ? arena?.selfSubmission.answer || ""
      : localSubmissionStatus !== "IDLE" && submissionAttempt
        ? submissionAttempt.answer
        : draft;
  const measurement = useMemo(
    () => measureAiMlAnswer(displayedAnswer, constraints),
    [constraints, displayedAnswer],
  );
  const parsedDeadline = snapshot.answerDeadlineAt
    ? Date.parse(snapshot.answerDeadlineAt)
    : Number.NaN;
  const deadlineMs = Number.isFinite(parsedDeadline) ? parsedDeadline : null;
  const remainingMs = deadlineMs === null ? 0 : Math.max(0, deadlineMs - now);
  const deadlinePassed = deadlineMs !== null && remainingMs <= 0;
  const active = snapshot.state === "ACTIVE";
  const finished = [
    "FINISHED",
    "REMATCH_PENDING",
    "NO_CONTEST",
    "CANCELLED",
  ].includes(snapshot.state);
  const parsedRetryAt = arena?.retryAt ? Date.parse(arena.retryAt) : Number.NaN;
  const retrySeconds = Number.isFinite(parsedRetryAt)
    ? Math.max(0, Math.ceil((parsedRetryAt - now) / 1000))
    : 0;

  useEffect(() => {
    if (snapshot.state === "LOBBY")
      router.replace(`/lobby/${snapshot.roomCode}`);
  }, [router, snapshot.roomCode, snapshot.state]);

  async function submitAnswer() {
    const retryingUncertainDelivery = localSubmissionStatus === "UNCERTAIN";
    if (
      !active ||
      !arena ||
      submitted ||
      localSubmissionStatus === "ACCEPTED" ||
      pending !== null ||
      (!retryingUncertainDelivery && (deadlineMs === null || deadlinePassed))
    )
      return;
    if (!retryingUncertainDelivery && !measurement.withinLimits) {
      setActionError(limitMessage(measurement, arena.question));
      return;
    }
    if (
      !retryingUncertainDelivery &&
      measurement.isBlank &&
      !window.confirm(
        "Submit an empty final answer? It will be locked and scored as blank.",
      )
    )
      return;

    setPending("SUBMIT");
    setActionError("");
    const attempt = submissionAttempt ?? {
      answer: measurement.normalized,
      idempotencyKey: crypto.randomUUID(),
    };
    setSubmissionAttempt(attempt);
    try {
      const response = await sendRoomCommand(
        snapshot.roomCode,
        snapshot.matchId,
        snapshot.version,
        {
          type: "SUBMIT_AI_ML_ANSWER",
          payload: { answer: attempt.answer },
        },
        attempt.idempotencyKey,
      );
      setLocalSubmissionStatus("ACCEPTED");
      if (response.snapshot) {
        applySnapshot(response.snapshot);
      } else {
        try {
          await refresh();
        } catch {
          setActionError(
            "Your final answer was accepted. Waiting for the live snapshot to catch up.",
          );
        }
      }
    } catch (caught) {
      if (caught instanceof ApiError) {
        setSubmissionAttempt(null);
        setLocalSubmissionStatus("IDLE");
        setActionError(caught.message);
      } else {
        setLocalSubmissionStatus("UNCERTAIN");
        setActionError(
          "Delivery could not be confirmed. Retry sends the exact same locked answer.",
        );
      }
    } finally {
      setPending(null);
    }
  }

  async function retryJudging() {
    if (!arena?.canRetry || retrySeconds > 0 || pending !== null) return;
    setPending("RETRY");
    setActionError("");
    const idempotencyKey = retryKey.current ?? crypto.randomUUID();
    retryKey.current = idempotencyKey;
    try {
      const response = await sendRoomCommand(
        snapshot.roomCode,
        snapshot.matchId,
        snapshot.version,
        { type: "RETRY_AI_ML_JUDGING", payload: {} },
        idempotencyKey,
      );
      retryKey.current = null;
      if (response.snapshot) applySnapshot(response.snapshot);
      else await refresh();
    } catch (caught) {
      setActionError(
        caught instanceof ApiError
          ? caught.message
          : "Judging recovery could not be requested.",
      );
    } finally {
      setPending(null);
    }
  }

  async function voteRematch() {
    setPending("REMATCH");
    setActionError("");
    try {
      const response = await sendRoomCommand(
        snapshot.roomCode,
        snapshot.matchId,
        snapshot.version,
        { type: "REMATCH_VOTE", payload: { vote: true } },
      );
      if (response.snapshot) applySnapshot(response.snapshot);
      else await refresh();
    } catch (caught) {
      setActionError(
        caught instanceof ApiError
          ? caught.message
          : "Could not register the rematch vote.",
      );
    } finally {
      setPending(null);
    }
  }

  async function forfeit() {
    if (
      !window.confirm(
        practice
          ? "End this arena practice? Your record will not change."
          : "Forfeit this active arena round? This records a loss and cannot be undone.",
      )
    )
      return;
    setPending("FORFEIT");
    setActionError("");
    try {
      const response = await sendRoomCommand(
        snapshot.roomCode,
        snapshot.matchId,
        snapshot.version,
        { type: "FORFEIT", payload: {} },
      );
      if (response.snapshot) applySnapshot(response.snapshot);
      else await refresh();
    } catch (caught) {
      setActionError(
        caught instanceof ApiError
          ? caught.message
          : "The arena round could not be ended.",
      );
    } finally {
      setPending(null);
    }
  }

  const timer =
    snapshot.state === "JUDGING"
      ? "LOCKED"
      : finished
        ? "FINAL"
        : snapshot.answerDeadlineAt
          ? formatClock(remainingMs)
          : "--:--";
  const centerLabel =
    snapshot.state === "COUNTDOWN"
      ? "ARMED"
      : snapshot.state === "JUDGING"
        ? "JUDGING"
        : finished
          ? practice
            ? "SCORED"
            : "RESULT"
          : practice
            ? "SOLO"
            : "ARENA";

  return (
    <main
      className={`battle-page battle-page--arena${finished ? " battle-page--finished" : ""}`}
      id="main-content"
    >
      <header className="battle-toolbar">
        <BrandMark compact />
        <div className="battle-toolbar__room">
          <span>AI/ML ARENA</span>
          <strong>{practice ? "PRACTICE" : snapshot.roomCode}</strong>
        </div>
        <div className="battle-toolbar__right">
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
          {active && !locallyLocked && (
            <button
              className="forfeit-button"
              disabled={pending === "FORFEIT"}
              onClick={() => void forfeit()}
              type="button"
            >
              {practice ? "End practice" : "Forfeit"}
            </button>
          )}
          <ClerkAuthControls compact />
        </div>
      </header>

      <BattleStrip
        challengeType="AI_ML"
        centerLabel={centerLabel}
        mode={snapshot.mode}
        opponent={snapshot.opponent}
        self={snapshot.self}
        state={snapshot.state}
        timer={timer}
      />

      {snapshot.state === "COUNTDOWN" ? (
        <ArenaCountdown now={now} startsAt={snapshot.startsAt} />
      ) : arena && question ? (
        <div className="arena-workspace">
          <ArenaQuestionPane question={question} />
          <section
            aria-label="AI/ML answer editor"
            className="arena-answer-pane"
          >
            <header className="arena-answer-toolbar">
              <div>
                <strong>FINAL RESPONSE</strong>
                <small>
                  {submitted
                    ? "answer locked by server"
                    : localSubmissionStatus === "ACCEPTED"
                      ? "accepted · synchronizing"
                      : localSubmissionStatus === "UNCERTAIN"
                        ? "exact final answer held for retry"
                        : "draft saved locally"}
                </small>
              </div>
              <ArcadeButton
                disabled={
                  !active ||
                  submitted ||
                  localSubmissionStatus === "ACCEPTED" ||
                  (localSubmissionStatus !== "UNCERTAIN" &&
                    (deadlineMs === null ||
                      deadlinePassed ||
                      !measurement.withinLimits)) ||
                  pending !== null
                }
                onClick={() => void submitAnswer()}
                tone={
                  submitted || localSubmissionStatus === "ACCEPTED"
                    ? "ghost"
                    : "gold"
                }
              >
                {submitted
                  ? "Answer submitted"
                  : localSubmissionStatus === "ACCEPTED"
                    ? "Answer sent · syncing"
                    : pending === "SUBMIT"
                      ? localSubmissionStatus === "UNCERTAIN"
                        ? "Retrying final delivery…"
                        : "Submitting final answer…"
                      : localSubmissionStatus === "UNCERTAIN"
                        ? "Retry final delivery"
                        : deadlinePassed
                          ? "Deadline reached"
                          : deadlineMs === null
                            ? "Synchronizing deadline…"
                            : "Submit final answer"}
              </ArcadeButton>
            </header>
            <div className="arena-editor-surface">
              <label className="sr-only" htmlFor="ai-ml-answer">
                AI/ML answer
              </label>
              <textarea
                aria-describedby="ai-ml-answer-budget ai-ml-answer-help"
                id="ai-ml-answer"
                onChange={(event) => setDraft(event.target.value)}
                placeholder="Explain your answer clearly and directly. Focus on correctness, relevant coverage, causal reasoning, and tradeoffs."
                readOnly={!active || locallyLocked || pending === "SUBMIT"}
                spellCheck
                value={displayedAnswer}
              />
              {locallyLocked && (
                <div aria-live="polite" className="arena-editor-lock">
                  <span aria-hidden="true">✓</span>
                  <div>
                    <strong>
                      {localSubmissionStatus === "UNCERTAIN"
                        ? "Delivery unconfirmed"
                        : "Answer locked"}
                    </strong>
                    <small>
                      {localSubmissionStatus === "UNCERTAIN"
                        ? "Retry will send this exact final answer."
                        : arena.selfSubmission.submittedAt
                          ? `Submitted ${new Date(arena.selfSubmission.submittedAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}`
                          : "The server accepted your final answer."}
                    </small>
                  </div>
                </div>
              )}
            </div>
            <footer
              className={`arena-word-budget${measurement.withinLimits ? "" : " arena-word-budget--over"}`}
              id="ai-ml-answer-budget"
            >
              <div>
                <span>
                  <strong className="tabular">{measurement.wordCount}</strong> /{" "}
                  {constraints.maxWords} words
                </span>
                <span className="arena-word-budget__secondary">
                  {measurement.characterCount.toLocaleString()} chars ·{" "}
                  {measurement.utf8ByteCount.toLocaleString()} bytes
                </span>
              </div>
              <i aria-hidden="true">
                <b
                  style={{
                    transform: `scaleX(${Math.min(1, measurement.wordCount / constraints.maxWords)})`,
                  }}
                />
              </i>
              <p aria-live="assertive">
                {question ? limitMessage(measurement, question) : ""}
              </p>
            </footer>
            <p className="sr-only" id="ai-ml-answer-help">
              Your final submission is immutable. Oversized answers are
              rejected, never truncated.
            </p>
          </section>
          <ArenaStatusPanel
            onRetry={() => void retryJudging()}
            pending={pending === "RETRY"}
            retrySeconds={retrySeconds}
            snapshot={snapshot}
          />
        </div>
      ) : (
        <RoomLoading label="The server is sealing the arena question…" />
      )}

      <footer className="battle-statusbar">
        <span>
          <i className={snapshot.self.connected ? "is-online" : ""} />
          {snapshot.self.connected ? "You are connected" : "Reconnecting…"}
        </span>
        <span className="battle-statusbar__hint">
          {locallyLocked
            ? practice
              ? "Your answer is locked while scoring completes"
              : arena?.opponentSubmitted
                ? "Both answers are locked"
                : "Your answer is locked · opponent is still thinking"
            : "One final answer · no edits after submission"}
        </span>
        <span aria-live="assertive" className="battle-statusbar__error">
          {actionError}
        </span>
      </footer>

      {finished && (
        <ArenaResultOverlay
          now={now}
          onRematch={() => void voteRematch()}
          pending={pending === "REMATCH"}
          result={arena?.result ?? null}
          snapshot={snapshot}
        />
      )}
    </main>
  );
}
