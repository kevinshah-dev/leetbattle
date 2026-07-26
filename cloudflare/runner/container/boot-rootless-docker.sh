#!/bin/sh
set -eu

JUDGE_IMAGE="leetbattle-judge:python-3.13.5-java-21.0.8-v2"
ROOTFS_ARCHIVE="/opt/leetbattle/judge-rootfs.tar"
ROOTFS_CHECKSUM="/opt/leetbattle/judge-rootfs.tar.sha256"
READY_DIRECTORY="/home/rootless/.cache/leetbattle"
READY_FILE="$READY_DIRECTORY/inner-sandbox.ready"
DOCKER_LOG="$READY_DIRECTORY/dockerd.log"

rm -f "$READY_FILE" "$DOCKER_LOG"
umask 077

dockerd-entrypoint.sh dockerd \
  --iptables=false \
  --ip6tables=false \
  --bridge=none \
  --ip-forward=false \
  --ip-masq=false \
  --userland-proxy=false \
  >"$DOCKER_LOG" 2>&1 &
dockerd_pid="$!"

cleanup() {
  rm -f "$READY_FILE"
  kill "$dockerd_pid" 2>/dev/null || true
  wait "$dockerd_pid" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 143' HUP INT TERM

attempt=0
while ! docker info >/dev/null 2>&1; do
  attempt="$((attempt + 1))"
  if [ "$attempt" -ge 120 ] || ! kill -0 "$dockerd_pid" 2>/dev/null; then
    printf '%s\n' "rootless Docker failed to become ready" >&2
    exit 1
  fi
  sleep 0.5
done
docker info --format '{{json .SecurityOptions}}' 2>/dev/null |
  grep -q '"name=rootless"' || {
    printf '%s\n' "Docker daemon is not rootless" >&2
    exit 1
  }
[ "$(docker info --format '{{.CgroupVersion}}' 2>/dev/null)" = "2" ] || {
  printf '%s\n' "Docker daemon does not expose cgroup v2" >&2
  exit 1
}

expected_rootfs_sha="$(awk 'NR == 1 { print $1 }' "$ROOTFS_CHECKSUM")"
case "$expected_rootfs_sha" in
  ""|*[!0-9a-f]*) printf '%s\n' "judge rootfs checksum is invalid" >&2; exit 1 ;;
esac
actual_rootfs_sha="$(sha256sum "$ROOTFS_ARCHIVE" | awk '{ print $1 }')"
[ "$actual_rootfs_sha" = "$expected_rootfs_sha" ] || {
  printf '%s\n' "judge rootfs checksum verification failed" >&2
  exit 1
}

if ! docker image inspect "$JUDGE_IMAGE" >/dev/null 2>&1; then
  docker import "$ROOTFS_ARCHIVE" "$JUDGE_IMAGE" >/dev/null
fi
image_id="$(docker image inspect --format '{{.Id}}' "$JUDGE_IMAGE")"
case "$image_id" in
  sha256:[0-9a-f]*) ;;
  *) printf '%s\n' "judge image identity is invalid" >&2; exit 1 ;;
esac

# Rootless Docker only receives a ready marker after the same restrictions used
# for jobs have been proven from inside a fresh container. Platforms without
# delegated cgroup v2 controllers therefore fail closed during startup.
docker run \
  --pull=never \
  --rm \
  --log-driver=none \
  --read-only \
  --network=none \
  --ipc=private \
  --user=65532:65532 \
  --cap-drop=ALL \
  --security-opt=no-new-privileges=true \
  --pids-limit=32 \
  --memory=134217728 \
  --memory-swap=134217728 \
  --cpus=1 \
  --shm-size=1048576 \
  --ulimit=core=0:0 \
  --ulimit=nofile=64:64 \
  --tmpfs=/workspace:rw,nosuid,nodev,noexec,size=1048576,uid=65532,gid=65532,mode=0700 \
  --tmpfs=/tmp:rw,nosuid,nodev,noexec,size=1048576,mode=1777 \
  --env=HOME=/nonexistent \
  --env=PATH=/opt/python/3.13.5/bin:/opt/java/openjdk/bin:/usr/bin:/bin \
  --env=LEETBATTLE_EXPECT_MEMORY_BYTES=134217728 \
  --env=LEETBATTLE_EXPECT_PIDS=32 \
  --env=LEETBATTLE_EXPECT_WORKSPACE_BYTES=1048576 \
  --env=LEETBATTLE_EXPECT_TMP_BYTES=1048576 \
  --env=LEETBATTLE_EXPECT_SHM_BYTES=1048576 \
  --env=LEETBATTLE_EXPECT_WRITABLE_BYTES=3145728 \
  --env=LEETBATTLE_EXPECT_CPU_MILLIS=1000 \
  "$JUDGE_IMAGE" \
  /opt/leetbattle/verify-inner-isolation \
  >/dev/null 2>&1

ready_tmp="$READY_FILE.$$"
printf '%s %s\n' "$image_id" "$actual_rootfs_sha" > "$ready_tmp"
chmod 0400 "$ready_tmp"
mv -f "$ready_tmp" "$READY_FILE"

wait "$dockerd_pid"
