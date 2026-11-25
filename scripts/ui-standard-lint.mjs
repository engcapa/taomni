import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const baselinePath = "scripts/ui-standard-baseline.json";
const rules = {
  font: /\btext-\[\d+(?:\.\d+)?px\]/g,
  color: /\b(?:bg|text|border|ring|fill|stroke)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g,
  layer: /\bz-(?:\[\d+\]|\d+\b)/g,
};

export function scanUI(path, text) {
  const counts = {};
  function add(id, by = 1) {
    if (by) counts[id] = (counts[id] ?? 0) + by;
  }
  function classes(value) {
    add("L04", [...value.matchAll(rules.color)].length);
    add("L05", [...value.matchAll(rules.layer)].length);
    add("L09", [...value.matchAll(rules.font)].length);
  }
  if (path.endsWith(".css")) {
    const css = text.replace(/\/\*[\s\S]*?\*\//g, "");
    add("L05", [...css.matchAll(/\bz-index\s*:\s*-?\d+\b/g)].length);
    return counts;
  }
  const ast = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true,
    /\.[jt]sx$/.test(path) ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  function visit(node) {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee.expression) && callee.expression.text === "window"
        && ["alert", "confirm", "prompt"].includes(callee.name.text)) add("L01");
    }
    if (ts.isStringLiteralLike(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isTemplateHead(node)) {
      classes(node.text);
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attrs = new Map(node.attributes.properties.filter(ts.isJsxAttribute)
        .map((attr) => [attr.name.getText(ast), attr.initializer]));
      if (node.tagName.getText(ast) === "button" && !attrs.has("type")) add("L10");
      for (const key of ["aria-label", "title", "placeholder"]) {
        const value = attrs.get(key);
        if (value && ts.isStringLiteral(value) && /\p{Script=Han}/u.test(value.text)) add("L08");
      }
    }
    if (ts.isJsxText(node) && /\p{Script=Han}/u.test(node.text)) add("L08");
    ts.forEachChild(node, visit);
  }
  visit(ast);
  return counts;
}

export function increases(observed, baseline) {
  return Object.entries(observed).flatMap(([path, counts]) =>
    Object.entries(counts).filter(([rule, count]) => count > (baseline[path]?.[rule] ?? 0))
      .map(([rule, count]) => `${path} ${rule}: ${baseline[path]?.[rule] ?? 0} -> ${count}`));
}

function run() {
  const paths = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard",
    "--", "src", "src-tauri/plugins"], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).split("\0");
  const observed = {};
  for (const path of [...new Set(paths)].sort()) {
    if (!/\.(?:[jt]sx?|css)$/.test(path) || !existsSync(path)) continue;
    if (/\/(?:__tests__|tests|__fixtures__|fixtures|stubs|locales|vendor)\//.test(path)
      || /\.(?:test|spec|cases|stories)\./.test(path)) continue;
    const counts = scanUI(path, readFileSync(path, "utf8"));
    if (Object.keys(counts).length) observed[path] = counts;
  }
  const initial = existsSync(baselinePath) ? JSON.parse(readFileSync(baselinePath, "utf8")) : {};
  const violations = increases(observed, initial);
  if (process.argv.includes("--reduce") && (!violations.length || !existsSync(baselinePath))) {
    const lines = Object.entries(observed).map(([path, counts]) => `  ${JSON.stringify(path)}: ${JSON.stringify(counts)}`);
    writeFileSync(baselinePath, "{\n" + lines.join(",\n") + "\n}\n");
    return;
  }
  if (violations.length) {
    console.error(violations.join("\n"));
    process.exitCode = 1;
  } else if (increases(initial, observed).length) {
    console.error("Reduce the repaired per-file UI debt with node scripts/ui-standard-lint.mjs --reduce.");
    process.exitCode = 1;
  } else {
    console.log(`Desktop UI lint passed. ${Object.keys(observed).length} files retain recorded findings.`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
