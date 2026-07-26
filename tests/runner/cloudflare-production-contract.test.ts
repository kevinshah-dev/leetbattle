import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PUBLIC_PROBLEMS } from "../../src/problems/public/catalog";
import { RUNNER_HTTP_TIMEOUT_MS } from "../../src/server/match/runner-client";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
const runnerRoot = `${repositoryRoot}/cloudflare/runner`;

function runnerFile(path: string): string {
  return readFileSync(`${runnerRoot}/${path}`, "utf8");
}

const dockerfile = runnerFile("Dockerfile");
const dockerignore = runnerFile(".dockerignore");
const boot = runnerFile("container/boot-rootless-docker.sh");
const supervisor = runnerFile("container/run-judge.sh");
const isolationProbe = runnerFile("container/verify-inner-isolation.sh");
const compileInner = runnerFile("container/compile-inner.sh");
const runInner = runnerFile("container/run-inner.sh");
const adapter = runnerFile("src/sandbox-adapter.ts");
const wrangler = runnerFile("wrangler.jsonc");

describe("Cloudflare production runner contract (no Docker required)", () => {
  it("pins every external image and imports the judge rootfs without runtime network access", () => {
    const imageSources = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map(
      (match) => match[1]!,
    );
    const externalImages = imageSources.filter(
      (source) => source !== "judge-rootfs",
    );
    expect(externalImages.length).toBeGreaterThanOrEqual(5);
    for (const source of externalImages) {
      expect(source).toMatch(/^docker\.io\/.+@sha256:[0-9a-f]{64}$/);
    }
    expect(dockerfile).toContain("docker:29.6.2-dind-rootless@sha256:");
    expect(dockerfile).toContain("cloudflare/sandbox:0.12.4-musl@sha256:");
    expect(dockerfile).toContain('ENV SANDBOX_VERSION="0.12.4"');
    expect(dockerfile).toContain("apk add --no-cache bash coreutils curl jq");
    expect(dockerfile).toMatch(/--exclude=\.\/(?:dev|proc|sys|tmp)\/\*/);
    expect(boot).toContain('docker import "$ROOTFS_ARCHIVE"');
    expect(boot).toContain('sha256sum "$ROOTFS_ARCHIVE"');
    expect(`${boot}\n${supervisor}`).not.toMatch(/\bdocker\s+(?:pull|build)\b/);
    expect(supervisor).toContain("--pull=never");
    for (const buildInput of [
      "!container/",
      "!container/boot-rootless-docker.sh",
      "!container/run-judge.sh",
      "!container/compile-inner.sh",
      "!container/run-inner.sh",
      "!container/verify-inner-isolation.sh",
    ]) {
      expect(dockerignore).toContain(buildInput);
    }
  });

  it("keeps the daemon rootless and withholds readiness until fail-closed preflight passes", () => {
    expect(boot).toContain("dockerd-entrypoint.sh dockerd");
    expect(boot).toContain("--iptables=false");
    expect(boot).toContain("--ip6tables=false");
    expect(boot).toContain("--bridge=none");
    expect(boot).toContain("'{{.CgroupVersion}}'");
    expect(boot).toContain('"name=rootless"');
    const probeIndex = boot.indexOf("/opt/leetbattle/verify-inner-isolation");
    const readyIndex = boot.indexOf('mv -f "$ready_tmp" "$READY_FILE"');
    expect(probeIndex).toBeGreaterThan(0);
    expect(readyIndex).toBeGreaterThan(probeIndex);
  });

  it("proves inner identity, cgroups, read-only mounts, and an isolated network before execution", () => {
    for (const requiredCheck of [
      'id -u)" = "65532"',
      'id -g)" = "65532"',
      "^NoNewPrivs:",
      "CapEff",
      "^Seccomp:",
      "mount_has_option / ro",
      "/sys/fs/cgroup/memory.max",
      "/sys/fs/cgroup/pids.max",
      "/sys/fs/cgroup/cpu.max",
      "/sys/class/net/*",
      '[ "$interface_name" = "lo" ]',
      "127.0.0.1",
      "/var/run/docker.sock",
      "/run/user/1000/docker.sock",
      "unexpected-writable-mount",
      "/proc/1/status",
    ]) {
      expect(isolationProbe).toContain(requiredCheck);
    }
    expect(compileInner.indexOf("verify-inner-isolation")).toBeLessThan(
      compileInner.indexOf("javac"),
    );
    expect(runInner.indexOf("verify-inner-isolation")).toBeLessThan(
      runInner.indexOf("/submission/harness.py"),
    );
  });

  it("runs submissions with no network, no capabilities, immutable inputs, and no hidden-suite mount", () => {
    for (const requiredArgument of [
      "--read-only",
      "--network=none",
      "--user=65532:65532",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges=true",
      "--pids-limit=",
      "--memory=",
      "--memory-swap=",
      "--cpus=1",
      "readonly",
    ]) {
      expect(supervisor).toContain(requiredArgument);
    }
    expect(supervisor).toContain('< "$WORKSPACE/cases.ndjson"');
    expect(supervisor).not.toMatch(/--mount=.*cases\.ndjson/);
    expect(supervisor).not.toContain("/var/run/docker.sock");
    expect(supervisor).not.toMatch(/--mount=.*\/run\/user\/1000\/docker\.sock/);
    expect(adapter).toContain('"/submission/solution.py"');
  });

  it("bounds aggregate writable filesystems, including Java handoff and shared memory", () => {
    expect(supervisor).toContain("--opt=type=tmpfs");
    expect(supervisor).toContain("--opt=device=tmpfs");
    expect(supervisor).toContain(
      "total_writable_bytes -\n    shm_bytes -\n    tmp_bytes -\n    job_workspace_bytes",
    );
    expect(supervisor).toContain('--shm-size="$shm_bytes"');
    expect(supervisor).toContain(
      '--tmpfs="/workspace:rw,nosuid,nodev,noexec,size=$job_workspace_bytes',
    );
    expect(supervisor).toContain(
      '--tmpfs="/tmp:rw,nosuid,nodev,noexec,size=$tmp_bytes',
    );
    expect(supervisor).toContain(
      '--env="LEETBATTLE_EXPECT_BUILD_BYTES=$build_bytes"',
    );
    for (const mount of ["/workspace", "/tmp", "/dev/shm", "/build"]) {
      expect(isolationProbe).toContain(mount);
    }
    expect(isolationProbe).toContain("aggregate-writable-limit");
    expect(isolationProbe).toContain("LEETBATTLE_EXPECT_WRITABLE_BYTES");
    expect(isolationProbe).toContain("/etc/resolv.conf");
    expect(isolationProbe).toContain("/etc/hostname");
    expect(isolationProbe).toContain("/etc/hosts");
  });

  it("uses separate compiler CPU/wall and runtime CPU/wall budgets", () => {
    expect(adapter).toContain("LEETBATTLE_COMPILE_WALL_MS");
    expect(adapter).toContain("LEETBATTLE_COMPILE_CPU_MS");
    expect(adapter).toContain("LEETBATTLE_RUN_CPU_MS");
    expect(adapter).toContain("LEETBATTLE_RUN_WALL_MS");
    expect(supervisor).toContain(
      '--ulimit="cpu=$compile_cpu_seconds:$compile_cpu_seconds"',
    );
    expect(supervisor).toContain(
      '--ulimit="cpu=$runtime_cpu_seconds:$runtime_cpu_seconds"',
    );
    expect(compileInner).toContain("LEETBATTLE_COMPILE_WALL_MS");
    expect(runInner).toContain("LEETBATTLE_RUN_WALL_MS");
    expect(supervisor).not.toContain("LEETBATTLE_RUN_MS");
    expect(supervisor).toContain(".cpu_stats.cpu_usage.total_usage");
    expect(supervisor).toContain("budget_ms * 1000000");
    expect(supervisor).toContain('"$LEETBATTLE_COMPILE_CPU_MS"');
    expect(supervisor).toContain('"$LEETBATTLE_RUN_CPU_MS"');
    expect(supervisor).not.toContain("compile.log");
    expect(compileInner).toMatch(
      /case "\$child_status" in[\s\S]*125\|126\|127\) exit 1/,
    );
    expect(compileInner).toContain('cfile="/workspace/solution.pyc"');
    expect(runInner).toMatch(
      /case "\$child_status" in[\s\S]*125\|126\|127\) exit 1/,
    );
    expect(runInner).toContain("-I -B /submission/harness.py");

    for (const { limits } of PUBLIC_PROBLEMS) {
      for (const milliseconds of [limits.compileTimeMs, limits.runTimeMs]) {
        const roundedSeconds = Math.ceil(milliseconds / 1_000);
        expect(roundedSeconds * 1_000 - milliseconds).toBeGreaterThanOrEqual(0);
        expect(roundedSeconds * 1_000 - milliseconds).toBeLessThan(1_000);
      }
    }
  });

  it("aligns the HTTP deadline with cold start, judging, and bounded destruction", () => {
    const readyMs = Number(
      adapter
        .match(/INNER_SANDBOX_READY_TIMEOUT_MS = ([\d_]+);/)?.[1]
        ?.replaceAll("_", ""),
    );
    const overheadMs = Number(
      adapter
        .match(/SUPERVISOR_OVERHEAD_MS = ([\d_]+);/)?.[1]
        ?.replaceAll("_", ""),
    );
    const destroyMs = Number(
      adapter
        .match(/SANDBOX_DESTROY_TIMEOUT_MS = ([\d_]+);/)?.[1]
        ?.replaceAll("_", ""),
    );
    const maxJudgeMs = Math.max(
      ...PUBLIC_PROBLEMS.map(
        ({ limits }) => limits.compileTimeMs + limits.wallTimeMs,
      ),
    );
    expect(readyMs).toBe(90_000);
    expect(overheadMs).toBe(20_000);
    expect(destroyMs).toBe(15_000);
    expect(RUNNER_HTTP_TIMEOUT_MS).toBeGreaterThan(
      readyMs + maxJudgeMs + overheadMs + destroyMs,
    );
    expect(adapter).toContain("withDeadline(sandbox.destroy()");
  });

  it("keeps the production config and every shell entrypoint statically valid", () => {
    expect(wrangler).toContain('"instance_type": "standard-2"');
    execFileSync("bash", ["-n", `${runnerRoot}/container/run-judge.sh`]);
    for (const script of [
      "boot-rootless-docker.sh",
      "verify-inner-isolation.sh",
      "compile-inner.sh",
      "run-inner.sh",
    ]) {
      execFileSync("sh", ["-n", `${runnerRoot}/container/${script}`]);
    }
  });
});
