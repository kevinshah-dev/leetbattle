#!/bin/bash
set -Eeuo pipefail

readonly SUPERVISOR_MARKER="__LEETBATTLE_SUPERVISOR__"
readonly WORKSPACE="/workspace/leetbattle"
readonly PYTHON_BIN="/opt/python/3.13.5/bin/python3.13"
readonly JAVA_HOME="/opt/java/openjdk"
readonly SUBMISSION_GUARD="/opt/leetbattle/submission-guard"
# RLIMIT_AS includes interpreter and shared-library mappings, so add a fixed
# runtime allowance to the problem's memory budget.
readonly PYTHON_RUNTIME_OVERHEAD_MB=64

job_id=""
job_directory=""
build_directory=""
temporary_directory=""
protocol_file=""
active_group_pid=""

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
    [ -n "$protocol_file" ] &&
    [ -f "$protocol_file" ]; then
    head -c "$LEETBATTLE_MAX_OUTPUT_BYTES" "$protocol_file" || true
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

kill_active_group() {
  if [ -n "$active_group_pid" ]; then
    kill -KILL -- "-$active_group_pid" 2>/dev/null || true
    wait "$active_group_pid" 2>/dev/null || true
    active_group_pid=""
  fi
}

cleanup() {
  set +e
  kill_active_group
  if [ -n "$job_directory" ]; then
    case "$job_directory" in
      "$WORKSPACE"/.judge-[0-9a-f]*) rm -rf -- "$job_directory" ;;
    esac
  fi
}
trap cleanup EXIT
trap 'exit 143' HUP INT TERM

[ "$(id -u)" = "0" ] || fail_infrastructure
[ "$(pwd -P)" = "$WORKSPACE" ] || fail_infrastructure

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

raw_job_id="$(cat /proc/sys/kernel/random/uuid)" || fail_infrastructure
case "$raw_job_id" in
  ????????-????-????-????-????????????) ;;
  *) fail_infrastructure ;;
esac
job_id="${raw_job_id//-/}"
case "$job_id" in
  *[!0-9a-f]*) fail_infrastructure ;;
esac

job_directory="$WORKSPACE/.judge-$job_id"
build_directory="$job_directory/build"
temporary_directory="$job_directory/tmp"
protocol_file="$job_directory/protocol.out"
install -d -o root -g root -m 0711 "$job_directory" || fail_infrastructure
install -d -o 65532 -g 65532 -m 0700 \
  "$build_directory" "$temporary_directory" || fail_infrastructure
install -o root -g root -m 0600 /dev/null "$protocol_file" ||
  fail_infrastructure

chmod 0444 "$WORKSPACE/$source_name" "$WORKSPACE/$harness_name" ||
  fail_infrastructure
chmod 0400 "$WORKSPACE/cases.ndjson" || fail_infrastructure
chmod 0555 "$WORKSPACE" || fail_infrastructure

python_address_space_bytes="$(((LEETBATTLE_MEMORY_MB + PYTHON_RUNTIME_OVERHEAD_MB) * 1024 * 1024))"
workspace_bytes="$((LEETBATTLE_MAX_WORKSPACE_MB * 1024 * 1024))"
runtime_output_bytes="$((LEETBATTLE_MAX_OUTPUT_BYTES + 1))"
compile_cpu_seconds="$(((LEETBATTLE_COMPILE_CPU_MS + 999) / 1000))"
runtime_cpu_seconds="$(((LEETBATTLE_RUN_CPU_MS + 999) / 1000))"

drop_privileges=(
  /usr/bin/setpriv
  --reuid=65532
  --regid=65532
  --clear-groups
  --no-new-privs
  --bounding-set=-all
  --inh-caps=-all
  --ambient-caps=-all
  --
)

compile_limits=(
  /usr/bin/prlimit
  "--cpu=$compile_cpu_seconds:$compile_cpu_seconds"
  "--nproc=$LEETBATTLE_MAX_PROCESSES:$LEETBATTLE_MAX_PROCESSES"
  "--fsize=$workspace_bytes:$workspace_bytes"
  --nofile=128:128
  --core=0:0
)
if [ "$LEETBATTLE_LANGUAGE" = "python" ]; then
  compile_limits+=("--as=$python_address_space_bytes:$python_address_space_bytes")
fi
compile_limits+=(--)

compile_environment=(
  /usr/bin/env -i
  HOME=/nonexistent
  "PATH=/opt/python/3.13.5/bin:$JAVA_HOME/bin:/usr/bin:/bin"
  "LD_LIBRARY_PATH=/opt/python/3.13.5/lib"
  "TMPDIR=$temporary_directory"
)

if [ "$LEETBATTLE_LANGUAGE" = "python" ]; then
  compile_command=(
    "$PYTHON_BIN"
    -I
    -c
    "import py_compile; py_compile.compile('$WORKSPACE/solution.py', cfile='$build_directory/solution.pyc', doraise=True)"
  )
else
  heap_mb="$((LEETBATTLE_MEMORY_MB / 2))"
  metaspace_mb="$((LEETBATTLE_MEMORY_MB / 8))"
  [ "$metaspace_mb" -ge 32 ] || metaspace_mb=32
  compile_command=(
    "$JAVA_HOME/bin/javac"
    "-J-Xmx${heap_mb}m"
    "-J-XX:MaxMetaspaceSize=${metaspace_mb}m"
    "-J-Djava.io.tmpdir=$temporary_directory"
    -encoding UTF-8
    -d "$build_directory"
    "$WORKSPACE/Solution.java"
    "$WORKSPACE/Harness.java"
  )
fi

compile_started="$(date +%s%3N)"
set +e
/usr/bin/setsid \
  /usr/bin/timeout \
    --signal=TERM \
    --kill-after=1s \
    "$(seconds_with_fraction "$LEETBATTLE_COMPILE_WALL_MS")" \
    "${compile_limits[@]}" \
    "${drop_privileges[@]}" \
    "${compile_environment[@]}" \
    "$SUBMISSION_GUARD" \
    "${compile_command[@]}" \
  >/dev/null 2>&1 &
active_group_pid="$!"
wait "$active_group_pid"
compile_status="$?"
kill_active_group
set -e
compile_finished="$(date +%s%3N)"
compile_ms="$(elapsed_ms "$compile_started" "$compile_finished")"

if [ "$compile_status" -ne 0 ]; then
  case "$compile_status" in
    124|137|152)
      finish "time_limit" "$compile_ms" 0 "false"
      ;;
    125|126|127)
      fail_infrastructure "$compile_ms" 0
      ;;
    *)
      finish "compile_error" "$compile_ms" 0 "false"
      ;;
  esac
fi

artifact_size="$(du -sb "$build_directory" | awk 'NR == 1 { print $1 }')" ||
  fail_infrastructure "$compile_ms" 0
require_bounded_uint "$artifact_size" 1 "$workspace_bytes" ||
  finish "output_limit" "$compile_ms" 0 "false"

runtime_limits=(
  /usr/bin/prlimit
  "--cpu=$runtime_cpu_seconds:$runtime_cpu_seconds"
  "--nproc=$LEETBATTLE_MAX_PROCESSES:$LEETBATTLE_MAX_PROCESSES"
  "--fsize=$runtime_output_bytes:$runtime_output_bytes"
  --nofile=128:128
  --core=0:0
)
if [ "$LEETBATTLE_LANGUAGE" = "python" ]; then
  runtime_limits+=("--as=$python_address_space_bytes:$python_address_space_bytes")
fi
runtime_limits+=(--)

runtime_environment=(
  /usr/bin/env -i
  HOME=/nonexistent
  "PATH=/opt/python/3.13.5/bin:$JAVA_HOME/bin:/usr/bin:/bin"
  "LD_LIBRARY_PATH=/opt/python/3.13.5/lib"
  "TMPDIR=$temporary_directory"
  "LEETBATTLE_COMPILE_MS=$compile_ms"
)

if [ "$LEETBATTLE_LANGUAGE" = "python" ]; then
  runtime_command=("$PYTHON_BIN" -I -B "$WORKSPACE/harness.py")
else
  heap_mb="$((LEETBATTLE_MEMORY_MB / 2))"
  metaspace_mb="$((LEETBATTLE_MEMORY_MB / 8))"
  [ "$metaspace_mb" -ge 32 ] || metaspace_mb=32
  runtime_command=(
    "$JAVA_HOME/bin/java"
    -XX:+UseSerialGC
    "-Xmx${heap_mb}m"
    "-XX:MaxMetaspaceSize=${metaspace_mb}m"
    -XX:MaxDirectMemorySize=16m
    -XX:ReservedCodeCacheSize=16m
    -Xss256k
    "-Djava.io.tmpdir=$temporary_directory"
    -cp "$build_directory"
    Harness
  )
fi

runtime_started="$(date +%s%3N)"
set +e
/usr/bin/setsid \
  /usr/bin/timeout \
    --signal=TERM \
    --kill-after=1s \
    "$(seconds_with_fraction "$LEETBATTLE_RUN_WALL_MS")" \
    "${runtime_limits[@]}" \
    "${drop_privileges[@]}" \
    "${runtime_environment[@]}" \
    "$SUBMISSION_GUARD" \
    "${runtime_command[@]}" \
  < "$WORKSPACE/cases.ndjson" \
  > "$protocol_file" 2>&1 &
active_group_pid="$!"
wait "$active_group_pid"
runtime_status="$?"
kill_active_group
set -e
runtime_finished="$(date +%s%3N)"
runtime_ms="$(elapsed_ms "$runtime_started" "$runtime_finished")"
protocol_bytes="$(wc -c < "$protocol_file")" ||
  fail_infrastructure "$compile_ms" "$runtime_ms"

if [ "$protocol_bytes" -gt "$LEETBATTLE_MAX_OUTPUT_BYTES" ]; then
  finish "output_limit" "$compile_ms" "$runtime_ms" "true"
fi

case "$runtime_status" in
  0)
    finish "ok" "$compile_ms" "$runtime_ms" "true"
    ;;
  124|137|152|153)
    finish "time_limit" "$compile_ms" "$runtime_ms" "true"
    ;;
  125|126|127)
    fail_infrastructure "$compile_ms" "$runtime_ms"
    ;;
  *)
    finish "runtime_error" "$compile_ms" "$runtime_ms" "true"
    ;;
esac
