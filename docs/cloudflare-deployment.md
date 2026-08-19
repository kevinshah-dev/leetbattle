# Deploy LeetBattle to Cloudflare

This runbook deploys the repository's Cloudflare production topology:

- `leetbattle-web`: the Next.js application compiled as an OpenNext Worker.
- `leetbattle-realtime`: the public WebSocket edge Worker and its per-room
  `RoomHub` Durable Objects.
- `leetbattle-runner`: a private Worker that creates one fresh,
  internet-disabled Cloudflare Sandbox VM for each judge request. A trusted
  supervisor in that VM launches the submission as an unprivileged child.
- OpenAI Responses API judging for written AI/ML rounds, called only by the web
  Worker and realtime deadline/recovery Worker. It is not part of the runner.
- `HYPERDRIVE_FRESH`: one cache-disabled Hyperdrive configuration shared by
  the web and realtime Workers and backed by an external PostgreSQL database.

The commands assume the repository is at
`/Users/kevinshah/Desktop/cegames/leetbattle`, the `cenough.games` zone is in
the authenticated Cloudflare account, and the intended production hostnames
are:

| Surface  | Production address                         | Internet exposure |
| -------- | ------------------------------------------ | ----------------- |
| Web      | `https://leetbattle.cenough.games`         | Public            |
| Realtime | `wss://ws.leetbattle.cenough.games/socket` | Public            |
| Runner   | `RUNNER_SERVICE` → `leetbattle-runner`     | Private binding   |
| Database | `HYPERDRIVE_FRESH` → external PostgreSQL   | Worker binding    |
| AI judge | OpenAI Responses API                       | Server outbound   |

The checked-in Wrangler files are the source of truth for Worker names,
bindings, routes, compatibility settings, observability, Durable Object class
lifecycle, and container settings. Do not duplicate or override those settings
in the dashboard without immediately reconciling the files.

The web build follows Cloudflare's
[Next.js/OpenNext deployment model](https://developers.cloudflare.com/workers/framework-guides/web-apps/nextjs/)
and the repository-pinned OpenNext adapter rather than Pages.

## Current production preflight

As of **August 19, 2026**, Workers Paid, Containers, Docker, the three Workers,
their routes and service bindings, and the cache-disabled `HYPERDRIVE_FRESH`
configuration are present. The existing web, realtime, runner, and coding
surfaces pass their unauthenticated HTTP boundary checks.

Before releasing AI/ML Arena, resolve these operator-owned prerequisites:

1. Install `OPENAI_API_KEY` as a secret on `leetbattle-web` and
   `leetbattle-realtime`. It is intentionally absent from the runner. Wrangler
   secrets are write-only and Worker-scoped, so obtain the key from the
   operator's OpenAI project or password manager; it cannot be copied back out
   of another Worker.
2. Create and record a PostgreSQL snapshot or portable logical backup before
   applying migrations `004_ai_ml_arena` and
   `005_ai_ml_judge_request_budget`.
3. Use the current `leetbattle2` database configuration. The older
   `.env.database.production.local` file targets a retired, quota-blocked
   database and must not be used. Parse the owner URL from
   `.env.database.leetbattle2.local` and change only its pathname to
   `/leetbattle` for migration and seed commands.

The local `psql` and `pg_dump` clients are optional but useful for independent
verification and a logical backup. Install the client-only package when needed:

```bash
brew install libpq
export PATH="$(brew --prefix libpq)/bin:$PATH"
psql --version
pg_dump --version
```

Alternatively, use a pinned PostgreSQL client container without placing the
database password in shell history or command arguments. The application itself
uses Postgres.js and does not require these binaries at runtime.

Reconfirm the control-plane and local prerequisites before every release:

```bash
cd /Users/kevinshah/Desktop/cegames/leetbattle
npx wrangler whoami
npx wrangler containers list
npx wrangler hyperdrive list
docker info
npx wrangler secret list -c wrangler.jsonc
npx wrangler secret list -c cloudflare/realtime/wrangler.jsonc
npx wrangler secret list -c cloudflare/runner/wrangler.jsonc
```

The web and realtime inventories must include `OPENAI_API_KEY`; the runner
inventory must not. Secret values must never be printed during this check.

## Architecture and deployment invariants

```text
Browser
  ├─ HTTPS + Clerk session ───────────────> leetbattle-web (OpenNext Worker)
  │                                           ├─ HYPERDRIVE_FRESH ─> PostgreSQL
  │                                           ├─ OpenAI Responses API (AI/ML only)
  │                                           ├─ RUNNER_SERVICE ───> leetbattle-runner
  │                                           │                         └─ JudgeSandbox
  │                                           │                            └─ one ephemeral,
  │                                           │                               internet-disabled VM
  │                                           │                                  └─ trusted supervisor
  │                                           │                                     └─ UID/GID 65532 child
  │                                           └─ REALTIME_SERVICE ─> internal notify
  │
  └─ WSS + short-lived one-use ticket ───> leetbattle-realtime
                                              ├─ RoomHub Durable Object
                                              ├─ HYPERDRIVE_FRESH ─> PostgreSQL
                                              └─ OpenAI Responses API (deadline/recovery)
```

Keep these invariants intact:

1. PostgreSQL remains authoritative for profiles, match state, events,
   executions, results, reconnect deadlines, and history. `RoomHub` coordinates
   WebSocket delivery; it is not an alternative match database.
2. The web and realtime Workers must use the **same** Hyperdrive ID.
3. Hyperdrive query caching must remain disabled. Match reads require
   read-after-write freshness, and Hyperdrive does not invalidate cached reads
   after application writes. See
   [Hyperdrive query caching](https://developers.cloudflare.com/hyperdrive/concepts/query-caching/).
4. Database migrations and seeds use a direct PostgreSQL URL from a trusted
   operator or CI environment. They never run through a Worker binding or
   Hyperdrive.
5. The runner has no public route, `workers.dev` address, or preview URL. The web
   Worker reaches it only through a
   [Service binding](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/).
6. The runner is deployed first, realtime second, and web last. Cloudflare
   requires a Service-binding target to exist before deploying its caller.
7. `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` and
   `NEXT_PUBLIC_REALTIME_URL` are build-time inputs. Changing a deployed secret
   does not rewrite already-built browser assets.
8. A Worker version contains its code, static assets, bindings, compatibility
   settings, and secret binding values. Rolling back activates those values from
   the target version. It does not rewind PostgreSQL rows, Durable Object
   storage, Hyperdrive resource settings, or other backing-resource state. Keep
   every resource referenced by a retained Worker version for the full rollback
   window.
9. `src/server/match/match-engine.ts` is bundled into both the web and realtime
   Workers. Deploy realtime before web whenever this shared match code changes,
   even if no file under `cloudflare/realtime/` changed.
10. `OPENAI_API_KEY` is a secret on web and realtime only. The runner, browser,
    database, logs, and build-time public environment must never receive it.
    Both judging Workers use the same checked-in model and rolling-24-hour
    global, per-user, and per-match outbound-attempt circuit limits.

## Repository deployment map

| Concern             | File or command                        |
| ------------------- | -------------------------------------- |
| OpenNext web config | `wrangler.jsonc`                       |
| OpenNext adapter    | `open-next.config.ts`                  |
| Realtime Worker     | `cloudflare/realtime/wrangler.jsonc`   |
| Runner Worker       | `cloudflare/runner/wrangler.jsonc`     |
| Hyperdrive helper   | `scripts/configure-cloudflare.mjs`     |
| SQL migrations      | `db/migrate.ts`, `db/migrations/*.sql` |
| Problem seed        | `db/seed.ts`                           |
| AI/ML operations    | `docs/ai-ml-arena.md`                  |
| Build web           | `npm run build:cloudflare`             |
| Deploy runner       | `npm run deploy:runner`                |
| Deploy realtime     | `npm run deploy:realtime`              |
| Deploy web          | `npm run deploy:web`                   |
| Validate bundles    | `npm run dry-run:cloudflare`           |
| Generate env types  | `npm run cf:typegen`                   |

The web Worker binds:

- `ASSETS` for `.open-next/assets`.
- `HYPERDRIVE_FRESH` for PostgreSQL.
- `RUNNER_SERVICE` to `leetbattle-runner`.
- `REALTIME_SERVICE` to `leetbattle-realtime`.

The realtime Worker binds `ROOM_HUB` and `HYPERDRIVE_FRESH`. The runner binds
`JUDGE_SANDBOX` to its `JudgeSandbox` class and container. Both Durable Object
classes use declarative SQLite `exports` lifecycle entries in their respective
Wrangler files. The runner uses Sandbox SDK RPC transport, a `standard-2`
container, and a checked-in ceiling of 10 concurrent instances.

## 1. Prerequisites and preflight

You need:

- Workers Paid enabled on the target account.
- Permission to deploy Workers, Durable Objects, Containers, Hyperdrive, secrets,
  routes, and Custom Domains in that account.
- The `cenough.games` zone active in the same account.
- Node.js 22 and npm 10 or newer.
- PostgreSQL's `psql` client for TLS, role, migration, and seed verification.
- The repository's pinned Wrangler and OpenNext dependencies installed with
  `npm ci`.
- Docker running locally. Wrangler builds and pushes the Sandbox image during
  runner deployment; Cloudflare documents this requirement in the
  [Sandbox getting-started guide](https://developers.cloudflare.com/sandbox/get-started/).
- An externally reachable PostgreSQL database with TLS, backups, and enough
  connections for Hyperdrive.
- Access to the existing Clerk application and its production publishable and
  secret keys.
- Two different Clerk test accounts for the final two-player smoke test, plus
  an optional third account for the room-capacity rejection check.

Run the non-mutating checks:

```bash
cd /Users/kevinshah/Desktop/cegames/leetbattle

node --version
npm --version
npm ci
npx wrangler --version
npx wrangler whoami
docker info
npx wrangler containers list
npx wrangler hyperdrive list
```

Verify that `wrangler whoami` selected the intended account. If multiple
Cloudflare profiles or accounts are available, stop until the account that owns
`cenough.games` is unambiguous.

Before the first Custom Domain deployment, confirm neither hostname is occupied
by an unrelated DNS record or Worker:

```bash
dig +short leetbattle.cenough.games
dig +short ws.leetbattle.cenough.games
```

Existing results are not automatically wrong, but investigate them. A
[Cloudflare Custom Domain](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)
cannot be created on a hostname with a conflicting CNAME. Wrangler will create
the required DNS record and certificate from the checked-in `routes` entries;
do not pre-create placeholder CNAMEs.

## 2. Prepare the external PostgreSQL database

Use a dedicated production database with two different roles:

- A migration owner that can apply DDL and run the trusted problem seed.
- A restricted runtime role for Hyperdrive with only the schema usage, table
  DML, and sequence privileges the running application needs. It must not own
  the schema or be able to create, alter, or drop application objects.

Do not use the migration owner as the Hyperdrive origin credential. The
database must accept TLS connections from Hyperdrive. If it is firewalled,
allow the connectivity model supported by the provider; a database that accepts
only loopback or private VPC traffic without a supported Cloudflare connection
path will fail Hyperdrive's creation-time connection test.

Here, "externally reachable" means that the database has a real DNS hostname
and TCP port that Cloudflare Hyperdrive can reach from Cloudflare's network. It
must not be a PostgreSQL server available only as `localhost`, only inside the
development Compose network, or only inside a private VPC with no configured
Cloudflare connection path. This does not mean the data is anonymous or
publicly readable: the endpoint must still require a strong password, TLS,
certificate and hostname verification, and the restricted runtime role.

Create the runtime login through an interface that does not silently grant it
provider-administrator membership. Prefer an interactive `psql` session so its
password never appears in shell history, SQL history, or a process argument.
Use the name `leetbattle_runtime` unless the provider assigns one. The
migration login must own the application schema objects; the runtime login must
not be a superuser, database owner, schema owner, member of the migration role,
or member of a managed-provider administrator role.

### Recommended concrete setup: Neon

Neon is the simplest default for this deployment because it provides a managed,
Internet-reachable PostgreSQL endpoint and is a documented Hyperdrive provider.
The other games in this repository use Cloudflare D1 or no database; there is
no existing external-PostgreSQL provider convention to copy.

1. Create a Neon project named `leetbattle-prod`. Use the paid Launch plan for
   production, choose PostgreSQL 17 (the newest major currently listed in
   Cloudflare's
   [supported PostgreSQL range](https://developers.cloudflare.com/hyperdrive/reference/supported-databases-and-features/)),
   select the region closest to the majority of players, and treat its default
   branch as the production branch (rename it to `production` if desired). The
   Free plan is useful for a trial but provides only a short restore window.
2. In **Branches -> your production branch -> Roles & Databases**, create a
   database named `leetbattle`. Select the project's default owner role
   (normally `neondb_owner`) as the database owner. This powerful login is the
   migration owner. Save its password in a password manager and never give this
   login to Hyperdrive or a Worker.
3. In Neon's **Connect** dialog, select the production branch, the `leetbattle`
   database, and the owner role. Select the `psql` connection type and turn
   Neon's connection pooling off. The direct hostname must not contain
   `-pooler`; Hyperdrive provides the production connection pool.
4. Connect with the direct hostname. Homebrew installed this repository's
   required client as a keg-only formula, so use its explicit path or export
   that directory for the current terminal:

   ```bash
   export PATH="/opt/homebrew/opt/libpq/bin:$PATH"

   psql \
     "host=YOUR_DIRECT_NEON_HOST port=5432 dbname=leetbattle user=neondb_owner sslmode=verify-full sslrootcert=system"
   ```

   Enter the owner password only at the prompt. Do not put it directly in this
   command.

5. At the interactive `psql` prompt, create a login with no inherited or
   elevated capabilities. Set its password with `\password`, which prompts
   securely instead of putting the cleartext password in SQL or command
   history:

   ```sql
   CREATE ROLE leetbattle_runtime
     NOLOGIN
     NOINHERIT
     NOSUPERUSER
     NOCREATEDB
     NOCREATEROLE
     NOREPLICATION
     NOBYPASSRLS;

   \password leetbattle_runtime
   ALTER ROLE leetbattle_runtime LOGIN;
   ```

   Generate and save a unique password in a password manager before responding
   to the two prompts. A URL-safe 64-character hexadecimal password is suitable.

6. Do not create `leetbattle_runtime` with Neon's normal **Roles** UI, Neon CLI,
   or Neon API. Neon grants roles created through those interfaces membership
   in `neon_superuser`. Neon documents that
   [roles created with SQL do not receive that membership](https://neon.com/docs/reference/compatibility).
   The Cloudflare
   [Neon integration guide](https://developers.cloudflare.com/hyperdrive/examples/connect-to-postgres/postgres-database-providers/neon/)
   confirms that Hyperdrive should use the direct, non-Neon-pooled endpoint.
7. Before migrations, open **Settings -> Instant restore** and set the Launch
   restore window to seven days. Protect the production branch. If scheduled
   snapshots are available on the selected plan, schedule a daily snapshot as
   an additional recovery point.

Create an ignored, operator-only database file without exposing it during file
creation:

```bash
cd /Users/kevinshah/Desktop/cegames/leetbattle
umask 077
touch .env.database.production.local
chmod 600 .env.database.production.local
```

Put the two direct URLs in `.env.database.production.local`:

```dotenv
MIGRATION_DATABASE_URL="postgresql://MIGRATION_OWNER:PERCENT_ENCODED_PASSWORD@HOST:5432/leetbattle?sslmode=verify-full&sslrootcert=system"
HYPERDRIVE_DATABASE_URL="postgresql://RUNTIME_USER:PERCENT_ENCODED_PASSWORD@HOST:5432/leetbattle"
RUNTIME_DATABASE_ROLE="leetbattle_runtime"
```

Percent-encode reserved characters in the usernames or passwords. Use
`verify-full` with the provider's trusted CA whenever the provider supports it.
Configure the provider CA for the migration client when it is not in the
client's trust store. Upload the verified signing CA to Hyperdrive for
`verify-full`, whether the provider uses a public or private CA, rather than
weakening hostname or certificate verification. Never commit this file, and
never put either URL in Worker secrets or browser build variables.

Read the migration URL with Node's dotenv parser instead of sourcing the file as
shell code. A subshell guarantees that the value disappears after this database
step, including when a command fails:

```bash
(
  set -e
  MIGRATION_DATABASE_URL="$(
    node --env-file=.env.database.production.local \
      -e 'process.stdout.write(process.env.MIGRATION_DATABASE_URL ?? "")'
  )"
  test -n "$MIGRATION_DATABASE_URL"

  psql "$MIGRATION_DATABASE_URL" \
    -v ON_ERROR_STOP=1 \
    -c 'select current_database(), current_user, now();'
  DATABASE_URL="$MIGRATION_DATABASE_URL" npm run db:migrate
  DATABASE_URL="$MIGRATION_DATABASE_URL" npm run db:seed

  psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
SELECT version, applied_at
FROM schema_migrations
ORDER BY version;

SELECT difficulty, count(*) AS active_problems
FROM problem_registry
WHERE active
GROUP BY difficulty
ORDER BY difficulty;
SQL
)
```

The final query must report exactly `EASY=2`, `MEDIUM=3`, and `HARD=2`.

After every currently checked-in migration has run, grant the runtime role only
the privileges used by the application. Run this block as the migration owner.
It safely quotes the configured role as a PostgreSQL identifier instead of
interpolating it into SQL:

```bash
(
  set -e
  MIGRATION_DATABASE_URL="$(
    node --env-file=.env.database.production.local \
      -e 'process.stdout.write(process.env.MIGRATION_DATABASE_URL ?? "")'
  )"
  RUNTIME_DATABASE_ROLE="$(
    node --env-file=.env.database.production.local \
      -e 'process.stdout.write(process.env.RUNTIME_DATABASE_ROLE ?? "")'
  )"
  test -n "$MIGRATION_DATABASE_URL"
  test -n "$RUNTIME_DATABASE_ROLE"

  psql "$MIGRATION_DATABASE_URL" \
    -v ON_ERROR_STOP=1 \
    -v runtime_role="$RUNTIME_DATABASE_ROLE" <<'SQL'
SELECT format(
  'GRANT CONNECT ON DATABASE %I TO %I',
  current_database(),
  :'runtime_role'
) \gexec

-- This is a dedicated application database. Removing PUBLIC schema creation
-- prevents the runtime login from regaining DDL through its implicit PUBLIC
-- membership. The database/schema owner retains its owner privileges.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;

SELECT format(
  'REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I',
  :'runtime_role'
) \gexec
SELECT format(
  'REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I',
  :'runtime_role'
) \gexec
SELECT format(
  'REVOKE CREATE ON SCHEMA public FROM %I',
  :'runtime_role'
) \gexec
SELECT format(
  'GRANT USAGE ON SCHEMA public TO %I',
  :'runtime_role'
) \gexec
SELECT format(
  'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO %I',
  :'runtime_role'
) \gexec
SELECT format(
  'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO %I',
  :'runtime_role'
) \gexec

-- These defaults cover tables and sequences created by later migrations run
-- by this same migration owner.
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO %I',
  current_user,
  :'runtime_role'
) \gexec
SELECT format(
  'ALTER DEFAULT PRIVILEGES FOR ROLE %I IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO %I',
  current_user,
  :'runtime_role'
) \gexec

SELECT rolname, rolsuper, rolcreaterole, rolcreatedb, rolreplication, rolbypassrls
FROM pg_roles
WHERE rolname = :'runtime_role';

-- There must be no direct role memberships. This catches managed-provider
-- administrator roles such as Neon's neon_superuser even when the direct
-- capability columns above are all false.
SELECT parent_role.rolname AS member_of
FROM pg_auth_members AS membership
JOIN pg_roles AS member_role ON member_role.oid = membership.member
JOIN pg_roles AS parent_role ON parent_role.oid = membership.roleid
WHERE member_role.rolname = :'runtime_role';
SQL
)
```

The final role row must exist and every Boolean capability shown must be
`false`. The membership query must return zero rows. If `REVOKE CREATE ON
SCHEMA public FROM PUBLIC` is rejected because the managed-provider migration
login does not own the schema, apply that one statement using the provider's
database-owner/admin console; do not skip it or grant schema ownership to the
runtime login.

Verify the restricted credential directly before giving it to Hyperdrive:

```bash
(
  set -e
  HYPERDRIVE_DATABASE_URL="$(
    node --env-file=.env.database.production.local \
      -e 'process.stdout.write(process.env.HYPERDRIVE_DATABASE_URL ?? "")'
  )"
  test -n "$HYPERDRIVE_DATABASE_URL"

  PGSSLMODE=verify-full PGSSLROOTCERT=system \
    psql "$HYPERDRIVE_DATABASE_URL" \
    -v ON_ERROR_STOP=1 <<'SQL'
SELECT current_database(), current_user, now();
SELECT count(*) AS registered_problems FROM problem_registry;
SELECT has_schema_privilege(current_user, 'public', 'USAGE') AS can_use_schema,
       has_schema_privilege(current_user, 'public', 'CREATE') AS can_create_objects,
       has_database_privilege(current_user, current_database(), 'CREATE')
         AS can_create_schemas;
SQL
)
```

That check must show seven registered problems, `can_use_schema = true`, and
both `can_create_objects = false` and `can_create_schemas = false`. Configure
the provider CA through `PGSSLROOTCERT` when it is not already trusted by the
release host.

Back up the database after migration and before opening production traffic.
LeetBattle's migration runner is forward-only; Worker rollback is not a
database rollback strategy. For Neon, create a named snapshot in **Backup &
Restore**, then make a portable logical backup from the direct endpoint:

```bash
(
  set -e
  MIGRATION_DATABASE_URL="$(
    node --env-file=.env.database.production.local \
      -e 'process.stdout.write(process.env.MIGRATION_DATABASE_URL ?? "")'
  )"
  test -n "$MIGRATION_DATABASE_URL"

  umask 077
  mkdir -p database-backups
  pg_dump "$MIGRATION_DATABASE_URL" \
    --format=custom \
    --no-owner \
    --no-acl \
    --file="database-backups/leetbattle-baseline.dump"
  pg_restore --list "database-backups/leetbattle-baseline.dump" >/dev/null
)
```

Move the dump to encrypted storage outside the database provider; a file kept
only on the release laptop is not an off-provider backup. During a maintenance
window, test restoration into a separate database or Neon branch and repeat the
migration and seven-problem verification queries. A backup is not considered
operationally verified until a restore test succeeds.

## 3. Create a cache-disabled Hyperdrive configuration

Make this step safe to resume. List the account resources first:

```bash
npx wrangler hyperdrive list
```

If exactly one existing configuration is named `leetbattle-db-fresh`, copy its
real ID, inspect it with `wrangler hyperdrive get`, and reuse it only if its
origin host, database, runtime username, TLS policy, and caching-disabled state
all match this release. If the name is ambiguous or the origin is wrong, stop;
do not silently repurpose a configuration another Worker may use.

Cloudflare's current
[Hyperdrive TLS documentation](https://developers.cloudflare.com/hyperdrive/configuration/tls-ssl-certificates-for-hyperdrive/)
requires a CA certificate upload for `verify-full`. Obtain the single root or
intermediate CA PEM that signs the actual database endpoint from the provider's
official certificate repository. Validate the endpoint chain first; do not
trust a CA copied from an unverified network connection. Neon uses publicly
trusted Let's Encrypt certificates, but the active chain can rotate, so confirm
the actual endpoint and then select the corresponding root from the official
[Let's Encrypt certificate repository](https://letsencrypt.org/certificates/).

For a Homebrew TLS trust store, this command validates the endpoint, including
its hostname, and prints the verified certificate chain:

```bash
export DATABASE_HOST='REPLACE_WITH_DIRECT_DATABASE_HOSTNAME'

openssl s_client \
  -starttls postgres \
  -connect "$DATABASE_HOST:5432" \
  -servername "$DATABASE_HOST" \
  -verify_hostname "$DATABASE_HOST" \
  -verify_return_error \
  -CAfile /opt/homebrew/etc/ca-certificates/cert.pem \
  -showcerts </dev/null
```

List existing account certificates before creating another one. Reuse one only
when its name, subject, fingerprint, and validity match the verified database
chain. Otherwise upload the provider-authenticated single-CA PEM and copy the
real UUID:

```bash
npx wrangler cert list

npx wrangler cert upload certificate-authority \
  --ca-cert /ABSOLUTE/PATH/TO/PROVIDER_CA.pem \
  --name leetbattle-postgres-origin-ca

export HYPERDRIVE_CA_CERTIFICATE_ID='REPLACE_WITH_UUID_FROM_WRANGLER'
```

If there is no matching Hyperdrive configuration, load only the restricted
runtime URL and create it:

```bash
(
  set -e
  HYPERDRIVE_DATABASE_URL="$(
    node --env-file=.env.database.production.local \
      -e 'process.stdout.write(process.env.HYPERDRIVE_DATABASE_URL ?? "")'
  )"
  test -n "$HYPERDRIVE_DATABASE_URL"
  test -n "$HYPERDRIVE_CA_CERTIFICATE_ID"

  npx wrangler hyperdrive create leetbattle-db-fresh \
    --connection-string="$HYPERDRIVE_DATABASE_URL" \
    --ca-certificate-id "$HYPERDRIVE_CA_CERTIFICATE_ID" \
    --sslmode verify-full \
    --caching-disabled
)
```

Wrangler validates the credentials and TLS policy and prints the new
configuration ID. Copy either the verified existing ID or the newly created ID
exactly:

```bash
export HYPERDRIVE_ID='REPLACE_WITH_ID_FROM_WRANGLER'
```

Although shell history records the variable name rather than its value, the
expanded connection string is briefly present in Wrangler's process arguments.
Run provisioning on a trusted single-user host or isolated CI worker. If that
exposure is unacceptable, create the configuration in the Cloudflare dashboard
or use a short-lived runtime credential and rotate it immediately after
provisioning.

The ID is not a password, but it identifies an account resource. Do not invent
one. Configure every checked-in Hyperdrive binding in one operation:

```bash
npm run cf:configure -- "$HYPERDRIVE_ID"
npm run cf:configure -- --check
```

The helper scans the root `wrangler.jsonc` and every
`cloudflare/**/wrangler.jsonc`. It replaces the exact placeholder only when it
is a `hyperdrive[*].id` value, rejects misplaced or ambiguous placeholders,
validates JSONC and ID shape, and refuses to silently rotate an already
configured ID. Multi-file writes are staged and restored if a commit fails. A
successful `--check` also verifies that all LeetBattle Hyperdrive bindings use
one ID.

Show its complete usage without changing files:

```bash
npm run cf:configure -- --help
```

Inspect the Cloudflare resource and confirm caching is disabled:

```bash
npx wrangler hyperdrive get "$HYPERDRIVE_ID"
```

If a configuration was accidentally created with caching enabled, fix the
resource before deployment. Do not update an in-use configuration until its
other consumers and the impact are understood:

```bash
npx wrangler hyperdrive update "$HYPERDRIVE_ID" --caching-disabled
```

Do not treat the local `localConnectionString` entries in Wrangler as
production credentials. They are used only by local simulation and connect
directly to local PostgreSQL; Hyperdrive pooling and caching are not active in
that mode. See
[Hyperdrive local development](https://developers.cloudflare.com/hyperdrive/configuration/local-development/).

## 4. Prepare Clerk and the public build inputs

LeetBattle reuses the existing Clerk application. For a public release, use that
application's production keys (`pk_live_...` and `sk_live_...`) rather than
development keys. Clerk's
[production deployment guide](https://clerk.com/docs/guides/development/deployment/production)
is the source of truth for its current DNS and instance requirements.

In the Clerk dashboard:

1. Confirm `https://leetbattle.cenough.games` is an authorized application
   origin for the reused instance.
2. If the production instance uses `cenough.games` as its root domain, add
   `leetbattle.cenough.games` to the subdomain allowlist. Do not broadly permit
   unused sibling subdomains.
3. Confirm the enabled sign-in methods and OAuth credentials exist in the
   production instance; development shared OAuth credentials do not carry over.
4. Confirm sign-in and sign-up can return to a path on
   `https://leetbattle.cenough.games`, including an invited room URL.
5. Complete Clerk's required DNS records and certificate deployment. Clerk DNS
   verification records that its dashboard says must be DNS-only should not be
   proxied through Cloudflare.

The realtime hostname does not need a Clerk frontend. The browser first obtains
a short-lived, one-use realtime ticket from the authenticated web Worker, then
uses that ticket for the WebSocket upgrade.

Keep these values available during every OpenNext build:

```dotenv
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_replace_me
NEXT_PUBLIC_REALTIME_URL=wss://ws.leetbattle.cenough.games
```

Create the ignored build file under a restrictive umask:

```bash
umask 077
touch .env.production.local
chmod 600 .env.production.local
```

Put only the two public values above in `.env.production.local`. Next.js reads
that file without the shell sourcing it. Rebuild and redeploy the web Worker
whenever either changes. The publishable key must exactly match the value later
uploaded as the web Worker's `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` binding.

## 5. Generate distinct internal secrets and provide the OpenAI secret

Generate four independent 48-byte values in a trusted interactive terminal and
store them in a password manager. Hex avoids dotenv quoting ambiguities:

```bash
openssl rand -hex 48
openssl rand -hex 48
openssl rand -hex 48
openssl rand -hex 48
```

Assign them to:

- `REALTIME_TICKET_SECRET`
- `RUNNER_INTERNAL_SECRET`
- `ROOM_INVITE_SECRET`
- `REALTIME_NOTIFY_SECRET`

Do not reuse a value. The application rejects missing values, published example
sentinels, values shorter than 32 bytes, and reused trust-boundary secrets.

Obtain `OPENAI_API_KEY` from the operator's OpenAI project and store it in the
same password manager. It is a separate provider credential, not one of the
four generated internal trust secrets. Do not print it in shell history, use it
as a build variable, or put it in a runner secret file.

Create three ignored, operator-only dotenv files. These files are passed to
Wrangler's `--secrets-file` option on the first deployment so
`secrets.required` can be satisfied atomically.

Set the restrictive umask before creating them, not afterward:

```bash
umask 077
touch \
  .dev.vars.production \
  cloudflare/realtime/.dev.vars.production \
  cloudflare/runner/.dev.vars.production
chmod 600 \
  .dev.vars.production \
  cloudflare/realtime/.dev.vars.production \
  cloudflare/runner/.dev.vars.production
```

Root `.dev.vars.production`:

```dotenv
CLERK_SECRET_KEY=sk_live_replace_me
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_replace_me
REALTIME_TICKET_SECRET=replace_with_generated_ticket_secret
RUNNER_INTERNAL_SECRET=replace_with_generated_runner_secret
ROOM_INVITE_SECRET=replace_with_generated_invite_secret
REALTIME_NOTIFY_SECRET=replace_with_generated_notify_secret
OPENAI_API_KEY=replace_with_openai_project_key
```

`cloudflare/realtime/.dev.vars.production`:

```dotenv
REALTIME_TICKET_SECRET=replace_with_the_same_ticket_secret
ROOM_INVITE_SECRET=replace_with_the_same_invite_secret
REALTIME_NOTIFY_SECRET=replace_with_the_same_notify_secret
OPENAI_API_KEY=replace_with_the_same_openai_project_key
```

`cloudflare/runner/.dev.vars.production`:

```dotenv
RUNNER_INTERNAL_SECRET=replace_with_the_same_runner_secret
```

The shared values must match byte-for-byte:

| Secret                 | Web | Realtime | Runner |
| ---------------------- | --- | -------- | ------ |
| Clerk secret           | ✓   |          |        |
| Clerk publishable key  | ✓   |          |        |
| Realtime ticket secret | ✓   | ✓        |        |
| Room invite secret     | ✓   | ✓        |        |
| Realtime notify secret | ✓   | ✓        |        |
| Runner internal secret | ✓   |          | ✓      |
| OpenAI API key         | ✓   | ✓        |        |

`OPENAI_JUDGE_MODEL="gpt-5.4-nano"` and
`OPENAI_JUDGE_MAX_DAILY_REQUESTS="1000"`,
`OPENAI_JUDGE_MAX_DAILY_REQUESTS_PER_USER="50"`, and
`OPENAI_JUDGE_MAX_DAILY_REQUESTS_PER_MATCH="6"` are non-secret Wrangler
variables in both judging Worker configs. They atomically limit actual outbound
attempt reservations over a rolling 24-hour window. Change values in both
checked-in Wrangler files and deploy realtime before web; do not create an
untracked dashboard override.

Do not add `DATABASE_URL`, hidden tests, canonical solutions, submitted source,
AI/ML answers, or private rubric/prompt material to any Worker secret file. Do
not set a public `RUNNER_URL` in production; `RUNNER_SERVICE` is the production
transport. Keep the password manager as the source of truth. These three files
are transient first-deploy inputs and are removed after production validation.

## 6. Validate before changing Cloudflare

Run the repository checks and generate binding types:

```bash
cd /Users/kevinshah/Desktop/cegames/leetbattle

npm run cf:configure -- --check
npm run cf:typegen
npm run check
npm run build:cloudflare
```

Then perform explicit Wrangler dry runs with the first-deploy secret files:

```bash
npx wrangler deploy --dry-run \
  --secrets-file .dev.vars.production

npx wrangler deploy --dry-run \
  --config cloudflare/realtime/wrangler.jsonc \
  --secrets-file cloudflare/realtime/.dev.vars.production

npx wrangler deploy --dry-run \
  --config cloudflare/runner/wrangler.jsonc \
  --secrets-file cloudflare/runner/.dev.vars.production
```

Runner validation requires Docker because Wrangler builds the checked-in
Sandbox image with its pinned Python and Java runtimes and trusted supervisor.
Resolve every type, bundle, missing-secret, binding, container-build, and
production-runner contract error before continuing.

`--containers-rollout=none` can validate the runner's Worker bundle on a host
without Docker, but it deliberately skips the container image. It is a useful
diagnostic, not a substitute for the full runner dry run or deployment.

```bash
npx wrangler deploy --dry-run \
  --containers-rollout=none \
  --config cloudflare/runner/wrangler.jsonc \
  --secrets-file cloudflare/runner/.dev.vars.production
```

`npm run dry-run:cloudflare` is a convenient repeat check after the resources
and secrets already exist. The explicit first-deploy form above makes the
secret source unambiguous.

## 7. Deploy in dependency order

### 7.1 Deploy the private runner

The runner must exist before the web Worker that binds to it. Deploy it first,
with Docker running:

```bash
docker info

npx wrangler deploy \
  --config cloudflare/runner/wrangler.jsonc \
  --secrets-file cloudflare/runner/.dev.vars.production \
  --message "Initial LeetBattle runner deployment"
```

Wrangler builds the pinned Sandbox image, pushes it to Cloudflare's registry,
deploys `leetbattle-runner`, and reconciles the `JudgeSandbox` SQLite-backed
Durable Object class. The Worker remains private because its config has no route
and disables both `workers.dev` and preview URLs.

The image has pinned or integrity-checked supply-chain inputs. The Ubuntu
package repositories used while building Python are not snapshot-locked, so
this is not a claim of bit-for-bit reproducibility:

| Item                     | Checked-in value                                                                 |
| ------------------------ | -------------------------------------------------------------------------------- |
| Sandbox runtime          | glibc `cloudflare/sandbox:0.12.7` image pinned by SHA-256                        |
| Python                   | `3.13.5` source with a verified archive hash                                     |
| Java                     | Eclipse Temurin `21.0.8_9` image pinned by SHA-256                               |
| Sandbox transport        | `rpc`                                                                            |
| Outer instance           | `standard-2`: 1 vCPU, 6 GiB memory, 12 GB disk                                   |
| Instance ceiling         | `10`                                                                             |
| Outer public Internet    | disabled by `JudgeSandbox`                                                       |
| Submission identity      | UID/GID `65532`, cleared groups/capabilities, `no-new-privileges`                |
| Submission network       | inherited seccomp denial of sockets and `io_uring`; inherited descriptors closed |
| Child limits             | hard CPU, PID, file-size, file-descriptor, and core limits; language memory caps |
| Hidden-input transport   | root-only case file redirected to child standard input                           |
| Expected-output handling | never enters the VM; comparison remains in the trusted Worker                    |

Cloudflare documents that each Sandbox runs in a separate VM with its own
filesystem, process, network, and resource boundary. The runner derives a new
random Sandbox identity for every execution and sets `enableInternet = false`.
Inside that single-use VM, a fixed, root-owned supervisor validates the input
files and configured limits, makes source and harness read-only, keeps the case
file root-only, and creates a fresh build/temporary directory for the job. See
[Cloudflare's Sandbox security model](https://developers.cloudflare.com/sandbox/concepts/security/).

Compilation and execution run directly in the Sandbox under a new process
group. The supervisor uses `setpriv` to drop the untrusted child to UID/GID
65532, clear supplementary groups and capability sets, and enable
`no-new-privileges`. It uses `prlimit` for hard CPU, process, file-size,
file-descriptor, and core-dump limits. Python also receives a hard address-space
limit; Java uses explicit heap, metaspace, direct-memory, code-cache, and stack
ceilings. Separate compile and runtime wall deadlines are enforced by the
trusted supervisor. The outer Sandbox VM remains the aggregate isolation and
resource boundary.

Cloudflare documents that processes in one Sandbox share localhost, including
the reserved Sandbox control plane. Immediately before each compiler and
runtime starts, the root-owned `submission-guard` verifies all real, effective,
and saved IDs are `65532`, verifies supplementary groups and every capability
set are empty, closes inherited descriptors above standard error, and loads an
inherited seccomp filter. The filter denies every socket syscall, the
`io_uring` interface that could otherwise create sockets, descriptor stealing,
and cross-process memory access. A child can only add stricter seccomp rules; it
cannot remove this filter across fork or exec. Any guard setup failure exits
`126`, which the supervisor maps to a fail-closed infrastructure error before
submitted code can start.

Hidden arguments are redirected into the harness through standard input.
Expected values, comparators, canonical solutions, Worker secrets, and database
access remain outside the VM; bounded protocol output returns to the Worker for
comparison. The supervisor kills the submitted process group during cleanup.
If the SDK wait fails or times out, the Worker sends `SIGKILL` to the Sandbox
process, and it invokes `sandbox.destroy()` from `finally` for every result.

`standard-2` provides headroom for the Sandbox control process, pinned Python
and Java runtimes, compilation, and the per-job workspace. Do not reduce the
instance type without rebuilding and passing complete Python and Java resource,
timeout, cleanup, and smoke tests. Static contract tests cannot prove the
deployed Container runtime; only the full image dry run and deployed execution
smoke test close that check.

Build the exact release image and run its executable security regression before
deploying it:

```bash
npm run test:runner-image
```

The test uses a disposable local container, confirms the unguarded SDK control
plane would execute as root, and then runs adversarial Python and Java through
the real supervisor. Both submissions must be unable to reach that control
plane while ordinary compilation, harness output, and supervisor completion
remain successful.

Container images take longer to provision than Worker code. Wait until the
deployment is ready:

```bash
npx wrangler containers list
npx wrangler containers images list
npx wrangler deployments list \
  --config cloudflare/runner/wrangler.jsonc
```

Do not add a temporary public runner route to test it. Its `GET /health` and
bearer-protected `POST /v1/execute` contract are intentionally reachable only
through a local development session or a configured Service binding. The health
endpoint proves Worker liveness only; it does not provision a Sandbox. Require
one real Python and one real Java execution before declaring the runner ready.

### 7.2 Deploy realtime

Realtime depends on the external database and Hyperdrive. Its Custom Domain is
created from the checked-in config:

```bash
npx wrangler deploy \
  --config cloudflare/realtime/wrangler.jsonc \
  --secrets-file cloudflare/realtime/.dev.vars.production \
  --message "Initial LeetBattle realtime deployment"
```

This creates `leetbattle-realtime`, reconciles the `RoomHub` SQLite-backed
Durable Object class, installs its scheduled recovery trigger, binds the
cache-disabled Hyperdrive configuration, and attaches
`ws.leetbattle.cenough.games`.

Active-room deadlines are handled by each `RoomHub` Durable Object alarm. The
global PostgreSQL sweep is only a recovery backstop and runs at 00:17, 06:17,
12:17, and 18:17 UTC (`17 */6 * * *`). Its 00:17 invocation also deletes
expired realtime-ticket records and disconnected realtime-session records;
those retention tasks do not need their own database wake.

Custom Domain DNS and certificate issuance can finish after the Worker upload.
Poll the liveness endpoint for at most ten minutes rather than treating the
first TLS or DNS failure as an application failure:

```bash
curl --retry 30 \
  --retry-delay 20 \
  --retry-max-time 600 \
  --retry-all-errors \
  --connect-timeout 10 \
  --max-time 15 \
  --fail-with-body \
  --silent \
  --show-error \
  https://ws.leetbattle.cenough.games/healthz

curl --include --silent --show-error \
  https://ws.leetbattle.cenough.games/socket
```

The first request must return a successful Worker liveness response. It is
deliberately database-free so an unauthenticated caller cannot manufacture
Hyperdrive traffic. The second must reject the missing ticket; a `101` without
a valid one-use ticket is a security failure. Database readiness is exercised
immediately by authenticated socket admission. Verify scheduled recovery in
the Worker logs after the next six-hour UTC window rather than treating it as
an immediate post-deploy smoke check.

### 7.3 Build and deploy web

Verify `.env.production.local` contains the final public values before
building:

```bash
grep -E '^(NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY|NEXT_PUBLIC_REALTIME_URL)=' \
  .env.production.local

npm run build:cloudflare
```

For the first deployment, call the OpenNext CLI directly so the secret file is
forwarded to Wrangler:

```bash
npx opennextjs-cloudflare deploy -- \
  --secrets-file .dev.vars.production
```

OpenNext deploys `.open-next/worker.js` and `.open-next/assets` as
`leetbattle-web`, attaches both Service bindings and `HYPERDRIVE_FRESH`, and
creates the `leetbattle.cenough.games` Custom Domain.

The pinned OpenNext CLI may print an early warning that required secrets are
missing because that precheck looks only at its own process environment. Do not
export secrets merely to silence it. The subsequent Wrangler binding inventory
must list all seven web secrets as `(hidden)`; that proves `--secrets-file` was
forwarded. Stop if any secret is absent from that inventory or if Wrangler
returns an error.

The production web config disables its stable `workers.dev` route and version
preview URLs. Wait for the Custom Domain certificate with the same bounded
retry policy:

```bash
curl --retry 30 \
  --retry-delay 20 \
  --retry-max-time 600 \
  --retry-all-errors \
  --connect-timeout 10 \
  --max-time 15 \
  --fail-with-body \
  --silent \
  --show-error \
  https://leetbattle.cenough.games/ >/dev/null
```

After initial secrets are installed, normal releases can use:

```bash
npm run deploy:runner
npm run deploy:realtime

NEXT_PUBLIC_REALTIME_URL=wss://ws.leetbattle.cenough.games \
  npm run build:cloudflare

rg --files-with-matches \
  --fixed-strings \
  'wss://ws.leetbattle.cenough.games' \
  .open-next/assets/_next/static/chunks

npx opennextjs-cloudflare deploy
```

Continue to use dependency order for a coordinated release: backward-compatible
runner changes, backward-compatible realtime changes, then web. Remove old
downstream behavior only in a later release after all callers have moved.

Build web once, inspect that artifact, and deploy it with the direct OpenNext
command. Do not run `npm run deploy:web` after inspecting `.open-next`: that
script starts another build, so it would deploy a different artifact from the
one that was verified.

### 7.4 Workers Builds and Git integration

Cloudflare Workers Builds runs in a remote environment. Ignored local files
such as `.env.production.local` are not available there, and runtime Worker
secrets are not inputs to `next build`. This repository intentionally tracks
only the non-secret production realtime endpoint in `.env.production`, so a
Git build has a safe default even when the dashboard variable is omitted.
Keep the Clerk key in **Settings > Builds > Build Variables and Secrets**, and
set both values there when the deployment target should override the
repository default:

```dotenv
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_live_replace_me
NEXT_PUBLIC_REALTIME_URL=wss://ws.leetbattle.cenough.games
```

Never add a secret, database URL, private Clerk key, or `OPENAI_API_KEY` to
`.env.production` or Workers Builds variables. OpenAI is a runtime Wrangler
secret, not a Next.js build input. Process-level public build variables take
precedence over the tracked public default.

Use:

```text
Build command:  npm run build:cloudflare
Deploy command: npx opennextjs-cloudflare deploy
```

The bundle check fails the build if the production realtime URL is absent, an
unresolved `NEXT_PUBLIC_REALTIME_URL` reference remains, a local WebSocket URL
appears in emitted client JavaScript, or client static contains a secret name,
secret-like value, private rubric/reference marker, or complete judge material.
The OpenNext runtime scan separately rejects seed modules, concrete private
material, and exact configured secret values while allowing server code to
reference secret binding names, published validation sentinels, and persisted
private-field names. Treat any failure as a build/privacy error; do not bypass
it.

Choose one production authority:

- If Git is authoritative, stop routine manual production web deployments and
  coordinate runner, realtime, and web in dependency order from one pipeline.
- If the release terminal is authoritative, disconnect automatic production
  deployment or use `npx opennextjs-cloudflare upload` in the Git deploy step,
  then promote verified versions explicitly.

Do not let separate automatic and manual writers race for the same production
Worker. Each successful deployment becomes the active version regardless of
which path produced it.

When Git is configured to auto-deploy only the web Worker, a coordinated shared
match release uses this order: apply additive database migrations, manually
deploy realtime from the exact release commit, then merge that same commit to
the production branch and let Workers Builds deploy web. The private runner does
not need a release when its code and execution contract are unchanged.

## 8. Production validation

### Control-plane inventory

```bash
export HYPERDRIVE_ID='REPLACE_WITH_REAL_ID'

npm run cf:configure -- --check
npx wrangler hyperdrive get "$HYPERDRIVE_ID"

npx wrangler secret list --config cloudflare/runner/wrangler.jsonc
npx wrangler secret list --config cloudflare/realtime/wrangler.jsonc
npx wrangler secret list --config wrangler.jsonc

npx wrangler deployments list --config cloudflare/runner/wrangler.jsonc
npx wrangler deployments list --config cloudflare/realtime/wrangler.jsonc
npx wrangler deployments list --config wrangler.jsonc

npx wrangler containers list
```

Secret **names** should match the matrix above; secret values are intentionally
not readable. Confirm the Hyperdrive output reports caching disabled.

### HTTP, authentication, and WebSocket boundaries

```bash
curl --fail-with-body --silent --show-error \
  https://leetbattle.cenough.games/ >/dev/null

curl --include --silent --show-error \
  https://leetbattle.cenough.games/api/profile

curl --fail-with-body --silent --show-error \
  https://ws.leetbattle.cenough.games/healthz

curl --include --silent --show-error \
  https://ws.leetbattle.cenough.games/socket
```

Expected results:

- The landing page returns `200`.
- The protected profile endpoint rejects an unauthenticated request.
- Realtime health returns success without touching PostgreSQL.
- A WebSocket request without a ticket is rejected.
- There is no public URL that reaches `leetbattle-runner`.

### Complete two-player smoke test

Use two separate browser profiles and two different accounts from the same
Clerk instance:

1. Sign in and create two distinct usernames.
2. Create a room as the host and join through the invite as the challenger.
3. Confirm a third user and the host-as-opponent path are rejected.
4. Choose different languages, ready independently, and verify both clients
   receive one countdown/start time and the same problem.
5. Run visible samples in both Python and Java.
6. Submit a known-wrong solution and verify the server-owned cooldown.
7. Submit an accepted solution and verify one winner, one loser, and matching
   history entries.
8. Disconnect and reconnect one browser during a new active round; confirm the
   authoritative snapshot resumes.
9. Request a mutual rematch and confirm a fresh round and language selection.
10. Confirm neither browser receives hidden inputs, canonical source, opponent
    source, or hidden-case diagnostics.

Keep live tails open while doing this:

```bash
npx wrangler tail --config wrangler.jsonc
npx wrangler tail --config cloudflare/realtime/wrangler.jsonc
npx wrangler tail --config cloudflare/runner/wrangler.jsonc
```

Run each tail in a separate terminal. The
[Workers Logs dashboard](https://developers.cloudflare.com/workers/observability/logs/workers-logs/)
provides retained, searchable invocation logs after the live test.

### Remove transient release secret files

After the control-plane inventory and two-player smoke test pass, verify the
password manager contains every database and Worker secret, then remove the
transient first-deploy files:

```bash
rm -f -- \
  .env.database.production.local \
  .dev.vars.production \
  cloudflare/realtime/.dev.vars.production \
  cloudflare/runner/.dev.vars.production
```

Normal deployments inherit the installed Worker secrets, so these files are not
needed for every release. Recreate them under `umask 077` only when provisioning
or rotating values. Keep `.env.production.local` only if the build host needs
the two public build inputs; it should contain no secret or database value.

The Playwright duel suite mutates database state and invokes real sandboxes.
Run it against a disposable staging database and Clerk test instance, not the
production database:

```bash
RUN_REAL_E2E=1 \
E2E_BASE_URL=https://YOUR_STAGING_WEB_DOMAIN \
E2E_CLERK_HOST_EMAIL=host@example.com \
E2E_CLERK_GUEST_EMAIL=guest@example.com \
npm run test:e2e
```

This repository does not define a separate staging Wrangler environment, so a
safe staging release requires separate Worker names, domains, Hyperdrive
configuration, secrets, and database. Do not re-enable the production
Worker's preview URLs as a shortcut; a different URL with production bindings
is not isolation.

## 9. Local and staging workflows

### Fast application development

The standard Node/Docker topology remains the quickest complete local workflow:

```bash
docker compose up -d postgres
npm run db:migrate
npm run db:seed
npm run runner:images
npm run dev
```

This exercises the Next.js app, Node WebSocket server, local PostgreSQL, and
fresh Docker judge containers. It does not emulate Workers, Service bindings,
Durable Objects, or Sandbox SDK containers.

### Local Cloudflare runtime

For Worker-specific validation, make local `.dev.vars` files with development
keys and distinct development secrets:

- `.dev.vars` for the web Worker.
- `cloudflare/realtime/.dev.vars` for realtime.
- `cloudflare/runner/.dev.vars` for the runner.

Use the same secret distribution as the production matrix, but do not copy
production secret values into local files. Keep the final public local values
in `.env.local`:

```dotenv
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_replace_me
CLERK_SECRET_KEY=sk_test_replace_me
NEXT_PUBLIC_REALTIME_URL=ws://127.0.0.1:8788
APP_ORIGIN=http://127.0.0.1:8787
DATABASE_URL=postgresql://leetbattle:leetbattle@127.0.0.1:5432/leetbattle
```

Start PostgreSQL and prepare it:

```bash
docker compose up -d postgres
npm run db:migrate
npm run db:seed
```

Then use three terminals so Wrangler's local service registry can connect the
named Workers.

Terminal 1 — private Sandbox runner:

```bash
npx wrangler dev \
  --config cloudflare/runner/wrangler.jsonc \
  --port 8789
```

Terminal 2 — realtime and local `RoomHub`:

```bash
CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_FRESH='postgresql://leetbattle:leetbattle@127.0.0.1:5432/leetbattle' \
npx wrangler dev \
  --config cloudflare/realtime/wrangler.jsonc \
  --port 8788 \
  --var APP_ORIGIN:http://127.0.0.1:8787
```

Terminal 3 — build and preview OpenNext:

```bash
npm run build:cloudflare
npx opennextjs-cloudflare preview -- \
  --port 8787 \
  --var APP_ORIGIN:http://127.0.0.1:8787
```

Wrangler should print both web Service bindings as `connected`. If either is
`not connected`, verify all three sessions are running from this project and
that the checked-in Worker names have not been overridden.

The root Wrangler file contains a local PostgreSQL connection string. The
realtime config intentionally does not commit one, so provide its Wrangler
local override in Terminal 2 as shown. Local Hyperdrive simulation connects
directly to PostgreSQL and does not provide production pooling or query caching.
Local Sandbox development requires Docker and may take several minutes on its
first image build. The production runner image starts the Sandbox control
process with the pinned Python/JDK runtimes and trusted supervisor already in
the image. Treat `runner_sandbox_failed` as a fail-closed infrastructure error:
use its logged phase to diagnose provisioning, input writes, process startup,
execution, or output collection rather than bypassing supervisor validation or
cleanup.

Do not use `wrangler dev --remote` for the complete topology:

- remote development can write production PostgreSQL through Hyperdrive;
- Containers are not supported in Wrangler remote development;
- SQLite Durable Objects and local Containers need the local simulation path.

### Production version uploads are not staging

A web-only version can be uploaded without moving production traffic:

```bash
npm run upload:web
npx wrangler versions list --config wrangler.jsonc
```

The production web config disables both `workers_dev` and `preview_urls`, so
this command does not provide a public test URL. It is useful only as the upload
phase of an intentional version/deployment workflow. Do not enable a public
production-connected preview to perform acceptance testing. Use separate
staging Worker names, a staging Custom Domain, a Clerk test instance, a separate
Hyperdrive configuration and database, and staging-only secrets.

Durable Object class lifecycle reconciliation is applied by `wrangler deploy`,
not a version upload. Use direct deployments for the realtime and runner
Workers, particularly when their `exports` declarations change.

## 10. Logs, metrics, and troubleshooting

### Useful inspection commands

```bash
# Live logs
npx wrangler tail --config wrangler.jsonc
npx wrangler tail --config cloudflare/realtime/wrangler.jsonc
npx wrangler tail --config cloudflare/runner/wrangler.jsonc

# Deployed versions and active deployments
npx wrangler versions list --config wrangler.jsonc
npx wrangler deployments list --config wrangler.jsonc
npx wrangler deployments list --config cloudflare/realtime/wrangler.jsonc
npx wrangler deployments list --config cloudflare/runner/wrangler.jsonc

# Database path
npx wrangler hyperdrive get "$HYPERDRIVE_ID"

# Container/image state
npx wrangler containers list
npx wrangler containers images list
```

Also watch:

- Hyperdrive query count, connection errors, origin latency, and `cacheStatus`.
  Production match traffic should report caching as disabled.
- PostgreSQL connection count, locks, slow queries, disk, backups, and provider
  incidents.
- Realtime Worker errors, WebSocket upgrade failures, Durable Object alarms,
  disconnect/reconnect lag, and six-hour recovery outcomes. The 00:17 UTC
  outcome must also report that daily cleanup ran.
- Runner Sandbox startup latency, execution infrastructure verdicts, timeouts,
  memory pressure, process-group termination, and VM-destroy cleanup.
- Web API latency and Clerk authorization failures.
- AI/ML evaluation and attempt counts, completion/failure classification,
  requested/returned model, prompt/schema/question/rubric versions, provider
  response ID, latency, token usage, blank/no-contest/tie-break counters, and
  the rolling-24-hour circuit state.

Never log submitted source, hidden fixtures, canonical solutions, database
credentials, bearer secrets, `OPENAI_API_KEY`, realtime tickets, full Clerk
session tokens, raw AI/ML answers, private reference/rubric material, complete
judge instructions, or raw provider output. Use opaque execution, evaluation,
attempt, match, room, and request IDs for correlation.

### Failure table

| Symptom                                                 | Likely cause and action                                                                                                                                                                    |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Unauthorized: ... Containers ... Workers Paid`         | The confirmed account blocker remains. Upgrade the target account, confirm `wrangler whoami`, then rerun `wrangler containers list`.                                                       |
| `docker: command not found` or daemon unavailable       | Install Docker on the release host, start its daemon, rerun `docker info`, and complete the full runner dry run. The rollout-none diagnostic is insufficient.                              |
| `REPLACE_WITH_HYPERDRIVE_ID` or configure check failure | Create the real cache-disabled Hyperdrive resource, run `npm run cf:configure -- <ID>`, then rerun `--check`.                                                                              |
| Web deploy says a bound service does not exist          | Deploy `leetbattle-runner`, then `leetbattle-realtime`, before `leetbattle-web`. Check the exact Worker names in each Wrangler file.                                                       |
| Hyperdrive create/get reports connection refused        | Verify database hostname/port, provider allowlist, database capacity, TLS mode, and credentials. Test the same URL directly with `psql`.                                                   |
| TLS or certificate failure to PostgreSQL                | Use the provider's supported CA with `verify-full`; upload a private CA to Hyperdrive when required. Do not disable verification to force a production connection.                         |
| Fresh reads appear stale                                | Verify `wrangler hyperdrive get` reports caching disabled and that both web and realtime bind the intended `HYPERDRIVE_FRESH` ID.                                                          |
| `relation ... does not exist`                           | Migrations or seed ran against a different database. Compare the direct URL's host/database with the Hyperdrive origin, then run direct `db:migrate` and `db:seed`.                        |
| Landing works but Clerk loops or rejects sessions       | Check production-vs-development key pairing, the web hostname in Clerk, OAuth production credentials, Clerk DNS, and that the public key was present during the latest OpenNext build.     |
| Next warns that `middleware` is deprecated              | Expected with the pinned adapter: OpenNext does not yet support Next 16's Node.js Proxy runtime. Keep `src/middleware.ts` until that support lands; auth still runs at the Edge boundary.  |
| Browser tries the wrong WebSocket host                  | `NEXT_PUBLIC_REALTIME_URL` was wrong or absent at build time. Set it to `wss://ws.leetbattle.cenough.games`, rebuild OpenNext, and redeploy web.                                           |
| Realtime health fails                                   | Tail realtime and verify the Worker deployment, Custom Domain, certificate, route, and required secrets. The endpoint intentionally does not query PostgreSQL.                             |
| Realtime health works but upgrade fails                 | Inspect Hyperdrive/PostgreSQL, then check `APP_ORIGIN`, `wss://`, clock skew, the one-use ticket path, and identical `REALTIME_TICKET_SECRET` values on web and realtime.                  |
| Internal notify is rejected                             | Ensure `REALTIME_NOTIFY_SECRET` matches on web and realtime. PostgreSQL remains authoritative, so fix delivery without rewriting match state.                                              |
| AI/ML judging reports missing configuration             | Ensure `OPENAI_API_KEY` is installed as a secret on web and realtime, and that both configs declare the same `OPENAI_JUDGE_MODEL`. Never add the key to runner or browser build variables. |
| AI/ML judging is temporarily unavailable                | Inspect safe failure classification and attempt metadata. For retryable failures, let idempotent recovery reuse the immutable snapshot; do not issue an independent second judgment.       |
| AI/ML budget circuit is open                            | Inspect the rolling 24-hour global, participant, and match attempt counts and provider spend. Wait for capacity or deliberately change identical limits in both Wrangler configs.          |
| Runner returns `401`/infrastructure error               | Ensure `RUNNER_INTERNAL_SECRET` matches on web and runner and that web uses `RUNNER_SERVICE`, not a public `RUNNER_URL`.                                                                   |
| Runner deploy cannot build the image                    | Start Docker, rerun `docker info`, confirm the pinned base image is reachable, and run the runner dry-run locally.                                                                         |
| `runner_sandbox_failed` after process startup           | Use the logged phase, verify the pinned runtimes and supervisor permissions, then run real Python and Java executions. `GET /health` alone does not exercise a Sandbox.                    |
| First execution fails after runner deploy               | Container provisioning can lag Worker deployment by several minutes. Check `wrangler containers list`, tail runner, and retry only after ready.                                            |
| Local service binding says `not connected`              | Run separate local Wrangler/OpenNext sessions for all three exact Worker names.                                                                                                            |
| Durable Object lifecycle/rollback is rejected           | `exports` changes are control-plane lifecycle changes. Do not mix `exports` and legacy `migrations`, and do not attempt a rollback across class creation, rename, transfer, or deletion.   |
| Custom Domain creation fails                            | Remove or reconcile a conflicting DNS/CNAME/Worker route and verify `cenough.games` is in the selected account. Keep Wrangler routes as source of truth.                                   |

## 11. Rollback and recovery

Record the last-known-good version IDs before every release:

```bash
npx wrangler deployments list --config wrangler.jsonc
npx wrangler deployments list --config cloudflare/realtime/wrangler.jsonc
npx wrangler deployments list --config cloudflare/runner/wrangler.jsonc
```

Before rollback, inspect the exact target version and confirm every referenced
Hyperdrive configuration and container image still exists. Roll back with
explicit version IDs:

```bash
npx wrangler rollback WEB_VERSION_ID \
  --config wrangler.jsonc \
  --message "Rollback LeetBattle web"

npx wrangler rollback REALTIME_VERSION_ID \
  --config cloudflare/realtime/wrangler.jsonc \
  --message "Rollback LeetBattle realtime"

npx wrangler rollback RUNNER_VERSION_ID \
  --config cloudflare/runner/wrangler.jsonc \
  --message "Rollback LeetBattle runner"
```

Cloudflare's
[rollback documentation](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/)
distinguishes versioned Worker state from attached resource state. A target
version brings back its code, static assets, bindings, compatibility settings,
and secret binding values. PostgreSQL, Durable Object storage, and the resources
behind those bindings retain their current state. Apply these rules:

- After migration `003_practice_mode` has accepted Practice traffic, never roll
  the web or realtime Worker back to a version from before Practice Mode. Those
  versions do not understand `rooms.mode` and can misclassify solo sessions as
  competitive matches. Pause new games and ship a forward fix from a
  Practice-aware version instead.
- Roll back only the failed component when its contract is unchanged.
- For a coordinated contract regression, roll back the caller first (web), then
  realtime or runner. This stops new calls that expect the bad downstream
  version.
- Do not add `--yes` mechanically. Wrangler warns when the target version has
  different secret values; inspect the named secrets and confirm only when the
  older values are the intended credentials for the older code.
- Do not cross a Durable Object class lifecycle change. Class creation, rename,
  transfer, or deletion can make an older Worker version ineligible for
  rollback.
- Do not delete stable container images from Cloudflare's registry; a rollback
  to a version whose image was deleted can fail.
- A container release rolls across instances rather than changing every running
  instance instantaneously. Monitor until the rollback rollout is complete.
- A rollback can restore an older Hyperdrive binding ID, but it does not restore
  or clone that resource's origin credentials, cache settings, or connection
  state. Retain every referenced Hyperdrive configuration until all Worker
  versions that use it are outside the rollback window.
- Secret binding values come from the target Worker version. After rollback,
  validate the Clerk key pair and every shared-secret contract; do not
  immediately overwrite an older value unless that is the deliberate recovery
  plan.
- PostgreSQL migrations, rows, and problem seed data are not restored. Use a
  tested database backup/PITR procedure during a maintenance window if data
  recovery is required.

Use additive, backward-compatible SQL migrations. Deploy schema support before
code that requires it, and remove old columns only after all rollback windows
have closed.

## 12. Security notes

- The runner must remain private. `workers_dev: false`, `preview_urls: false`,
  no `routes`, and `RUNNER_SERVICE` are deliberate controls.
- The runner still validates `RUNNER_INTERNAL_SECRET` even across a Service
  binding. This is defense in depth, not a reason to expose it.
- Each judge request uses a new Sandbox identity. The adapter disables public
  Internet access and always invokes `sandbox.destroy()` during `finally`
  cleanup. Cloudflare still permits its own DNS path under
  [`enableInternet = false`](https://developers.cloudflare.com/sandbox/guides/outbound-traffic/),
  so never treat the VM as a place for secrets or expected hidden outputs.
- Submitted code runs directly in that single-use VM as a child of the trusted
  supervisor. Preserve the root-owned supervisor and protocol file, root-only
  hidden-input file, read-only source/harness permissions, fixed environment,
  UID/GID 65532 privilege drop, cleared capability sets,
  `no-new-privileges`, closed inherited descriptors, seccomp denial of sockets
  and `io_uring`, and hard resource limits. Processes within one Sandbox share
  its filesystem, process space, and localhost as described by Cloudflare's
  [Sandbox isolation model](https://developers.cloudflare.com/sandbox/concepts/security/).
  Do not remove or bypass `submission-guard`: without that inner network
  boundary, an untrusted child can reach the root Sandbox control plane.
- A command timeout alone does not necessarily kill the underlying process.
  Preserve the supervisor's `setsid` process group, TERM/KILL wall deadlines,
  explicit process-group cleanup, the adapter's fallback SDK-process `SIGKILL`,
  and unconditional Sandbox-destroy path.
- Never pass Worker secrets, expected hidden outputs, canonical solutions, or
  application/database files into a judge sandbox. The current adapter writes
  only bounded source, a generated harness, and test arguments; comparison
  against expected outputs remains in the trusted runner Worker.
- Keep Hyperdrive caching disabled. Stale match reads are a correctness and
  security problem, not merely a performance issue.
- Use full-verification TLS and separate least-privilege migration-owner and
  runtime database roles.
- Keep the direct migration URL out of Cloudflare Worker secrets and browser
  builds.
- Rotate internal shared secrets during a maintenance window. The current
  single-value validators do not provide a dual-key overlap period, so rotating
  one side first creates a temporary authorization failure.
- Rotating the Clerk publishable key requires a fresh OpenNext build. Rotating
  only `CLERK_SECRET_KEY` requires updating the web secret, but validate the key
  pair and sessions afterward.
- Rotate `OPENAI_API_KEY` on web and realtime together. It is a runtime secret,
  so rotation does not require rebuilding browser assets. Validate with a
  controlled AI/ML evaluation and never copy the key to the runner or a build
  variable.
- AI/ML question and judge-prompt seed modules must remain outside every runtime
  import graph. Keep the client and OpenNext bundle scans enabled; they protect
  against concrete prompt/rubric/reference leakage and secret material.
- Retained AI/ML raw answers and detailed judgments are participant-only data.
  An invite does not grant history access, and general logs or realtime events
  are not alternative data stores.
- Restrict Clerk's allowed production subdomains and origins. A WebSocket ticket
  does not broaden Clerk authorization.
- Keep `workers_dev: false` and `preview_urls: false` on every production
  Worker. Realtime remains public only through its Custom Domain. Use an
  isolated staging deployment for public test surfaces.

## 13. Cost and capacity

Budget for six distinct categories:

1. The Workers Paid account minimum. The current plan gate is unavoidable for
   Sandbox/Containers.
2. Worker and Durable Object requests/duration/storage. Realtime uses
   hibernatable WebSockets to reduce idle Durable Object duration, but messages,
   alarms, and active handlers are still metered. See
   [Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/).
3. Runner Containers. Each active judge provisions one `standard-2` Sandbox
   instance: 6 GiB memory and 12 GB disk, with CPU billed by active use. The
   Worker destroys the fresh Sandbox after every execution, but a burst can
   reach the checked-in `max_instances = 10` ceiling. This is a security and
   Python/Java runtime and compilation sizing choice with a real cost; measure
   it before raising concurrency.
4. External PostgreSQL. Hyperdrive pooling is included in Workers Paid, but the
   database provider, storage, backups, and network policy remain separate
   costs. See [Hyperdrive pricing](https://developers.cloudflare.com/hyperdrive/platform/pricing/).
5. Observability. The checked-in configs enable high sampling for initial
   validation. Logs and traces consume the account's included event allowance
   and then incur usage charges. Reduce sampling deliberately after measuring
   traffic; do not disable the error signal blindly.
6. OpenAI judging. Each nonblank evaluation uses `gpt-5.4-nano` with a compact
   rubric, 500-word answer cap, low reasoning effort, no tools, fixed output
   cap, and no close-score second pass. The rolling-24-hour outbound-attempt
   defaults are 1,000 globally, 50 per participant, and 6 per match; also
   configure provider-side budget alerts.

The realtime Worker intentionally relies on per-room alarms for precise match
work and wakes PostgreSQL globally only every six hours. Assuming each wake
holds a 0.25-CU Neon compute active for five minutes, the four daily fallback
wakes consume about 2.5 CU-hours in a 30-day month, before real traffic. The
old every-minute trigger could keep the endpoint active continuously and use
about 180 CU-hours. Do not add a frequent health check or second cleanup cron
that recreates that keep-awake pattern.

The local Node realtime service is different: without Durable Object alarms it
runs a one-second development sweeper. Do not leave `npm run dev` running
against Neon when testing is finished if the goal is to let the database scale
to zero; prefer local PostgreSQL for long development sessions.

Create Cloudflare billing alerts and database-provider budget alerts before
opening the game publicly. Track concurrent judge executions and container
startup latency; increase runner capacity only after load tests show a need.

## Release checklist

- [ ] Workers Paid enabled; `wrangler containers list` succeeds.
- [ ] Docker installed and running; the full runner image dry run succeeds.
- [ ] Correct Cloudflare account and `cenough.games` zone selected.
- [ ] Separate migration-owner and restricted runtime database roles created.
- [ ] External PostgreSQL reachable with full-verification TLS and backed up.
- [ ] Direct `db:migrate` and `db:seed` completed successfully.
- [ ] Existing or newly created Hyperdrive origin and caching-disabled state
      inspected before reuse.
- [ ] `npm run cf:configure -- --check` passes with one shared ID.
- [ ] Existing production Clerk instance configured for the web hostname.
- [ ] Final public Clerk key and realtime URL present before OpenNext build.
- [ ] Four strong, distinct internal secrets stored and distributed per matrix.
- [ ] `OPENAI_API_KEY` installed on web and realtime only; runner inventory has
      no OpenAI binding.
- [ ] Web and realtime both use `OPENAI_JUDGE_MODEL=gpt-5.4-nano` and
      global/per-user/per-match limits of `1000`/`50`/`6` (or the same reviewed
      overrides).
- [ ] Full repository checks and all three Wrangler dry runs pass.
- [ ] Runner deployed and container provisioning ready.
- [ ] Deployed runner completes one real Python and one real Java execution,
      including supervisor privilege drop, limits, bounded output, timeout kill,
      and fresh-Sandbox destroy cleanup.
- [ ] Realtime deployed; health succeeds and unauthenticated socket is rejected.
- [ ] Web built after public env configuration and deployed last.
- [ ] Production `workers.dev` and preview URLs disabled for all three Workers.
- [ ] Secret names, versions, routes, Hyperdrive, and Containers inventoried.
- [ ] Two-account Python/Java duel, cooldown, winner, reconnect, rematch, and
      history smoke tests pass.
- [ ] AI/ML duel, practice, blank/no-contest, recoverable judge failure, and
      participant-only history smoke tests pass without exposing an answer
      before finalization.
- [ ] Client and OpenNext bundle privacy scans pass against the exact deployed
      artifact.
- [ ] Logs contain no source, AI/ML answer, private rubric/prompt, hidden case,
      credential, or token.
- [ ] Transient database and first-deploy secret files removed after validation.
- [ ] Last-known-good Worker versions, referenced Hyperdrive IDs/container
      images, and PostgreSQL recovery point recorded.
