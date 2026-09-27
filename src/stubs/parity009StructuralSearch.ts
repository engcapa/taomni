import { javaLanguage } from "@codemirror/lang-java";
import type {
  StructuralContainer,
  StructuralMatch,
  StructuralSearchCapabilities,
  StructuralSearchRequest,
  StructuralSearchResponse,
} from "../lib/editor/structuralSearch";
import { vfsList, vfsReadText } from "./localVfs";

/**
 * ED-PARITY-009 browser fixture backend. Browser preview has no native
 * tree-sitter process, so by default Structural Search reports a typed
 * `unavailable`. With the isolated QA fixture enabled, templates are matched
 * against the Lezer Java AST of VFS files (node kinds + leaf token text; the
 * same algorithm as src-tauri structural_search.rs). This proves renderer
 * entry, typed lifecycle and navigation only — never the native parser.
 */

export const parity009Root = "/preview/parity009";
const enabledKey = "taomni.qa.parity009.enabled";
const modeKey = "taomni.qa.parity009.mode";
const VAR_PREFIX = "__ssr_var_";
const BACKEND = { id: "browser-lezer-java", parser: "@lezer/java (QA fixture)", grammar: "lezer-java 1.x" };

// @lezer/common is not a direct dependency; derive its node type from the parser.
type SyntaxNode = ReturnType<typeof javaLanguage.parser.parse>["topNode"];
type Pattern = { var: string } | { kind: string; text: string | null; children: Pattern[] };

const active = new Map<string, { cancelled: boolean; release?: () => void }>();
const runs: Array<{ requestId: string; status: string; pattern: string; count: number | null }> = [];

function fixtureEnabled(): boolean {
  try { return localStorage.getItem(enabledKey) === "true"; } catch { return false; }
}

function mode(): string {
  try { return localStorage.getItem(modeKey) ?? "normal"; } catch { return "normal"; }
}

function children(node: SyntaxNode): SyntaxNode[] {
  const out: SyntaxNode[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "LineComment" || child.name === "BlockComment") continue;
    out.push(child);
  }
  return out;
}

function toPattern(node: SyntaxNode, source: string): Pattern {
  const text = source.slice(node.from, node.to);
  if ((node.name === "Identifier" || node.name === "Definition" || node.name === "TypeName") && text.startsWith(VAR_PREFIX)) {
    return { var: text.slice(VAR_PREFIX.length) };
  }
  const kids = children(node).map((child) => toPattern(child, source));
  return { kind: node.name, text: kids.length === 0 ? text : null, children: kids };
}

function hasError(node: SyntaxNode): boolean {
  if (node.type.isError) return true;
  for (let child = node.firstChild; child; child = child.nextSibling) if (hasError(child)) return true;
  return false;
}

function compile(pattern: string): { root: Pattern; variables: string[] } | string {
  if (!pattern.trim()) return "Search template must not be empty";
  const variables: string[] = [];
  let substituted = "";
  let rest = pattern;
  for (;;) {
    const start = rest.indexOf("$");
    if (start < 0) break;
    const end = rest.indexOf("$", start + 1);
    if (end < 0) return "Unterminated template variable: expected a closing '$'";
    const name = rest.slice(start + 1, end);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return `Invalid template variable name '$${name}$'`;
    if (!variables.includes(name)) variables.push(name);
    substituted += rest.slice(0, start) + VAR_PREFIX + name;
    rest = rest.slice(end + 1);
  }
  substituted += rest;
  const wrappers: Array<[string, string, (top: SyntaxNode) => SyntaxNode | null]> = [
    ["class __SsrT { void __ssrM() {\n", "\n} }", (top) => {
      const block = top.getChild("ClassDeclaration")?.getChild("ClassBody")?.getChild("MethodDeclaration")?.getChild("Block");
      const statements = block ? children(block).filter((child) => child.name !== "{" && child.name !== "}") : [];
      return statements.length === 1 ? statements[0]! : null;
    }],
    ["class __SsrT { Object __ssrF = (\n", "\n); }", (top) => {
      const value = top.getChild("ClassDeclaration")?.getChild("ClassBody")?.getChild("FieldDeclaration")
        ?.getChild("VariableDeclarator")?.getChild("ParenthesizedExpression");
      const inner = value ? children(value).filter((child) => child.name !== "(" && child.name !== ")") : [];
      return inner.length === 1 ? inner[0]! : null;
    }],
  ];
  for (const [prefix, suffix, locate] of wrappers) {
    const source = `${prefix}${substituted}${suffix}`;
    const top = javaLanguage.parser.parse(source).topNode as unknown as SyntaxNode;
    if (hasError(top)) continue;
    const node = locate(top);
    if (!node) continue;
    const root = toPattern(node, source);
    if ("var" in root) return "Search template must contain Java code, not only a variable";
    return { root, variables };
  }
  return "Search template is not a single Java statement, expression or class member";
}

function position(source: string, offset: number) {
  const before = source.slice(0, offset);
  const line = before.split("\n").length - 1;
  return { line, character: offset - (before.lastIndexOf("\n") + 1) };
}

function containers(node: SyntaxNode, source: string): StructuralContainer[] {
  const out: StructuralContainer[] = [];
  const kinds: Record<string, StructuralContainer["kind"]> = {
    ClassDeclaration: "class", InterfaceDeclaration: "interface", EnumDeclaration: "enum",
    RecordDeclaration: "record", MethodDeclaration: "method", ConstructorDeclaration: "constructor",
  };
  for (let parent = node.parent; parent; parent = parent.parent) {
    const kind = kinds[parent.name];
    if (!kind) continue;
    const name = parent.getChild("Definition");
    out.unshift({ kind, name: name ? source.slice(name.from, name.to) : "" });
  }
  return out;
}

interface Binding { name: string; node: SyntaxNode; text: string }

function matches(
  pattern: Pattern,
  node: SyntaxNode,
  source: string,
  bindings: Binding[],
  matchCase: boolean,
): boolean {
  const equal = (a: string, b: string) => (matchCase ? a === b : a.toLowerCase() === b.toLowerCase());
  if (node.type.isError) return false;
  const text = source.slice(node.from, node.to);
  if ("var" in pattern) {
    const previous = bindings.find((binding) => binding.name === pattern.var);
    if (previous) return equal(previous.text, text);
    bindings.push({ name: pattern.var, node, text });
    return true;
  }
  if (node.name !== pattern.kind) return false;
  const targets = children(node);
  if (pattern.children.length === 0 || targets.length === 0) {
    return pattern.children.length === 0 && targets.length === 0 && equal(pattern.text ?? "", text);
  }
  return targets.length === pattern.children.length
    && pattern.children.every((child, index) => matches(child, targets[index]!, source, bindings, matchCase));
}

async function javaFiles(dir: string, prefix = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await vfsList(dir)) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.fileType === "dir") out.push(...await javaFiles(entry.path, relative));
    else if (entry.name.endsWith(".java")) out.push(relative);
  }
  return out.sort();
}

function variableFilters(request: StructuralSearchRequest, variables: string[]) {
  const filters: Array<{ name: string; regex: RegExp; invert: boolean }> = [];
  for (const [name, variable] of Object.entries(request.query.variables)) {
    if (!variables.includes(name)) continue;
    if (variable.minCount !== 1 || variable.maxCount !== 1) {
      return { error: `Variable $${name}$: only Count [1,1] is supported by this backend` };
    }
    if (!variable.text) continue;
    try {
      filters.push({ name, regex: new RegExp(`^(?:${variable.text})$`, request.query.matchCase ? "" : "i"), invert: !!variable.invert });
    } catch (error) {
      return { error: `Variable $${name}$ Text: ${error instanceof Error ? error.message : String(error)}`, invalid: true };
    }
  }
  return { filters };
}

async function search(request: StructuralSearchRequest): Promise<StructuralSearchResponse> {
  const { requestId, query } = request;
  if (query.languageId !== "java") {
    return { status: "unavailable", requestId, reason: "unsupported-language", message: `No parser backend for '${query.languageId}'` };
  }
  const compiled = compile(query.pattern);
  if (typeof compiled === "string") return { status: "error", requestId, code: "invalid-pattern", message: compiled };
  const built = variableFilters(request, compiled.variables);
  if ("error" in built) {
    return { status: "error", requestId, code: built.invalid ? "invalid-pattern" : "unsupported-constraint", message: built.error! };
  }
  const started = performance.now();
  const roots = query.scope === "workspace"
    ? request.roots
    : request.roots.filter((root) => root.id === request.activeFile?.rootId);
  if (roots.length === 0) return { status: "error", requestId, code: "invalid-scope", message: `Scope '${query.scope}' needs an active file` };
  const results: StructuralMatch[] = [];
  let filesScanned = 0;
  for (const root of roots) {
    const files = query.scope === "file" && request.activeFile ? [request.activeFile.path] : await javaFiles(root.path);
    for (const path of files) {
      const source = await vfsReadText(`${root.path}/${path}`);
      filesScanned += 1;
      const tree = javaLanguage.parser.parse(source);
      tree.iterate({
        enter: (ref) => {
          const node = ref.node as unknown as SyntaxNode;
          if (!("kind" in compiled.root) || node.name !== compiled.root.kind) return;
          const bindings: Binding[] = [];
          if (!matches(compiled.root, node, source, bindings, !!query.matchCase)) return;
          const pass = built.filters.every((filter) => {
            const binding = bindings.find((item) => item.name === filter.name);
            return !binding || filter.regex.test(binding.text) !== filter.invert;
          });
          if (!pass) return;
          const lineStart = source.lastIndexOf("\n", node.from - 1) + 1;
          const lineEnd = source.indexOf("\n", node.from);
          results.push({
            rootId: root.id, rootName: root.name, path,
            start: position(source, node.from), end: position(source, node.to),
            startByte: node.from, endByte: node.to,
            lineText: source.slice(lineStart, lineEnd < 0 ? source.length : lineEnd),
            matchedText: source.slice(node.from, node.to),
            captures: compiled.variables.flatMap((name) => {
              const binding = bindings.find((item) => item.name === name);
              return binding ? [{
                name, text: binding.text,
                start: position(source, binding.node.from), end: position(source, binding.node.to),
              }] : [];
            }),
            containers: containers(node, source),
          });
        },
      });
    }
  }
  return {
    status: "ok", requestId, backend: BACKEND, matches: results, truncated: false,
    stats: { filesScanned, filesWithParseErrors: 0, elapsedMs: Math.round(performance.now() - started) },
  };
}

export function parity009Capabilities(): StructuralSearchCapabilities {
  const available = fixtureEnabled() && mode() !== "unavailable";
  return {
    available,
    backend: available ? BACKEND : { id: "none", parser: "browser preview", grammar: "no native parser" },
    languages: available ? ["java"] : [],
    scopes: ["workspace", "module", "file"],
    activeRequests: active.size,
  };
}

export async function parity009Run(request: StructuralSearchRequest): Promise<StructuralSearchResponse> {
  if (!parity009Capabilities().available) {
    return {
      status: "unavailable", requestId: request.requestId, reason: "backend-missing",
      message: "Structural Search needs the desktop parser backend (tree-sitter-java); browser preview has none",
    };
  }
  const entry: { cancelled: boolean; release?: () => void } = { cancelled: false };
  active.set(request.requestId, entry);
  try {
    if (mode() === "hold") await new Promise<void>((resolve) => { entry.release = resolve; });
    if (entry.cancelled) {
      runs.push({ requestId: request.requestId, status: "cancelled", pattern: request.query.pattern, count: null });
      return { status: "cancelled", requestId: request.requestId, stats: { filesScanned: 0, filesWithParseErrors: 0, elapsedMs: 0 } };
    }
    const response = mode() === "error"
      ? { status: "error" as const, requestId: request.requestId, code: "invalid-request" as const, message: "parity009 fixture: controlled backend error" }
      : await search(request);
    runs.push({
      requestId: request.requestId, status: response.status, pattern: request.query.pattern,
      count: response.status === "ok" ? response.matches.length : null,
    });
    return response;
  } finally {
    active.delete(request.requestId);
  }
}

export function parity009Cancel(requestId: string): boolean {
  const entry = active.get(requestId);
  if (!entry) return false;
  entry.cancelled = true;
  entry.release?.();
  return true;
}

declare global {
  interface Window {
    __taomniQaParity009?: {
      observe: () => { active: string[]; runs: typeof runs; mode: string };
      setMode: (value: string) => void;
      release: () => number;
    };
  }
}

if (typeof window !== "undefined") {
  window.__taomniQaParity009 = {
    observe: () => ({ active: [...active.keys()], runs: [...runs], mode: mode() }),
    setMode: (value) => { try { localStorage.setItem(modeKey, value); } catch { /* fixture only */ } },
    release: () => {
      let count = 0;
      for (const entry of active.values()) {
        if (entry.release) { entry.release(); count += 1; }
      }
      return count;
    },
  };
}
