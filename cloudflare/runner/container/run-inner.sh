#!/bin/sh
set -eu

/opt/leetbattle/verify-inner-isolation

case "${LEETBATTLE_RUN_WALL_MS:-}" in
  ""|*[!0-9]*) exit 125 ;;
esac
[ "$LEETBATTLE_RUN_WALL_MS" -gt 0 ] || exit 125

run_seconds="$((LEETBATTLE_RUN_WALL_MS / 1000))"
run_fraction="$((LEETBATTLE_RUN_WALL_MS % 1000))"
run_timeout="${run_seconds}.$(printf '%03d' "$run_fraction")s"

case "${LEETBATTLE_LANGUAGE:-}" in
  python)
    export HOME=/nonexistent
    export LD_LIBRARY_PATH=/opt/python/3.13.5/lib
    export PATH=/opt/python/3.13.5/bin:/usr/bin:/bin
    export TMPDIR=/tmp
    set +e
    timeout --signal=TERM --kill-after=1s "$run_timeout" \
      /opt/python/3.13.5/bin/python3.13 \
      -I -B /submission/harness.py
    child_status="$?"
    set -e
    ;;
  java)
    export HOME=/nonexistent
    export PATH=/opt/java/openjdk/bin:/usr/bin:/bin
    export TMPDIR=/tmp
    set +e
    timeout --signal=TERM --kill-after=1s "$run_timeout" \
      /opt/java/openjdk/bin/java \
      -XX:+ExitOnOutOfMemoryError \
      -XX:+UseSerialGC \
      -XX:InitialRAMPercentage=6.25 \
      -XX:MaxRAMPercentage=50 \
      -XX:MaxMetaspaceSize=32m \
      -XX:MaxDirectMemorySize=16m \
      -XX:ReservedCodeCacheSize=16m \
      -Xss256k \
      -Djava.io.tmpdir=/tmp \
      -cp /build \
      Harness
    child_status="$?"
    set -e
    ;;
  *)
    exit 125
    ;;
esac

# Submitted code may deliberately exit with Docker/timeout-reserved statuses.
# Remap them only after the trusted verifier succeeded so they remain ordinary
# runtime failures rather than attacker-selected infrastructure failures.
case "$child_status" in
  125|126|127) exit 1 ;;
  *) exit "$child_status" ;;
esac
