import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// These are implementation modules, not alternate application entry points.
const boundaries = [
  ["src/lib/editor/lsp", "src/lib/editor/lsp.ts"],
  ["src/lib/mail", "src/lib/mail.ts"],
  ["src/lib/mailHtml", "src/lib/mailHtml.ts"],
  ["src/lib/sqlMetadataCompletions", "src/lib/sqlMetadataCompletions.ts"],
  ["src/components/editor/workspace/layoutTree", "src/components/editor/workspace/recursiveLayoutTree.ts"],
  ["src/components/editor/workspace/codeActions", "src/components/editor/workspace/codeActionProviderAdapter.ts"],
  ["src/components/editor/workspace/editorCommands", "src/components/editor/workspace/workspaceEditorCommands.ts"],
  ["src/components/editor/workspace/actions", "src/components/editor/workspace/workspaceActionRegistry.ts"],
  ["src/components/editor/workspace/actions", "src/components/editor/workspace/workspaceActionHost.ts"],
  ["src/components/editor/workspace/templates", "src/components/editor/workspace/liveTemplates.ts"],
  ["src/components/editor/workspace/debug/model", "src/components/editor/workspace/dapDebugModel.ts"],
  ["src/components/editor/workspace/model", "src/components/editor/workspace/codeWorkspaceModel.ts"],
  ["src/components/editor/workspace/workflow", "src/components/editor/workspace/rearrangeCleanupWorkflow.ts"],
  ["src/components/editor/workspace/refactor", "src/components/editor/workspace/refactorPlan.ts"],
  ["src/components/screenshot/overlay", "src/components/screenshot/ScreenshotOverlay.tsx"],
  ["src/components/sidebar/sessionTree", "src/components/sidebar/SessionTree.tsx"],
  ["src/components/database/grid", "src/components/database/QueryResultGrid.tsx"],
  ["src/components/welcome", "src/components/WelcomePanel.tsx"],
  ["src/components/vnc/panel", "src/components/vnc/VncPanel.tsx"],
  ["src/components/editor/workspace/host", "src/components/editor/workspace/CodeMirrorHost.tsx"],
  ["src/lib/ipc", "src/lib/ipc.ts"],
  ["src/lib/sessionImportExport", "src/lib/sessionImportExport.ts"],
  ["src/stores/app", "src/stores/appStore.ts"],
  ["src/stubs/commands", "src/stubs/tauri-core.ts"],
  ["src/components/editor/workspace/controller", "src/components/editor/CodeWorkspaceTab.tsx"],
  ["src/components/editor/workspace/completion", "src/components/editor/workspace/lspCompletion.ts"],
  ["src/components/editor/workspace/commands", "src/components/editor/workspace/controller/commandCatalog.tsx"],
  ["src/components/editor/workspace/debug", "src/components/editor/workspace/useCodeDebugSession.ts"],
  ["src/components/editor/workspace/hooks", "src/components/editor/CodeWorkspaceTab.tsx"],
  ["src/components/editor/workspace/views", "src/components/editor/CodeWorkspaceTab.tsx"],
  ["src/components/database/client", "src/components/database/DbClientTab.tsx"],
  ["src/components/mail/client", "src/components/mail/MailClientTab.tsx"],
  ["src/components/git/workspace", "src/components/git/WorkspaceGitManager.tsx"],
  ["src/components/git/panel", "src/components/git/GitPanel.tsx"],
  ["src/components/terminal/panel", "src/components/terminal/TerminalPanel.tsx"],
  ["src/components/session/editor", "src/components/session/SessionEditor.tsx"],
  ["src/components/sockscap/panel", "src/components/sockscap/SocksCapPanel.tsx"],
  ["src/layouts/main", "src/layouts/MainLayout.tsx"],
];
function sources(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? sources(file) : /\.tsx?$/.test(file) && !file.includes(".test.") ? [file] : [];
  });
}
function resolve(from, specifier) {
  if (!specifier.startsWith(".")) return null;
  const base = path.resolve(path.dirname(from), specifier);
  return [base, `${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`]
    .find((file) => fs.existsSync(file) && fs.statSync(file).isFile()) ?? null;
}
const errors = [];
const graph = new Map();
for (const [directory, facade] of boundaries) {
  for (const file of sources(path.join(root, directory))) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
    const edges = [];
    for (const node of source.statements) {
      if (!ts.isImportDeclaration(node) && !ts.isExportDeclaration(node)) continue;
      if (!node.moduleSpecifier || !ts.isStringLiteral(node.moduleSpecifier)) continue;
      const target = resolve(file, node.moduleSpecifier.text);
      if (!target) continue;
      // Even type-only dependencies belong in domain contracts, not UI shells.
      if (target === path.join(root, facade)) errors.push(`${path.relative(root, file)} imports its facade ${facade}`);
      const clause = ts.isImportDeclaration(node) ? node.importClause : node;
      const bindings = ts.isImportDeclaration(node) ? clause?.namedBindings : node.exportClause;
      const typeOnly = clause?.isTypeOnly || (bindings && (ts.isNamedImports(bindings) || ts.isNamedExports(bindings))
        && bindings.elements.length > 0 && bindings.elements.every((entry) => entry.isTypeOnly)
        && !(ts.isImportDeclaration(node) && clause?.name));
      if (!typeOnly) edges.push(target);
    }
    const visitInlineImport = (node) => {
      const typeImport = ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
        ? node.argument.literal : null;
      const dynamicImport = ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword
        ? node.arguments[0] : null;
      const specifier = typeImport ?? dynamicImport;
      if (specifier && ts.isStringLiteral(specifier)) {
        const target = resolve(file, specifier.text);
        if (target === path.join(root, facade)) errors.push(`${path.relative(root, file)} imports its facade ${facade}`);
        if (target && dynamicImport) edges.push(target);
      }
      ts.forEachChild(node, visitInlineImport);
    };
    visitInlineImport(source);
    graph.set(file, edges);
  }
}
const complete = new Set();
const visiting = new Set();
function visit(file, trail) {
  if (visiting.has(file)) {
    errors.push(`Runtime dependency cycle: ${[...trail.slice(trail.indexOf(file)), file].map((value) => path.relative(root, value)).join(" -> ")}`);
    return;
  }
  if (complete.has(file)) return;
  visiting.add(file);
  for (const target of graph.get(file) ?? []) if (graph.has(target)) visit(target, [...trail, file]);
  visiting.delete(file);
  complete.add(file);
}
for (const file of graph.keys()) visit(file, []);
if (errors.length) {
  console.error(errors.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Boundary checks passed: ${graph.size} implementation modules; no reverse facade imports or internal runtime cycles.`);
}
