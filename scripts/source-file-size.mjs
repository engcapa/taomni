import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const maximumLines = 800;
const roots = ["mobile-web/src", "src", "src-tauri/src", "src-tauri/tests", "scripts", "vite-plugins"];
const sourceExtension = /\.(?:[cm]?js|tsx?|rs|py|css)$/;
const ignoredDirectories = new Set(["node_modules", "target", "dist", ".git", ".gradle"]);

// These are declarative inputs or generated bindings, not feature owners.
// Rationale and follow-up: docs-issue/refactor-p0-p5-implementation-20261021.md.
const exceptions = new Map([
  ["src-tauri/src/hbase/thrift/idl.rs", "Generated Thrift bindings; regenerate from the IDL."],
  ["src/lib/i18n/locales/en.ts", "English locale dictionary."],
  ["src/lib/i18n/locales/zh-CN.ts", "Chinese locale dictionary."],
  ["src-tauri/src/commands/mod.rs", "Homogeneous compile-time Tauri command routing table."],
]);

function sources(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      return ignoredDirectories.has(entry.name) ? [] : sources(file);
    }
    return entry.isFile() && sourceExtension.test(entry.name) ? [file] : [];
  });
}

const files = roots.flatMap((directory) => sources(path.join(root, directory)));
const oversized = [];
for (const file of files) {
  const relative = path.relative(root, file).split(path.sep).join("/");
  if (exceptions.has(relative)) continue;
  const source = fs.readFileSync(file, "utf8");
  const lines = source ? source.split("\n").length - Number(source.endsWith("\n")) : 0;
  if (lines > maximumLines) oversized.push({ file: relative, lines });
}

if (oversized.length) {
  console.error(`Source files must stay within ${maximumLines} physical lines (AGENTS.md).`);
  for (const { file, lines } of oversized.sort((a, b) => b.lines - a.lines)) {
    console.error(`  ${file}: ${lines} lines; extract a responsibility with its state and lifecycle.`);
  }
  process.exitCode = 1;
} else {
  console.log(`Source size checks passed: ${files.length} files; ${exceptions.size} documented declarative/generated exceptions.`);
}
