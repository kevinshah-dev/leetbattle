import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const bundleRoot = path.resolve(".open-next");
const privateProblemSentinels = [
  "pairedCanonical",
  "longestCanonical",
  "windowCanonical",
  "islandsCanonical",
  "callsignCanonical",
  "shieldCanonical",
  "phaseCanonical",
  "return sum(count // 2 for count in counts.values())",
] as const;

async function filesUnder(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const candidate = path.join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(candidate) : [candidate];
    }),
  );
  return nested.flat();
}

const files = await filesUnder(bundleRoot);
for (const file of files) {
  const body = await readFile(file);
  if (body.includes(0)) continue;
  const text = body.toString("utf8");
  const leaked = privateProblemSentinels.find((sentinel) =>
    text.includes(sentinel),
  );
  if (leaked) {
    throw new Error(
      `Private judge material (${leaked}) leaked into ${path.relative(bundleRoot, file)}`,
    );
  }
}

console.log(
  `Cloudflare web bundle privacy check passed (${files.length} files).`,
);
