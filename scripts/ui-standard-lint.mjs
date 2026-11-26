import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
import { checkElement, checkInlineStyle, importedIconNames } from "./ui-standard-controls.mjs";

import { tokenScopes, unresolvedTokens } from "./ui-standard-tokens.mjs";

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
  const icons = importedIconNames(ast);
  const dialogNames = new Set(["alert", "confirm", "prompt"]);
  let checker;
  function isGlobal(identifier) {
    if (!checker) {
      // Bind this file only. A name with no local symbol resolves to the host global.
      const options = { noLib: true, noResolve: true, allowJs: true, jsx: ts.JsxEmit.Preserve };
      const host = ts.createCompilerHost(options);
      host.getSourceFile = (name) => name === ast.fileName ? ast : undefined;
      checker = ts.createProgram([ast.fileName], options, host).getTypeChecker();
    }
    return !checker.getSymbolAtLocation(identifier)?.declarations?.length;
  }
  function visit(node) {
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && dialogNames.has(callee.text) && isGlobal(callee)) add("L01");
      if (ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee)) {
        const owner = callee.expression;
        const name = ts.isPropertyAccessExpression(callee) ? callee.name.text
          : ts.isStringLiteralLike(callee.argumentExpression) ? callee.argumentExpression.text : "";
        if (ts.isIdentifier(owner) && ["window", "globalThis", "self"].includes(owner.text)
            && dialogNames.has(name) && isGlobal(owner)) add("L01");
      }
    }
    if (ts.isStringLiteralLike(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node) || ts.isTemplateHead(node)) {
      classes(node.text);
    }
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attrs = new Map(node.attributes.properties.filter(ts.isJsxAttribute)
        .map((attr) => [attr.name.getText(ast), attr.initializer]));
      checkElement(node, attrs, icons, path, add);
      checkInlineStyle(attrs.get("style"), add);
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

function sourcePaths(args) {
  return execFileSync("git", [...args, "--", "src", "src-tauri/plugins", "src-tauri/crates/taomni-plugin-api/frontend"], {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024,
  }).split("\0").filter(isUISource);
}

function isUISource(path) {
  return /\.(?:[jt]sx?|css)$/.test(path)
    && !/\/(?:__tests__|tests|__fixtures__|fixtures|stubs|locales|vendor)\//.test(path)
    && !/\.(?:test|spec|cases|stories)\./.test(path);
}

// Compare source on both sides with the same rule definitions. This also
// protects the first baseline and new rules introduced by the current PR.
export function sourceIncreases(base, observed) {
  const existing = new Set(sourcePaths(["ls-tree", "-rz", "--name-only", base]));
  const changed = sourcePaths(["diff", "-z", "--no-renames", "--name-only", "--diff-filter=AM", base]);
  const prior = {};
  const current = {};
  for (const path of changed) {
    if (!observed[path]) continue;
    current[path] = observed[path];
    if (existing.has(path)) {
      const previous = execFileSync("git", ["show", base + ":" + path], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      prior[path] = scanUI(path, previous);
    }
  }
  return increases(current, prior);
}

function run() {
  const paths = sourcePaths(["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  const observed = {};
  const scopes = tokenScopes();
  const missingTokens = [];
  for (const path of [...new Set(paths)].sort()) {
    if (!existsSync(path)) continue;
    const source = readFileSync(path, "utf8");
    const counts = scanUI(path, source);
    for (const token of unresolvedTokens(path, source, scopes)) missingTokens.push(`${path} L03: ${token}`);
    if (Object.keys(counts).length) observed[path] = counts;
  }
  const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
  const violations = [...missingTokens, ...increases(observed, {})];
  if (Object.keys(baseline).length > 0) violations.push("The desktop UI lint baseline must stay empty.");
  const baseIndex = process.argv.indexOf("--base");
  if (baseIndex !== -1) {
    const base = process.argv[baseIndex + 1];
    if (!base || base.startsWith("-")) throw new Error("--base requires a commit");
    violations.push(...sourceIncreases(base, observed));
  }
  if (violations.length) {
    console.error(violations.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("Desktop UI lint passed with an empty exception baseline.");
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
