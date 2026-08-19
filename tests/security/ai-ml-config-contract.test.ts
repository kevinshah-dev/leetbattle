import { readdir, readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

const root = process.cwd();
const judgeConfiguration = {
  key: "OPENAI_API_KEY",
  model: "OPENAI_JUDGE_MODEL",
  budget: "OPENAI_JUDGE_MAX_DAILY_REQUESTS",
  userBudget: "OPENAI_JUDGE_MAX_DAILY_REQUESTS_PER_USER",
  matchBudget: "OPENAI_JUDGE_MAX_DAILY_REQUESTS_PER_MATCH",
} as const;

async function projectFile(path: string): Promise<string> {
  return readFile(resolve(root, path), "utf8");
}

function composeService(compose: string, name: string): string {
  const matches = [...compose.matchAll(/^  ([a-z][a-z0-9-]*):\n/gm)];
  const index = matches.findIndex((match) => match[1] === name);
  if (index < 0) throw new Error(`Missing Compose service ${name}`);
  const selected = matches[index];
  if (!selected || selected.index === undefined) {
    throw new Error(`Could not locate Compose service ${name}`);
  }
  const start = selected.index;
  const end = matches[index + 1]?.index ?? compose.length;
  return compose.slice(start, end);
}

async function codeFilesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const candidate = resolve(directory, entry.name);
      if (entry.isDirectory()) return codeFilesUnder(candidate);
      return entry.isFile() && /\.[cm]?[jt]sx?$/.test(entry.name)
        ? [candidate]
        : [];
    }),
  );
  return nested.flat();
}

describe("AI/ML judge configuration", () => {
  it("keeps PostgreSQL array type discovery enabled in both Hyperdrive runtimes", async () => {
    const [webDatabase, realtimeDatabase] = await Promise.all([
      projectFile("src/server/db/client.ts"),
      projectFile("cloudflare/realtime/src/runtime.ts"),
    ]);

    for (const runtime of [webDatabase, realtimeDatabase]) {
      expect(runtime).toContain("fetch_types: true");
      expect(runtime).not.toContain("fetch_types: false");
    }
  });

  it("documents the same server-only defaults in every judging example", async () => {
    const examples = await Promise.all(
      [
        ".env.example",
        ".dev.vars.example",
        "cloudflare/realtime/.dev.vars.example",
      ].map(projectFile),
    );

    for (const example of examples) {
      expect(example).toContain(`${judgeConfiguration.key}=`);
      expect(example).toContain(`${judgeConfiguration.model}=gpt-5.4-nano`);
      expect(example).toContain(`${judgeConfiguration.budget}=1000`);
      expect(example).toContain(`${judgeConfiguration.userBudget}=50`);
      expect(example).toContain(`${judgeConfiguration.matchBudget}=6`);
      expect(example).not.toContain("NEXT_PUBLIC_OPENAI");
    }
  });

  it("passes judge configuration only to Compose judging runtimes", async () => {
    const compose = await projectFile("compose.yaml");
    const judgingServices = ["web", "realtime"];
    const nonJudgingServices = ["postgres", "migrate", "seed", "runner"];

    for (const name of judgingServices) {
      const service = composeService(compose, name);
      expect(service).toContain(`${judgeConfiguration.key}:`);
      expect(service).toContain(
        `${judgeConfiguration.model}: \${OPENAI_JUDGE_MODEL:-gpt-5.4-nano}`,
      );
      expect(service).toContain(
        `${judgeConfiguration.budget}: \${OPENAI_JUDGE_MAX_DAILY_REQUESTS:-1000}`,
      );
      expect(service).toContain(
        `${judgeConfiguration.userBudget}: \${OPENAI_JUDGE_MAX_DAILY_REQUESTS_PER_USER:-50}`,
      );
      expect(service).toContain(
        `${judgeConfiguration.matchBudget}: \${OPENAI_JUDGE_MAX_DAILY_REQUESTS_PER_MATCH:-6}`,
      );
    }

    for (const name of nonJudgingServices) {
      const service = composeService(compose, name);
      expect(service).not.toContain("OPENAI_");
    }
  });

  it("keeps Cloudflare judge bindings on web and realtime, never runner", async () => {
    const web = await projectFile("wrangler.jsonc");
    const realtime = await projectFile("cloudflare/realtime/wrangler.jsonc");
    const runner = await projectFile("cloudflare/runner/wrangler.jsonc");
    const runnerDevVars = await projectFile(
      "cloudflare/runner/.dev.vars.example",
    );

    for (const config of [web, realtime]) {
      const varsStart = config.indexOf('"vars"');
      const secretsStart = config.indexOf('"secrets"');
      expect(varsStart).toBeGreaterThanOrEqual(0);
      expect(secretsStart).toBeGreaterThan(varsStart);
      expect(config).toContain(`"${judgeConfiguration.key}"`);
      expect(config).toContain(`"${judgeConfiguration.model}": "gpt-5.4-nano"`);
      expect(config).toContain(`"${judgeConfiguration.budget}": "1000"`);
      expect(config).toContain(`"${judgeConfiguration.userBudget}": "50"`);
      expect(config).toContain(`"${judgeConfiguration.matchBudget}": "6"`);
      expect(config.slice(varsStart, secretsStart)).not.toContain(
        judgeConfiguration.key,
      );
      expect(config).not.toContain("replace_with_openai_api_key");
    }
    expect(runner).not.toContain("OPENAI_");
    expect(runnerDevVars).not.toContain("OPENAI_");
  });

  it("strips judge variables before starting the host runner", async () => {
    const packageJson = JSON.parse(await projectFile("package.json")) as {
      scripts?: Record<string, string>;
    };
    const launcher = await projectFile("scripts/start-sanitized-runner.mjs");

    expect(packageJson.scripts?.["dev:runner"]).toContain(
      "scripts/start-sanitized-runner.mjs",
    );
    expect(packageJson.scripts?.["start:runner"]).toContain(
      "scripts/start-sanitized-runner.mjs",
    );
    for (const name of Object.values(judgeConfiguration)) {
      expect(launcher).toContain(`delete runnerEnvironment.${name}`);
    }
  });

  it("types judge bindings only for Cloudflare judging runtimes", async () => {
    const web = await projectFile("cloudflare-env.d.ts");
    const realtime = await projectFile(
      "cloudflare/realtime/worker-configuration.d.ts",
    );
    const runner = await projectFile(
      "cloudflare/runner/worker-configuration.d.ts",
    );

    for (const declarations of [web, realtime]) {
      expect(declarations).toContain("OPENAI_API_KEY: string");
      expect(declarations).toContain('OPENAI_JUDGE_MODEL: "gpt-5.4-nano"');
      expect(declarations).toContain('OPENAI_JUDGE_MAX_DAILY_REQUESTS: "1000"');
      expect(declarations).toContain(
        'OPENAI_JUDGE_MAX_DAILY_REQUESTS_PER_USER: "50"',
      );
      expect(declarations).toContain(
        'OPENAI_JUDGE_MAX_DAILY_REQUESTS_PER_MATCH: "6"',
      );
    }
    expect(runner).not.toContain("OPENAI_");
  });
});

describe("AI/ML seed-only import boundary", () => {
  it("keeps private question and prompt modules out of runtime source", async () => {
    const privateModuleNames = [
      ["private", "bank.seed"].join("-"),
      ["judge", "prompts.seed"].join("-"),
    ];
    const runtimeRoots = ["src", "services", "cloudflare"];
    const privateModuleFiles = new Set(
      privateModuleNames.map((moduleName) =>
        ["src", "arena", "server", `${moduleName}.ts`].join("/"),
      ),
    );
    const files = (
      await Promise.all(
        runtimeRoots.map((directory) =>
          codeFilesUnder(resolve(root, directory)),
        ),
      )
    ).flat();
    const violations: string[] = [];

    for (const file of files) {
      const projectPath = relative(root, file).split(sep).join("/");
      if (privateModuleFiles.has(projectPath)) continue;
      const source = await readFile(file, "utf8");
      if (
        privateModuleNames.some((moduleName) => source.includes(moduleName))
      ) {
        violations.push(projectPath);
      }
    }

    expect(violations).toEqual([]);
  });
});
