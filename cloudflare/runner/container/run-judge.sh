#!/bin/bash
set -Eeuo pipefail

readonly SUPERVISOR_MARKER="__LEETBATTLE_SUPERVISOR__"
readonly WORKSPACE="/workspace/leetbattle"
readonly READY_FILE="/home/rootless/.cache/leetbattle/inner-sandbox.ready"
readonly ROOTFS_CHECKSUM="/opt/leetbattle/judge-rootfs.tar.sha256"
readonly JUDGE_IMAGE="leetbattle-judge:python-3.13.5-java-21.0.8-v2"
readonly DOCKER_SOCKET="/run/user/1000/docker.sock"
readonly READY_WAIT_ATTEMPTS=180

job_id=""
job_directory=""
build_volume=""
init_container=""
compile_container=""
runtime_container=""
artifact_container=""
output_reader_pid=""

emit_status() {
  local status="$1"
  local compile_ms="$2"
  local runtime_ms="$3"
  printf '%s{"status":"%s","compileMs":%s,"runtimeMs":%s}\n' \
    "$SUPERVISOR_MARKER" "$status" "$compile_ms" "$runtime_ms"
}

finish() {
  local status="$1"
  local compile_ms="${2:-0}"
  local runtime_ms="${3:-0}"
  local include_protocol="${4:-false}"
  if [ "$include_protocol" = "true" ] &&
    [ -n "$job_directory" ] &&
    [ -f "$job_directory/protocol.out" ]; then
    head -c "$LEETBATTLE_MAX_OUTPUT_BYTES" \
      "$job_directory/protocol.out" || true
    printf '\n'
  fi
  emit_status "$status" "$compile_ms" "$runtime_ms"
  exit 0
}

fail_infrastructure() {
  finish "infrastructure_error" "${1:-0}" "${2:-0}" "false"
}

require_bounded_uint() {
  local value="${1:-}"
  local minimum="$2"
  local maximum="$3"
  case "$value" in
    ""|*[!0-9]*) return 1 ;;
  esac
  [ "$value" -ge "$minimum" ] && [ "$value" -le "$maximum" ]
}

elapsed_ms() {
  local started="$1"
  local finished="$2"
  if [ "$finished" -ge "$started" ]; then
    printf '%s' "$((finished - started))"
  else
    printf '0'
  fi
}

seconds_with_fraction() {
  local milliseconds="$1"
  printf '%s.%03ds' \
    "$((milliseconds / 1000))" \
    "$((milliseconds % 1000))"
}

container_oom_state() {
  local container_name="$1"
  local value
  value="$(
    timeout --signal=TERM --kill-after=1s 3s \
      docker inspect --format '{{.State.OOMKilled}}' "$container_name" \
      2>/dev/null
  )" || {
    printf 'unknown'
    return
  }
  case "$value" in
    true|false) printf '%s' "$value" ;;
    *) printf 'unknown' ;;
  esac
}

container_state() {
  local container_name="$1"
  local value
  value="$(
    timeout --signal=TERM --kill-after=1s 2s \
      docker inspect --format '{{.State.Status}}' "$container_name" \
      2>/dev/null
  )" || {
    printf 'unknown'
    return
  }
  case "$value" in
    created|running|paused|restarting|removing|exited|dead)
      printf '%s' "$value"
      ;;
    *) printf 'unknown' ;;
  esac
}

container_cpu_usage_ns() {
  local container_name="$1"
  curl \
    --silent \
    --show-error \
    --fail \
    --max-time 0.05 \
    --unix-socket "$DOCKER_SOCKET" \
    "http://docker/containers/$container_name/stats?stream=false&one-shot=true" \
    2>/dev/null |
    jq -er \
      '.cpu_stats.cpu_usage.total_usage |
       select(type == "number" and . >= 0) |
       floor'
}

# Docker's CPU ulimit is intentionally retained as defense in depth, but it is
# integer-second and per-process. The trusted outer supervisor enforces the
# configured millisecond budget against the container cgroup's aggregate CPU
# counter, so forks cannot multiply their allowance. With a one-CPU quota, the
# 25 ms poll plus 50 ms local-API deadline bounds sampling overshoot to 75 ms.
monitor_cpu_budget() {
  local container_name="$1"
  local budget_ms="$2"
  local client_pid="$3"
  local budget_ns="$((budget_ms * 1000000))"
  local failures=0
  local startup_attempts=0
  local observed_usage=false
  local last_usage_ns=0
  local running
  local usage_ns

  while kill -0 "$client_pid" 2>/dev/null; do
    running="$(container_state "$container_name")"
    case "$running" in
      running)
        startup_attempts=0
        usage_ns="$(container_cpu_usage_ns "$container_name")" || {
          failures="$((failures + 1))"
          if [ "$failures" -ge 3 ]; then
            remove_container "$container_name"
            printf 'infrastructure_error'
            return
          fi
          sleep 0.025
          continue
        }
        failures=0
        if [ "$observed_usage" = "true" ] &&
          [ "$usage_ns" -lt "$last_usage_ns" ]; then
          remove_container "$container_name"
          printf 'infrastructure_error'
          return
        fi
        observed_usage=true
        last_usage_ns="$usage_ns"
        if [ "$usage_ns" -gt "$budget_ns" ]; then
          remove_container "$container_name"
          printf 'time_limit'
          return
        fi
        ;;
      exited|dead)
        if [ "$observed_usage" = "true" ]; then
          printf 'ok'
        else
          printf 'unobserved'
        fi
        return
        ;;
      created|restarting|removing)
        startup_attempts="$((startup_attempts + 1))"
        if [ "$startup_attempts" -ge 200 ]; then
          remove_container "$container_name"
          printf 'infrastructure_error'
          return
        fi
        ;;
      paused)
        remove_container "$container_name"
        printf 'infrastructure_error'
        return
        ;;
      *)
        startup_attempts="$((startup_attempts + 1))"
        if [ "$startup_attempts" -ge 200 ]; then
          remove_container "$container_name"
          printf 'infrastructure_error'
          return
        fi
        ;;
    esac
    sleep 0.025
  done
  if [ "$observed_usage" = "true" ]; then
    printf 'ok'
  else
    printf 'unobserved'
  fi
}

remove_container() {
  local container_name="$1"
  timeout --signal=TERM --kill-after=1s 4s \
    docker rm -f "$container_name" >/dev/null 2>&1 || true
}

cleanup() {
  set +e
  if [ -n "$output_reader_pid" ]; then
    kill "$output_reader_pid" 2>/dev/null || true
    wait "$output_reader_pid" 2>/dev/null || true
  fi
  local names=()
  [ -n "$init_container" ] && names+=("$init_container")
  [ -n "$compile_container" ] && names+=("$compile_container")
  [ -n "$runtime_container" ] && names+=("$runtime_container")
  [ -n "$artifact_container" ] && names+=("$artifact_container")
  if [ "${#names[@]}" -gt 0 ]; then
    timeout --signal=TERM --kill-after=1s 5s \
      docker rm -f "${names[@]}" >/dev/null 2>&1 || true
  fi
  if [ -n "$build_volume" ]; then
    timeout --signal=TERM --kill-after=1s 5s \
      docker volume rm -f "$build_volume" >/dev/null 2>&1 || true
  fi
  if [ -n "$job_directory" ]; then
    rm -f \
      "$job_directory/protocol.pipe" \
      "$job_directory/protocol.out" \
      2>/dev/null || true
    rmdir "$job_directory" 2>/dev/null || true
  fi
}
trap cleanup EXIT
trap 'exit 143' HUP INT TERM

require_bounded_uint "${LEETBATTLE_COMPILE_WALL_MS:-}" 1 60000 ||
  fail_infrastructure
require_bounded_uint "${LEETBATTLE_COMPILE_CPU_MS:-}" 1 60000 ||
  fail_infrastructure
require_bounded_uint "${LEETBATTLE_RUN_CPU_MS:-}" 1 60000 ||
  fail_infrastructure
require_bounded_uint "${LEETBATTLE_RUN_WALL_MS:-}" 1 60000 ||
  fail_infrastructure
require_bounded_uint "${LEETBATTLE_MEMORY_MB:-}" 64 1024 ||
  fail_infrastructure
require_bounded_uint "${LEETBATTLE_MAX_PROCESSES:-}" 1 256 ||
  fail_infrastructure
require_bounded_uint "${LEETBATTLE_MAX_OUTPUT_BYTES:-}" 1 1048576 ||
  fail_infrastructure
require_bounded_uint "${LEETBATTLE_MAX_WORKSPACE_MB:-}" 16 256 ||
  fail_infrastructure

case "${LEETBATTLE_LANGUAGE:-}" in
  python)
    source_name="solution.py"
    harness_name="harness.py"
    ;;
  java)
    source_name="Solution.java"
    harness_name="Harness.java"
    ;;
  *)
    fail_infrastructure
    ;;
esac
readonly source_name harness_name

for required_path in \
  "$WORKSPACE/$source_name" \
  "$WORKSPACE/$harness_name" \
  "$WORKSPACE/cases.ndjson"
do
  [ -f "$required_path" ] && [ ! -L "$required_path" ] ||
    fail_infrastructure
done
chmod 0444 \
  "$WORKSPACE/$source_name" \
  "$WORKSPACE/$harness_name" \
  "$WORKSPACE/cases.ndjson" ||
  fail_infrastructure

ready_attempt=0
while [ ! -f "$READY_FILE" ]; do
  ready_attempt="$((ready_attempt + 1))"
  [ "$ready_attempt" -lt "$READY_WAIT_ATTEMPTS" ] ||
    fail_infrastructure
  sleep 0.5
done

read -r ready_image_id ready_rootfs_sha ready_extra < "$READY_FILE" ||
  fail_infrastructure
[ -n "$ready_image_id" ] &&
  [ -n "$ready_rootfs_sha" ] &&
  [ -z "${ready_extra:-}" ] ||
  fail_infrastructure

expected_rootfs_sha="$(awk 'NR == 1 { print $1 }' "$ROOTFS_CHECKSUM")" ||
  fail_infrastructure
[ "$ready_rootfs_sha" = "$expected_rootfs_sha" ] ||
  fail_infrastructure
actual_image_id="$(
  timeout --signal=TERM --kill-after=1s 5s \
    docker image inspect --format '{{.Id}}' "$JUDGE_IMAGE" 2>/dev/null
)" || fail_infrastructure
[ "$actual_image_id" = "$ready_image_id" ] || fail_infrastructure
readonly actual_image_id

raw_job_id="$(cat /proc/sys/kernel/random/uuid)" || fail_infrastructure
case "$raw_job_id" in
  ????????-????-????-????-????????????) ;;
  *) fail_infrastructure ;;
esac
job_id="${raw_job_id//-/}"
case "$job_id" in
  *[!0-9a-f]*) fail_infrastructure ;;
esac

job_directory="/home/rootless/.cache/leetbattle/job-$job_id"
build_volume="leetbattle-build-$job_id"
init_container="leetbattle-init-$job_id"
compile_container="leetbattle-compile-$job_id"
runtime_container="leetbattle-runtime-$job_id"
artifact_container="leetbattle-artifact-$job_id"
mkdir -m 0700 "$job_directory" || fail_infrastructure
: > "$job_directory/protocol.out" || fail_infrastructure
mkfifo -m 0600 "$job_directory/protocol.pipe" ||
  fail_infrastructure
chmod 0600 "$job_directory/protocol.out" ||
  fail_infrastructure

memory_bytes="$((LEETBATTLE_MEMORY_MB * 1024 * 1024))"
total_writable_bytes="$((LEETBATTLE_MAX_WORKSPACE_MB * 1024 * 1024))"
shm_bytes=1048576
tmp_bytes="$((total_writable_bytes / 4))"
job_workspace_bytes="$((total_writable_bytes / 4))"
build_bytes="$((
  total_writable_bytes -
    shm_bytes -
    tmp_bytes -
    job_workspace_bytes
))"
compile_cpu_seconds="$(((LEETBATTLE_COMPILE_CPU_MS + 999) / 1000))"
runtime_cpu_seconds="$(((LEETBATTLE_RUN_CPU_MS + 999) / 1000))"
compile_outer_timeout="$((LEETBATTLE_COMPILE_WALL_MS + 10000))"
runtime_outer_timeout="$((LEETBATTLE_RUN_WALL_MS + 10000))"

require_bounded_uint "$build_bytes" 1 "$total_writable_bytes" ||
  fail_infrastructure
docker volume create \
  --driver=local \
  --opt=type=tmpfs \
  --opt=device=tmpfs \
  --opt="o=size=$build_bytes,uid=65532,gid=65532,mode=0700,nosuid,nodev,noexec" \
  "$build_volume" >/dev/null 2>&1 ||
  fail_infrastructure

# The only root inner container performs a fixed chown on a fresh named
# volume. It has one capability, no network, and never sees a submission.
timeout --signal=TERM --kill-after=1s 5s \
  docker run \
    --pull=never \
    --rm \
    --name="$init_container" \
    --log-driver=none \
    --read-only \
    --network=none \
    --ipc=private \
    --user=0:0 \
    --cap-drop=ALL \
    --cap-add=CHOWN \
    --security-opt=no-new-privileges=true \
    --pids-limit=8 \
    --memory=67108864 \
    --memory-swap=67108864 \
    --cpus=1 \
    --shm-size="$shm_bytes" \
    --ulimit=core=0:0 \
    --mount="type=volume,src=$build_volume,dst=/build" \
    "$actual_image_id" \
    /bin/chown 65532:65532 /build \
    >/dev/null 2>&1 ||
  fail_infrastructure
init_container=""

common_job_arguments=(
  --pull=never
  --log-driver=none
  --read-only
  --network=none
  --ipc=private
  --user=65532:65532
  --cap-drop=ALL
  --security-opt=no-new-privileges=true
  --pids-limit="$LEETBATTLE_MAX_PROCESSES"
  --memory="$memory_bytes"
  --memory-swap="$memory_bytes"
  --cpus=1
  --shm-size="$shm_bytes"
  --ulimit=core=0:0
  --ulimit=nofile=128:128
  --ulimit="fsize=$total_writable_bytes:$total_writable_bytes"
  --tmpfs="/workspace:rw,nosuid,nodev,noexec,size=$job_workspace_bytes,uid=65532,gid=65532,mode=0700"
  --tmpfs="/tmp:rw,nosuid,nodev,noexec,size=$tmp_bytes,mode=1777"
  --env=HOME=/nonexistent
  --env=PATH=/opt/python/3.13.5/bin:/opt/java/openjdk/bin:/usr/bin:/bin
  --env="LEETBATTLE_LANGUAGE=$LEETBATTLE_LANGUAGE"
  --env="LEETBATTLE_EXPECT_MEMORY_BYTES=$memory_bytes"
  --env="LEETBATTLE_EXPECT_PIDS=$LEETBATTLE_MAX_PROCESSES"
  --env="LEETBATTLE_EXPECT_WORKSPACE_BYTES=$job_workspace_bytes"
  --env="LEETBATTLE_EXPECT_TMP_BYTES=$tmp_bytes"
  --env="LEETBATTLE_EXPECT_SHM_BYTES=$shm_bytes"
  --env="LEETBATTLE_EXPECT_WRITABLE_BYTES=$total_writable_bytes"
  --env=LEETBATTLE_EXPECT_CPU_MILLIS=1000
  --env=LEETBATTLE_EXPECT_SUBMISSION_MOUNTS=1
  --mount="type=bind,src=$WORKSPACE/$source_name,dst=/submission/$source_name,readonly"
  --mount="type=bind,src=$WORKSPACE/$harness_name,dst=/submission/$harness_name,readonly"
)

compile_arguments=(
  "${common_job_arguments[@]}"
  --name="$compile_container"
  --ulimit="cpu=$compile_cpu_seconds:$compile_cpu_seconds"
  --env="LEETBATTLE_COMPILE_WALL_MS=$LEETBATTLE_COMPILE_WALL_MS"
  --env="LEETBATTLE_MEMORY_MB=$LEETBATTLE_MEMORY_MB"
)
if [ "$LEETBATTLE_LANGUAGE" = "java" ]; then
  compile_arguments+=(
    --env=LEETBATTLE_EXPECT_BUILD_MOUNT=rw
    --env="LEETBATTLE_EXPECT_BUILD_BYTES=$build_bytes"
    --mount="type=volume,src=$build_volume,dst=/build"
  )
else
  compile_arguments+=(--env=LEETBATTLE_EXPECT_BUILD_MOUNT=none)
fi
compile_arguments+=("$actual_image_id" /opt/leetbattle/compile-inner)

compile_started="$(date +%s%3N)"
set +e
timeout \
  --signal=TERM \
  --kill-after=2s \
  "$(seconds_with_fraction "$compile_outer_timeout")" \
  docker run "${compile_arguments[@]}" \
  >/dev/null 2>&1 &
compile_client_pid="$!"
compile_cpu_outcome="$(
  monitor_cpu_budget \
    "$compile_container" \
    "$LEETBATTLE_COMPILE_CPU_MS" \
    "$compile_client_pid"
)"
wait "$compile_client_pid"
compile_status="$?"
set -e
compile_finished="$(date +%s%3N)"
compile_ms="$(elapsed_ms "$compile_started" "$compile_finished")"
compile_oom="$(container_oom_state "$compile_container")"
remove_container "$compile_container"
compile_container=""

if [ "$compile_cpu_outcome" = "infrastructure_error" ]; then
  fail_infrastructure "$compile_ms" 0
fi
if [ "$compile_cpu_outcome" = "unobserved" ] &&
  [ "$compile_ms" -gt "$LEETBATTLE_COMPILE_CPU_MS" ]; then
  fail_infrastructure "$compile_ms" 0
fi
if [ "$compile_cpu_outcome" = "time_limit" ]; then
  finish "time_limit" "$compile_ms" 0 "false"
fi
if [ "$compile_status" -ne 0 ]; then
  case "$compile_status" in
    124|137|152)
      if [ "$compile_oom" = "true" ]; then
        finish "memory_limit" "$compile_ms" 0 "false"
      fi
      finish "time_limit" "$compile_ms" 0 "false"
      ;;
    125|126|127)
      fail_infrastructure "$compile_ms" 0
      ;;
    *)
      if [ "$compile_oom" = "true" ]; then
        finish "memory_limit" "$compile_ms" 0 "false"
      fi
      finish "compile_error" "$compile_ms" 0 "false"
      ;;
  esac
fi

if [ "$LEETBATTLE_LANGUAGE" = "java" ]; then
  artifact_size="$(
    timeout --signal=TERM --kill-after=1s 5s \
      docker run \
        --pull=never \
        --rm \
        --name="$artifact_container" \
        --log-driver=none \
        --read-only \
        --network=none \
        --ipc=private \
        --user=65532:65532 \
        --cap-drop=ALL \
        --security-opt=no-new-privileges=true \
        --pids-limit=8 \
        --memory=67108864 \
        --memory-swap=67108864 \
        --cpus=1 \
        --shm-size="$shm_bytes" \
        --ulimit=core=0:0 \
        --mount="type=volume,src=$build_volume,dst=/build,readonly" \
        "$actual_image_id" \
        /usr/bin/du -sb /build \
        2>/dev/null |
      awk 'NR == 1 { print $1 }'
  )" || fail_infrastructure "$compile_ms" 0
  artifact_container=""
  require_bounded_uint "$artifact_size" 1 "$build_bytes" ||
    finish "output_limit" "$compile_ms" 0 "false"
fi

runtime_arguments=(
  "${common_job_arguments[@]}"
  --name="$runtime_container"
  --ulimit="cpu=$runtime_cpu_seconds:$runtime_cpu_seconds"
  --env="LEETBATTLE_RUN_WALL_MS=$LEETBATTLE_RUN_WALL_MS"
  --env="LEETBATTLE_COMPILE_MS=$compile_ms"
)
if [ "$LEETBATTLE_LANGUAGE" = "java" ]; then
  runtime_arguments+=(
    --env=LEETBATTLE_EXPECT_BUILD_MOUNT=ro
    --env="LEETBATTLE_EXPECT_BUILD_BYTES=$build_bytes"
    --mount="type=volume,src=$build_volume,dst=/build,readonly"
  )
else
  runtime_arguments+=(--env=LEETBATTLE_EXPECT_BUILD_MOUNT=none)
fi
runtime_arguments+=("$actual_image_id" /opt/leetbattle/run-inner)

runtime_started="$(date +%s%3N)"
set +e
head -c "$((LEETBATTLE_MAX_OUTPUT_BYTES + 1))" \
  < "$job_directory/protocol.pipe" \
  > "$job_directory/protocol.out" &
output_reader_pid="$!"
timeout \
  --signal=TERM \
  --kill-after=2s \
  "$(seconds_with_fraction "$runtime_outer_timeout")" \
  docker run "${runtime_arguments[@]}" \
  < "$WORKSPACE/cases.ndjson" \
  > "$job_directory/protocol.pipe" 2>&1 &
runtime_client_pid="$!"
runtime_cpu_outcome="$(
  monitor_cpu_budget \
    "$runtime_container" \
    "$LEETBATTLE_RUN_CPU_MS" \
    "$runtime_client_pid"
)"
wait "$runtime_client_pid"
runtime_status="$?"
wait "$output_reader_pid"
output_reader_status="$?"
output_reader_pid=""
set -e
runtime_finished="$(date +%s%3N)"
runtime_ms="$(elapsed_ms "$runtime_started" "$runtime_finished")"
protocol_bytes="$(wc -c < "$job_directory/protocol.out")"
runtime_oom="$(container_oom_state "$runtime_container")"
remove_container "$runtime_container"
runtime_container=""
rm -f "$job_directory/protocol.pipe" ||
  fail_infrastructure "$compile_ms" "$runtime_ms"

if [ "$runtime_cpu_outcome" = "infrastructure_error" ]; then
  fail_infrastructure "$compile_ms" "$runtime_ms"
fi
if [ "$runtime_cpu_outcome" = "unobserved" ] &&
  [ "$runtime_ms" -gt "$LEETBATTLE_RUN_CPU_MS" ]; then
  fail_infrastructure "$compile_ms" "$runtime_ms"
fi
if [ "$output_reader_status" -ne 0 ]; then
  fail_infrastructure "$compile_ms" "$runtime_ms"
fi
if [ "$protocol_bytes" -gt "$LEETBATTLE_MAX_OUTPUT_BYTES" ]; then
  finish "output_limit" "$compile_ms" "$runtime_ms" "true"
fi
if [ "$runtime_cpu_outcome" = "time_limit" ]; then
  finish "time_limit" "$compile_ms" "$runtime_ms" "true"
fi
if [ "$runtime_oom" = "true" ]; then
  finish "memory_limit" "$compile_ms" "$runtime_ms" "true"
fi
case "$runtime_status" in
  0)
    finish "ok" "$compile_ms" "$runtime_ms" "true"
    ;;
  124|137|152)
    finish "time_limit" "$compile_ms" "$runtime_ms" "true"
    ;;
  125|126|127)
    fail_infrastructure "$compile_ms" "$runtime_ms"
    ;;
  *)
    finish "runtime_error" "$compile_ms" "$runtime_ms" "true"
    ;;
esac
