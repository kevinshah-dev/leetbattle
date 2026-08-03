# Isolated runner

The runner is a separate internal HTTP service. The web and real-time services send only an immutable problem ID/version, language, mode, execution ID, and source. The runner resolves fixtures in its own server-only problem bank. It never accepts caller-supplied tests, commands, compiler flags, filenames, or images.

## Supported runtimes

- Python 3.13.5, image `leetbattle-python-runner:3.13`
- Java 21.0.8 LTS, image `leetbattle-java-runner:21`
- Node.js 22 for the trusted runner control plane

Build both execution images before starting the application:

```sh
npm run runner:images
```

Set `RUNNER_INTERNAL_SECRET` to a distinct random value of at least 32 bytes. The application uses `RUNNER_URL`; the runner also reads `RUNNER_PORT` (default `3002`), `RUNNER_HOST` (default `0.0.0.0`), `PYTHON_RUNNER_IMAGE`, and `JAVA_RUNNER_IMAGE`.

## HTTP contract

`POST /v1/execute` requires `Authorization: Bearer <RUNNER_INTERNAL_SECRET>` and `Content-Type: application/json`.

```json
{
  "executionId": "immutable_execution_id",
  "problemId": "paired-pulses",
  "problemVersion": 1,
  "language": "PYTHON",
  "mode": "samples",
  "source": "class Solution: ..."
}
```

The synchronous response contains only `executionId`, status, verdict, aggregate passed/total counts, aggregate runtime, separate compile time, and a generic message. Sample mode may also return bounded public-sample results and a serialized actual value. Submit mode always omits individual case data and actual values. It never returns source, compiler diagnostics, stack traces, hidden input, expected output, actual hidden output, fixture names, sandbox stderr, image details, or host errors. Infrastructure failures use HTTP 503 and may be retried once by the caller; normal judge failures use HTTP 200.

For the local Node runner, `GET /health` probes the Docker daemon and both
configured execution images through a short-lived cache. It returns only
`{"status":"ok"}` with HTTP 200 when ready, or `{"status":"unavailable"}`
with HTTP 503; dependency diagnostics are never exposed. The Cloudflare
runner's private `GET /health` is Worker liveness only and does not provision a
Sandbox. A real Python and Java execution smoke test is the production readiness
check.

## Isolation and judging flow

Every execution creates a random Docker volume and container. The trusted service archives exactly `solution.py` plus `harness.py`, or `Solution.java` plus `Harness.java`, and streams that archive into the volume through stdin. This avoids host-path bind mounts and works when the runner control plane is itself in Compose. Source is written only to a fixed filename and is never interpolated into a shell command.

The execution container has:

- no network namespace connectivity;
- an explicit non-root UID/GID;
- a read-only root filesystem and all Linux capabilities dropped;
- `no-new-privileges`;
- bounded memory with swap disabled, one CPU, CPU and wall deadlines, PID limits, file-size limits, source and output limits;
- bounded `noexec`, `nosuid`, `nodev` tmpfs mounts for the workspace and `/tmp`;
- a read-only submission volume containing no application files, environment files, database credentials, or host directories.

The harness is deliberately input-only. Canonical solutions, comparators, expected outputs, and the test suite stay in the trusted Node process. The runner sends one case input at a time, receives one bounded JSON return value, and compares it outside the container. A submission cannot read expected values from generated harness source. Per-case and aggregate runtime are measured with the trusted Node control plane's monotonic clock; harness-reported timing is ignored, and the aggregate `runTimeMs` budget is an active kill deadline. Ordinary wrong answers continue through the complete hidden suite so aggregate progress is not merely a passing prefix. Containers and volumes are killed and removed on completion, failure, excessive output, or timeout. After an unexpected exit, the adapter inspects Docker's OOM state before removal so memory pressure is not mislabeled as an infrastructure failure.

Python syntax checking and Java compilation happen before harness readiness. Their elapsed time is reported separately from aggregate user-function runtime. Diagnostics are discarded and replaced by a generic compilation verdict.

On startup, the control plane performs best-effort cleanup of stale resources carrying its private Docker label and an exact `leetbattle-<24 lowercase hex>` name. Fresh running work from another instance is preserved, and cleanup never uses a broad prefix deletion. SIGTERM and SIGINT stop new HTTP work and allow in-flight executions to drain before connections are force-closed.

## Verification

Portable tests validate all fixtures with independent TypeScript implementations, catalog boundaries, comparators, request/auth/body policy, safe response whitelisting, source limits, and required Docker flags. Docker integration tests exercise both canonical solutions for all seven problems plus wrong answers, Python/Java compile failures, runtime errors, infinite loops, excessive output, memory pressure, and blocked network access.

Run:

```sh
npm test -- tests/problems tests/runner
```

Docker integration tests clearly skip when the daemon or either prebuilt image is unavailable. Build the images first to enable them.

## Production boundary

This Docker adapter is a working local-development/MVP boundary, not hardened hostile multi-tenant isolation. Docker-socket access gives the trusted runner control plane daemon-level authority, and ordinary containers share a host kernel. A production deployment should replace `RunnerAdapter` with a purpose-built sandbox using microVMs or equivalent per-execution isolation, stronger syscall filtering, independent worker hosts, image digest pinning, admission control, and centralized resource telemetry. Do not expose this HTTP service or the Docker socket to the public internet.

The checked-in Cloudflare adapter is that production replacement. The private
runner Worker creates one fresh, randomly named Cloudflare Sandbox VM per
execution and disables its public Internet access. The VM contains pinned
Python and Java runtimes plus a fixed, root-owned supervisor; it does not start
a nested container runtime.

The supervisor validates fixed filenames and limits, makes the source and
harness read-only and the case file root-only, then launches compilation and
execution in a new process group. Before the untrusted child starts, `setpriv`
drops it to UID/GID 65532, clears its groups and capability sets, and enables
`no-new-privileges`; `prlimit` installs hard CPU, process, file-size,
file-descriptor, and core-dump limits. Python also receives a hard address-space
limit, while Java uses bounded heap, metaspace, direct-memory, code-cache, and
stack settings. A small root-owned launcher then verifies the complete dropped
identity and empty capability sets, closes every descriptor above standard
error, and loads a seccomp filter before the compiler or runtime starts. The
filter is inherited across fork and exec, denies all socket operations plus the
`io_uring` interface, and therefore prevents submitted code from reaching the
Sandbox's root control process over shared localhost. The launcher exits `126`
without starting user code if any identity or filter step fails. The fresh
Sandbox VM remains the outer isolation and aggregate resource boundary.

Hidden case arguments are stored in a root-only file and redirected to the
harness through standard input. Expected outputs, comparators, canonical
solutions, application secrets, and database access never enter the Sandbox;
the trusted Worker parses bounded protocol output and performs comparison.
The supervisor applies compile and runtime wall deadlines, kills the submitted
process group during cleanup, and bounds its protocol file. The Worker also
SIGKILLs an unfinished Sandbox process and invokes `sandbox.destroy()` from an
unconditional `finally` path. See the exact image, validation, deployment,
smoke-test, and rollback procedure in
[the Cloudflare deployment runbook](cloudflare-deployment.md).

`npm run test:runner-image` builds the exact pinned production image and runs an
opt-in Docker regression suite. The suite first proves the disposable image's
unguarded localhost control plane has root authority, then verifies that real
Python and Java submissions launched by the supervisor cannot reach it. Run
this test for every runner image release in addition to the portable contract
tests.
