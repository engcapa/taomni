import ts from "typescript";
import { describe, expect, it } from "vitest";

// P0-3: the native overlay window must not evaluate the main application.
// Follow every static import from the overlay entry modules (dynamic imports
// load lazily and are not part of the first evaluation).

const sources = import.meta.glob(
  ["/src/**/*.{ts,tsx}", "!/src/**/*.test.{ts,tsx}", "!/src/**/__fixtures__/**"],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const FORBIDDEN = [
  "/src/App.tsx",
  "/src/layouts/",
  "/src/components/filebrowser/",
  "/src/components/notes/",
  "/src/components/servers/",
  "/src/components/terminal/",
  "/src/components/editor/",
  "/src/stores/appStore.ts",
];

function normalize(parts: string[]): string {
  const out: string[] = [];
  for (const part of parts) {
    if (part === "..") out.pop();
    else if (part && part !== ".") out.push(part);
  }
  return `/${out.join("/")}`;
}

function resolveImport(from: string, specifier: string): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = normalize([...from.split("/").slice(0, -1), ...specifier.split("/")]);
  return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]
    .find((file) => file in sources) ?? null;
}

/** Erased at build time: `import type`, or only `type` named bindings. */
function isTypeOnly(node: ts.ImportDeclaration | ts.ExportDeclaration): boolean {
  if (ts.isExportDeclaration(node)) {
    return node.isTypeOnly || (!!node.exportClause && ts.isNamedExports(node.exportClause)
      && node.exportClause.elements.length > 0 && node.exportClause.elements.every((entry) => entry.isTypeOnly));
  }
  const clause = node.importClause;
  if (!clause) return false;
  if (clause.isTypeOnly) return true;
  const bindings = clause.namedBindings;
  return !clause.name && !!bindings && ts.isNamedImports(bindings)
    && bindings.elements.length > 0 && bindings.elements.every((entry) => entry.isTypeOnly);
}

function staticImports(file: string): string[] {
  const source = ts.createSourceFile(file, sources[file], ts.ScriptTarget.Latest, true);
  const targets: string[] = [];
  for (const node of source.statements) {
    if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue;
    if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) continue;
    if (isTypeOnly(node)) continue;
    const target = resolveImport(file, node.moduleSpecifier.text);
    if (target) targets.push(target);
  }
  return targets;
}

function reachable(entries: string[]): Set<string> {
  const seen = new Set<string>();
  const queue = [...entries];
  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    queue.push(...staticImports(file));
  }
  return seen;
}

describe("screenshot overlay entry", () => {
  it("does not statically reach the main layout or other feature modules", () => {
    const files = [...reachable(["/src/screenshotOverlayBoot.ts", "/src/screenshotOverlayRoot.tsx"])];
    expect(files).toContain("/src/components/screenshot/ScreenshotOverlay.tsx");
    expect(files.filter((file) => FORBIDDEN.some((prefix) => file.startsWith(prefix)))).toEqual([]);
  });

  it("is the first app module main.tsx evaluates", () => {
    const imports = [...sources["/src/main.tsx"].matchAll(/^import (?:.*? from )?"([^"]+)";/gm)].map((m) => m[1]);
    expect(imports.slice(0, 2)).toEqual(["./lib/webviewCompat", "./screenshotOverlayBoot"]);
  });
});
