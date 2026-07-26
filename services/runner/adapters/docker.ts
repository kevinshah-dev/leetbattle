import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";

import { compareJudgeOutput } from "../../../src/problems/server/compare.server";
import { generateJavaHarness } from "../harness/java";
import { generatePythonHarness } from "../harness/python";
import type {
  AdapterExecutionRequest,
  HarnessMessage,
  RunnerAdapter,
  RunnerResult,
  RunnerVerdict,
  SampleResult,
} from "../types";

const execFileAsync = promisify(execFile);
const MARKER = "__LEETBATTLE_PROTOCOL__";
const RUNNER_RESOURCE_LABEL = "com.leetbattle.runner=true";
const RUNNER_CONTAINER_PATTERN = /^leetbattle-[0-9a-f]{24}$/;
const RUNNER_VOLUME_PATTERN = /^leetbattle-[0-9a-f]{24}-submission$/;

export interface DockerRunnerOptions {
  readonly dockerCommand?: string;
  readonly pythonImage?: string;
  readonly javaImage?: string;
}

export function isRunnerResourceName(
  kind: "container" | "volume",
  name: string,
): boolean {
  return kind === "container"
    ? RUNNER_CONTAINER_PATTERN.test(name)
    : RUNNER_VOLUME_PATTERN.test(name);
}

export function classifyDockerExit(state: {
  readonly OOMKilled?: unknown;
  readonly ExitCode?: unknown;
  readonly Status?: unknown;
  readonly Error?: unknown;
}): "memory_limit" | "time_limit" | "runtime_error" | undefined {
  if (state.OOMKilled === true) return "memory_limit";
  // 128 + SIGKILL and 128 + SIGXCPU. A deliberate wall-clock kill is
  // tracked separately, while these unexpected exits represent CPU limits.
  if (state.ExitCode === 137 || state.ExitCode === 152) return "time_limit";
  // Once Docker successfully started the sandbox, an early process exit is
  // attributable to submitted code (for example System.exit/os._exit), not a
  // retryable control-plane fault. Docker start errors retain infra semantics.
  if (
    state.Status === "exited" &&
    typeof state.ExitCode === "number" &&
    !state.Error
  ) {
    return "runtime_error";
  }
  return undefined;
}

export interface TrustedRuntimeAccounting {
  readonly caseRuntimeMs: number;
  readonly totalRuntimeMs: number;
  readonly exceeded: boolean;
}

/**
 * Accounts only control-plane monotonic time. Harness-reported timing is
 * intentionally not an input because submitted Python can replace its clock.
 */
export function accountTrustedCaseRuntime(
  aggregateMs: number,
  startedAtMs: number,
  finishedAtMs: number,
  limitMs: number,
): TrustedRuntimeAccounting {
  const caseRuntimeMs = Math.max(0, Math.ceil(finishedAtMs - startedAtMs));
  const totalRuntimeMs = aggregateMs + caseRuntimeMs;
  return {
    caseRuntimeMs,
    totalRuntimeMs,
    exceeded: totalRuntimeMs > limitMs,
  };
}

class LineChannel {
  private buffer = "";
  private readonly lines: string[] = [];
  private readonly waiters: Array<{
    resolve: (line: string) => void;
    reject: (error: Error) => void;
  }> = [];
  private closedError: Error | undefined;
  private bytes = 0;

  constructor(
    process: ChildProcessWithoutNullStreams,
    private readonly maxBytes: number,
    private readonly onOverflow: () => void,
  ) {
    process.stdout.on("data", (chunk: Buffer) => this.push(chunk));
    process.stderr.on("data", (chunk: Buffer) => this.push(chunk));
    process.once("error", (error) => this.close(error));
    process.once("close", (code, signal) =>
      this.close(
        new Error(
          `Sandbox exited before completing (${String(code)}/${String(signal)})`,
        ),
      ),
    );
  }

  private push(chunk: Buffer): void {
    this.bytes += chunk.byteLength;
    if (this.bytes > this.maxBytes) {
      this.onOverflow();
      this.close(new Error("Sandbox output limit exceeded"));
      return;
    }
    this.buffer += chunk.toString("utf8");
    while (true) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(line);
      else this.lines.push(line);
    }
  }

  private close(error: Error): void {
    if (this.closedError) return;
    this.closedError = error;
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  async next(deadline: number): Promise<string> {
    const line = this.lines.shift();
    if (line !== undefined) return line;
    if (this.closedError) throw this.closedError;
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error("Sandbox deadline exceeded");
    return await new Promise<string>((resolve, reject) => {
      const waiter = { resolve, reject };
      this.waiters.push(waiter);
      const timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error("Sandbox deadline exceeded"));
      }, remaining);
      timer.unref();
      waiter.resolve = (value) => {
        clearTimeout(timer);
        resolve(value);
      };
      waiter.reject = (error) => {
        clearTimeout(timer);
        reject(error);
      };
    });
  }
}

function safeMessage(verdict: RunnerVerdict): string {
  switch (verdict) {
    case "accepted":
      return "All evaluated cases passed.";
    case "wrong_answer":
      return "The returned value did not match the required result.";
    case "compile_error":
      return "The source could not be compiled.";
    case "runtime_error":
      return "The program stopped with a runtime error.";
    case "time_limit":
      return "The program exceeded the time limit.";
    case "memory_limit":
      return "The program exceeded the memory limit.";
    case "output_limit":
      return "The program produced too much output.";
    case "source_limit":
      return "The submitted source exceeds the allowed size or format.";
    case "infrastructure_error":
      return "The execution service is temporarily unavailable.";
  }
}

function result(
  request: AdapterExecutionRequest,
  verdict: RunnerVerdict,
  passed: number,
  total: number,
  runtimeMs: number,
  compileMs?: number,
  samples?: readonly SampleResult[],
): RunnerResult {
  return {
    executionId: request.executionId,
    status:
      verdict === "infrastructure_error" ? "infrastructure_error" : "completed",
    verdict,
    passed,
    total,
    runtimeMs,
    ...(compileMs === undefined ? {} : { compileMs }),
    message: safeMessage(verdict),
    ...(request.mode === "samples" && samples ? { samples } : {}),
  };
}

function isHarnessMessage(value: unknown): value is HarnessMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  if (message.kind === "compile_error")
    return typeof message.compileMs === "number";
  if (message.kind === "ready") {
    return (
      typeof message.compileMs === "number" &&
      Number.isFinite(message.compileMs)
    );
  }
  return (
    message.kind === "case" &&
    ["ok", "runtime_error", "memory_limit", "output_limit"].includes(
      String(message.status),
    ) &&
    typeof message.runtimeMs === "number" &&
    Number.isFinite(message.runtimeMs)
  );
}

async function nextProtocolMessage(
  channel: LineChannel,
  deadline: number,
): Promise<HarnessMessage> {
  while (true) {
    const line = await channel.next(deadline);
    if (!line.startsWith(MARKER)) continue;
    let decoded: unknown;
    try {
      decoded = JSON.parse(line.slice(MARKER.length));
    } catch {
      continue;
    }
    if (isHarnessMessage(decoded)) return decoded;
  }
}

function boundedActual(value: unknown, maxBytes: number): string | undefined {
  try {
    const serialized = JSON.stringify(value);
    if (Buffer.byteLength(serialized) > maxBytes) return undefined;
    return serialized;
  } catch {
    return undefined;
  }
}

export class DockerRunnerAdapter implements RunnerAdapter {
  private readonly dockerCommand: string;
  private readonly pythonImage: string;
  private readonly javaImage: string;
  private readinessCache:
    | { readonly expiresAt: number; readonly probe: Promise<boolean> }
    | undefined;

  constructor(options: DockerRunnerOptions = {}) {
    this.dockerCommand = options.dockerCommand ?? "docker";
    this.pythonImage = options.pythonImage ?? "leetbattle-python-runner:3.13";
    this.javaImage = options.javaImage ?? "leetbattle-java-runner:21";
  }

  async isReady(cacheMs = 5_000): Promise<boolean> {
    const now = Date.now();
    if (this.readinessCache && this.readinessCache.expiresAt > now) {
      return await this.readinessCache.probe;
    }
    const probe = (async () => {
      try {
        await execFileAsync(
          this.dockerCommand,
          ["info", "--format", "{{.ServerVersion}}"],
          { timeout: 3_000 },
        );
        await Promise.all(
          [this.pythonImage, this.javaImage].map((image) =>
            execFileAsync(this.dockerCommand, ["image", "inspect", image], {
              timeout: 3_000,
            }),
          ),
        );
        return true;
      } catch {
        return false;
      }
    })();
    this.readinessCache = { expiresAt: now + Math.max(250, cacheMs), probe };
    return await probe;
  }

  /**
   * Removes only label-owned, prefix-validated resources that are stopped or
   * older than the maximum possible execution lifetime. Fresh running work
   * from another runner instance is never touched.
   */
  async cleanupOrphans(maxAgeMs = 5 * 60_000): Promise<void> {
    const now = Date.now();
    try {
      const listed = await execFileAsync(
        this.dockerCommand,
        [
          "ps",
          "--all",
          "--filter",
          `label=${RUNNER_RESOURCE_LABEL}`,
          "--format",
          "{{.Names}}",
        ],
        { timeout: 5_000 },
      );
      const names = listed.stdout
        .split(/\r?\n/)
        .filter((name) => isRunnerResourceName("container", name));
      for (const name of names) {
        try {
          const inspected = await execFileAsync(
            this.dockerCommand,
            ["inspect", name],
            { timeout: 2_000 },
          );
          const record = (
            JSON.parse(inspected.stdout) as Array<{
              readonly Created?: unknown;
              readonly State?: { readonly Running?: unknown };
            }>
          )[0];
          const createdAt =
            typeof record?.Created === "string"
              ? Date.parse(record.Created)
              : Number.NaN;
          const freshAndRunning =
            record?.State?.Running === true &&
            Number.isFinite(createdAt) &&
            now - createdAt < maxAgeMs;
          if (freshAndRunning) continue;
          await execFileAsync(this.dockerCommand, ["kill", name], {
            timeout: 2_000,
          }).catch(() => undefined);
          await execFileAsync(this.dockerCommand, ["rm", "-f", name], {
            timeout: 2_000,
          }).catch(() => undefined);
          await execFileAsync(
            this.dockerCommand,
            ["volume", "rm", "-f", `${name}-submission`],
            { timeout: 2_000 },
          ).catch(() => undefined);
        } catch {
          // A concurrently completing execution is already cleaning itself.
        }
      }

      const volumes = await execFileAsync(
        this.dockerCommand,
        [
          "volume",
          "ls",
          "--filter",
          `label=${RUNNER_RESOURCE_LABEL}`,
          "--format",
          "{{.Name}}",
        ],
        { timeout: 5_000 },
      );
      for (const name of volumes.stdout
        .split(/\r?\n/)
        .filter((candidate) => isRunnerResourceName("volume", candidate))) {
        const containerName = name.slice(0, -"-submission".length);
        try {
          await execFileAsync(this.dockerCommand, ["inspect", containerName], {
            timeout: 1_000,
          });
          continue;
        } catch {
          // No owning container. Keep a just-created staging volume so another
          // live runner instance can finish attaching its execution container.
        }
        try {
          const inspected = await execFileAsync(
            this.dockerCommand,
            ["volume", "inspect", name],
            { timeout: 2_000 },
          );
          const record = (
            JSON.parse(inspected.stdout) as Array<{
              readonly CreatedAt?: unknown;
            }>
          )[0];
          const createdAt =
            typeof record?.CreatedAt === "string"
              ? Date.parse(record.CreatedAt)
              : Number.NaN;
          if (!Number.isFinite(createdAt) || now - createdAt < maxAgeMs) {
            continue;
          }
          await execFileAsync(
            this.dockerCommand,
            ["volume", "rm", "-f", name],
            { timeout: 2_000 },
          ).catch(() => undefined);
        } catch {
          // Best-effort startup hygiene must never widen the deletion scope.
        }
      }
    } catch {
      // Readiness will report an unavailable daemon/image without exposing why.
    }
  }

  async execute(request: AdapterExecutionRequest): Promise<RunnerResult> {
    const limits = request.problem.public.limits;
    if (
      Buffer.byteLength(request.source, "utf8") > limits.maxSourceBytes ||
      request.source.includes("\0") ||
      (request.language === "java" &&
        /^\s*package\s+[\w.]+\s*;/m.test(request.source))
    ) {
      return result(request, "source_limit", 0, request.cases.length, 0);
    }

    const directory = await mkdtemp(join(tmpdir(), "leetbattle-runner-"));
    const containerName = `leetbattle-${randomBytes(12).toString("hex")}`;
    const volumeName = `${containerName}-submission`;
    let child: ChildProcessWithoutNullStreams | undefined;
    let killedForOutput = false;
    let killedForTimeout = false;
    let compileMs: number | undefined;
    let runtimeMs = 0;
    let passed = 0;
    const sampleResults: SampleResult[] = [];

    const killContainer = async () => {
      await execFileAsync(this.dockerCommand, ["kill", containerName], {
        timeout: 2_000,
      }).catch(() => undefined);
    };
    const cleanupResources = async () => {
      await killContainer();
      await execFileAsync(this.dockerCommand, ["rm", "-f", containerName], {
        timeout: 2_000,
      }).catch(() => undefined);
      await execFileAsync(
        this.dockerCommand,
        ["volume", "rm", "-f", volumeName],
        { timeout: 2_000 },
      ).catch(() => undefined);
    };
    const inspectContainerState = async (): Promise<{
      readonly OOMKilled?: unknown;
      readonly ExitCode?: unknown;
      readonly Status?: unknown;
      readonly Error?: unknown;
    }> => {
      try {
        const inspected = await execFileAsync(
          this.dockerCommand,
          ["inspect", "--format", "{{json .State}}", containerName],
          { timeout: 2_000 },
        );
        return JSON.parse(inspected.stdout) as {
          OOMKilled?: unknown;
          ExitCode?: unknown;
          Status?: unknown;
          Error?: unknown;
        };
      } catch {
        return {};
      }
    };

    try {
      const sourceName =
        request.language === "python" ? "solution.py" : "Solution.java";
      const harnessName =
        request.language === "python" ? "harness.py" : "Harness.java";
      const harness =
        request.language === "python"
          ? generatePythonHarness(
              request.problem.public.functionName,
              limits.maxOutputBytes,
            )
          : generateJavaHarness(request.problem.public, limits.maxOutputBytes);
      await Promise.all([
        writeFile(join(directory, sourceName), request.source, {
          encoding: "utf8",
          mode: 0o444,
        }),
        writeFile(join(directory, harnessName), harness, {
          encoding: "utf8",
          mode: 0o444,
        }),
      ]);
      await chmod(directory, 0o555);

      const image =
        request.language === "python" ? this.pythonImage : this.javaImage;
      await execFileAsync(
        this.dockerCommand,
        ["volume", "create", "--label", RUNNER_RESOURCE_LABEL, volumeName],
        { timeout: 5_000 },
      );
      await this.stageSubmission(
        directory,
        volumeName,
        image,
        sourceName,
        harnessName,
      );
      const cpuSeconds = Math.max(
        1,
        Math.ceil((limits.compileTimeMs + limits.wallTimeMs) / 1_000) + 1,
      );
      const args = [
        "run",
        "--interactive",
        "--name",
        containerName,
        "--label",
        RUNNER_RESOURCE_LABEL,
        "--network",
        "none",
        "--read-only",
        "--user",
        "65532:65532",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--pids-limit",
        String(limits.maxProcesses),
        "--memory",
        `${limits.memoryMb}m`,
        "--memory-swap",
        `${limits.memoryMb}m`,
        "--cpus",
        "1",
        "--ulimit",
        `cpu=${cpuSeconds}:${cpuSeconds}`,
        "--ulimit",
        `fsize=${Math.ceil(limits.maxWorkspaceMb * 1024 * 1024)}:${Math.ceil(limits.maxWorkspaceMb * 1024 * 1024)}`,
        "--tmpfs",
        `/workspace:rw,nosuid,nodev,noexec,size=${limits.maxWorkspaceMb}m,mode=1777`,
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,noexec,size=8m,mode=1777",
        "--mount",
        `type=volume,source=${volumeName},target=/submission,readonly`,
        image,
      ];
      child = spawn(this.dockerCommand, args, {
        stdio: ["pipe", "pipe", "pipe"],
      });
      // Early sandbox exits can close stdin between protocol turns. The
      // channel/inspect path owns classification; never let EPIPE crash the
      // trusted runner process.
      child.stdin.on("error", () => undefined);
      const channel = new LineChannel(child, limits.maxOutputBytes, () => {
        killedForOutput = true;
        void killContainer();
      });
      const compileDeadline = performance.now() + limits.compileTimeMs;
      let ready: HarnessMessage;
      try {
        ready = await nextProtocolMessage(channel, compileDeadline);
      } catch (error) {
        if (killedForOutput) {
          return result(request, "output_limit", 0, request.cases.length, 0);
        }
        if (
          performance.now() >= compileDeadline ||
          String(error).includes("deadline")
        ) {
          killedForTimeout = true;
          await killContainer();
          return result(request, "time_limit", 0, request.cases.length, 0);
        }
        const state = await inspectContainerState();
        const exitVerdict = classifyDockerExit(state);
        if (exitVerdict) {
          return result(request, exitVerdict, 0, request.cases.length, 0);
        }
        return result(
          request,
          "infrastructure_error",
          0,
          request.cases.length,
          0,
        );
      }
      if (ready.kind === "compile_error") {
        return result(
          request,
          "compile_error",
          0,
          request.cases.length,
          0,
          ready.compileMs,
        );
      }
      if (ready.kind !== "ready") {
        const verdict =
          ready.status === "memory_limit"
            ? "memory_limit"
            : ready.status === "output_limit"
              ? "output_limit"
              : "runtime_error";
        return result(request, verdict, 0, request.cases.length, 0);
      }
      compileMs = ready.compileMs;
      const runDeadline = performance.now() + limits.wallTimeMs;

      for (let index = 0; index < request.cases.length; index += 1) {
        const judgeCase = request.cases[index]!;
        const packet = `${JSON.stringify({ args: judgeCase.args })}\n`;
        const remainingRunMs = limits.runTimeMs - runtimeMs;
        if (remainingRunMs <= 0) {
          killedForTimeout = true;
          await killContainer();
          if (request.mode === "samples") {
            sampleResults.push({
              id: `sample-${index + 1}`,
              status: "ERROR",
              runtimeMs: 0,
              message: safeMessage("time_limit"),
            });
          }
          return result(
            request,
            "time_limit",
            passed,
            request.cases.length,
            runtimeMs,
            compileMs,
            sampleResults,
          );
        }
        const caseStartedAt = performance.now();
        const caseDeadline = Math.min(
          runDeadline,
          caseStartedAt + remainingRunMs,
        );
        child.stdin.write(packet);
        let message: HarnessMessage;
        try {
          message = await nextProtocolMessage(channel, caseDeadline);
        } catch (error) {
          const timing = accountTrustedCaseRuntime(
            runtimeMs,
            caseStartedAt,
            performance.now(),
            limits.runTimeMs,
          );
          runtimeMs = timing.totalRuntimeMs;
          if (killedForOutput)
            return result(
              request,
              "output_limit",
              passed,
              request.cases.length,
              runtimeMs,
              compileMs,
              sampleResults,
            );
          if (
            performance.now() >= caseDeadline ||
            String(error).includes("deadline")
          ) {
            killedForTimeout = true;
            await killContainer();
            if (request.mode === "samples") {
              sampleResults.push({
                id: `sample-${index + 1}`,
                status: "ERROR",
                runtimeMs: timing.caseRuntimeMs,
                message: safeMessage("time_limit"),
              });
            }
            return result(
              request,
              "time_limit",
              passed,
              request.cases.length,
              runtimeMs,
              compileMs,
              sampleResults,
            );
          }
          const state = await inspectContainerState();
          const exitVerdict = classifyDockerExit(state);
          if (exitVerdict) {
            return result(
              request,
              exitVerdict,
              passed,
              request.cases.length,
              runtimeMs,
              compileMs,
              sampleResults,
            );
          }
          return result(
            request,
            "infrastructure_error",
            passed,
            request.cases.length,
            runtimeMs,
            compileMs,
          );
        }
        const timing = accountTrustedCaseRuntime(
          runtimeMs,
          caseStartedAt,
          performance.now(),
          limits.runTimeMs,
        );
        runtimeMs = timing.totalRuntimeMs;
        if (timing.exceeded || performance.now() > runDeadline) {
          killedForTimeout = true;
          await killContainer();
          if (request.mode === "samples") {
            sampleResults.push({
              id: `sample-${index + 1}`,
              status: "ERROR",
              runtimeMs: timing.caseRuntimeMs,
              message: safeMessage("time_limit"),
            });
          }
          return result(
            request,
            "time_limit",
            passed,
            request.cases.length,
            runtimeMs,
            compileMs,
            sampleResults,
          );
        }
        if (message.kind !== "case") {
          return result(
            request,
            "infrastructure_error",
            passed,
            request.cases.length,
            runtimeMs,
            compileMs,
          );
        }
        if (message.status !== "ok") {
          const verdict = message.status;
          if (request.mode === "samples") {
            sampleResults.push({
              id: `sample-${index + 1}`,
              status: "ERROR",
              runtimeMs: timing.caseRuntimeMs,
              message: safeMessage(verdict),
            });
          }
          return result(
            request,
            verdict,
            passed,
            request.cases.length,
            runtimeMs,
            compileMs,
            sampleResults,
          );
        }

        const matches = compareJudgeOutput(
          request.problem.comparator,
          message.actual,
          judgeCase.expected,
        );
        if (matches) passed += 1;
        if (request.mode === "samples") {
          sampleResults.push({
            id: `sample-${index + 1}`,
            status: matches ? "PASSED" : "FAILED",
            runtimeMs: timing.caseRuntimeMs,
            ...(boundedActual(
              message.actual,
              Math.min(limits.maxOutputBytes, 8_192),
            ) === undefined
              ? {}
              : {
                  actual: boundedActual(
                    message.actual,
                    Math.min(limits.maxOutputBytes, 8_192),
                  ),
                }),
            ...(!matches ? { message: safeMessage("wrong_answer") } : {}),
          });
        }
      }

      const verdict =
        passed === request.cases.length ? "accepted" : "wrong_answer";
      return result(
        request,
        verdict,
        passed,
        request.cases.length,
        runtimeMs,
        compileMs,
        sampleResults,
      );
    } catch {
      if (killedForOutput)
        return result(
          request,
          "output_limit",
          passed,
          request.cases.length,
          runtimeMs,
          compileMs,
          sampleResults,
        );
      if (killedForTimeout)
        return result(
          request,
          "time_limit",
          passed,
          request.cases.length,
          runtimeMs,
          compileMs,
          sampleResults,
        );
      const state = await inspectContainerState();
      const exitVerdict = classifyDockerExit(state);
      if (exitVerdict)
        return result(
          request,
          exitVerdict,
          passed,
          request.cases.length,
          runtimeMs,
          compileMs,
          sampleResults,
        );
      return result(
        request,
        "infrastructure_error",
        passed,
        request.cases.length,
        runtimeMs,
        compileMs,
      );
    } finally {
      child?.stdin.destroy();
      await cleanupResources();
      await chmod(directory, 0o755).catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  }

  /**
   * Copies the two fixed submission files through stdin into a daemon-owned
   * volume. This works when the runner itself is containerized: the Docker
   * daemon never has to resolve a bind path in the runner's mount namespace.
   */
  private async stageSubmission(
    directory: string,
    volumeName: string,
    image: string,
    sourceName: string,
    harnessName: string,
  ): Promise<void> {
    const archive = spawn(
      "tar",
      ["-cf", "-", "-C", directory, sourceName, harnessName],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const importer = spawn(
      this.dockerCommand,
      [
        "run",
        "--rm",
        "--interactive",
        "--network",
        "none",
        "--read-only",
        "--user",
        "0:0",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--pids-limit",
        "16",
        "--memory",
        "64m",
        "--cpus",
        "0.25",
        "--mount",
        `type=volume,source=${volumeName},target=/submission`,
        "--entrypoint",
        "/bin/sh",
        image,
        "-c",
        "tar -xf - -C /submission && chmod -R a=rX /submission",
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    importer.stdin.on("error", () => undefined);
    archive.stdout.pipe(importer.stdin);
    let diagnosticBytes = 0;
    const countDiagnostic = (chunk: Buffer) => {
      diagnosticBytes += chunk.byteLength;
      if (diagnosticBytes > 8_192) {
        archive.kill("SIGKILL");
        importer.kill("SIGKILL");
      }
    };
    archive.stderr.on("data", countDiagnostic);
    importer.stderr.on("data", countDiagnostic);
    const [archiveCode, importerCode] = await Promise.all([
      new Promise<number | null>((resolve, reject) => {
        archive.once("error", reject);
        archive.once("close", resolve);
      }),
      new Promise<number | null>((resolve, reject) => {
        importer.once("error", reject);
        importer.once("close", resolve);
      }),
    ]);
    if (archiveCode !== 0 || importerCode !== 0 || diagnosticBytes > 8_192) {
      throw new Error("Could not stage sandbox files");
    }
  }
}

export async function isDockerAvailable(command = "docker"): Promise<boolean> {
  try {
    await execFileAsync(command, ["info", "--format", "{{.ServerVersion}}"], {
      timeout: 3_000,
    });
    return true;
  } catch {
    return false;
  }
}
