import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

import { DockerRunnerAdapter } from "./adapters/docker";
import { createRunnerHttpHandler } from "./http";

export function registerGracefulShutdown(
  server: ReturnType<typeof createServer>,
  drainMs = 30_000,
): () => void {
  let shuttingDown = false;
  let forceTimer: NodeJS.Timeout | undefined;
  let idleTimer: NodeJS.Timeout | undefined;
  const shutdown = () => {
    if (shuttingDown) return;
    shuttingDown = true;
    server.close((error) => {
      if (forceTimer) clearTimeout(forceTimer);
      if (idleTimer) clearInterval(idleTimer);
      if (error) process.exitCode = 1;
    });
    server.closeIdleConnections();
    idleTimer = setInterval(() => server.closeIdleConnections(), 250);
    idleTimer.unref();
    forceTimer = setTimeout(() => server.closeAllConnections(), drainMs);
    forceTimer.unref();
  };
  const removeListeners = () => {
    process.off("SIGTERM", shutdown);
    process.off("SIGINT", shutdown);
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  server.once("close", removeListeners);
  return shutdown;
}

export function startRunnerServer(): ReturnType<typeof createServer> {
  const sharedSecret = process.env.RUNNER_INTERNAL_SECRET;
  if (!sharedSecret) throw new Error("RUNNER_INTERNAL_SECRET is required");
  const port = Number.parseInt(process.env.RUNNER_PORT ?? "3002", 10);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("RUNNER_PORT must be a valid TCP port");
  }
  const host = process.env.RUNNER_HOST ?? "0.0.0.0";
  const adapter = new DockerRunnerAdapter({
    dockerCommand: process.env.DOCKER_COMMAND,
    pythonImage: process.env.PYTHON_RUNNER_IMAGE,
    javaImage: process.env.JAVA_RUNNER_IMAGE,
  });
  const server = createServer(
    createRunnerHttpHandler({
      adapter,
      sharedSecret,
      readiness: () => adapter.isReady(),
    }),
  );
  registerGracefulShutdown(server);
  void adapter.cleanupOrphans();
  server.listen(port, host, () => {
    // Never log submissions, fixture data, tokens, or sandbox output.
    process.stdout.write(
      `LeetBattle runner listening on http://${host}:${port}\n`,
    );
  });
  return server;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  startRunnerServer();
}
