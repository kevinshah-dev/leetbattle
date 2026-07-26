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

`GET /health` probes the Docker daemon and both configured execution images through a short-lived cache. It returns only `{"status":"ok"}` with HTTP 200 when ready, or `{"status":"unavailable"}` with HTTP 503; dependency diagnostics are never exposed.

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
runner Worker creates one fresh Cloudflare Sandbox VM per execution, then uses
the supported rootless Docker-in-Docker pattern for a second boundary around
submitted code. The inner compiler and runtime containers have no network or
Docker socket, run as UID/GID 65532 with a read-only root and no capabilities,
and fail closed unless cgroup v2, process, memory, CPU, mount, and aggregate
tmpfs limits are observable from inside the container. Hidden case arguments
arrive only through standard input; expected values and comparison remain in
the trusted Worker.

The outer VM is still destroyed in bounded cleanup. This extra inner boundary
is necessary because processes within one Cloudflare Sandbox share its
filesystem, process space, and localhost, including the Sandbox control plane.
See the exact image, validation, deployment, smoke-test, and rollback procedure
in [the Cloudflare deployment runbook](cloudflare-deployment.md).
