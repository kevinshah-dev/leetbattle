import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FORBIDDEN_CLOUDFLARE_RUNTIME_SENTINELS,
  scanCloudflareBundle,
} from "../../scripts/check-cloudflare-bundle";

const temporaryDirectories: string[] = [];
const expectedRealtimeUrl = "wss://ws.leetbattle.cenough.games";

async function temporaryCloudflareBundle(): Promise<{
  root: string;
  serverFile: string;
  clientFile: string;
}> {
  const root = await mkdtemp(join(tmpdir(), "leetbattle-open-next-"));
  temporaryDirectories.push(root);
  const staticDirectory = join(root, "assets/_next/static/chunks");
  await mkdir(staticDirectory, { recursive: true });

  const serverFile = join(root, "worker.js");
  const clientFile = join(staticDirectory, "app.js");
  await writeFile(
    serverFile,
    [
      "OPENAI_API_KEY",
      "referenceAnswerNotes",
      "requiredConcepts",
      "private_material",
      "rubric_hash",
      "replace_with_openai_api_key",
      "replace_with_at_least_32_random_bytes",
      "sk-proj-",
    ].join("|"),
  );
  await writeFile(
    clientFile,
    `connect(${JSON.stringify(expectedRealtimeUrl)})`,
  );
  return { root, serverFile, clientFile };
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Cloudflare bundle privacy scanner", () => {
  it("allows server binding and persisted-field names needed at runtime", async () => {
    const bundle = await temporaryCloudflareBundle();

    await expect(scanCloudflareBundle(bundle.root)).resolves.toMatchObject({
      filesScanned: 2,
      clientFilesScanned: 1,
    });
  });

  it.each(FORBIDDEN_CLOUDFLARE_RUNTIME_SENTINELS)(
    "rejects $label from a runtime bundle",
    async ({ label, value }) => {
      const bundle = await temporaryCloudflareBundle();
      await writeFile(bundle.serverFile, `server:${value}`);

      await expect(scanCloudflareBundle(bundle.root)).rejects.toThrow(label);
    },
  );

  it("rejects an exact configured secret value from a runtime bundle", async () => {
    const bundle = await temporaryCloudflareBundle();
    const secret = "sk-dynamic-secret-value-never-publish";
    await writeFile(bundle.serverFile, `server:${secret}`);

    await expect(
      scanCloudflareBundle(bundle.root, {
        secretEnvironment: { OPENAI_API_KEY: secret },
      }),
    ).rejects.toThrow("OPENAI_API_KEY configured secret value");
  });

  it("allows harmless server binding names in client static", async () => {
    const bundle = await temporaryCloudflareBundle();
    await writeFile(
      bundle.clientFile,
      `${expectedRealtimeUrl}|OPENAI_API_KEY|CLERK_SECRET_KEY|DATABASE_URL`,
    );

    await expect(scanCloudflareBundle(bundle.root)).resolves.toMatchObject({
      filesScanned: 2,
      clientFilesScanned: 1,
    });
  });

  it("rejects an exact configured secret value only when it reaches client static", async () => {
    const bundle = await temporaryCloudflareBundle();
    const secret = "sk-dynamic-secret-value-never-publish";
    await writeFile(bundle.clientFile, `${expectedRealtimeUrl}|${secret}`);

    await expect(
      scanCloudflareBundle(bundle.root, {
        secretEnvironment: { OPENAI_API_KEY: secret },
      }),
    ).rejects.toThrow("OPENAI_API_KEY configured secret value");
  });

  it("rejects unresolved and local realtime configuration", async () => {
    const unresolved = await temporaryCloudflareBundle();
    await writeFile(
      unresolved.clientFile,
      `${expectedRealtimeUrl}|NEXT_PUBLIC_REALTIME_URL`,
    );
    await expect(scanCloudflareBundle(unresolved.root)).rejects.toThrow(
      "Unresolved NEXT_PUBLIC_REALTIME_URL",
    );

    const local = await temporaryCloudflareBundle();
    await writeFile(
      local.clientFile,
      `${expectedRealtimeUrl}|ws://localhost:3001`,
    );
    await expect(scanCloudflareBundle(local.root)).rejects.toThrow(
      "Local realtime URL",
    );
  });

  it("requires the configured production realtime URL", async () => {
    const bundle = await temporaryCloudflareBundle();
    await writeFile(bundle.clientFile, 'connect("wss://wrong.example")');

    await expect(scanCloudflareBundle(bundle.root)).rejects.toThrow(
      "Production realtime URL",
    );
  });
});
