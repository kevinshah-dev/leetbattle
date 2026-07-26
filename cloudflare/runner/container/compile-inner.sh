#!/bin/sh
set -eu

/opt/leetbattle/verify-inner-isolation

case "${LEETBATTLE_COMPILE_WALL_MS:-}" in
  ""|*[!0-9]*) exit 125 ;;
esac
[ "$LEETBATTLE_COMPILE_WALL_MS" -gt 0 ] || exit 125

compile_seconds="$((LEETBATTLE_COMPILE_WALL_MS / 1000))"
compile_fraction="$((LEETBATTLE_COMPILE_WALL_MS % 1000))"
compile_timeout="${compile_seconds}.$(printf '%03d' "$compile_fraction")s"

case "${LEETBATTLE_LANGUAGE:-}" in
  python)
    export HOME=/nonexistent
    export LD_LIBRARY_PATH=/opt/python/3.13.5/lib
    export PATH=/opt/python/3.13.5/bin:/usr/bin:/bin
    set +e
    timeout --signal=TERM --kill-after=1s "$compile_timeout" \
      /opt/python/3.13.5/bin/python3.13 \
      -I -c \
      'import py_compile; py_compile.compile("/submission/solution.py", cfile="/workspace/solution.pyc", doraise=True)'
    child_status="$?"
    set -e
    ;;
  java)
    case "${LEETBATTLE_MEMORY_MB:-}" in
      ""|*[!0-9]*) exit 125 ;;
    esac
    [ "$LEETBATTLE_MEMORY_MB" -ge 64 ] || exit 125
    heap_mb="$((LEETBATTLE_MEMORY_MB / 2))"
    metaspace_mb="$((LEETBATTLE_MEMORY_MB / 8))"
    [ "$metaspace_mb" -ge 32 ] || metaspace_mb=32
    export HOME=/nonexistent
    export PATH=/opt/java/openjdk/bin:/usr/bin:/bin
    export TMPDIR=/tmp
    set +e
    timeout --signal=TERM --kill-after=1s "$compile_timeout" \
      /opt/java/openjdk/bin/javac \
      "-J-Xmx${heap_mb}m" \
      "-J-XX:MaxMetaspaceSize=${metaspace_mb}m" \
      -encoding UTF-8 \
      -d /build \
      /submission/Solution.java \
      /submission/Harness.java
    child_status="$?"
    set -e
    ;;
  *)
    exit 125
    ;;
esac

# Exit 125 is reserved for the isolation verifier; 126/127 are reserved for
# trusted container-launch failures. Compiler-controlled statuses cannot mint
# an infrastructure verdict.
case "$child_status" in
  125|126|127) exit 1 ;;
  *) exit "$child_status" ;;
esac
