import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const runnerEnvironment = { ...process.env };
delete runnerEnvironment.OPENAI_API_KEY;
delete runnerEnvironment.OPENAI_JUDGE_MODEL;
delete runnerEnvironment.OPENAI_JUDGE_MAX_DAILY_REQUESTS;
delete runnerEnvironment.OPENAI_JUDGE_MAX_DAILY_REQUESTS_PER_USER;
delete runnerEnvironment.OPENAI_JUDGE_MAX_DAILY_REQUESTS_PER_MATCH;

const tsx = fileURLToPath(new URL("../node_modules/.bin/tsx", import.meta.url));
const child = spawn(tsx, process.argv.slice(2), {
  env: runnerEnvironment,
  stdio: "inherit",
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => child.kill(signal));
}

child.on("error", (error) => {
  console.error(`Could not start the runner: ${error.message}`);
  process.exitCode = 1;
});

child.on("exit", (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0);
});
