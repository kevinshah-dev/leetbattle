# AI/ML Arena operations and data contract

AI/ML Arena adds written-answer rounds without changing coding rounds. Challenge
type (`CODING` or `AI_ML`) and participation mode (`DUEL` or `PRACTICE`) are
independent, immutable match properties. Existing rows default to `CODING`.
AI/ML rounds use private invites, authentication, ready-up, countdown,
reconnect, rematch, and history; they do not use language selection or public
matchmaking.

## Question bank and versioning

The version-1 catalog contains exactly 20 active questions: seven Easy, seven
Medium, and six Hard. A public catalog item contains only its stable ID and
version, title, prompt, difficulty, category, tags, and answer constraints.
Reference notes, required concepts, optional nuances, misconceptions, and
question-specific rubric criteria are seed-only material.

`db/seed.ts` is the production path allowed to import the private question bank
and judge-instruction modules. It persists versioned rows in
`ai_ml_question_registry` and `ai_ml_judge_prompts`. Application and Worker
runtimes load private material from PostgreSQL; they must never import either
seed module. Client and OpenNext bundle scans fail on seed module identifiers,
concrete private content, prompt content, rubric/reference markers, or secrets.

Treat a question version as immutable after use:

- Editing a public prompt, answer constraint, private reference material, or
  criterion creates a new `(question_id, version)` row. Do not rewrite a version
  referenced by a match.
- Archive an old version and activate the replacement deliberately. Keep the old
  row so history and stored evaluations remain reproducible.
- Every rubric has an immutable hash. An evaluation records the question
  version, rubric hash, prompt version, schema version, and requested model.
- Changing judge instructions creates a new prompt version. A strict response
  shape change also creates a new schema version.

Selection is server-owned and difficulty-scoped. The question stays sealed
through the lobby and countdown and is revealed only when the match becomes
`ACTIVE`. A rematch avoids the immediately previous question and should avoid
reuse within the room until that difficulty pool is exhausted.

## Authoritative round lifecycle

The database start time establishes a ten-minute `answer_deadline_at`; browser
timers are display-only. The realtime deadline alarm resolves abandoned rounds,
and the global maintenance sweep recovers missed alarms or stale evaluation
claims.

An answer is normalized before validation and is limited to 500 words, 12,000
characters, and 24,000 UTF-8 bytes. Oversized input is rejected, never
truncated. Each participant can create at most one final answer, and a database
trigger makes it immutable. Opponents see submission status but not answer text
until a result is finalized.

The resolution contract is:

- When all required answers arrive, the match enters `JUDGING` immediately.
- At the deadline, a missing answer becomes a final blank answer.
- In a duel with one blank, the nonblank answer wins automatically, the blank
  receives zero, and only the nonblank answer is scored against the rubric.
- Two duel blanks finish `NO_CONTEST` at 0–0 without an OpenAI request or record
  change.
- A blank practice answer finishes at zero without an OpenAI request or record
  change.
- Completed judgments use the explicit `JUDGED` end reason. Exhausted judging
  failures use `JUDGE_FAILED`; neither a failure nor `NO_CONTEST` changes records.
- Duel finalization and the one shared wins/losses update are transactional and
  idempotent. Practice never changes wins/losses.

Refreshes, reconnects, duplicate submissions, concurrent workers, and delayed
provider responses cannot create a second evaluation or overwrite a completed
one. Rematches preserve challenge type, mode, and difficulty.

## OpenAI judging boundary

Production judging uses the official server-side OpenAI JavaScript SDK pinned at
`7.5.0`, the
[Responses API](https://developers.openai.com/api/docs/guides/structured-outputs),
and [`gpt-5.4-nano`](https://developers.openai.com/api/docs/models/gpt-5.4-nano)
by default. It does not fall back to Chat Completions or substitute another
model.

Before the provider call, the server persists an immutable, identity-free
evaluation snapshot and a cryptographically randomized Answer A/Answer B
mapping. Retries reuse that snapshot, model, rubric, instructions, and order.
The request never contains usernames, user IDs, slots, records, ratings, or
submission order. Versioned developer instructions and the serialized user
payload are separate messages, so answer text remains untrusted data rather
than instructions.

The request contract is intentionally narrow:

- Responses API with strict Structured Outputs and a versioned schema
- `store: false`, no tools, low reasoning effort, and a fixed small output limit
- integer per-criterion scores; the server calculates and validates totals
- a second Zod parse plus semantic checks for criterion IDs, ranges, winner,
  tie-break, and explanation bounds
- one valid result only: no reversed-order pass, close-score review, ensemble,
  low-confidence review, or second opinion

Raw-score ties are resolved by the versioned tie-break contract. The server
persists both raw and official scores and adjusts only the winning official
score when needed so a duel winner always has the strictly higher displayed
score. Byte-identical answers require the exact-equivalence rule against the
persisted randomized mapping.

## Retries, failures, and recovery

A failed request may be retried only as recovery of the same evaluation.
Retryable cases include network errors, timeouts, rate limits, provider 5xx
responses, incomplete output or refusal, strict-schema failures, and semantic
validation failures. The adapter owns the retry loop: SDK retries are disabled,
each attempt has a bounded timeout, and there are at most three total automated
attempts with short exponential backoff and jitter.

The first valid result is final. After retryable attempts fail, the service
preserves the answer and immutable snapshot, records only allowlisted failure
metadata, makes no score or winner, leaves records unchanged, and exposes
“Judging is temporarily unavailable.” Recovery is idempotent and rate-limited,
reuses the original snapshot/model/A-B mapping, and cannot overwrite a later
completed result. A genuinely non-retryable provider or configuration failure
atomically finishes the match as `JUDGE_FAILED`/no-contest, preserves its
authorized history, opens duel rematch, and never changes records.

The request circuit counts each reserved outbound provider attempt—not merely
each evaluation—atomically in PostgreSQL across web and realtime workers. Its
rolling 24-hour defaults are 1,000 globally, 50 per participant, and 6 per
match/evaluation (one initial three-attempt run plus one recovery run). Opening
any circuit creates a recoverable judge failure with at least a five-minute
cooldown rather than a player loss. Reservation rows retain only IDs, charged
participants, model, and timestamps; daily maintenance removes rows after eight
days. Do not bypass a circuit by changing the model or issuing an independent
evaluation.

## Runtime configuration

| Variable                                    | Default        | Classification | Allowed runtimes      |
| ------------------------------------------- | -------------- | -------------- | --------------------- |
| `OPENAI_API_KEY`                            | none           | secret         | web and realtime only |
| `OPENAI_JUDGE_MODEL`                        | `gpt-5.4-nano` | configuration  | web and realtime only |
| `OPENAI_JUDGE_MAX_DAILY_REQUESTS`           | `1000`         | configuration  | web and realtime only |
| `OPENAI_JUDGE_MAX_DAILY_REQUESTS_PER_USER`  | `50`           | configuration  | web and realtime only |
| `OPENAI_JUDGE_MAX_DAILY_REQUESTS_PER_MATCH` | `6`            | configuration  | web and realtime only |

The web API can start immediate evaluation, while realtime alarms can resolve
deadlines and recover evaluations; both therefore receive the same judge
configuration. Compose and Cloudflare omit every OpenAI variable from the coding
runner, and the host runner launcher removes them after loading the shared local
dotenv files. The API key must not be prefixed with `NEXT_PUBLIC_`, copied into
Wrangler `vars`, baked into an image, placed in PostgreSQL, or included in logs
or realtime payloads. Use Wrangler secrets in Cloudflare and a managed secret
store in other environments.

Normal tests inject a fake judge and do not need a key. Live provider contract
tests are disabled unless `RUN_OPENAI_CONTRACT_TEST=1` is set explicitly; do not
enable that flag in routine CI.

## History, access, and retention

Raw normalized answers are intentionally retained because participant history
must reproduce completed duel and practice results. The application applies no
time-based TTL to AI/ML answers or evaluations: they live with the match until
an authorized application/operator deletion removes that data. Database backup
retention is an operator policy and must be handled consistently with account
and match deletion requirements.

History lists can expose compact summaries, but complete answers and detailed
judgments require an authenticated detail request and a fresh participant check.
Both duel participants can read the completed result; a practice result belongs
to its sole participant. Possessing an invite does not authorize a nonmember to
read history. Answers and explanations render as escaped plain text, never raw
HTML.

Before finalization, snapshots and realtime events contain only safe question
metadata, the deadline, and submission/judging status. General logs and event
payloads must exclude raw answers, private reference/rubric material, complete
judge instructions, provider raw output, and the API key. Safe telemetry is
limited to opaque evaluation/attempt IDs, versions and hashes, requested and
returned model, provider response ID, attempt classification, latency, token
counts, blank/no-contest/tie-break counters, and aggregate score distributions.

## Release checks

For every question, prompt, schema, or judge integration change:

1. Run migrations and the idempotent seed against the target database.
2. Verify the active catalog count and 7/7/6 difficulty distribution.
3. Run the catalog, configuration/import-boundary, fake-judge, authorization,
   and bundle-scanner tests. Routine tests must make zero provider requests.
4. Build both Next.js and OpenNext artifacts so static and Worker privacy scans
   inspect the emitted bundles.
5. Confirm the web and realtime deployments use the same model and circuit
   limit, both have `OPENAI_API_KEY` as a secret, and the runner has none.
6. Monitor completion/failure classes, retry count, circuit-open events, latency,
   and token use without enabling sensitive payload logging.
