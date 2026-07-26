"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";

import {
  ApiError,
  sendRoomCommand,
  type PublicProblem,
  type RoomSnapshot,
} from "./api-client";
import { ArcadeButton, ArcadeLink, StatusLamp } from "./ArcadePrimitives";
import { BattleStrip } from "./BattleStrip";
import { BrandMark } from "./BrandMark";
import { ClerkAuthControls } from "./ClerkAuthControls";
import { CodeEditor } from "./CodeEditor";
import { RoomError, RoomLoading } from "./RoomState";
import { usePersistentDraft } from "./usePersistentDraft";
import { useRoomSession } from "./useRoomSession";

function useAuthoritativeNow(serverOffsetMs: number) {
  const [localNow, setLocalNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setLocalNow(Date.now()), 100);
    return () => window.clearInterval(timer);
  }, []);
  return localNow + serverOffsetMs;
}

function formatClock(ms: number) {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function Countdown({
  now,
  startsAt,
}: {
  now: number;
  startsAt: string | null;
}) {
  const remaining = startsAt ? Date.parse(startsAt) - now : 3_000;
  const count = Math.ceil(remaining / 1000);
  const label = count > 0 ? String(Math.min(3, count)) : "FIGHT!";
  return (
    <div
      aria-live="assertive"
      className={`countdown-overlay${label === "FIGHT!" ? " countdown-overlay--fight" : ""}`}
      role="status"
    >
      <div aria-hidden="true" className="countdown-overlay__rays">
        <i />
        <i />
        <i />
        <i />
      </div>
      <p>Both players locked</p>
      <strong key={label}>{label}</strong>
      <small>
        {label === "FIGHT!"
          ? "Synchronizing first frame…"
          : "Problem reveal armed"}
      </small>
    </div>
  );
}

function ProblemPane({ problem }: { problem: PublicProblem }) {
  const [tab, setTab] = useState<"statement" | "samples">("statement");
  return (
    <section className="problem-pane">
      <header className="pane-tabs">
        <div role="tablist" aria-label="Problem information">
          <button
            aria-selected={tab === "statement"}
            onClick={() => setTab("statement")}
            role="tab"
            type="button"
          >
            Problem
          </button>
          <button
            aria-selected={tab === "samples"}
            onClick={() => setTab("samples")}
            role="tab"
            type="button"
          >
            Samples <span>{problem.samples.length}</span>
          </button>
        </div>
        <span
          className={`difficulty-tag difficulty-tag--${problem.difficulty.toLowerCase()}`}
        >
          {problem.difficulty}
        </span>
      </header>
      <div className="problem-pane__scroll">
        {tab === "statement" ? (
          <article className="problem-copy" role="tabpanel">
            <p className="problem-copy__id">
              {problem.id} · v{problem.version}
            </p>
            <h1>{problem.title}</h1>
            <div className="problem-copy__description">
              {problem.description.split(/\n\n+/).map((paragraph, index) => (
                <p key={index}>{paragraph}</p>
              ))}
            </div>
            <h2>Function contract</h2>
            <code>{problem.contracts.PYTHON}</code>
            <code>{problem.contracts.JAVA}</code>
            <h2>Constraints</h2>
            <ul>
              {problem.constraints.map((constraint) => (
                <li key={constraint}>{constraint}</li>
              ))}
            </ul>
            <div className="limits-row">
              <span>
                Wall limit <strong>{problem.limits.wallMs} ms</strong>
              </span>
              <span>
                Memory <strong>{problem.limits.memoryMb} MB</strong>
              </span>
            </div>
          </article>
        ) : (
          <div className="sample-list" role="tabpanel">
            {problem.samples.map((sample, index) => (
              <article className="sample-card" key={sample.id}>
                <h2>Sample {index + 1}</h2>
                <dl>
                  <div>
                    <dt>Input</dt>
                    <dd>
                      <pre>{sample.input}</pre>
                    </dd>
                  </div>
                  <div>
                    <dt>Output</dt>
                    <dd>
                      <pre>{sample.output}</pre>
                    </dd>
                  </div>
                </dl>
                {sample.explanation && <p>{sample.explanation}</p>}
              </article>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}

function JudgeConsole({ snapshot }: { snapshot: RoomSnapshot }) {
  const results = snapshot.sampleRun?.results || [];
  const submission = snapshot.lastSubmission;
  return (
    <section aria-label="Judge console" className="judge-console">
      <header>
        <span>
          <i />
          JUDGE CONSOLE
        </span>
        <small>
          {snapshot.sampleRun?.status === "RUNNING"
            ? "running samples…"
            : submission
              ? submission.verdict.replaceAll("_", " ")
              : "ready"}
        </small>
      </header>
      <div aria-live="polite" className="judge-console__body">
        {snapshot.sampleRun?.status === "RUNNING" ? (
          <div className="console-running">
            <span className="pixel-loader" aria-hidden="true">
              <i />
              <i />
              <i />
              <i />
              <i />
            </span>
            <p>Executing published samples in an isolated runner…</p>
          </div>
        ) : results.length > 0 ? (
          <div className="sample-results">
            {results.map((result, index) => (
              <div
                className={`sample-result sample-result--${result.status.toLowerCase()}`}
                key={result.id}
              >
                <strong>
                  <span aria-hidden="true">
                    {result.status === "PASSED" ? "✓" : "×"}
                  </span>{" "}
                  Sample {index + 1}
                </strong>
                <span>
                  {result.status === "PASSED"
                    ? `${result.runtimeMs ?? 0} ms`
                    : result.message || result.status.toLowerCase()}
                </span>
              </div>
            ))}
          </div>
        ) : submission ? (
          <div
            className={`submission-line submission-line--${submission.verdict.toLowerCase()}`}
          >
            <strong>{submission.verdict.replaceAll("_", " ")}</strong>
            <p>{submission.message}</p>
            <span>
              {submission.passed}/{submission.total} hidden tests
            </span>
          </div>
        ) : (
          <p className="console-placeholder">
            <span>&gt;</span> Run published samples or submit against the hidden
            suite. Opponent output stays private.
          </p>
        )}
      </div>
    </section>
  );
}

function ActivityFeed({ snapshot }: { snapshot: RoomSnapshot }) {
  const items = snapshot.activity.slice(-6).reverse();
  return (
    <aside className="activity-feed">
      <header>
        <span>ACTIVITY</span>
        <small>latest first</small>
      </header>
      <ol aria-live="polite">
        {items.length === 0 ? (
          <li className="activity-feed__empty">
            The pit is quiet. Start coding.
          </li>
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
    </aside>
  );
}

function ResultOverlay({
  now,
  onRematch,
  pending,
  snapshot,
}: {
  now: number;
  onRematch: () => void;
  pending: boolean;
  snapshot: RoomSnapshot;
}) {
  const result = snapshot.result;
  const outcome =
    result?.outcome ||
    (snapshot.state === "NO_CONTEST" ? "NO_CONTEST" : "DRAW");
  const forfeited = result?.endReason === "FORFEIT";
  const title =
    outcome === "WIN"
      ? "VICTORY"
      : outcome === "LOSS"
        ? forfeited
          ? "FORFEIT"
          : "DEFEAT"
        : outcome === "CANCELLED"
          ? "CANCELLED"
          : outcome === "NO_CONTEST"
            ? "NO CONTEST"
            : "DRAW";
  const rematchSeconds = snapshot.rematchDeadline
    ? Math.max(
        0,
        Math.ceil((Date.parse(snapshot.rematchDeadline) - now) / 1000),
      )
    : 0;
  const reason = result?.endReason
    ? result.endReason.replaceAll("_", " ").toLowerCase()
    : "match ended";
  return (
    <div
      aria-labelledby="result-title"
      aria-modal="true"
      className={`result-overlay result-overlay--${outcome.toLowerCase().replace("_", "-")}`}
      role="dialog"
    >
      <div aria-hidden="true" className="result-overlay__impact">
        <i />
        <i />
        <i />
        <i />
        <span />
      </div>
      <div className="result-card">
        <p className="eyebrow">Round complete // {reason}</p>
        <h1 id="result-title">{title}</h1>
        <p className="result-card__summary">
          {outcome === "WIN" &&
            (forfeited
              ? "Your rival did not return before the reconnect window closed."
              : "Your accepted submission landed first.")}
          {outcome === "LOSS" &&
            (forfeited
              ? "The server recorded this round as a forfeit."
              : `${result?.winnerUsername || "Your rival"} cleared the hidden suite first.`)}
          {outcome === "DRAW" &&
            "Neither player takes a win or loss from this round."}
          {outcome === "CANCELLED" &&
            "The room closed before the battle began. No record changed."}
          {outcome === "NO_CONTEST" &&
            "The round ended without changing either record."}
        </p>
        <dl className="result-stats">
          <div>
            <dt>Duration</dt>
            <dd className="tabular">{formatClock(result?.durationMs || 0)}</dd>
          </div>
          <div>
            <dt>Your best</dt>
            <dd>
              {snapshot.self.bestPassed}/{snapshot.self.totalTests || "—"}
            </dd>
          </div>
          <div>
            <dt>Language</dt>
            <dd>
              {snapshot.self.language === "PYTHON"
                ? "Python"
                : snapshot.self.language === "JAVA"
                  ? "Java"
                  : "Not selected"}
            </dd>
          </div>
        </dl>
        {snapshot.rematchDeadline && rematchSeconds > 0 && (
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
                : "Both players must opt in. The next problem will be fresh."}
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
        <div className="result-card__actions">
          <ArcadeLink href="/" tone="ghost">
            Return home
          </ArcadeLink>
          <ArcadeLink href="/history" tone="cyan">
            Match history
          </ArcadeLink>
        </div>
      </div>
    </div>
  );
}

function BattleWorkspace({
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
  const language = snapshot.self.language || "PYTHON";
  const starter = snapshot.problem?.starterCode[language] || "";
  const draftScope = `${snapshot.matchId}:${snapshot.problem?.id || "sealed"}:v${snapshot.problem?.version || snapshot.roundNumber}`;
  const [source, setSource] = usePersistentDraft(
    snapshot.roomCode,
    draftScope,
    language,
    starter,
  );
  const [pending, setPending] = useState<
    "RUN" | "SUBMIT" | "REMATCH" | "FORFEIT" | null
  >(null);
  const [actionError, setActionError] = useState("");

  useEffect(() => {
    if (snapshot.state === "LOBBY")
      router.replace(`/lobby/${snapshot.roomCode}`);
  }, [router, snapshot.roomCode, snapshot.state]);

  const active = snapshot.state === "ACTIVE";
  const elapsed = snapshot.startsAt ? now - Date.parse(snapshot.startsAt) : 0;
  const cooldownMs = snapshot.self.cooldownUntil
    ? Math.max(0, Date.parse(snapshot.self.cooldownUntil) - now)
    : 0;
  const executing = ["COMPILING", "JUDGING", "VERIFYING"].includes(
    snapshot.self.activity,
  );
  const runDisabled = !active || executing || pending !== null;
  const submitDisabled = runDisabled || cooldownMs > 0;

  const dispatch = useCallback(
    async (type: "RUN_SAMPLES" | "SUBMIT") => {
      if (!active || !snapshot.problem) return;
      if (executing || pending !== null) return;
      if (type === "SUBMIT" && cooldownMs > 0) return;
      setPending(type === "RUN_SAMPLES" ? "RUN" : "SUBMIT");
      setActionError("");
      try {
        const response = await sendRoomCommand(
          snapshot.roomCode,
          snapshot.matchId,
          snapshot.version,
          { type, payload: { language, source } },
        );
        if (response.snapshot) applySnapshot(response.snapshot);
        else await refresh();
      } catch (caught) {
        setActionError(
          caught instanceof ApiError
            ? caught.message
            : "The judge command was not accepted.",
        );
      } finally {
        setPending(null);
      }
    },
    [
      active,
      applySnapshot,
      cooldownMs,
      executing,
      language,
      pending,
      refresh,
      snapshot.matchId,
      snapshot.problem,
      snapshot.roomCode,
      snapshot.version,
      source,
    ],
  );

  async function voteRematch() {
    setPending("REMATCH");
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
        caught instanceof Error
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
        "Forfeit this active match? This records a loss and cannot be undone.",
      )
    )
      return;
    setPending("FORFEIT");
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
        caught instanceof Error
          ? caught.message
          : "Could not record the forfeit.",
      );
      setPending(null);
    }
  }

  const centerLabel =
    snapshot.state === "COUNTDOWN"
      ? "ARMED"
      : snapshot.state === "ACTIVE"
        ? "LIVE"
        : "ROUND END";
  const finished = [
    "FINISHED",
    "REMATCH_PENDING",
    "NO_CONTEST",
    "CANCELLED",
  ].includes(snapshot.state);

  return (
    <main
      className={`battle-page${finished ? " battle-page--finished" : ""}`}
      id="main-content"
    >
      <header className="battle-toolbar">
        <BrandMark compact />
        <div className="battle-toolbar__room">
          <span>ROOM</span>
          <strong>{snapshot.roomCode}</strong>
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
          {active && (
            <button
              className="forfeit-button"
              disabled={pending === "FORFEIT"}
              onClick={forfeit}
              type="button"
            >
              Forfeit
            </button>
          )}
          <ClerkAuthControls compact />
        </div>
      </header>

      <BattleStrip
        centerLabel={centerLabel}
        opponent={snapshot.opponent}
        self={snapshot.self}
        state={snapshot.state}
        timer={formatClock(elapsed)}
      />

      {snapshot.state === "COUNTDOWN" ? (
        <Countdown now={now} startsAt={snapshot.startsAt} />
      ) : snapshot.problem ? (
        <div className="battle-workspace">
          <ProblemPane problem={snapshot.problem} />
          <section className="coding-pane">
            <header className="editor-toolbar">
              <div className="editor-file">
                <span
                  aria-hidden="true"
                  className={`language-glyph language-glyph--${language.toLowerCase()}`}
                >
                  {language === "PYTHON" ? "py" : "{}"}
                </span>
                <strong>
                  {snapshot.problem.functionName}.
                  {language === "PYTHON" ? "py" : "java"}
                </strong>
                <small>draft saved locally</small>
              </div>
              <div className="editor-actions">
                <button
                  disabled={runDisabled}
                  onClick={() => void dispatch("RUN_SAMPLES")}
                  type="button"
                >
                  <span>{pending === "RUN" ? "Running…" : "Run samples"}</span>
                  <kbd>⌘↵</kbd>
                </button>
                <button
                  className="editor-submit"
                  disabled={submitDisabled}
                  onClick={() => void dispatch("SUBMIT")}
                  type="button"
                >
                  <span>
                    {pending === "SUBMIT" ? "Submitting…" : "Submit solution"}
                  </span>
                  <kbd>⇧⌘↵</kbd>
                </button>
              </div>
            </header>
            <div className="editor-surface">
              <CodeEditor
                language={language}
                onChange={setSource}
                onRun={() => void dispatch("RUN_SAMPLES")}
                onSubmit={() => void dispatch("SUBMIT")}
                readOnly={!active}
                value={source}
              />
            </div>
            <JudgeConsole snapshot={snapshot} />
          </section>
          <ActivityFeed snapshot={snapshot} />
        </div>
      ) : (
        <RoomLoading label="The server is sealing both players’ problem…" />
      )}

      <footer className="battle-statusbar">
        <span>
          <i className={snapshot.self.connected ? "is-online" : ""} />
          {snapshot.self.connected ? "You are connected" : "Reconnecting…"}
        </span>
        {cooldownMs > 0 ? (
          <div aria-live="polite" className="cooldown-meter">
            <span>COOLDOWN</span>
            <i>
              <b
                style={{
                  transform: `scaleX(${Math.min(1, cooldownMs / 10_000)})`,
                }}
              />
            </i>
            <strong className="tabular">
              {(cooldownMs / 1000).toFixed(1)}s
            </strong>
          </div>
        ) : (
          <span className="battle-statusbar__hint">
            Run samples: <kbd>⌘↵</kbd> · Submit: <kbd>⇧⌘↵</kbd>
          </span>
        )}
        <span aria-live="assertive" className="battle-statusbar__error">
          {actionError}
        </span>
      </footer>

      {finished && (
        <ResultOverlay
          now={now}
          onRematch={() => void voteRematch()}
          pending={pending === "REMATCH"}
          snapshot={snapshot}
        />
      )}
    </main>
  );
}

export function BattleView({ roomCode }: { roomCode: string }) {
  const session = useRoomSession(roomCode);
  if (session.loading || !session.snapshot)
    return session.error ? (
      <RoomError message={session.error} />
    ) : (
      <RoomLoading />
    );
  if (session.error) return <RoomError message={session.error} />;
  return <BattleWorkspace {...session} snapshot={session.snapshot} />;
}
