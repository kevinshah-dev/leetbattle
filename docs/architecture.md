# LeetBattle authoritative backend

The Next.js application authenticates with Clerk, then passes the authenticated Clerk `userId` into the server services. `src/server/auth.ts` is the route boundary; every match service method independently verifies profile, room, or participant membership. The browser never supplies an identity, slot, start time, cooldown, progress value, or winner.

## Persistence and concurrency

PostgreSQL is the source of truth. The ordered files in `db/migrations/` store
profiles, case-insensitive usernames, room mode and membership, matches,
participants, source-hash-only execution summaries, rematch votes, events,
command receipts, realtime sessions, records, and versioned AI/ML questions,
answers, and evaluations. Important mutations lock the match row and run in one
transaction.

- Every client mutation has an idempotency key bound to actor, command type, match, and canonical payload hash.
- Match events increment the persisted match version and receive a timestamp strictly later than the preceding event timestamp in the same transaction.
- Submission receipt time and an immutable database sequence are recorded before code crosses the runner trust boundary.
- An accepted candidate cannot finalize while a submission with an earlier (or equal) receipt timestamp is unresolved. Equal timestamps use judge runtime, then server sequence.
- Finalization, participant outcomes, and win/loss increments share one match-row-locked transaction. Replayed callbacks see the completed execution and cannot update records twice.
- Raw source is sent directly to the isolated runner and is never inserted into the application database. Only SHA-256 and byte length are retained.
- AI/ML final answers are different: their normalized raw text is retained for
  participant-authorized history. One final answer is allowed per participant,
  and database triggers make answers and evaluation snapshots immutable.
- Every AI/ML evaluation pins the question version, rubric hash, prompt/schema
  versions, requested model, and anonymous A/B mapping. One worker claims the
  evaluation, and a late provider response cannot replace a completed result.

## Match lifecycle

Duels use `LOBBY → COUNTDOWN → ACTIVE → FINISHED → REMATCH_PENDING`.
Practice sessions use the same lifecycle through `FINISHED` and stop there.
Ready-up requires a fresh persisted realtime session, and the selected problem
is chosen only in the transaction that observes all required participants—two
for a duel or one for practice—live, ready, and holding a fixed language.
Countdown events contain only `startsAt`; snapshots and events omit the problem
until server time activates the match. Once selection begins, cancellation is
unavailable until the match is active, preventing a sealed problem from
becoming a pre-reveal reroll oracle.

Incorrect submissions create a ten-second database cooldown. Infrastructure failures receive one safe retry and no cooldown. Sample runs are rate-limited to one every two seconds and never update the opponent-visible hidden-test progress.

A duel room can have exactly two service-assigned slots; a practice room has one
and rejects joins. Multiple realtime sessions per player are supported. In a
duel, the final session disconnect starts a persisted 60-second deadline
measured from the explicit close or last heartbeat; reconnect clears it. A
single expired disconnect forfeits to a connected opponent, while two expired
disconnects produce a no-contest. Practice disconnects preserve the solo
attempt without starting a forfeit deadline. Pending duel submissions delay
disconnect resolution so a valid in-flight acceptance remains eligible.

Both players may cast one persisted rematch vote during the 30-second window. The second vote creates one new round through a unique `(room_id, round_number)` constraint, copies membership only, and resets language, readiness, problem, execution, and progress.

AI/ML is an orthogonal challenge type, not another match mode. Its duel and
practice rounds follow `LOBBY → COUNTDOWN → ACTIVE → JUDGING → FINISHED` (and
duels may then enter `REMATCH_PENDING`). The server selects an active,
difficulty-matched versioned question while the countdown remains sealed and
reveals it only at `ACTIVE`. A persisted ten-minute answer deadline, Durable
Object alarm, and global recovery sweep resolve the round without relying on an
open browser.

AI/ML answers are normalized and bounded at 500 words, 12,000 characters, and
24,000 UTF-8 bytes. Opponents receive only submission state before finalization.
One blank duel answer loses automatically; two blanks are a 0–0 no-contest; a
blank practice answer scores zero. Two blanks and blank practice do not call the
provider. Practice, no-contest, and judge failure never update shared records.
Completed duel outcomes and the single record update are committed atomically.

## Runner and realtime boundaries

`ExecutionCoordinator` calls the replaceable `RunnerAdapter`. The local HTTP adapter sends a fixed request to `RUNNER_URL/v1/execute` with an internal bearer secret. Submit diagnostics are discarded at this boundary; only aggregate verdict/count/timing data is persisted or broadcast.

The websocket service listens on port `3001` by default. An authenticated HTTP route issues a 45-second HS256 ticket after membership validation. Admission verifies audience, issuer, expiry, membership, active match, and slot, then atomically consumes the ticket JTI so it cannot be replayed. The service persists the connection before sending a full authoritative snapshot. Only after that snapshot is sent are buffered commands processed; subsequent durable events are delivered in version order.

Shared runtime configuration is `DATABASE_URL` plus pairwise-distinct
`REALTIME_TICKET_SECRET`, `RUNNER_INTERNAL_SECRET`, `ROOM_INVITE_SECRET`, and
`REALTIME_NOTIFY_SECRET` values of at least 32 bytes each. Published placeholder
sentinels fail closed. AI/ML judging runtimes additionally receive
`OPENAI_API_KEY`, `OPENAI_JUDGE_MODEL`, and identical global/per-user/per-match
outbound-attempt circuit limits;
the coding runner does not. `RUNNER_URL`, `REALTIME_PORT`, and pool size have
local defaults or optional overrides. Local container execution is a
development trust boundary, not hardened multi-tenant isolation.

## AI/ML judge, privacy, and recovery boundary

Web requests and realtime deadline alarms can claim an AI/ML evaluation. They
load the private rubric and versioned judge instructions from PostgreSQL, never
from the seed-only source modules, and invoke the official server-side OpenAI
SDK through the Responses API. The coding runner is not in this path and never
receives OpenAI configuration.

The outbound snapshot contains anonymous Answer A/Answer B text and no player
identity, slot, record, rating, or submission order. Instructions and serialized
untrusted data occupy separate messages. Requests use strict Structured Outputs,
`store: false`, no tools, low reasoning effort, and a fixed output limit. Zod
and semantic validation run after the SDK parse; server code calculates totals
and official tie-adjusted scores.

One valid response ends evaluation. Recoverable transport, refusal, incomplete,
schema, or semantic failures can retry the exact same snapshot at most three
total attempts with bounded timeouts and backoff. Exhaustion preserves answers
in a recoverable failed-judge state and makes no record change; a genuinely
non-retryable failure finishes as `JUDGE_FAILED`/no-contest. Recovery is
idempotent and rate-limited. The PostgreSQL rolling-24-hour request circuit
defaults to 1,000 outbound attempts globally, 50 per participant, and 6 per
match/evaluation, and opens into the same recoverable failure path.

Only an authenticated match participant can retrieve retained raw answers and
detailed judgment history; an invite alone is insufficient. The application
has no automatic TTL for those records, so they remain with match history until
authorized deletion. Logs and pre-result realtime events exclude answer text,
private references/rubrics, complete judge instructions, provider raw output,
and secret values. See [AI/ML Arena operations and data contract](ai-ml-arena.md)
for versioning, configuration, retention, and release checks.
