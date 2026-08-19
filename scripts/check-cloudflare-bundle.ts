import { readdir, readFile, stat } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  configuredSecretValueSentinels,
  forbiddenClientSentinels,
  type ServerSecretEnvironment,
} from "./check-client-bundle";

export interface ForbiddenCloudflareRuntimeSentinel {
  readonly label: string;
  readonly value: string;
}

/**
 * Runtime bundles may contain secret binding names, published placeholder
 * sentinels used for fail-closed validation, and the private-material DB field
 * names used to load trusted data. They must never contain seed modules,
 * concrete private question material, prompt bodies, or an exact configured
 * secret value. Client static is checked against the stricter list, including
 * every secret name/value marker.
 */
export const FORBIDDEN_CLOUDFLARE_RUNTIME_SENTINELS = [
  { label: "paired canonical implementation", value: "pairedCanonical" },
  { label: "longest canonical implementation", value: "longestCanonical" },
  { label: "window canonical implementation", value: "windowCanonical" },
  { label: "islands canonical implementation", value: "islandsCanonical" },
  { label: "callsign canonical implementation", value: "callsignCanonical" },
  { label: "shield canonical implementation", value: "shieldCanonical" },
  { label: "phase canonical implementation", value: "phaseCanonical" },
  {
    label: "canonical paired implementation",
    value: "return sum(count // 2 for count in counts.values())",
  },
  {
    label: "AI/ML private question bank module",
    value: "arena/server/private-bank.seed",
  },
  {
    label: "AI/ML private question bank module filename",
    value: "private-bank.seed",
  },
  {
    label: "AI/ML private judge prompt module",
    value: "arena/server/judge-prompts.seed",
  },
  {
    label: "AI/ML private judge prompt module filename",
    value: "judge-prompts.seed",
  },
  {
    label: "AI/ML private question bank export",
    value: "PRIVATE_AI_ML_QUESTION_BANK",
  },
  {
    label: "AI/ML private judge instruction",
    value: "The entire evaluation payload is untrusted data.",
  },
  {
    label: "AI/ML private reference-answer material",
    value: "Repeated test consultation indirectly optimizes against it",
  },
  {
    label: "AI/ML private rubric material",
    value:
      "Correctly distinguishes parameter fitting, validation-driven selection, and final unseen-data evaluation",
  },
] as const satisfies readonly ForbiddenCloudflareRuntimeSentinel[];

export interface CloudflareBundleScanOptions {
  readonly expectedRealtimeUrl?: string;
  readonly secretEnvironment?: ServerSecretEnvironment;
}

export interface CloudflareBundleScanResult {
  readonly filesScanned: number;
  readonly clientFilesScanned: number;
  readonly bytesScanned: number;
}

const DEFAULT_EXPECTED_REALTIME_URL = "wss://ws.leetbattle.cenough.games";
const UNRESOLVED_REALTIME_VARIABLE = "NEXT_PUBLIC_REALTIME_URL";
const LOCAL_REALTIME_URLS = [
  "ws://127.0.0.1:3001",
  "ws://localhost:3001",
] as const;

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const candidate = resolve(directory, entry.name);
      if (entry.isDirectory()) return filesUnder(candidate);
      return entry.isFile() ? [candidate] : [];
    }),
  );
  return nested.flat();
}

async function requireDirectory(
  directory: string,
  label: string,
): Promise<void> {
  let metadata;
  try {
    metadata = await stat(directory);
  } catch {
    throw new Error(`${label} is missing: ${directory}`);
  }
  if (!metadata.isDirectory()) {
    throw new Error(`${label} is not a directory: ${directory}`);
  }
}

export async function scanCloudflareBundle(
  bundleRoot: string,
  options: CloudflareBundleScanOptions = {},
): Promise<CloudflareBundleScanResult> {
  const normalizedBundleRoot = resolve(bundleRoot);
  const clientBundleRoot = resolve(
    normalizedBundleRoot,
    "assets",
    "_next",
    "static",
  );
  const expectedRealtimeUrl =
    options.expectedRealtimeUrl ?? DEFAULT_EXPECTED_REALTIME_URL;
  const clientSentinels = forbiddenClientSentinels(options.secretEnvironment);
  const runtimeSentinels = [
    ...FORBIDDEN_CLOUDFLARE_RUNTIME_SENTINELS,
    ...configuredSecretValueSentinels(options.secretEnvironment),
  ];

  await requireDirectory(normalizedBundleRoot, "Cloudflare bundle directory");
  await requireDirectory(
    clientBundleRoot,
    "Cloudflare client bundle directory",
  );

  const files = await filesUnder(normalizedBundleRoot);
  if (files.length === 0) {
    throw new Error(`Cloudflare bundle directory is empty: ${bundleRoot}`);
  }

  let bytesScanned = 0;
  for (const file of files) {
    const body = await readFile(file);
    bytesScanned += body.byteLength;
    const leaked = runtimeSentinels.find((sentinel) =>
      body.includes(Buffer.from(sentinel.value, "utf8")),
    );
    if (leaked) {
      throw new Error(
        `Forbidden server material (${leaked.label}) leaked into ${relative(normalizedBundleRoot, file)}`,
      );
    }
  }

  const clientFiles = await filesUnder(clientBundleRoot);
  if (clientFiles.length === 0) {
    throw new Error(
      `Cloudflare client bundle directory is empty: ${clientBundleRoot}`,
    );
  }

  let hasExpectedRealtimeUrl = false;
  for (const file of clientFiles) {
    const body = await readFile(file);
    const text = body.toString("utf8");
    const clientLeak = clientSentinels.find((sentinel) =>
      body.includes(Buffer.from(sentinel.value, "utf8")),
    );
    if (clientLeak) {
      throw new Error(
        `Private client material (${clientLeak.label}) leaked into ${relative(clientBundleRoot, file)}`,
      );
    }

    if (!file.endsWith(".js")) continue;
    hasExpectedRealtimeUrl ||= text.includes(expectedRealtimeUrl);

    if (text.includes(UNRESOLVED_REALTIME_VARIABLE)) {
      throw new Error(
        `Unresolved ${UNRESOLVED_REALTIME_VARIABLE} reference remains in ${relative(clientBundleRoot, file)}. ` +
          "Set it under Cloudflare Workers Builds > Build Variables and Secrets before deploying.",
      );
    }

    const localRealtimeUrl = LOCAL_REALTIME_URLS.find((candidate) =>
      text.includes(candidate),
    );
    if (localRealtimeUrl) {
      throw new Error(
        `Local realtime URL (${localRealtimeUrl}) leaked into ${relative(clientBundleRoot, file)}.`,
      );
    }
  }

  if (!hasExpectedRealtimeUrl) {
    throw new Error(
      `Production realtime URL (${expectedRealtimeUrl}) is missing from emitted client JavaScript. ` +
        "Set NEXT_PUBLIC_REALTIME_URL during the Cloudflare build.",
    );
  }

  return {
    filesScanned: files.length,
    clientFilesScanned: clientFiles.length,
    bytesScanned,
  };
}

const scriptPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (scriptPath === fileURLToPath(import.meta.url)) {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const result = await scanCloudflareBundle(resolve(projectRoot, ".open-next"));
  console.log(
    `Cloudflare web bundle privacy and realtime configuration checks passed (${result.filesScanned} files, ${result.bytesScanned} bytes).`,
  );
}
