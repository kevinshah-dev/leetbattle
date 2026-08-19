import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const API_ROOT = join(process.cwd(), "src/app/api");
const HTTP_METHODS = new Set([
  "DELETE",
  "GET",
  "HEAD",
  "OPTIONS",
  "PATCH",
  "POST",
  "PUT",
]);

const EXPECTED_PROTECTED_HANDLERS = {
  "history/[matchId]/route.ts": ["GET"],
  "history/route.ts": ["GET"],
  "profile/route.ts": ["GET", "POST"],
  "rooms/[roomCode]/commands/route.ts": ["POST"],
  "rooms/[roomCode]/realtime-token/route.ts": ["POST"],
  "rooms/[roomCode]/route.ts": ["GET"],
  "rooms/join/route.ts": ["POST"],
  "rooms/route.ts": ["POST"],
} as const;

function routeFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return routeFiles(path);
      return entry.isFile() && entry.name === "route.ts" ? [path] : [];
    })
    .sort();
}

function routeName(file: string): string {
  return relative(API_ROOT, file).split(sep).join("/");
}

function exportedHttpHandlers(
  sourceFile: ts.SourceFile,
): ts.FunctionDeclaration[] {
  return sourceFile.statements.filter(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) &&
      statement.name !== undefined &&
      HTTP_METHODS.has(statement.name.text) &&
      statement.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
      ) === true,
  );
}

function importsCentralAuthBoundary(sourceFile: ts.SourceFile): boolean {
  return sourceFile.statements.some((statement) => {
    if (
      !ts.isImportDeclaration(statement) ||
      statement.moduleSpecifier.getText(sourceFile) !== '"@/server/auth"'
    ) {
      return false;
    }
    const bindings = statement.importClause?.namedBindings;
    return (
      bindings !== undefined &&
      ts.isNamedImports(bindings) &&
      bindings.elements.some(
        (element) =>
          element.propertyName === undefined &&
          element.name.text === "requireAuthenticatedUserId",
      )
    );
  });
}

function awaitsCentralAuthBoundary(handler: ts.FunctionDeclaration): boolean {
  let found = false;
  function visit(node: ts.Node): void {
    if (
      ts.isAwaitExpression(node) &&
      ts.isCallExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "requireAuthenticatedUserId"
    ) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  }
  if (handler.body) visit(handler.body);
  return found;
}

describe("protected App Router API contract", () => {
  it("keeps the protected route inventory explicit", () => {
    const inventory = Object.fromEntries(
      routeFiles(API_ROOT).map((file) => {
        const sourceFile = ts.createSourceFile(
          file,
          readFileSync(file, "utf8"),
          ts.ScriptTarget.Latest,
          true,
          ts.ScriptKind.TS,
        );
        return [
          routeName(file),
          exportedHttpHandlers(sourceFile).map((handler) => handler.name!.text),
        ];
      }),
    );

    expect(inventory).toEqual(EXPECTED_PROTECTED_HANDLERS);
  });

  it("makes every protected handler await the central auth boundary", () => {
    for (const file of routeFiles(API_ROOT)) {
      const source = readFileSync(file, "utf8");
      const sourceFile = ts.createSourceFile(
        file,
        source,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS,
      );
      expect(
        importsCentralAuthBoundary(sourceFile),
        `${routeName(file)} must import the central auth boundary`,
      ).toBe(true);
      expect(
        source.includes("@clerk/"),
        `${routeName(file)} must not establish a second Clerk auth boundary`,
      ).toBe(false);

      for (const handler of exportedHttpHandlers(sourceFile)) {
        expect(
          awaitsCentralAuthBoundary(handler),
          `${routeName(file)} ${handler.name!.text} must await requireAuthenticatedUserId()`,
        ).toBe(true);
      }
    }
  });
});
