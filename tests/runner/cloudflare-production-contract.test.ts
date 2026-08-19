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
const supervisor = runnerFile("container/run-judge.sh");
const submissionGuard = runnerFile("container/submission-guard.c");
const adapter = runnerFile("src/sandbox-adapter.ts");
const wrangler = runnerFile("wrangler.jsonc");

describe("Cloudflare production runner contract (no Docker required)", () => {
  it("pins the Sandbox VM and both language runtimes without nested Docker", () => {
    const imageSources = [...dockerfile.matchAll(/^FROM\s+(\S+)/gm)].map(
      (match) => match[1]!,
    );
    expect(imageSources).toHaveLength(4);
    for (const source of imageSources) {
      expect(source).toMatch(/^docker\.io\/.+@sha256:[0-9a-f]{64}$/);
    }
    expect(dockerfile).toContain("cloudflare/sandbox:0.12.7@sha256:");
    expect(dockerfile).toContain("eclipse-temurin:21.0.8_9-jdk-jammy@sha256:");
    expect(dockerfile).toContain("ARG PYTHON_VERSION=3.13.5");
    expect(dockerfile).toContain("ARG PYTHON_SHA256=");
    expect(dockerfile).toContain('ENTRYPOINT ["/container-server/sandbox"]');
    expect(dockerfile).not.toMatch(/docker:(?:dind|\d)|dockerd|judge-rootfs/);
    expect(`${dockerfile}\n${supervisor}`).not.toMatch(/\bdocker\s/);
    expect(dockerignore).toContain("!container/run-judge.sh");
    expect(dockerignore).toContain("!container/submission-guard.c");
    expect(dockerignore).not.toContain("boot-rootless-docker.sh");
  });

  it("uses one fresh internet-disabled Sandbox VM and destroys it after every execution", () => {
    expect(adapter).toContain("override enableInternet = false");
    expect(adapter).toContain("`judge-${crypto.randomUUID()}`");
    expect(adapter).toContain("keepAlive: false");
    expect(adapter).toContain('sleepAfter: "1m"');
    expect(adapter).toContain("sandbox.startProcess(TRUSTED_COMMAND");
    expect(adapter).toContain("process.waitForExit(");
    expect(adapter).toContain('judgeProcess.kill("SIGKILL")');
    expect(adapter).toContain("disposeRpcValue(completed)");
    expect(adapter).toContain("disposeRpcValue(logs)");
    expect(adapter).toContain("disposeRpcValue(judgeProcess)");
    expect(adapter).toContain("withDeadline(sandbox.destroy()");
  });

  it("drops submission privileges and installs hard process limits before either runtime", () => {
    for (const requiredSetting of [
      "--reuid=65532",
      "--regid=65532",
      "--clear-groups",
      "--no-new-privs",
      "--bounding-set=-all",
      "--inh-caps=-all",
      "--ambient-caps=-all",
      '"--cpu=$compile_cpu_seconds:$compile_cpu_seconds"',
      '"--cpu=$runtime_cpu_seconds:$runtime_cpu_seconds"',
      '"--nproc=$LEETBATTLE_MAX_PROCESSES:$LEETBATTLE_MAX_PROCESSES"',
      '"--as=$python_address_space_bytes:$python_address_space_bytes"',
      "--nofile=128:128",
      "--core=0:0",
      "/usr/bin/setsid",
      "/usr/bin/timeout",
    ]) {
      expect(supervisor).toContain(requiredSetting);
    }
    expect(supervisor).toContain('kill -KILL -- "-$active_group_pid"');
    expect(supervisor).toContain('chmod 0400 "$WORKSPACE/cases.ndjson"');
    expect(supervisor).toContain('chmod 0555 "$WORKSPACE"');
    expect(supervisor).toContain("readonly PYTHON_RUNTIME_OVERHEAD_MB=64");
  });

  it("places a fail-closed seccomp boundary around compilation and execution", () => {
    expect(dockerfile).toContain("libseccomp-dev");
    expect(dockerfile).toContain("-Werror=format-security");
    expect(dockerfile).toContain(
      "COPY --from=guard-builder /tmp/submission-guard /opt/leetbattle/submission-guard",
    );
    expect(dockerfile).toContain("ldd /opt/leetbattle/submission-guard");

    expect(supervisor).toContain(
      'readonly SUBMISSION_GUARD="/opt/leetbattle/submission-guard"',
    );
    expect(supervisor.match(/"\$SUBMISSION_GUARD"/g)).toHaveLength(2);
    for (const environment of [
      '"${compile_environment[@]}"',
      '"${runtime_environment[@]}"',
    ]) {
      expect(supervisor.indexOf(environment)).toBeLessThan(
        supervisor.indexOf(
          '"$SUBMISSION_GUARD"',
          supervisor.indexOf(environment),
        ),
      );
    }

    for (const requiredControl of [
      "getresuid",
      "getresgid",
      "getgroups",
      "SYS_capget",
      "PR_CAPBSET_READ",
      "PR_SET_NO_NEW_PRIVS",
      "PR_SET_DUMPABLE",
      "SYS_close_range",
      "SCMP_FLTATR_ACT_BADARCH",
      "SCMP_ACT_KILL_PROCESS",
      "SCMP_ACT_ERRNO(EPERM)",
      '"socket"',
      '"connect"',
      '"socketcall"',
      '"io_uring_setup"',
      '"pidfd_getfd"',
      "execv(argv[1]",
    ]) {
      expect(submissionGuard).toContain(requiredControl);
    }
    expect(submissionGuard).not.toMatch(/\b(system|popen|execvp|execlp)\s*\(/);
  });

  it("keeps hidden expected values in the Worker and passes only case arguments over stdin", () => {
    expect(adapter).toContain("JSON.stringify({ args: judgeCase.args })");
    expect(adapter).toContain("compareJudgeOutput(");
    expect(supervisor).toContain('< "$WORKSPACE/cases.ndjson"');
    expect(supervisor).not.toMatch(/eval|source\s+\$|bash\s+-c/);
    expect(adapter).toContain("sandbox.writeFile(`${WORKSPACE}/${sourceName}`");
  });

  it("bounds compiler, runtime, output, source, process, and workspace inputs", () => {
    for (const variable of [
      "LEETBATTLE_COMPILE_WALL_MS",
      "LEETBATTLE_COMPILE_CPU_MS",
      "LEETBATTLE_RUN_CPU_MS",
      "LEETBATTLE_RUN_WALL_MS",
      "LEETBATTLE_MEMORY_MB",
      "LEETBATTLE_MAX_PROCESSES",
      "LEETBATTLE_MAX_OUTPUT_BYTES",
      "LEETBATTLE_MAX_WORKSPACE_MB",
    ]) {
      expect(adapter).toContain(variable);
      expect(supervisor).toContain(variable);
    }
    expect(adapter).toContain("MAX_CASE_INPUT_BYTES");
    expect(supervisor).toContain(
      'runtime_output_bytes="$((LEETBATTLE_MAX_OUTPUT_BYTES + 1))"',
    );
    expect(supervisor).toContain(
      'head -c "$LEETBATTLE_MAX_OUTPUT_BYTES" "$protocol_file"',
    );
    expect(supervisor).toContain(
      'require_bounded_uint "$artifact_size" 1 "$workspace_bytes"',
    );
  });

  it("keeps the trusted protocol packet last and treats incomplete output as a judge failure", () => {
    expect(
      supervisor.indexOf('head -c "$LEETBATTLE_MAX_OUTPUT_BYTES"'),
    ).toBeLessThan(supervisor.indexOf('emit_status "$status"'));
    expect(adapter).toContain("const supervisor = parseSupervisorMessage(");
    expect(adapter).toContain("executionIntegrityVerdict({");
  });

  it("aligns the HTTP deadline with judging, explicit process kill, and VM destruction", () => {
    const overheadMs = Number(
      adapter
        .match(/SUPERVISOR_OVERHEAD_MS = ([\d_]+);/)?.[1]
        ?.replaceAll("_", ""),
    );
    const killMs = Number(
      adapter
        .match(/SANDBOX_PROCESS_KILL_TIMEOUT_MS = ([\d_]+);/)?.[1]
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
    expect(overheadMs).toBe(20_000);
    expect(killMs).toBe(3_000);
    expect(destroyMs).toBe(15_000);
    expect(RUNNER_HTTP_TIMEOUT_MS).toBeGreaterThan(
      maxJudgeMs + overheadMs + killMs + destroyMs,
    );
  });

  it("emits safe phase telemetry and keeps all production entrypoints statically valid", () => {
    for (const phase of [
      "provision_workspace",
      "write_inputs",
      "start_judge",
      "wait_for_judge",
      "read_judge_output",
    ]) {
      expect(adapter).toContain(phase);
    }
    expect(adapter).not.toMatch(/error\.message|error\.stack/);
    expect(wrangler).toContain('"instance_type": "standard-2"');
    execFileSync("bash", ["-n", `${runnerRoot}/container/run-judge.sh`]);
  });
});
