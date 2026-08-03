import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { generateJavaHarness } from "../../services/runner/harness/java";
import { generatePythonHarness } from "../../services/runner/harness/python";
import { getServerProblem } from "../../src/problems/server/bank.server";

const execFileAsync = promisify(execFile);
const runImageTests =
  process.env.RUN_CLOUDFLARE_RUNNER_IMAGE_TESTS === "1";
const image =
  process.env.CLOUDFLARE_RUNNER_TEST_IMAGE ??
  "leetbattle-cloudflare-runner:security-test";
const container = `leetbattle-runner-security-${process.pid}`;
const workspace = "/workspace/leetbattle";
const problem = getServerProblem("paired-pulses", 1)!;

async function docker(args: readonly string[], timeout = 30_000) {
  return execFileAsync("docker", [...args], {
    timeout,
    maxBuffer: 4 * 1024 * 1024,
  });
}

async function waitForControlPlane(): Promise<void> {
  const probe = [
    "import socket, time",
    "deadline = time.monotonic() + 20",
    "while True:",
    "    try:",
    "        with socket.create_connection(('127.0.0.1', 3000), timeout=0.2): pass",
    "        break",
    "    except OSError:",
    "        if time.monotonic() >= deadline: raise",
    "        time.sleep(0.1)",
  ].join("\n");
  await docker([
    "exec",
    container,
    "/opt/python/3.13.5/bin/python3.13",
    "-I",
    "-c",
    probe,
  ]);
}

async function writeWorkspace(files: Readonly<Record<string, string>>) {
  const directory = await mkdtemp(join(tmpdir(), "leetbattle-guard-"));
  try {
    await Promise.all(
      Object.entries(files).map(([name, contents]) =>
        writeFile(join(directory, name), contents, { mode: 0o600 }),
      ),
    );
    await docker(["exec", container, "/bin/rm", "-rf", "--", workspace]);
    await docker(["exec", container, "/bin/mkdir", "-p", workspace]);
    await docker(["cp", `${directory}/.`, `${container}:${workspace}`]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function runJudge(language: "python" | "java") {
  return docker(
    [
      "exec",
      "--workdir",
      workspace,
      "--env",
      `LEETBATTLE_LANGUAGE=${language}`,
      "--env",
      "LEETBATTLE_COMPILE_WALL_MS=10000",
      "--env",
      "LEETBATTLE_COMPILE_CPU_MS=10000",
      "--env",
      "LEETBATTLE_RUN_CPU_MS=3000",
      "--env",
      "LEETBATTLE_RUN_WALL_MS=5000",
      "--env",
      "LEETBATTLE_MEMORY_MB=256",
      "--env",
      "LEETBATTLE_MAX_PROCESSES=64",
      "--env",
      "LEETBATTLE_MAX_OUTPUT_BYTES=65536",
      "--env",
      "LEETBATTLE_MAX_WORKSPACE_MB=64",
      container,
      "/opt/leetbattle/run-judge",
    ],
    30_000,
  );
}

function expectBlockedResult(stdout: string): void {
  expect(stdout).toContain(
    '__LEETBATTLE_PROTOCOL__{"kind":"ready","compileMs":',
  );
  expect(stdout).toContain('"status":"ok","actual":-31337');
  expect(stdout).not.toContain('"actual":31337');
  expect(stdout).toContain(
    '__LEETBATTLE_SUPERVISOR__{"status":"ok","compileMs":',
  );
}

describe.skipIf(!runImageTests)(
  "Cloudflare Sandbox image submission boundary",
  () => {
    beforeAll(async () => {
      await docker(["image", "inspect", image]);
      await docker(["run", "--detach", "--name", container, image]);
      await waitForControlPlane();
    }, 30_000);

    afterAll(async () => {
      await docker(["rm", "--force", container]).catch(() => undefined);
    });

    it("confirms the unguarded local control plane runs commands as root", async () => {
      const script = [
        "import json, urllib.request",
        "request = urllib.request.Request(",
        "    'http://127.0.0.1:3000/api/execute',",
        "    data=json.dumps({'command': 'id', 'sessionId': 'guard-precondition'}).encode(),",
        "    headers={'content-type': 'application/json'},",
        ")",
        "print(urllib.request.urlopen(request, timeout=2).read().decode())",
      ].join("\n");
      const { stdout } = await docker([
        "exec",
        "--user",
        "65532:65532",
        container,
        "/opt/python/3.13.5/bin/python3.13",
        "-I",
        "-c",
        script,
      ]);
      expect(stdout).toContain("uid=0(root)");
    });

    it("blocks a submitted Python process from the root control plane", async () => {
      const source = `import socket

def root_control_reachable():
    body = b'{"command":"id","sessionId":"python-submission"}'
    request = (
        b"POST /api/execute HTTP/1.1\\r\\n"
        b"Host: 127.0.0.1\\r\\n"
        b"Content-Type: application/json\\r\\n"
        + b"Content-Length: " + str(len(body)).encode() + b"\\r\\n"
        b"Connection: close\\r\\n\\r\\n" + body
    )
    try:
        with socket.create_connection(("127.0.0.1", 3000), timeout=1) as connection:
            connection.sendall(request)
            response = b""
            while True:
                packet = connection.recv(4096)
                if not packet:
                    break
                response += packet
        return b"uid=0(root)" in response
    except OSError:
        return False

class Solution:
    def pairedPulses(self, pulses):
        return 31337 if root_control_reachable() else -31337
`;
      await writeWorkspace({
        "solution.py": source,
        "harness.py": generatePythonHarness(
          problem.public.functionName,
          problem.public.limits.maxOutputBytes,
          `${workspace}/solution.py`,
        ),
        "cases.ndjson": `${JSON.stringify({ args: problem.samples[0]!.args })}\n`,
      });

      const { stdout } = await runJudge("python");
      expectBlockedResult(stdout);
    });

    it("blocks a submitted Java process from the root control plane", async () => {
      const source = `import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

class Solution {
    public int pairedPulses(int[] pulses) {
        return rootControlReachable() ? 31337 : -31337;
    }

    private boolean rootControlReachable() {
        byte[] body = "{\\"command\\":\\"id\\",\\"sessionId\\":\\"java-submission\\"}"
            .getBytes(StandardCharsets.UTF_8);
        String headers = "POST /api/execute HTTP/1.1\\r\\n"
            + "Host: 127.0.0.1\\r\\n"
            + "Content-Type: application/json\\r\\n"
            + "Content-Length: " + body.length + "\\r\\n"
            + "Connection: close\\r\\n\\r\\n";
        try (Socket socket = new Socket()) {
            socket.connect(new InetSocketAddress("127.0.0.1", 3000), 1000);
            OutputStream output = socket.getOutputStream();
            output.write(headers.getBytes(StandardCharsets.US_ASCII));
            output.write(body);
            output.flush();
            ByteArrayOutputStream response = new ByteArrayOutputStream();
            InputStream input = socket.getInputStream();
            input.transferTo(response);
            return response.toString(StandardCharsets.UTF_8).contains("uid=0(root)");
        } catch (Exception blocked) {
            return false;
        }
    }
}
`;
      await writeWorkspace({
        "Solution.java": source,
        "Harness.java": generateJavaHarness(
          problem.public,
          problem.public.limits.maxOutputBytes,
        ),
        "cases.ndjson": `${JSON.stringify({ args: problem.samples[0]!.args })}\n`,
      });

      const { stdout } = await runJudge("java");
      expectBlockedResult(stdout);
    });
  },
);
