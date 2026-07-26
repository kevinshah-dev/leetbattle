#!/usr/bin/env node

import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PROJECT_ROOT = fileURLToPath(new URL("../", import.meta.url));
const CLOUDFLARE_ROOT = resolve(PROJECT_ROOT, "cloudflare");
const PLACEHOLDER = "REPLACE_WITH_HYPERDRIVE_ID";
const HYPERDRIVE_ID_PATTERN =
  /^(?:[a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;

const HELP = `Configure LeetBattle's Cloudflare Hyperdrive binding.

Usage:
  node scripts/configure-cloudflare.mjs <HYPERDRIVE_ID>
  node scripts/configure-cloudflare.mjs --id <HYPERDRIVE_ID>
  node scripts/configure-cloudflare.mjs --check
  node scripts/configure-cloudflare.mjs --help

The configure command replaces the exact literal ${PLACEHOLDER} only when it is
the value of hyperdrive[*].id in the root wrangler.jsonc or a
cloudflare/**/wrangler.jsonc file. Multi-file updates are staged and rolled back
on commit failure. It refuses to overwrite an existing ID. --check is read-only
and fails on misplaced placeholders, malformed JSONC, invalid IDs, or divergent
Hyperdrive IDs.
`;

function fail(message, { showHelp = false } = {}) {
  if (showHelp) process.stderr.write(`${HELP}\n`);
  throw new Error(message);
}

function parseArguments(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    return { mode: "help" };
  }

  if (argv.includes("--check")) {
    if (argv.length !== 1) {
      fail("--check cannot be combined with another argument.", {
        showHelp: true,
      });
    }
    return { mode: "check" };
  }

  let id;
  if (argv.length === 1 && !argv[0].startsWith("-")) {
    id = argv[0];
  } else if (argv.length === 2 && argv[0] === "--id") {
    id = argv[1];
  } else if (argv.length === 1 && argv[0].startsWith("--id=")) {
    id = argv[0].slice("--id=".length);
  } else {
    fail("Provide exactly one Hyperdrive ID.", { showHelp: true });
  }

  if (!HYPERDRIVE_ID_PATTERN.test(id)) {
    fail(
      "Hyperdrive ID must be 32 hexadecimal characters, with optional UUID hyphens.",
    );
  }

  return { mode: "configure", id };
}

async function pathExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findWranglerConfigs(directory) {
  if (!(await pathExists(directory))) return [];

  const entries = await readdir(directory, { withFileTypes: true });
  const paths = [];
  for (const entry of entries.sort((left, right) =>
    left.name.localeCompare(right.name),
  )) {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) {
      paths.push(...(await findWranglerConfigs(path)));
    } else if (entry.isFile() && entry.name === "wrangler.jsonc") {
      paths.push(path);
    }
  }
  return paths;
}

async function configurationPaths() {
  const rootConfig = resolve(PROJECT_ROOT, "wrangler.jsonc");
  const paths = await findWranglerConfigs(CLOUDFLARE_ROOT);
  if (await pathExists(rootConfig)) paths.unshift(rootConfig);
  if (paths.length === 0) {
    fail("No Wrangler JSONC configuration files were found.");
  }
  return paths;
}

function tokenizeJsonc(source, path) {
  const tokens = [];
  let index = 0;

  while (index < source.length) {
    const character = source[index];
    const next = source[index + 1];

    if (/\s/.test(character)) {
      index += 1;
      continue;
    }

    if (character === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }

    if (character === "/" && next === "*") {
      const commentEnd = source.indexOf("*/", index + 2);
      if (commentEnd === -1) {
        fail(`${displayPath(path)} has an unterminated block comment.`);
      }
      index = commentEnd + 2;
      continue;
    }

    if ("{}[]:,".includes(character)) {
      tokens.push({ type: character, start: index, end: index + 1 });
      index += 1;
      continue;
    }

    if (character === '"') {
      const start = index;
      index += 1;
      let escaped = false;
      while (index < source.length) {
        const stringCharacter = source[index];
        if (escaped) {
          escaped = false;
        } else if (stringCharacter === "\\") {
          escaped = true;
        } else if (stringCharacter === '"') {
          index += 1;
          const raw = source.slice(start, index);
          try {
            tokens.push({
              type: "string",
              value: JSON.parse(raw),
              start,
              end: index,
            });
          } catch (error) {
            const detail =
              error instanceof Error ? error.message : String(error);
            fail(`${displayPath(path)} has an invalid string: ${detail}`);
          }
          break;
        }
        index += 1;
      }
      if (tokens.at(-1)?.start !== start) {
        fail(`${displayPath(path)} has an unterminated string.`);
      }
      continue;
    }

    const start = index;
    while (
      index < source.length &&
      !/\s/.test(source[index]) &&
      !"{}[]:,".includes(source[index])
    ) {
      index += 1;
    }
    const raw = source.slice(start, index);
    try {
      tokens.push({
        type: "literal",
        value: JSON.parse(raw),
        start,
        end: index,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      fail(`${displayPath(path)} has an invalid token "${raw}": ${detail}`);
    }
  }

  return tokens;
}

function parseJsonc(source, path) {
  const tokens = tokenizeJsonc(source, path);
  let cursor = 0;

  function expect(type) {
    const token = tokens[cursor];
    if (token?.type !== type) {
      fail(
        `${displayPath(path)} expected "${type}" near byte ${token?.start ?? source.length}.`,
      );
    }
    cursor += 1;
    return token;
  }

  function parseValue() {
    const token = tokens[cursor];
    if (!token) {
      fail(`${displayPath(path)} ended before a JSON value was complete.`);
    }

    if (token.type === "string" || token.type === "literal") {
      cursor += 1;
      return { ...token, value: token.value };
    }

    if (token.type === "{") {
      const openToken = expect("{");
      const properties = [];
      const value = Object.create(null);

      if (tokens[cursor]?.type === "}") {
        const closeToken = expect("}");
        return {
          type: "object",
          value,
          properties,
          start: openToken.start,
          end: closeToken.end,
        };
      }

      while (true) {
        const key = expect("string");
        expect(":");
        const child = parseValue();
        properties.push({ key, value: child });
        value[key.value] = child.value;

        if (tokens[cursor]?.type !== ",") {
          const closeToken = expect("}");
          return {
            type: "object",
            value,
            properties,
            start: openToken.start,
            end: closeToken.end,
          };
        }

        expect(",");
        if (tokens[cursor]?.type === "}") {
          const closeToken = expect("}");
          return {
            type: "object",
            value,
            properties,
            start: openToken.start,
            end: closeToken.end,
          };
        }
      }
    }

    if (token.type === "[") {
      const openToken = expect("[");
      const items = [];

      if (tokens[cursor]?.type === "]") {
        const closeToken = expect("]");
        return {
          type: "array",
          value: [],
          items,
          start: openToken.start,
          end: closeToken.end,
        };
      }

      while (true) {
        items.push(parseValue());
        if (tokens[cursor]?.type !== ",") {
          const closeToken = expect("]");
          return {
            type: "array",
            value: items.map((item) => item.value),
            items,
            start: openToken.start,
            end: closeToken.end,
          };
        }

        expect(",");
        if (tokens[cursor]?.type === "]") {
          const closeToken = expect("]");
          return {
            type: "array",
            value: items.map((item) => item.value),
            items,
            start: openToken.start,
            end: closeToken.end,
          };
        }
      }
    }

    fail(
      `${displayPath(path)} expected a JSON value near byte ${token.start}.`,
    );
  }

  const root = parseValue();
  if (cursor !== tokens.length) {
    fail(
      `${displayPath(path)} has content after the root JSON value near byte ${tokens[cursor].start}.`,
    );
  }
  return root;
}

function collectHyperdriveBindings(node, path = "$", bindings = []) {
  if (node.type === "array") {
    node.items.forEach((item, index) =>
      collectHyperdriveBindings(item, `${path}[${index}]`, bindings),
    );
    return bindings;
  }

  if (node.type !== "object") return bindings;

  for (const property of node.properties) {
    const key = property.key.value;
    const child = property.value;
    const childPath = `${path}.${key}`;
    if (key === "hyperdrive") {
      if (child.type !== "array") {
        fail(`${childPath} must be an array.`);
      }
      child.items.forEach((binding, index) => {
        const bindingPath = `${childPath}[${index}]`;
        if (binding.type !== "object") {
          fail(`${bindingPath} must be an object.`);
        }
        const idProperties = binding.properties.filter(
          (candidate) => candidate.key.value === "id",
        );
        if (idProperties.length !== 1) {
          fail(`${bindingPath} must contain exactly one id property.`);
        }
        bindings.push({
          binding,
          idNode: idProperties[0].value,
          path: bindingPath,
        });
      });
    }
    collectHyperdriveBindings(child, childPath, bindings);
  }

  return bindings;
}

function displayPath(path) {
  return relative(PROJECT_ROOT, path) || ".";
}

function findLiteralOffsets(source, literal) {
  const offsets = [];
  let offset = source.indexOf(literal);
  while (offset !== -1) {
    offsets.push(offset);
    offset = source.indexOf(literal, offset + literal.length);
  }
  return offsets;
}

function inspectConfiguration(source, path) {
  const document = parseJsonc(source, path);
  const bindings = collectHyperdriveBindings(document);
  const ids = [];
  const placeholderNodes = [];

  for (const { idNode, path: bindingPath } of bindings) {
    if (idNode.type !== "string") {
      fail(`${displayPath(path)} ${bindingPath}.id must be a string.`);
    }
    const id = idNode.value;
    if (id !== PLACEHOLDER && !HYPERDRIVE_ID_PATTERN.test(id)) {
      fail(
        `${displayPath(path)} ${bindingPath}.id is not a valid Hyperdrive ID.`,
      );
    }
    if (id === PLACEHOLDER) {
      if (
        source.slice(idNode.start, idNode.end) !== JSON.stringify(PLACEHOLDER)
      ) {
        fail(
          `${displayPath(path)} ${bindingPath}.id must use the exact literal "${PLACEHOLDER}" before it can be configured.`,
        );
      }
      placeholderNodes.push(idNode);
    }
    ids.push(id);
  }

  const literalOffsets = findLiteralOffsets(source, PLACEHOLDER);
  const bindingOffsets = placeholderNodes.map((node) => node.start + 1);
  if (
    literalOffsets.length !== bindingOffsets.length ||
    literalOffsets.some((offset, index) => offset !== bindingOffsets[index])
  ) {
    fail(
      `${displayPath(path)} contains "${PLACEHOLDER}" outside a hyperdrive[*].id value.`,
    );
  }

  return {
    bindings: bindings.length,
    ids,
    placeholderNodes,
    placeholders: placeholderNodes.length,
  };
}

function configurePlaceholders(source, placeholderNodes, id) {
  let configured = source;
  for (const node of [...placeholderNodes].sort(
    (left, right) => right.start - left.start,
  )) {
    configured =
      configured.slice(0, node.start) +
      JSON.stringify(id) +
      configured.slice(node.end);
  }
  return configured;
}

function assertConfigured(inspections) {
  const placeholderCount = inspections.reduce(
    (total, inspection) => total + inspection.placeholders,
    0,
  );
  if (placeholderCount > 0) {
    fail(
      `${placeholderCount} Hyperdrive placeholder(s) remain. Run this command with the real Hyperdrive ID.`,
    );
  }

  const ids = new Set(inspections.flatMap((inspection) => inspection.ids));
  if (ids.size === 0) fail("No Hyperdrive bindings were found.");
  if (ids.size > 1) {
    fail(
      "Wrangler configurations contain divergent Hyperdrive IDs; reconcile them explicitly.",
    );
  }
}

async function syncFile(path) {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeStagedFile(path, source, mode) {
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(source, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(path, mode);
}

async function removeTransactionFiles(paths) {
  await Promise.all(
    paths.map((path) =>
      rm(path, { force: true }).catch(() => {
        // A failed best-effort cleanup must not hide the commit or rollback result.
      }),
    ),
  );
}

async function settleOrThrow(tasks) {
  const results = await Promise.allSettled(tasks);
  const rejection = results.find((result) => result.status === "rejected");
  if (rejection) throw rejection.reason;
}

async function commitConfigurationUpdates(files) {
  const transactionId = `${process.pid}-${randomUUID()}`;
  const transaction = await Promise.all(
    files.map(async (file) => {
      const metadata = await stat(file.path);
      const mode = metadata.mode & 0o777;
      return {
        ...file,
        mode,
        stagedPath: `${file.path}.configure-${transactionId}.tmp`,
        backupPath: `${file.path}.configure-${transactionId}.bak`,
      };
    }),
  );
  const artifactPaths = transaction.flatMap((file) => [
    file.stagedPath,
    file.backupPath,
  ]);

  try {
    await settleOrThrow(
      transaction.map((file) =>
        writeStagedFile(file.stagedPath, file.source, file.mode),
      ),
    );
    await settleOrThrow(
      transaction.map(async (file) => {
        await copyFile(file.path, file.backupPath, fsConstants.COPYFILE_EXCL);
        await chmod(file.backupPath, file.mode);
        await syncFile(file.backupPath);
      }),
    );
  } catch (error) {
    await removeTransactionFiles(artifactPaths);
    throw error;
  }

  try {
    for (const file of transaction) {
      await rename(file.stagedPath, file.path);
    }
    for (const file of transaction) {
      const committedSource = await readFile(file.path, "utf8");
      if (committedSource !== file.source) {
        fail(
          `${displayPath(file.path)} did not match its staged content after commit.`,
        );
      }
      inspectConfiguration(committedSource, file.path);
    }
  } catch (commitError) {
    const rollbackErrors = [];
    for (const file of [...transaction].reverse()) {
      try {
        await rename(file.backupPath, file.path);
      } catch (rollbackError) {
        rollbackErrors.push({
          file,
          message:
            rollbackError instanceof Error
              ? rollbackError.message
              : String(rollbackError),
        });
      }
    }
    if (rollbackErrors.length > 0) {
      await removeTransactionFiles(transaction.map((file) => file.stagedPath));
      const commitMessage =
        commitError instanceof Error
          ? commitError.message
          : String(commitError);
      fail(
        `Configuration commit failed (${commitMessage}) and rollback was incomplete. Backup files were preserved; recover the affected configs before continuing:\n${rollbackErrors
          .map(
            ({ file, message }) =>
              `  - ${displayPath(file.path)} from ${displayPath(file.backupPath)}: ${message}`,
          )
          .join("\n")}`,
      );
    }
    await removeTransactionFiles(artifactPaths);
    throw commitError;
  }

  await removeTransactionFiles(artifactPaths);
}

async function main() {
  const arguments_ = parseArguments(process.argv.slice(2));
  if (arguments_.mode === "help") {
    process.stdout.write(HELP);
    return;
  }

  const paths = await configurationPaths();
  const files = await Promise.all(
    paths.map(async (path) => {
      const source = await readFile(path, "utf8");
      return { path, source, inspection: inspectConfiguration(source, path) };
    }),
  );

  if (arguments_.mode === "check") {
    assertConfigured(files.map((file) => file.inspection));
    const bindingCount = files.reduce(
      (total, file) => total + file.inspection.bindings,
      0,
    );
    process.stdout.write(
      `Cloudflare configuration check passed: ${files.length} config(s), ${bindingCount} Hyperdrive binding(s).\n`,
    );
    return;
  }

  const placeholderCount = files.reduce(
    (total, file) => total + file.inspection.placeholders,
    0,
  );
  if (placeholderCount === 0) {
    assertConfigured(files.map((file) => file.inspection));
    const configuredIds = new Set(files.flatMap((file) => file.inspection.ids));
    if (!configuredIds.has(arguments_.id)) {
      fail(
        "Hyperdrive is already configured with a different ID; edit intentionally instead of rotating it through this helper.",
      );
    }
    process.stdout.write(
      "Hyperdrive is already configured; no files changed.\n",
    );
    return;
  }

  const updates = files.map((file) => {
    const source = configurePlaceholders(
      file.source,
      file.inspection.placeholderNodes,
      arguments_.id,
    );
    return {
      ...file,
      source,
      inspection: inspectConfiguration(source, file.path),
    };
  });
  assertConfigured(updates.map((file) => file.inspection));

  const changed = updates.filter(
    (file, index) => file.source !== files[index].source,
  );
  await commitConfigurationUpdates(changed);

  process.stdout.write(
    `Configured ${placeholderCount} Hyperdrive binding placeholder(s) in:\n${changed
      .map((file) => `  - ${displayPath(file.path)}`)
      .join("\n")}\n`,
  );
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`configure-cloudflare: ${message}\n`);
  process.exitCode = 1;
});
