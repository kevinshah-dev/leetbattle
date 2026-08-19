import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  FORBIDDEN_CLIENT_SENTINELS,
  scanClientStatic,
} from "../../scripts/check-client-bundle";

const temporaryDirectories: string[] = [];

async function temporaryStaticDirectory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "leetbattle-static-"));
  temporaryDirectories.push(root);
  const directory = join(root, ".next/static");
  await mkdir(directory, { recursive: true });
  return directory;
}

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("client bundle privacy scanner", () => {
  it("accepts a client-only static tree", async () => {
    const staticDirectory = await temporaryStaticDirectory();
    await mkdir(join(staticDirectory, "chunks"));
    await writeFile(
      join(staticDirectory, "chunks/app.js"),
      'console.log("public problem metadata only")',
    );

    await expect(scanClientStatic(staticDirectory)).resolves.toEqual({
      filesScanned: 1,
      bytesScanned: 43,
    });
  });

  it("allows public SDKs to reference secret environment-variable names", async () => {
    const staticDirectory = await temporaryStaticDirectory();
    await writeFile(
      join(staticDirectory, "chunk.js"),
      "CLERK_SECRET_KEY|OPENAI_API_KEY|DATABASE_URL|RUNNER_INTERNAL_SECRET",
    );

    await expect(scanClientStatic(staticDirectory)).resolves.toMatchObject({
      filesScanned: 1,
    });
  });

  it.each(FORBIDDEN_CLIENT_SENTINELS)(
    "rejects $label",
    async ({ label, value }) => {
      const staticDirectory = await temporaryStaticDirectory();
      await writeFile(
        join(staticDirectory, "chunk.js"),
        `prefix${value}suffix`,
      );

      await expect(scanClientStatic(staticDirectory)).rejects.toThrow(label);
    },
  );

  it("rejects an exact configured secret value", async () => {
    const staticDirectory = await temporaryStaticDirectory();
    const secret = "sk-dynamic-secret-value-never-publish";
    await writeFile(join(staticDirectory, "chunk.js"), `prefix${secret}suffix`);

    await expect(
      scanClientStatic(staticDirectory, {
        secretEnvironment: { OPENAI_API_KEY: secret },
      }),
    ).rejects.toThrow("OPENAI_API_KEY configured secret value");
  });

  it("fails closed when the post-build static directory is absent", async () => {
    const root = await mkdtemp(join(tmpdir(), "leetbattle-missing-static-"));
    temporaryDirectories.push(root);

    await expect(scanClientStatic(join(root, ".next/static"))).rejects.toThrow(
      "Run next build before this check",
    );
  });
});
