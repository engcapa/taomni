import { type EditorState } from "@codemirror/state";
import { foldEffect, foldService, syntaxTree } from "@codemirror/language";
import type { Command } from "@codemirror/view";
import { normalizeEditorSelections } from "./clipboard";
import { type RegionCommentGrammar, type RegionFoldingProvenance } from "./foldingTypes";

export const foldSelection: Command = (view) => {
  const normalized = normalizeEditorSelections(
    view.state.selection.ranges,
    view.state.selection.mainIndex,
  );
  const effects = normalized.ranges
    .filter((range) => !range.empty && range.from < range.to)
    .map((range) => foldEffect.of({ from: range.from, to: range.to }));
  if (effects.length === 0) return false;
  view.dispatch({ effects });
  return true;
};

export const REGION_LINE_TOKENS: Record<string, RegExp> = {
  "//": /\/\//,
  "#": /#/,
  "--": /--/,
  "%": /%/,
  ";": /;/,
};

/**
 * The fold gutter asks the region fold service about every visible line on
 * every update, so the grammar and its matchers are cached per extension.
 */
export const regionGrammarCache = new Map<string, RegionCommentGrammar | null>();

export const regionMatcherCache = new WeakMap<RegionCommentGrammar, { start: RegExp; end: RegExp; }>();

export function regionGrammarForPath(path: string | null | undefined): RegionCommentGrammar | null {
  if (!path) return null;
  const lower = path.toLowerCase();
  const ext = lower.slice(lower.lastIndexOf(".") + 1);
  if (regionGrammarCache.has(ext)) return regionGrammarCache.get(ext) ?? null;
  const grammar = regionGrammarForExtension(ext);
  regionGrammarCache.set(ext, grammar);
  return grammar;
}

export function regionGrammarForExtension(ext: string): RegionCommentGrammar | null {
  const byLine = (token: RegExp): RegionCommentGrammar => ({ lineToken: token });
  switch (ext) {
    case "java":
    case "js":
    case "jsx":
    case "ts":
    case "tsx":
    case "mjs":
    case "cjs":
    case "c":
    case "h":
    case "cpp":
    case "hpp":
    case "cc":
    case "cs":
    case "go":
    case "rs":
    case "swift":
    case "kt":
    case "kts":
    case "scala":
    case "php":
      return { lineToken: REGION_LINE_TOKENS["//"], block: { open: /\/\*/, close: /\*\// } };
    case "py":
    case "pyw":
    case "rb":
    case "sh":
    case "bash":
    case "zsh":
    case "yml":
    case "yaml":
    case "toml":
      return byLine(REGION_LINE_TOKENS["#"]);
    case "sql":
    case "lua":
    case "hs":
      return byLine(REGION_LINE_TOKENS["--"]);
    case "erl":
    case "hrl":
    case "tex":
      return byLine(REGION_LINE_TOKENS["%"]);
    case "clj":
    case "cljs":
    case "edn":
    case "ini":
    case "properties":
      return byLine(REGION_LINE_TOKENS[";"]);
    default:
      // XML/HTML family folds regions inside <!-- --> blocks; every other
      // language is region-fold unavailable.
      if (["xml", "html", "htm", "xhtml", "svg", "vue", "md", "markdown"].includes(ext)) {
        return { lineToken: /<!--/, block: { open: /<!--/, close: /-->/ } };
      }
      return null;
  }
}

export function buildRegionMatchers(grammar: RegionCommentGrammar): { start: RegExp; end: RegExp; } {
  const cached = regionMatcherCache.get(grammar);
  if (cached) return cached;
  const matchers = buildRegionMatchersUncached(grammar);
  regionMatcherCache.set(grammar, matchers);
  return matchers;
}

export function buildRegionMatchersUncached(grammar: RegionCommentGrammar): { start: RegExp; end: RegExp; } {
  const tokenSource = `(?:${grammar.lineToken.source}${grammar.block ? `|${grammar.block.open.source}` : ""})`;
  return {
    start: new RegExp(`^\\s*${tokenSource}\\s*#?region(?:\\s|$)`, "i"),
    end: new RegExp(`^\\s*${tokenSource}\\s*#?endregion(?:\\s|$)`, "i"),
  };
}

/**
 * True when the node name identifies a comment node (case-insensitive).
 * Exported for tests of the syntax-gated region folding decision.
 */
export function isCommentSyntaxNodeName(name: string): boolean {
  return /comment/i.test(name);
}

/**
 * Syntax gate for one candidate region marker (§8.18.4): returns
 * - `"reject"` when the parser proves the marker sits inside a string /
 *   template / other non-comment node,
 * - `"comment"` when it is provably inside a comment node,
 * - `"heuristic"` when no parser information exists (unknown language or
 *   parser not ready) — the extension-token table then decides, documented as
 *   text-marker HEURISTIC folding that does not count as semantic folding.
 */
export function classifyRegionMarker(
  node: { name: string; } | null,
): "reject" | "comment" | "heuristic" {
  if (!node || node.name === "") return "heuristic";
  return isCommentSyntaxNodeName(node.name) ? "comment" : "reject";
}

export function regionFoldingProvenance(
  node: { name: string; } | null,
  context?: { isCommentMarker?: boolean; isIndent?: boolean; },
): RegionFoldingProvenance {
  if (context?.isIndent) return "indent-fallback";
  if (context?.isCommentMarker || (node && node.name !== "" && isCommentSyntaxNodeName(node.name))) {
    return "explicit-comment";
  }
  if (node && node.name !== "") {
    return "language-syntax";
  }
  return "indent-fallback";
}

export function regionFoldingProvenanceLabel(provenance: RegionFoldingProvenance): string {
  switch (provenance) {
    case "explicit-comment":
      return "explicit-comment";
    case "language-syntax":
      return "language-syntax";
    case "indent-fallback":
      return "indent-fallback";
  }
}

/**
 * §8.21.3 V2-C: Detects region fold provenance for a given line:
 * - "explicit-comment": matches region comment marker and passes comment syntax check.
 * - "language-syntax": non-comment syntax tree node spanning beyond the line.
 * - "indent-fallback": indented block without parser grammar.
 */
export function detectLineFoldProvenance(
  state: EditorState,
  lineNumber: number,
  path?: string | null,
): RegionFoldingProvenance | null {
  if (lineNumber < 1 || lineNumber > state.doc.lines) return null;
  const line = state.doc.line(lineNumber);
  const grammar = regionGrammarForPath(path ?? null);
  if (grammar) {
    const matchers = buildRegionMatchers(grammar);
    if (matchers.start.test(line.text)) {
      const startMatch = line.text.match(matchers.start);
      const markerOffset = startMatch?.index ?? line.text.search(/\S/);
      const node = syntaxTree(state).resolveInner(line.from + Math.max(markerOffset, 0), -1);
      const verdict = classifyRegionMarker(node ?? null);
      if (verdict !== "reject") {
        return "explicit-comment";
      }
    }
  }

  // Syntax AST check
  const tree = syntaxTree(state);
  const nonWs = line.text.search(/\S/);
  if (nonWs >= 0) {
    const node = tree.resolveInner(line.from + nonWs, 1);
    if (node && node.name !== "" && !isCommentSyntaxNodeName(node.name) && node.to > line.to) {
      return "language-syntax";
    }
  }

  // Indent check
  if (lineNumber < state.doc.lines && line.text.trim().length > 0) {
    const currentIndent = line.text.match(/^\s*/)?.[0].length ?? 0;
    const nextLine = state.doc.line(lineNumber + 1);
    const nextIndent = nextLine.text.match(/^\s*/)?.[0].length ?? 0;
    if (nextIndent > currentIndent) {
      return "indent-fallback";
    }
  }

  return null;
}

/**
 * Language-aware region fold service factory (§8.17.6 step 3, gated §8.18.4).
 * The resolver runs per query so the service follows the host's current file
 * without rebuilding extensions. Unknown/unmapped languages produce no folds
 * instead of scanning arbitrary text. When a Lezer syntax tree IS available,
 * a marker must live inside a comment node — markers inside strings/templates
 * are rejected even when the token table would match them.
 */
export function createRegionFoldService(
  resolvePath: () => string | null | undefined,
): ReturnType<typeof foldService.of> {
  return foldService.of((state, lineStart, lineEnd) => {
    const grammar = regionGrammarForPath(resolvePath() ?? null);
    if (!grammar) return null;
    const matchers = buildRegionMatchers(grammar);
    const line = state.doc.lineAt(lineStart);
    const startMatch = line.text.match(matchers.start);
    if (!startMatch) return null;

    // Syntax gate: verify the matched marker position against the parse tree.
    const markerOffset = startMatch.index ?? line.text.search(/\S/);
    const node = syntaxTree(state).resolveInner(line.from + Math.max(markerOffset, 0), -1);
    const verdict = classifyRegionMarker(node ?? null);
    if (verdict === "reject") return null;

    // The end marker must pass the same gate when the parser can see it.
    let depth = 1;
    for (let number = line.number + 1; number <= state.doc.lines; number++) {
      const candidate = state.doc.line(number);
      if (matchers.start.test(candidate.text)) {
        const candidateStart = candidate.text.match(matchers.start);
        const candidateNode = syntaxTree(state).resolveInner(
          candidate.from + Math.max(candidateStart?.index ?? 0, 0),
          -1,
        );
        if (classifyRegionMarker(candidateNode ?? null) !== "reject") depth += 1;
      }
      if (!matchers.end.test(candidate.text)) continue;
      const endMatch = candidate.text.match(matchers.end);
      const endNode = syntaxTree(state).resolveInner(candidate.from + Math.max(endMatch?.index ?? 0, 0), -1);
      if (classifyRegionMarker(endNode ?? null) === "reject") continue;
      depth -= 1;
      if (depth === 0) {
        return {
          from: lineEnd,
          to: candidate.from,
        };
      }
    }
    return null;
  });
}

/** Grammar-table fixture for tests/diagnostics. */
export function regionFoldAvailableForPath(path: string): boolean {
  return regionGrammarForPath(path) !== null;
}
