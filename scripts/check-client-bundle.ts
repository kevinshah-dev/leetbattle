import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, relative, resolve } from "node:path";

export interface ForbiddenClientSentinel {
  readonly label: string;
  readonly value: string;
}

/**
 * These values exist only in the trusted problem bank. Concrete hidden-case
 * payloads complement module/symbol markers so minification cannot make an
 * accidental server-bank import invisible to this check.
 */
export const FORBIDDEN_CLIENT_SENTINELS = [
  { label: "server problem module path", value: "problems/server/" },
  { label: "server problem bank module", value: "bank.server" },
  { label: "server comparator module", value: "compare.server" },
  { label: "server problem types module", value: "types.server" },
  { label: "server problem collection", value: "SERVER_PROBLEMS" },
  { label: "server problem listing function", value: "listServerProblems" },
  { label: "hidden clear-channel fixture", value: "A##BC###D" },
  { label: "hidden clear-channel boundary fixture", value: "AB12CD34##Z" },
  { label: "hidden phase fixture", value: "MISSISSIPPI" },
  {
    label: "hidden callsign fixture",
    value: "zyxwvutsrqponmlkjihgfedcba",
  },
  {
    label: "canonical callsign implementation",
    value: "groups.setdefault(tuple(counts), []).append(callsign)",
  },
] as const satisfies readonly ForbiddenClientSentinel[];

async function listFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return listFiles(path);
      return entry.isFile() ? [path] : [];
    }),
  );
  return files.flat();
}

export interface ClientBundleScanResult {
  readonly filesScanned: number;
  readonly bytesScanned: number;
}

export async function scanClientStatic(
  staticDirectory: string,
): Promise<ClientBundleScanResult> {
  let metadata;
  try {
    metadata = await stat(staticDirectory);
  } catch {
    throw new Error(
      `Client static directory is missing: ${staticDirectory}. Run next build before this check.`,
    );
  }
  if (!metadata.isDirectory()) {
    throw new Error(
      `Client static path is not a directory: ${staticDirectory}`,
    );
  }

  const files = await listFiles(staticDirectory);
  if (files.length === 0) {
    throw new Error(`Client static directory is empty: ${staticDirectory}`);
  }

  let bytesScanned = 0;
  const leaks: string[] = [];
  for (const file of files) {
    const contents = await readFile(file);
    bytesScanned += contents.byteLength;
    for (const sentinel of FORBIDDEN_CLIENT_SENTINELS) {
      if (contents.includes(Buffer.from(sentinel.value, "utf8"))) {
        leaks.push(`${relative(staticDirectory, file)}: ${sentinel.label}`);
      }
    }
  }

  if (leaks.length > 0) {
    throw new Error(
      `Trusted problem-bank data leaked into .next/static:\n${leaks
        .map((leak) => `- ${leak}`)
        .join("\n")}`,
    );
  }
  return { filesScanned: files.length, bytesScanned };
}

const scriptPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (scriptPath === fileURLToPath(import.meta.url)) {
  const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const staticDirectory = resolve(projectRoot, ".next/static");
  const result = await scanClientStatic(staticDirectory);
  console.log(
    `Client bundle privacy check passed (${result.filesScanned} files, ${result.bytesScanned} bytes).`,
  );
}
