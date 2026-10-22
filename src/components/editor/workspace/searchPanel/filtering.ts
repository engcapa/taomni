import { syntaxTree } from "@codemirror/language";
import { SearchQuery } from "@codemirror/search";
import { EditorSelection, type EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";

export type SearchContextFilter = "anywhere" | "comments" | "strings" | "exclude-comments";

export interface SearchFilterOptions {
  inSelection?: boolean;
  selectionRange?: { from: number; to: number; } | null;
  contextFilter?: SearchContextFilter;
}

/**
 * Returns whether syntax-aware context filtering is available for the given EditorState.
 * Only languages with an actual Lezer syntax tree parser are supported; plain-text returns false.
 */
export function isSyntaxFilterAvailable(state: EditorState): boolean {
  try {
    const tree = syntaxTree(state);
    return tree.length > 0 && (tree.topNode.name !== "" || tree.topNode.firstChild != null);
  } catch {
    return false;
  }
}

export function matchContextFilter(
  state: EditorState,
  from: number,
  to: number,
  filter: SearchContextFilter,
): boolean {
  if (filter === "anywhere") return true;
  if (!isSyntaxFilterAvailable(state)) return false;

  const tree = syntaxTree(state);
  const mid = Math.floor((from + to) / 2);
  let node: ReturnType<typeof tree.resolveInner> | null = tree.resolveInner(mid, 1);

  let isComment = false;
  let isString = false;

  while (node) {
    const name = node.name.toLowerCase();
    if (name.includes("comment")) {
      isComment = true;
      break;
    }
    if (
      name.includes("string")
      || name.includes("character")
      || (name.includes("literal") && (name.includes("str") || name.includes("char")))
    ) {
      isString = true;
      break;
    }
    node = node.parent;
  }

  if (filter === "comments") return isComment;
  if (filter === "strings") return isString;
  if (filter === "exclude-comments") return !isComment;
  return true;
}

/**
 * Finds all matches of query satisfying inSelection and contextFilter criteria.
 */
export function getFilteredMatches(
  state: EditorState,
  query: SearchQuery,
  options?: SearchFilterOptions,
): Array<{ from: number; to: number; }> {
  if (!query.valid || !query.search) return [];
  const matches: Array<{ from: number; to: number; }> = [];
  const cursor = query.getCursor(state);

  const selRange = options?.inSelection && options.selectionRange ? options.selectionRange : null;
  const context = options?.contextFilter ?? "anywhere";

  for (let item = cursor.next(); !item.done; item = cursor.next()) {
    const { from, to } = item.value;
    if (selRange && (from < selRange.from || to > selRange.to)) {
      continue;
    }
    if (context !== "anywhere" && !matchContextFilter(state, from, to, context)) {
      continue;
    }
    matches.push({ from, to });
  }

  return matches;
}

/**
 * Selects all occurrences matching the search query and filters.
 */
export function selectAllOccurrences(
  view: EditorView,
  query: SearchQuery,
  options?: SearchFilterOptions,
): boolean {
  const matches = getFilteredMatches(view.state, query, options);
  if (matches.length === 0) return false;

  view.dispatch({
    selection: EditorSelection.create(
      matches.map((m) => EditorSelection.range(m.from, m.to)),
    ),
    scrollIntoView: true,
  });
  return true;
}
