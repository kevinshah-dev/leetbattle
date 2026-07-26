#!/bin/sh
set -eu

# This probe runs inside every untrusted inner container before a compiler or
# submitted program starts. It deliberately reports only a stable check name:
# host paths, cgroup values, and submission data must never enter runner logs.
fail() {
  printf 'inner isolation check failed: %s\n' "$1" >&2
  exit 125
}

require_uint() {
  case "${1:-}" in
    ""|*[!0-9]*) return 1 ;;
    *) [ "$1" -gt 0 ] ;;
  esac
}

mount_has_option() {
  mount_point="$1"
  wanted="$2"
  awk -v mount_point="$mount_point" -v wanted="$wanted" '
    $5 == mount_point {
      count = split($6, options, ",")
      for (index = 1; index <= count; index += 1) {
        if (options[index] == wanted) {
          found = 1
        }
      }
    }
    END { exit found ? 0 : 1 }
  ' /proc/self/mountinfo
}

verify_tmpfs_bound() {
  tmpfs_path="$1"
  tmpfs_limit="$2"
  check_name="$3"
  writable="${4:-true}"
  [ "$(stat -f -c %T "$tmpfs_path" 2>/dev/null)" = "tmpfs" ] ||
    fail "${check_name}-filesystem"
  actual_bytes="$(
    df -B1 --output=size "$tmpfs_path" 2>/dev/null |
      awk 'NR == 2 { print $1 }'
  )"
  require_uint "$actual_bytes" || fail "${check_name}-size"
  [ "$actual_bytes" -le "$tmpfs_limit" ] ||
    fail "${check_name}-limit"
  if [ "$writable" = "true" ]; then
    probe_path="$tmpfs_path/.leetbattle-isolation-probe"
    (umask 077 && printf 'probe' > "$probe_path") 2>/dev/null ||
      fail "${check_name}-write"
    rm -f "$probe_path" || fail "${check_name}-cleanup"
  fi
}

require_uint "${LEETBATTLE_EXPECT_MEMORY_BYTES:-}" ||
  fail "memory-configuration"
require_uint "${LEETBATTLE_EXPECT_PIDS:-}" ||
  fail "process-configuration"
require_uint "${LEETBATTLE_EXPECT_WORKSPACE_BYTES:-}" ||
  fail "workspace-configuration"
require_uint "${LEETBATTLE_EXPECT_TMP_BYTES:-}" ||
  fail "temporary-configuration"
require_uint "${LEETBATTLE_EXPECT_SHM_BYTES:-}" ||
  fail "shared-memory-configuration"
require_uint "${LEETBATTLE_EXPECT_WRITABLE_BYTES:-}" ||
  fail "writable-configuration"
require_uint "${LEETBATTLE_EXPECT_CPU_MILLIS:-}" ||
  fail "cpu-configuration"

[ "$(id -u)" = "65532" ] || fail "uid"
[ "$(id -g)" = "65532" ] || fail "gid"

grep -Eq '^NoNewPrivs:[[:space:]]+1$' /proc/self/status ||
  fail "no-new-privileges"
grep -Eq '^Seccomp:[[:space:]]+2$' /proc/self/status ||
  fail "seccomp"
for capability_set in CapInh CapPrm CapEff CapBnd CapAmb; do
  grep -Eq "^${capability_set}:[[:space:]]+0+$" /proc/self/status ||
    fail "capabilities"
done

mount_has_option / ro || fail "read-only-root"
if (: > /leetbattle-root-write-probe) 2>/dev/null; then
  rm -f /leetbattle-root-write-probe
  fail "writable-root"
fi

# Docker's device tmpfs contains special device nodes, not ordinary workspace
# storage. Its directory and Docker-generated /etc files must remain
# non-writable to the submission; /dev/shm is checked and budgeted separately.
for immutable_path in \
  /dev \
  /etc \
  /etc/hostname \
  /etc/hosts \
  /etc/resolv.conf \
  /proc/sys \
  /sys
do
  [ ! -w "$immutable_path" ] || fail "unexpected-writable-mount"
done
grep -Eq '^Uid:[[:space:]]+65532([[:space:]]+65532){3}$' \
  /proc/1/status || fail "pid-namespace-user"

verify_tmpfs_bound \
  /workspace "$LEETBATTLE_EXPECT_WORKSPACE_BYTES" workspace true
verify_tmpfs_bound /tmp "$LEETBATTLE_EXPECT_TMP_BYTES" temporary true
verify_tmpfs_bound \
  /dev/shm "$LEETBATTLE_EXPECT_SHM_BYTES" shared-memory true

for cgroup_file in \
  /sys/fs/cgroup/cgroup.controllers \
  /sys/fs/cgroup/memory.current \
  /sys/fs/cgroup/memory.max \
  /sys/fs/cgroup/pids.current \
  /sys/fs/cgroup/pids.max \
  /sys/fs/cgroup/cpu.max \
  /sys/fs/cgroup/cpu.stat
do
  [ -r "$cgroup_file" ] || fail "cgroup-v2"
done

memory_max="$(cat /sys/fs/cgroup/memory.max)"
pids_max="$(cat /sys/fs/cgroup/pids.max)"
require_uint "$memory_max" || fail "memory-cgroup"
require_uint "$pids_max" || fail "process-cgroup"
[ "$memory_max" -le "$LEETBATTLE_EXPECT_MEMORY_BYTES" ] ||
  fail "memory-limit"
[ "$pids_max" -le "$LEETBATTLE_EXPECT_PIDS" ] ||
  fail "process-limit"

read -r cpu_quota cpu_period < /sys/fs/cgroup/cpu.max ||
  fail "cpu-cgroup"
require_uint "$cpu_quota" || fail "cpu-quota"
require_uint "$cpu_period" || fail "cpu-period"
[ "$((cpu_quota * 1000))" -le \
  "$((LEETBATTLE_EXPECT_CPU_MILLIS * cpu_period))" ] ||
  fail "cpu-limit"

network_interfaces=0
for interface_path in /sys/class/net/*; do
  [ -e "$interface_path" ] || continue
  interface_name="${interface_path##*/}"
  [ "$interface_name" = "lo" ] || fail "network-interface"
  network_interfaces="$((network_interfaces + 1))"
done
[ "$network_interfaces" -eq 1 ] || fail "network-namespace"

[ ! -e /var/run/docker.sock ] || fail "docker-socket"
[ ! -e /run/user/1000/docker.sock ] || fail "rootless-docker-socket"
/opt/python/3.13.5/bin/python3.13 -I -S - <<'PY' ||
import socket

probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
probe.settimeout(0.2)
try:
    if probe.connect_ex(("127.0.0.1", 3000)) == 0:
        raise SystemExit(1)
finally:
    probe.close()
PY
  fail "outer-localhost"

if [ "${LEETBATTLE_EXPECT_SUBMISSION_MOUNTS:-0}" = "1" ]; then
  case "${LEETBATTLE_LANGUAGE:-}" in
    python)
      solution_path="/submission/solution.py"
      harness_path="/submission/harness.py"
      ;;
    java)
      solution_path="/submission/Solution.java"
      harness_path="/submission/Harness.java"
      ;;
    *)
      fail "language"
      ;;
  esac
  for submission_path in "$solution_path" "$harness_path"; do
    [ -f "$submission_path" ] && [ ! -L "$submission_path" ] ||
      fail "submission-file"
    mount_has_option "$submission_path" ro ||
      fail "submission-read-only"
  done
fi

case "${LEETBATTLE_EXPECT_BUILD_MOUNT:-none}" in
  none)
    build_bytes=0
    ;;
  rw)
    require_uint "${LEETBATTLE_EXPECT_BUILD_BYTES:-}" ||
      fail "build-size-configuration"
    mount_has_option /build rw || fail "build-read-write"
    verify_tmpfs_bound \
      /build "$LEETBATTLE_EXPECT_BUILD_BYTES" build false
    build_probe="/build/.leetbattle-isolation-probe"
    (umask 077 && printf 'probe' > "$build_probe") 2>/dev/null ||
      fail "build-write"
    rm -f "$build_probe" || fail "build-cleanup"
    build_bytes="$LEETBATTLE_EXPECT_BUILD_BYTES"
    ;;
  ro)
    require_uint "${LEETBATTLE_EXPECT_BUILD_BYTES:-}" ||
      fail "build-size-configuration"
    mount_has_option /build ro || fail "build-read-only"
    verify_tmpfs_bound \
      /build "$LEETBATTLE_EXPECT_BUILD_BYTES" build false
    build_bytes="$LEETBATTLE_EXPECT_BUILD_BYTES"
    ;;
  *)
    fail "build-configuration"
    ;;
esac

writable_bytes="$((
  LEETBATTLE_EXPECT_WORKSPACE_BYTES +
    LEETBATTLE_EXPECT_TMP_BYTES +
    LEETBATTLE_EXPECT_SHM_BYTES +
    build_bytes
))"
[ "$writable_bytes" -le "$LEETBATTLE_EXPECT_WRITABLE_BYTES" ] ||
  fail "aggregate-writable-limit"

exit 0
