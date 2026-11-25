import { readFileSync } from "node:fs";
import postcss from "postcss";

const workspace = "src/components/editor/workspace/";

// Read declarations from their production owners. Workspace geometry is supplied
// by the tree and editor containers, so sibling surfaces cannot rely on it.
export function tokenScopes(read = (path) => readFileSync(path, "utf8")) {
  const global = new Set();
  postcss.parse(read("src/styles/theme.css")).walkRules(":root", (rule) => {
    rule.walkDecls(/^--taomni-/, (decl) => global.add(decl.prop));
  });
  const scopes = [
    [workspace, workspace + "hooks/useWorkspaceAppearance.ts"],
    [workspace + "ProjectTree.css", workspace + "FileTreePane.tsx"],
  ];
  return { global, scoped: scopes.map(([path, owner]) => [path, localTokens(read(owner))]) };
}

function localTokens(source) {
  const names = new Set();
  for (const match of source.matchAll(/["']?(--taomni-[\w-]+)["']?\s*:/g)) names.add(match[1]);
  for (const match of source.matchAll(/\.setProperty\(\s*["'](--taomni-[\w-]+)["']/g)) names.add(match[1]);
  return names;
}

export function unresolvedTokens(path, source, { global, scoped }) {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "");
  const local = localTokens(stripped);
  for (const [prefix, names] of scoped) {
    if (path.startsWith(prefix)) for (const name of names) local.add(name);
  }
  const missing = new Set();
  // A nested fallback variable without its own fallback must also resolve.
  for (const [, name] of stripped.matchAll(/var\(\s*(--taomni-[\w-]+)\s*\)/g)) {
    if (!global.has(name) && !local.has(name)) missing.add(name);
  }
  return [...missing].sort();
}
