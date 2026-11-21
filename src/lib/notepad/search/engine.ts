import {
  readSearchHistory,
  recordSearchHistory,
  resetSearchHistoryForTests,
} from "../../../components/editor/workspace/searchPanel/history";
import type { NotepadSearchResultHit } from "../../../stores/notepadStore";
import { getLineStarts, lineIndexAt, type TextRange } from "../transforms/lines";
import {
  buildSearchRegExp,
  resolveReplacementText,
  type NotepadSearchMode,
} from "../transforms/escape";

export { readSearchHistory, recordSearchHistory, resetSearchHistoryForTests };

export interface NotepadSearchQuery {
  query: string;
  replace?: string;
  mode: NotepadSearchMode;
  caseSensitive: boolean;
  wholeWord: boolean;
  wrapAround: boolean;
  backward: boolean;
  inSelection: boolean;
  dotAll: boolean;
}

export interface SearchMatchSpan {
  from: number;
  to: number;
  text: string;
  groups: string[];
}

export interface SearchAllResult {
  matches: SearchMatchSpan[];
  timedOut: boolean;
  truncated: boolean;
  error?: string;
}

const DEFAULT_MAX_MATCHES = 20000;
const DEFAULT_TIME_BUDGET_MS = 250;

/**
 * Detect nested quantifiers / classic ReDoS constructs before executing user regexes
 * so the renderer UI cannot be locked up by catastrophic backtracking (`V-23`).
 */
export function hasCatastrophicBacktrackingRisk(pattern: string): boolean {
  // Strip escaped sequences first so literal `\+` inside `\(+` does not trigger false positives
  const stripped = pattern.replace(/\\./g, "x");
  // Pattern: group containing a quantifier (+, *, {n,m}, ?) followed directly by an outer quantifier
  const nestedGroupQuantifier = /\([^)]*[+*][^)]*\)[+*{]/;
  if (nestedGroupQuantifier.test(stripped)) return true;
  // Overlapping alternation inside quantified group: (a|a)+ or (.*|a)+
  const quantifiedAlt = /\([^)]*\|[^)]*\)[+*{]/;
  if (quantifiedAlt.test(stripped) && /[*+]/.test(stripped.split(")")[0] ?? "")) {
    return true;
  }
  return false;
}

export function findAllMatches(
  text: string,
  options: Pick<NotepadSearchQuery, "query" | "mode" | "caseSensitive" | "wholeWord" | "dotAll">,
  scope?: TextRange,
  limits?: { maxMatches?: number; timeBudgetMs?: number },
): SearchAllResult {
  if (!options.query) {
    return { matches: [], timedOut: false, truncated: false };
  }
  if (options.mode === "re" && hasCatastrophicBacktrackingRisk(options.query)) {
    return {
      matches: [],
      timedOut: true,
      truncated: false,
      error: "Regular expression rejected: nested quantifiers may cause catastrophic backtracking.",
    };
  }

  let regex: RegExp | null = null;
  try {
    regex = buildSearchRegExp(options, true);
  } catch (err) {
    return {
      matches: [],
      timedOut: false,
      truncated: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
  if (!regex) return { matches: [], timedOut: false, truncated: false };

  const startOffset = scope ? Math.max(0, Math.min(scope.from, text.length)) : 0;
  const endOffset = scope ? Math.max(startOffset, Math.min(scope.to, text.length)) : text.length;
  const haystack = scope ? text.slice(startOffset, endOffset) : text;

  const maxMatches = limits?.maxMatches ?? DEFAULT_MAX_MATCHES;
  const budgetMs = limits?.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS;
  const startTime = typeof performance !== "undefined" ? performance.now() : Date.now();
  const matches: SearchMatchSpan[] = [];

  regex.lastIndex = 0;
  let m: RegExpExecArray | null;
  let ops = 0;
  while ((m = regex.exec(haystack)) !== null) {
    ops += 1;
    if ((ops & 63) === 0) {
      const elapsed = (typeof performance !== "undefined" ? performance.now() : Date.now()) - startTime;
      if (elapsed > budgetMs) {
        return {
          matches,
          timedOut: true,
          truncated: true,
          error: `Search aborted after ${Math.round(elapsed)}ms safety budget.`,
        };
      }
    }
    const from = startOffset + m.index;
    const to = from + m[0].length;
    matches.push({ from, to, text: m[0], groups: m.slice(1).map((g) => g ?? "") });
    if (m[0].length === 0) {
      regex.lastIndex += 1;
    }
    if (matches.length >= maxMatches) {
      return { matches, timedOut: false, truncated: true };
    }
  }
  return { matches, timedOut: false, truncated: false };
}

export function findNextMatch(
  text: string,
  query: NotepadSearchQuery,
  cursor: TextRange,
  selectionScope?: TextRange,
): { match: SearchMatchSpan | null; wrapped: boolean; error?: string } {
  const scope = query.inSelection && selectionScope && selectionScope.to > selectionScope.from
    ? selectionScope
    : undefined;
  const all = findAllMatches(text, query, scope);
  if (all.error) return { match: null, wrapped: false, error: all.error };
  if (all.matches.length === 0) return { match: null, wrapped: false };

  if (query.backward) {
    const prev = [...all.matches].reverse().find((m) => m.to <= cursor.from || m.from < cursor.from);
    if (prev) return { match: prev, wrapped: false };
    if (query.wrapAround) return { match: all.matches[all.matches.length - 1], wrapped: true };
    return { match: null, wrapped: false };
  }

  const next = all.matches.find((m) => m.from >= cursor.to);
  if (next) return { match: next, wrapped: false };
  if (query.wrapAround) return { match: all.matches[0], wrapped: true };
  return { match: null, wrapped: false };
}

export function expandMatchReplacement(
  match: SearchMatchSpan,
  replaceTemplate: string,
  mode: NotepadSearchMode,
): string {
  const expanded = resolveReplacementText(replaceTemplate, mode);
  if (mode !== "re") return expanded;
  return expanded.replace(/\$(\$|&|\d{1,2}|\{\d{1,2}\})/g, (_m, token: string) => {
    if (token === "$") return "$";
    if (token === "&") return match.text;
    const digits = token.startsWith("{") ? token.slice(1, -1) : token;
    const idx = Number.parseInt(digits, 10);
    if (idx === 0) return match.text;
    return match.groups[idx - 1] ?? "";
  });
}

export function replaceAllInText(
  text: string,
  query: NotepadSearchQuery,
  selectionScope?: TextRange,
): { text: string; count: number; error?: string } {
  const scope = query.inSelection && selectionScope && selectionScope.to > selectionScope.from
    ? selectionScope
    : undefined;
  const res = findAllMatches(text, query, scope);
  if (res.error) return { text, count: 0, error: res.error };
  if (res.matches.length === 0) return { text, count: 0 };

  const tpl = query.replace ?? "";
  let out = "";
  let pos = 0;
  for (const m of res.matches) {
    out += text.slice(pos, m.from);
    out += expandMatchReplacement(m, tpl, query.mode);
    pos = m.to;
  }
  out += text.slice(pos);
  return { text: out, count: res.matches.length };
}

export function toSearchResultHits(
  docInfo: { docId?: string; filePath?: string; name: string },
  text: string,
  matches: SearchMatchSpan[],
): NotepadSearchResultHit[] {
  if (matches.length === 0) return [];
  const starts = getLineStarts(text);
  const lines = text.split("\n");
  return matches.map((m) => {
    const ln = lineIndexAt(text, m.from);
    return {
      docId: docInfo.docId,
      filePath: docInfo.filePath,
      name: docInfo.name,
      line: ln,
      column: m.from - starts[ln],
      from: m.from,
      to: m.to,
      lineText: lines[ln] ?? "",
      matchLength: Math.max(0, m.to - m.from),
    };
  });
}
