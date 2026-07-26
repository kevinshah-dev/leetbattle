# LeetBattle authoritative backend

The Next.js application authenticates with Clerk, then passes the authenticated Clerk `userId` into the server services. `src/server/auth.ts` is the route boundary; every match service method independently verifies profile, room, or participant membership. The browser never supplies an identity, slot, start time, cooldown, progress value, or winner.

## Persistence and concurrency

PostgreSQL is the source of truth. `db/migrations/001_initial.sql` stores profiles, case-insensitive usernames, room membership, matches, participants, source-hash-only execution summaries, rematch votes, events, command receipts, realtime sessions, and records. Important mutations lock the match row and run in one transaction.

- Every client mutation has an idempotency key bound to actor, command type, match, and canonical payload hash.
- Match events increment the persisted match version and receive a timestamp strictly later than the preceding event timestamp in the same transaction.
- Submission receipt time and an immutable database sequence are recorded before code crosses the runner trust boundary.
- An accepted candidate cannot finalize while a submission with an earlier (or equal) receipt timestamp is unresolved. Equal timestamps use judge runtime, then server sequence.
- Finalization, participant outcomes, and win/loss increments share one match-row-locked transaction. Replayed callbacks see the completed execution and cannot update records twice.
- Raw source is sent directly to the isolated runner and is never inserted into the application database. Only SHA-256 and byte length are retained.

## Match lifecycle

The persisted lifecycle is `LOBBY → COUNTDOWN → ACTIVE → FINISHED → REMATCH_PENDING`. Ready-up requires a fresh persisted realtime session, and the selected problem is chosen only in the transaction that observes two live, ready players with fixed languages. Countdown events contain only `startsAt`; snapshots and events omit the problem until server time activates the match. Once selection begins, cancellation and forfeit are unavailable until the match is active, preventing a sealed problem from becoming a pre-reveal reroll oracle.

Incorrect submissions create a ten-second database cooldown. Infrastructure failures receive one safe retry and no cooldown. Sample runs are rate-limited to one every two seconds and never update the opponent-visible hidden-test progress.

A room can have exactly two service-assigned slots. Multiple realtime sessions per player are supported. The final session disconnect starts a persisted 60-second deadline measured from the explicit close or last heartbeat; reconnect clears it. A single expired disconnect forfeits to a connected opponent, while two expired disconnects produce a no-contest. Pending submissions delay disconnect resolution so a valid in-flight acceptance remains eligible.

Both players may cast one persisted rematch vote during the 30-second window. The second vote creates one new round through a unique `(room_id, round_number)` constraint, copies membership only, and resets language, readiness, problem, execution, and progress.

## Runner and realtime boundaries

`ExecutionCoordinator` calls the replaceable `RunnerAdapter`. The local HTTP adapter sends a fixed request to `RUNNER_URL/v1/execute` with an internal bearer secret. Submit diagnostics are discarded at this boundary; only aggregate verdict/count/timing data is persisted or broadcast.

The websocket service listens on port `3001` by default. An authenticated HTTP route issues a 45-second HS256 ticket after membership validation. Admission verifies audience, issuer, expiry, membership, active match, and slot, then atomically consumes the ticket JTI so it cannot be replayed. The service persists the connection before sending a full authoritative snapshot. Only after that snapshot is sent are buffered commands processed; subsequent durable events are delivered in version order.

Required runtime configuration is `DATABASE_URL` plus pairwise-distinct `REALTIME_TICKET_SECRET`, `RUNNER_INTERNAL_SECRET`, and `ROOM_INVITE_SECRET` values of at least 32 bytes each. Published placeholder sentinels fail closed. `RUNNER_URL`, `REALTIME_PORT`, and pool size have local defaults or optional overrides. Local container execution is a development trust boundary, not hardened multi-tenant isolation.
