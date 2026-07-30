import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const bundleRoot = path.resolve(".open-next");
const clientBundleRoot = path.join(bundleRoot, "assets", "_next", "static");
const expectedRealtimeUrl = "wss://ws.leetbattle.cenough.games";
const unresolvedRealtimeVariable = "NEXT_PUBLIC_REALTIME_URL";
const localRealtimeUrls = [
  "ws://127.0.0.1:3001",
  "ws://localhost:3001",
] as const;
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

const clientFiles = (await filesUnder(clientBundleRoot)).filter((file) =>
  file.endsWith(".js"),
);
let hasExpectedRealtimeUrl = false;

for (const file of clientFiles) {
  const text = await readFile(file, "utf8");
  hasExpectedRealtimeUrl ||= text.includes(expectedRealtimeUrl);

  if (text.includes(unresolvedRealtimeVariable)) {
    throw new Error(
      `Unresolved ${unresolvedRealtimeVariable} reference remains in ${path.relative(clientBundleRoot, file)}. ` +
        "Set it under Cloudflare Workers Builds > Build Variables and Secrets before deploying.",
    );
  }

  const localRealtimeUrl = localRealtimeUrls.find((candidate) =>
    text.includes(candidate),
  );
  if (localRealtimeUrl) {
    throw new Error(
      `Local realtime URL (${localRealtimeUrl}) leaked into ${path.relative(clientBundleRoot, file)}.`,
    );
  }
}

if (!hasExpectedRealtimeUrl) {
  throw new Error(
    `Production realtime URL (${expectedRealtimeUrl}) is missing from emitted client JavaScript. ` +
      "Set NEXT_PUBLIC_REALTIME_URL during the Cloudflare build.",
  );
}

console.log(
  `Cloudflare web bundle privacy and realtime configuration checks passed (${files.length} files).`,
);
