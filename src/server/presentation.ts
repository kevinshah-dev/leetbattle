import { getPublicProblem } from "@/problems/public";
import type {
  ActivityEvent,
  MatchResult,
  PlayerActivity,
  PlayerHud,
  PublicProblem,
  RoomSnapshot,
  SampleResult,
  SubmissionSummary,
} from "@/components/api-client";
import type { Database } from "@/server/db/client";
import type {
  MatchEvent,
  MatchSnapshot,
  PlayerSnapshot,
} from "@/server/domain/types";
import type { MatchEngine } from "@/server/match/match-engine";

interface ExecutionViewRow {
  kind: "RUN" | "SUBMIT";
  status: "QUEUED" | "RUNNING" | "COMPLETED";
  verdict: string | null;
  result_summary: Record<string, unknown> | null;
}

function playerActivity(
  player: PlayerSnapshot,
  state: MatchSnapshot["state"],
): PlayerActivity {
  if (!player.connected) return "DISCONNECTED";
  if (player.activity === "ACCEPTED" && state === "ACTIVE") return "VERIFYING";
  if (player.activity === "ACCEPTED") return "ACCEPTED";
  if (player.activity === "COMPILING") return "COMPILING";
  if (player.activity === "JUDGING") return "JUDGING";
  if (player.activity === "COOLDOWN") return "COOLDOWN";
  if (player.ready && state === "LOBBY") return "READY";
  return "THINKING";
}

function playerHud(
  player: PlayerSnapshot,
  state: MatchSnapshot["state"],
  rematchVotes: readonly number[],
): PlayerHud {
  return {
    id: `slot-${player.slot}`,
    username: player.username,
    role: player.slot === 1 ? "HOST" : "CHALLENGER",
    connected: player.connected,
    ready: player.ready,
    language: player.language,
    activity: playerActivity(player, state),
    bestPassed: player.bestPassedCount,
    totalTests: player.hiddenTestCount ?? 0,
    cooldownUntil: player.cooldownUntil,
    rematchVoted: rematchVotes.includes(player.slot),
  };
}

function eventMessage(
  event: MatchEvent,
  selfSlot: number,
  mode: MatchSnapshot["mode"],
): Pick<ActivityEvent, "message" | "tone"> {
  const slot =
    typeof event.payload.slot === "number" ? event.payload.slot : null;
  const self = slot === selfSlot;
  const actor = self ? "You" : "Your rival";
  switch (event.type) {
    case "MATCH_CREATED":
      return {
        message:
          mode === "PRACTICE"
            ? "Solo practice session opened."
            : "Private battle room opened.",
        tone: "NEUTRAL",
      };
    case "PLAYER_JOINED":
      return {
        message: "A challenger claimed the second slot.",
        tone: "OPPONENT",
      };
    case "PLAYER_LANGUAGE_CHANGED":
      return {
        message: `${actor} selected ${event.payload.language === "JAVA" ? "Java" : "Python"}.`,
        tone: self ? "SELF" : "OPPONENT",
      };
    case "PLAYER_READY_CHANGED":
      return {
        message: `${actor} ${event.payload.ready ? "locked in" : "unlocked their loadout"}.`,
        tone: self ? "SELF" : "OPPONENT",
      };
    case "COUNTDOWN_STARTED":
      return {
        message:
          mode === "PRACTICE"
            ? "Loadout locked. Problem reveal armed."
            : "Both players are ready. Reveal synchronized.",
        tone: "SUCCESS",
      };
    case "MATCH_ACTIVE":
      return {
        message:
          mode === "PRACTICE"
            ? "GO! The practice problem is now live."
            : "FIGHT! The problem is now live.",
        tone: "SUCCESS",
      };
    case "EXECUTION_STARTED":
      return {
        message:
          event.payload.kind === "SUBMIT"
            ? self
              ? "You submitted against the hidden suite."
              : "Opponent submitted."
            : self
              ? "You started the published samples."
              : "Opponent is compiling.",
        tone: self ? "SELF" : "OPPONENT",
      };
    case "EXECUTION_PROGRESS":
      return {
        message: `${actor} ${event.payload.activity === "JUDGING" ? "is judging" : "is compiling"}.`,
        tone: self ? "SELF" : "OPPONENT",
      };
    case "EXECUTION_COMPLETED": {
      const accepted = event.payload.accepted === true;
      const passed = Number(event.payload.passedCount ?? 0);
      const total = Number(event.payload.totalCount ?? 0);
      return {
        message: accepted
          ? `${actor} cleared the suite; result is being verified.`
          : event.payload.kind === "SUBMIT"
            ? `${actor} reached ${passed}/${total} hidden tests.`
            : self
              ? "Your sample run finished."
              : "Opponent returned to coding.",
        tone: accepted ? "SUCCESS" : self ? "SELF" : "OPPONENT",
      };
    }
    case "CONNECTION_CHANGED":
      return {
        message: `${actor} ${event.payload.connected ? "reconnected" : "lost the live link"}.`,
        tone: event.payload.connected ? "SUCCESS" : "DANGER",
      };
    case "MATCH_FINISHED":
      return {
        message:
          mode === "PRACTICE"
            ? "The server finalized your practice result."
            : "The server finalized the round.",
        tone: "SUCCESS",
      };
    case "REMATCH_OPENED":
      return {
        message: "The 30-second rematch window is open.",
        tone: "NEUTRAL",
      };
    case "REMATCH_VOTED":
      return {
        message: `${actor} requested a rematch.`,
        tone: self ? "SELF" : "OPPONENT",
      };
    case "REMATCH_CREATED":
      return {
        message: "Mutual rematch confirmed. Fresh round created.",
        tone: "SUCCESS",
      };
    default:
      return {
        message: "The authoritative match state changed.",
        tone: "NEUTRAL",
      };
  }
}

function activityFeed(
  events: readonly MatchEvent[],
  selfSlot: number,
  mode: MatchSnapshot["mode"],
): ActivityEvent[] {
  return events.map((event) => ({
    id: `${event.matchId}:${event.version}`,
    serverTimestamp: event.serverTimestamp,
    ...eventMessage(event, selfSlot, mode),
  }));
}

function presentProblem(
  reference: NonNullable<MatchSnapshot["problem"]>,
): PublicProblem | null {
  const problem = getPublicProblem(reference.id, reference.version);
  if (!problem) return null;
  return {
    id: problem.id,
    version: problem.version,
    title: problem.title,
    difficulty: problem.difficulty,
    description: problem.description,
    constraints: [...problem.constraints],
    samples: problem.samples.map((sample) => ({ ...sample })),
    functionName: problem.functionName,
    contracts: {
      PYTHON: problem.contracts.PYTHON.signature,
      JAVA: problem.contracts.JAVA.signature,
    },
    starterCode: { ...problem.starterCode },
    limits: { ...problem.limits },
  };
}

function sampleResults(
  summary: Record<string, unknown> | null,
): SampleResult[] {
  const details = summary?.details;
  if (!details || typeof details !== "object" || Array.isArray(details))
    return [];
  const candidates = (details as Record<string, unknown>).samples;
  if (!Array.isArray(candidates)) return [];
  const results: SampleResult[] = [];
  for (const [index, candidate] of candidates.entries()) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      continue;
    const row = candidate as Record<string, unknown>;
    if (
      row.status !== "PASSED" &&
      row.status !== "FAILED" &&
      row.status !== "ERROR"
    )
      continue;
    results.push({
      id: typeof row.id === "string" ? row.id : `sample-${index + 1}`,
      status: row.status,
      ...(typeof row.runtimeMs === "number"
        ? { runtimeMs: row.runtimeMs }
        : {}),
      ...(typeof row.actual === "string"
        ? { actual: row.actual.slice(0, 4_096) }
        : {}),
      ...(typeof row.message === "string"
        ? { message: row.message.slice(0, 4_096) }
        : {}),
    });
  }
  return results;
}

function submissionSummary(
  row: ExecutionViewRow | undefined,
  mode: MatchSnapshot["mode"],
): SubmissionSummary | null {
  if (!row || row.status !== "COMPLETED" || !row.result_summary) return null;
  const summary = row.result_summary;
  const verdict =
    typeof summary.verdict === "string" ? summary.verdict : "INFRA_ERROR";
  const mappedVerdict: SubmissionSummary["verdict"] =
    verdict === "TIMEOUT"
      ? "TIME_LIMIT"
      : verdict === "INFRA_ERROR"
        ? "INFRASTRUCTURE_ERROR"
        : verdict === "OUTPUT_LIMIT"
          ? "OUTPUT_LIMIT"
          : (verdict as SubmissionSummary["verdict"]);
  const messages: Record<SubmissionSummary["verdict"], string> = {
    ACCEPTED:
      mode === "PRACTICE"
        ? "Every hidden test passed. Practice complete."
        : "Every hidden test passed. The server is resolving receipt order.",
    WRONG_ANSWER: "At least one hidden result did not match.",
    COMPILE_ERROR:
      "Compilation failed. Review the function contract and syntax.",
    RUNTIME_ERROR: "The solution stopped with a runtime error.",
    TIME_LIMIT: "The solution exceeded its execution limit.",
    MEMORY_LIMIT: "The solution exceeded its memory limit.",
    OUTPUT_LIMIT: "The solution produced more output than the judge allows.",
    INFRASTRUCTURE_ERROR: "The judge was unavailable. No cooldown was applied.",
  };
  return {
    verdict: mappedVerdict,
    passed: Number(summary.passedCount ?? 0),
    total: Number(summary.totalCount ?? 0),
    ...(typeof summary.runtimeMs === "number"
      ? { runtimeMs: summary.runtimeMs }
      : {}),
    message: messages[mappedVerdict] ?? "The judge returned a result.",
  };
}

function matchResult(
  snapshot: MatchSnapshot,
  self: PlayerSnapshot,
): MatchResult | null {
  if (!snapshot.finishedAt || !snapshot.endReason || !self.outcome) return null;
  const outcome: MatchResult["outcome"] =
    self.outcome === "WIN"
      ? "WIN"
      : self.outcome === "LOSS"
        ? "LOSS"
        : self.outcome === "NO_CONTEST"
          ? "NO_CONTEST"
          : self.outcome === "CANCELLED"
            ? "CANCELLED"
            : "DRAW";
  const start = snapshot.startsAt
    ? Date.parse(snapshot.startsAt)
    : Date.parse(snapshot.finishedAt);
  return {
    outcome,
    endReason: snapshot.endReason,
    winnerUsername: snapshot.winnerUsername,
    durationMs: Math.max(0, Date.parse(snapshot.finishedAt) - start),
  };
}

export async function presentRoomSnapshot(input: {
  actorUserId: string;
  inviteToken: string;
  snapshot: MatchSnapshot;
  db: Database;
  matches: MatchEngine;
  appOrigin: string;
}): Promise<RoomSnapshot> {
  const { actorUserId, inviteToken, db, matches } = input;
  let snapshot = input.snapshot;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const eventFloor = Math.max(0, snapshot.version - 40);
    const [executions, events] = await Promise.all([
      db<ExecutionViewRow[]>`
        SELECT kind, status, verdict, result_summary
        FROM executions
        WHERE match_id = ${snapshot.matchId} AND clerk_user_id = ${actorUserId}
        ORDER BY server_sequence DESC
        LIMIT 20
      `,
      matches.eventsSince(actorUserId, snapshot.matchId, eventFloor, 50),
    ]);
    const verified = await matches.getSnapshot(actorUserId, snapshot.roomId);
    if (
      verified.matchId !== snapshot.matchId ||
      verified.version !== snapshot.version
    ) {
      snapshot = verified;
      continue;
    }

    const self = verified.players.find((player) => player.isSelf);
    if (!self) {
      throw new Error("Authorized snapshot did not contain the current player");
    }
    const opponent = verified.players.find((player) => !player.isSelf) ?? null;
    const latestRun = executions.find((execution) => execution.kind === "RUN");
    const latestSubmit = executions.find(
      (execution) => execution.kind === "SUBMIT",
    );
    const latestExecution = executions[0];
    const appOrigin = input.appOrigin.replace(/\/$/, "");
    return {
      roomCode: inviteToken,
      ...(verified.mode === "DUEL"
        ? { inviteUrl: `${appOrigin}/join/${encodeURIComponent(inviteToken)}` }
        : {}),
      matchId: verified.matchId,
      mode: verified.mode,
      roundNumber: verified.roundNumber,
      version: verified.version,
      serverNow: verified.serverTimestamp,
      state: verified.state,
      difficulty: verified.difficulty,
      startsAt: verified.startsAt,
      finishedAt: verified.finishedAt,
      rematchDeadline: verified.rematchDeadline,
      self: playerHud(self, verified.state, verified.rematchVotes),
      opponent: opponent
        ? playerHud(opponent, verified.state, verified.rematchVotes)
        : null,
      problem: verified.problem ? presentProblem(verified.problem) : null,
      activity: activityFeed(events, self.slot, verified.mode),
      latestExecution: latestExecution
        ? {
            kind: latestExecution.kind,
            status:
              latestExecution.status === "COMPLETED" ? "COMPLETE" : "RUNNING",
          }
        : null,
      sampleRun: latestRun
        ? {
            status: latestRun.status === "COMPLETED" ? "COMPLETE" : "RUNNING",
            results: sampleResults(latestRun.result_summary),
          }
        : null,
      lastSubmission: submissionSummary(latestSubmit, verified.mode),
      result: matchResult(verified, self),
    };
  }
  throw new Error(
    "Match state changed too quickly to present a coherent snapshot",
  );
}
