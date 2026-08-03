# LeetBattle

LeetBattle supports private two-player coding duels and single-player Practice
Mode. Duels share one server-owned start time and award the earliest accepted
submission; practice sessions use the same hidden judge without an opponent or
any change to the player's win/loss record.

This repository is a standalone application. It does not use or modify any sibling game or the shared stats API.

## Prerequisites

- Node.js 22 and npm 10+
- Docker Engine or Docker Desktop with the standard `/var/run/docker.sock`
- A PostgreSQL 18-compatible database (the Compose setup supplies one)
- A Clerk application with two test accounts
- About 4 GB of memory available to Docker for the web, database, and isolated judge containers

The supplied runner invokes the Docker CLI and the Compose topology mounts the
standard Docker Engine socket. Podman and rootless Docker socket layouts are not
supported without adapting the runner command and socket mount.

## Local setup

1. Copy `.env.example` to `.env.local` for host development. If you will run
   any Docker Compose command, also copy it to `.env`: Compose does not read
   `.env.local` and validates the project's required secrets before starting a
   selected service.
2. Add the existing Clerk publishable and secret keys. Compose rejects missing
   Clerk keys. Do not add keys to source control.
3. Replace all four internal-secret placeholders. Generate each value
   independently with `openssl rand -base64 32`; startup rejects the published
   placeholders, values shorter than 32 bytes, and reused values.
4. Install dependencies and build the pinned execution images:

   ```bash
   npm ci
   npm run runner:images
   ```

5. Start PostgreSQL, migrate, and seed the seven public problem records:

   ```bash
   docker compose up -d postgres
   npm run db:migrate
   npm run db:seed
   ```

6. Start the web app, WebSocket service, and isolated runner service:

   ```bash
   npm run dev
   ```

Open [http://localhost:3000](http://localhost:3000). Add `http://localhost:3000` to the allowed development origins in the reused Clerk instance. Sign in with two different accounts in separate browser profiles to exercise the complete flow.

`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and `NEXT_PUBLIC_REALTIME_URL` are embedded
in browser assets during `next build`. Set their final values before building
an image; changing only the running container's environment does not update
those assets. When overriding `REALTIME_PORT`, also set
`NEXT_PUBLIC_REALTIME_URL` to the browser-reachable URL using that port.
The repository pins the public production WebSocket endpoint in
`.env.production` so remote production builds cannot silently fall back to
polling. A process-level value still overrides it for staging or another
deployment target.

To run everything through Docker after building the two judge images:

```bash
docker compose up --build
```

Compose waits for PostgreSQL, applies migrations, idempotently seeds the seven
problem records, verifies the runner process, Docker daemon, and both judge
images, and then admits the realtime and web services. The runner container
mounts the local Docker socket but does not publish its HTTP port to the host.
PostgreSQL is published on loopback only for the host-development commands
above. See the security boundary below before deploying.

## Commands

| Command                    | Purpose                                                                                     |
| -------------------------- | ------------------------------------------------------------------------------------------- |
| `npm run dev`              | Start Next.js, the WebSocket service, and the runner service                                |
| `npm run db:migrate`       | Apply idempotent SQL migrations                                                             |
| `npm run db:seed`          | Register exactly seven public problem records idempotently                                  |
| `npm run runner:images`    | Build the pinned Python 3.13 and Java 21 execution images                                   |
| `npm run format:check`     | Check formatting                                                                            |
| `npm run lint`             | Run ESLint, including React and accessibility rules                                         |
| `npm run typecheck`        | Run strict TypeScript checking                                                              |
| `npm test`                 | Run unit and integration tests; Docker/DB suites skip with a stated reason when unavailable |
| `npm run test:coverage`    | Run tests with V8 coverage                                                                  |
| `npm run test:e2e:list`    | Discover the opt-in real-browser tests without starting the stack or browser                |
| `npm run test:e2e`         | Run the environment-gated duel and solo-practice Chromium flows against the real stack      |
| `npm run test:e2e:install` | Install the pinned Playwright Chromium binary                                               |
| `npm run build`            | Create the production Next.js build                                                         |
| `npm run build:cloudflare` | Build the OpenNext Worker and scan it for private judge material                            |
| `npm run cf:typegen`       | Regenerate binding and current Workers runtime types                                        |
| `npm run deploy:runner`    | Deploy the private Cloudflare Sandbox runner Worker                                         |
| `npm run deploy:realtime`  | Deploy the WebSocket/Durable Object Worker                                                  |
| `npm run deploy:web`       | Build and deploy the OpenNext web Worker                                                    |
| `npm run check`            | Run formatting, lint, types, E2E discovery, tests, and the production build                 |

## Real browser E2E

The Playwright suite is an opt-in production-boundary check. It signs existing
users into the configured Clerk instance with Clerk's official testing helper,
then exercises the real duel and solo-practice paths: application APIs,
PostgreSQL state, WebSocket updates, Docker-backed Python and Java execution,
accepted hidden-suite submissions, winner ordering, rematch, cancellation,
history, draft restoration, and practice record isolation. Canonical source is
imported from the private problem bank only by the Node-side test process and
typed into Monaco; it is never included in an application entry point or client
bundle. The suite does not enable an application auth bypass or replace the
judge.

Before running it:

1. Use a Clerk development/test instance with two different existing users.
   The Clerk instance must match the keys used to build/run LeetBattle.
2. Build both judge images and start the complete healthy stack. For example:

   ```bash
   npm run runner:images
   docker compose up --build -d
   ```

3. Install the pinned browser once:

   ```bash
   npm run test:e2e:install
   ```

4. Set the following in `.env.local` (never commit real emails or keys):

   ```dotenv
   RUN_REAL_E2E=1
   E2E_BASE_URL=http://localhost:3000
   E2E_CLERK_HOST_EMAIL=host+clerk_test@example.com
   E2E_CLERK_GUEST_EMAIL=guest+clerk_test@example.com
   ```

   `CLERK_SECRET_KEY` and either `CLERK_PUBLISHABLE_KEY` or the app's existing
   `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` must also be available. The email values
   must identify two distinct users already present in that Clerk instance.
   `E2E_BASE_URL` must have the same origin as `APP_ORIGIN`; this preserves the
   real origin-bound Clerk session when the challenger follows the invite.
   The official helper creates real Clerk sessions using the secret key; it
   does not store account passwords or alter LeetBattle runtime behavior.

5. Run:

   ```bash
   npm run test:e2e
   ```

With `RUN_REAL_E2E` disabled or required account/key values absent, the Clerk
setup, duel, and practice tests are reported as skipped with the exact
missing prerequisite. Once explicitly enabled, an unreachable app is also
reported as a failure; broken database, realtime, or runner behavior discovered
after sign-in fails the test as well, so infrastructure regressions are not hidden.

## Architecture

```text
Browser
  ├── HTTPS + Clerk session ──> Next.js App Router/API ──> PostgreSQL
  └── short-lived one-use ticket ──> WebSocket service ──> PostgreSQL event log

Next.js API ── internal bearer secret ──> runner service
  ├── local ── fixed Docker commands ──> fresh Python/Java container
  └── production ── Sandbox SDK ──> fresh Cloudflare Sandbox VM
                                      └── trusted supervisor ──> submission child
```

- PostgreSQL is authoritative for profiles, membership, match state, commands, events, executions, results, records, reconnect deadlines, and rematch votes.
- Match commands carry idempotency keys. State changes append monotonically versioned events with database timestamps.
- The WebSocket service sends an authoritative snapshot before later event versions. It is a delivery layer, not the source of truth.
- The synchronous judge coordinator records receipt order before execution and persists completion before responding. Important transitions are not left to an untracked browser or background promise.
- Hidden fixtures and canonical solutions are isolated from the public problem catalog. Browser payloads receive only statements, samples, starter code, aggregate progress, and player-safe summaries.
- Raw submitted source is sent to the runner only for that execution. PostgreSQL retains its SHA-256 hash and bounded verdict summary, not the source itself.

## Judge and security boundary

The local Docker adapter gives each execution a new container with a fixed image
and command, no network, a non-root user, a read-only root filesystem, a bounded
temporary workspace, CPU/wall-clock/memory/PID/file/output limits, and no
application files or secrets. The production adapter uses the separate
Cloudflare VM boundary described below. Both adapters accept only Python or Java
and fixed function contracts, never interpolate source into a shell command,
and explicitly terminate submitted processes on completion or timeout.

The local images pin Python 3.13 and Java 21. Java compilation time is recorded separately from solution runtime. `Run samples` uses only published cases; `Submit solution` uses hidden cases and never returns hidden inputs, expected values, per-case identities, stack traces, or captured hidden-case output.

Authentication is checked in every protected route. Room membership is checked again for every snapshot, command, history query, and WebSocket ticket. WebSocket tickets are short-lived and single-use. Invite tokens contain 256 bits of entropy and are stored only as hashes. Usernames are unique through PostgreSQL `citext` and a database constraint.

The Docker runner is a useful local isolation boundary, but ordinary
containers—especially a development runner with access to the Docker socket—are
not hardened hostile multi-tenant production isolation. Use the prepared
Cloudflare Sandbox adapter or another purpose-built microVM sandbox in
production. Do not place the Docker socket in the public web or WebSocket
containers.

## Cloudflare deployment

The prepared Cloudflare production topology uses an OpenNext web Worker,
cache-disabled Hyperdrive to external PostgreSQL, a hibernating `RoomHub`
Durable Object per match, and a private Cloudflare Sandbox runner. Every
execution gets a fresh `standard-2` Sandbox VM with public Internet access
disabled. A fixed, root-owned supervisor runs directly in that VM, then launches
the compiler or runtime in a separate process group after dropping to UID/GID
65532, clearing capabilities, enabling `no-new-privileges`, installing hard
resource limits, replacing the environment with a fixed allowlist, closing
inherited descriptors, and loading an inherited seccomp policy that denies all
socket and `io_uring` operations. That inner policy prevents submitted code from
reaching the Sandbox control process over shared localhost; failure to install
it aborts the judge before user code starts. Hidden case arguments reach the
harness only through standard input; expected outputs and comparison remain in
the trusted Worker. Output is bounded, timed-out process groups are killed
explicitly, and the adapter always destroys the fresh Sandbox in `finally`.
This follows the same OpenNext/Wrangler conventions as the sibling `call-sheet`
and `newsle` games while keeping PostgreSQL as the authoritative match database.

The production stack is deployed at `leetbattle.cenough.games` with separate
web, realtime, and private runner Workers. The web Worker is connected to
Cloudflare Workers Builds on GitHub `main`; shared realtime code and database
migrations still require coordinated manual release steps.

Follow the copy-paste deployment order, first-deploy secret flow, Custom Domain
setup, validation, rollback, and troubleshooting guide in
[`docs/cloudflare-deployment.md`](docs/cloudflare-deployment.md). The required
order is runner, realtime, then web.

## Match guarantees

- The problem is selected in a transaction only after two different members have live realtime sessions and independently select a language and ready up.
- Practice Mode selects from the same sealed catalog after one live player locks a language; accepted practice submissions never update competitive records or history.
- One database timestamp controls countdown and reveal for both players.
- Cancellation is lobby-only and forfeit is active-only, so a sealed countdown problem cannot be exposed and rerolled before reveal.
- One active execution per player, a database-enforced two-second sample rate limit, and a ten-second failed-submit cooldown prevent client bypasses.
- Winner order is receipt timestamp, then trusted control-plane runtime for equal timestamps, then immutable server sequence. A later accepted result waits while an earlier submission is still in flight.
- Finalization and win/loss application are transactional and idempotent.
- In duels, a disconnected active player has 60 seconds to reconnect. One absent player forfeits; two absent players produce a no-contest. Accepted in-flight work remains eligible. Practice disconnects preserve the solo attempt without a forfeit deadline.
- Mutual rematch votes within 30 seconds create one fresh round, reset languages, and avoid the previous problem when another problem exists at that difficulty.

## Deployment assumptions

- Run Next.js, the WebSocket service, the runner, and PostgreSQL as separately scalable processes.
- The WebSocket and web services must reach the same PostgreSQL database. Run at least one due-transition/reconnect sweeper.
- Set the final Clerk publishable key and `wss://` realtime URL at image-build time, then rebuild whenever either public value changes.
- Set `APP_ORIGIN` to the public HTTPS origin, terminate TLS before the app, and use `wss://` for real-time traffic.
- Keep `CLERK_SECRET_KEY`, database credentials, ticket/invite secrets, and the runner bearer secret in a managed secret store.
- Restrict the runner endpoint to a private network and apply egress controls outside the execution containers as defense in depth.
- Back up PostgreSQL and monitor execution queue age, infrastructure verdicts, reconnect sweeps, and event-delivery lag without logging player source or hidden data.

## Known MVP limits

- There is no ranked/public matchmaking, spectators, chat, leaderboard, audio, mobile editor, problem authoring, or solution comparison.
- The desktop workspace requires roughly `1180 × 720`; smaller screens receive a deliberate desktop-required screen.
- LeetBattle protects server state, membership, hidden material, rate limits, and execution isolation. It cannot prevent a player from using another website, an AI tool, or another device, and does not attempt invasive monitoring.
- Clerk credentials and a Docker runtime are external prerequisites. Docker-backed canonical and adversarial judge tests explicitly skip rather than simulate execution when Docker is unavailable.

The compact visual system and desktop layout rationale are documented in [`docs/design-system.md`](docs/design-system.md).
