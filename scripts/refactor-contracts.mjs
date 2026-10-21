import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const baselinePath = path.join(root, "docs-issue/refactor-p0-p5/baseline-contracts.json");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
function files(dir, extension) {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const file = `${dir}/${entry.name}`;
    return entry.isDirectory() ? files(file, extension) : file.endsWith(extension) ? [file] : [];
  });
}
export function nativeCommands() {
  const sources = ["src-tauri/src/lib.rs", ...(fs.existsSync(path.join(root, "src-tauri/src/commands")) ? files("src-tauri/src/commands", ".rs") : [])];
  return sources.flatMap((file) => [...read(file).matchAll(/tauri::generate_handler!\[([\s\S]*?)\]/g)].flatMap((match) =>
    match[1].replace(/\/\/[^\n]*/g, "").split(",").map((value) => value.trim()).filter(Boolean).map((handler) => ({
      name: handler.split("::").at(-1), handler: handler.replace(/^crate::/, ""),
    })))).sort((a, b) => a.name.localeCompare(b.name));
}
export function facadeExports(file) {
  const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  return source.statements.flatMap((node) => {
    if (ts.isExportDeclaration(node) && node.exportClause && ts.isNamedExports(node.exportClause)) {
      return node.exportClause.elements.map((entry) => entry.name.text);
    }
    if (!node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)) return [];
    if (ts.isVariableStatement(node)) return node.declarationList.declarations.map((entry) => entry.name.getText(source));
    return node.name ? [node.name.text] : [];
  }).sort();
}
export function frontendEvents() {
  const names = new Set();
  for (const file of [...files("src", ".ts"), ...files("src", ".tsx")].filter((file) => !file.includes(".test.") && !file.includes("/stubs/"))) {
    const source = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (ts.isCallExpression(node) && /^(listen|emit|emitTo|once)$/.test(node.expression.getText(source))) {
        const argument = node.arguments[node.expression.getText(source) === "emitTo" ? 1 : 0];
        if (argument && ts.isStringLiteral(argument)) names.add(argument.text);
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  return [...names].sort();
}
export function currentContracts() {
  return {
    schema: 1,
    baselineCommit: "f3e375eb",
    note: "Native registered commands and public facade exports; event names cover literal frontend calls only. Dynamic names and payload compatibility require runtime tests.",
    commands: nativeCommands(),
    facades: Object.fromEntries(["src/lib/ipc.ts", "src/stores/appStore.ts"].map((file) => [file, facadeExports(file)])),
    frontendLiteralEvents: frontendEvents(),
  };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--write")) {
    fs.mkdirSync(path.dirname(baselinePath), { recursive: true });
    fs.writeFileSync(baselinePath, JSON.stringify(currentContracts(), null, 2) + "\n");
  } else {
    const expected = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
    const actual = currentContracts();
    const errors = [];
    const names = actual.commands.map((command) => command.name);
    if (new Set(names).size !== names.length) errors.push("Duplicate native command names");
    const dispatcher = "src-tauri/src/commands/mod.rs";
    if (fs.existsSync(path.join(root, dispatcher))) {
      const routes = new Map();
      for (const match of read(dispatcher).matchAll(/((?:"\w+"\s*\|?\s*)+)\s*=>\s*\{?\s*(\w+)::handle\(invoke\)/g)) {
        for (const name of match[1].matchAll(/"(\w+)"/g)) {
          if (routes.has(name[1])) errors.push(`Duplicate native route: ${name[1]}`);
          routes.set(name[1], match[2]);
        }
      }
      for (const command of actual.commands) {
        const domain = routes.get(command.name);
        if (!domain || !read(`src-tauri/src/commands/${domain}.rs`).includes(`crate::${command.handler},`)) {
          errors.push(`Missing or incorrect native route: ${command.name}`);
        }
      }
      for (const name of routes.keys()) if (!names.includes(name)) errors.push(`Unregistered native route: ${name}`);
    }
    for (const command of expected.commands) if (!names.includes(command.name)) errors.push(`Removed command: ${command.name}`);
    for (const [file, exports] of Object.entries(expected.facades)) for (const name of exports) if (!actual.facades[file].includes(name)) errors.push(`Removed export: ${file}#${name}`);
    for (const event of expected.frontendLiteralEvents) if (!actual.frontendLiteralEvents.includes(event)) errors.push(`Removed event: ${event}`);
    if (errors.length) { console.error(errors.join("\n")); process.exitCode = 1; }
    else console.log(`Contracts preserved: ${names.length} native commands, ${Object.values(expected.facades).flat().length} facade exports, ${expected.frontendLiteralEvents.length} literal events.`);
  }
}
