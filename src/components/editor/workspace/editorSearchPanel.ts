import { RegExpCursor, SearchQuery, closeSearchPanel, findNext, findPrevious, getSearchQuery, openSearchPanel, replaceAll, replaceNext, setSearchQuery } from "@codemirror/search";
import { EditorSelection, type EditorState } from "@codemirror/state";
import { syntaxTree } from "@codemirror/language";
import { EditorView, type Panel, type ViewUpdate } from "@codemirror/view";

function button(label: string, text: string, onClick: () => void): HTMLButtonElement {
  const element = document.createElement("button");
  element.type = "button";
  element.className = "cm-workspace-search-button";
  element.setAttribute("aria-label", label);
  element.title = label;
  element.textContent = text;
  element.addEventListener("click", onClick);
  return element;
}

function input(
  label: string,
  name: string,
  placeholder: string,
  type: "search" | "text" = "text",
): HTMLInputElement {
  const element = document.createElement("input");
  element.type = type;
  element.className = "cm-workspace-search-input";
  element.name = name;
  element.placeholder = placeholder;
  element.setAttribute("aria-label", label);
  element.autocomplete = "off";
  element.spellcheck = false;
  return element;
}

function fieldShell(field: HTMLElement): HTMLDivElement {
  const shell = document.createElement("div");
  shell.className = "cm-workspace-search-field";
  shell.append(field);
  return shell;
}

function matchStatus(view: EditorView, query: SearchQuery): string {
  // IDEA wording (ED-PARITY-012 A2): "0 results", "N results", "i/N".
  if (!query.search) return "0 results";
  if (!query.valid) return "Invalid pattern";
  const matches: Array<{ from: number; to: number }> = [];
  const cursor = query.getCursor(view.state);
  for (let item = cursor.next(); !item.done; item = cursor.next()) {
    matches.push(item.value);
  }
  if (matches.length === 0) return "0 results";
  const selection = view.state.selection.main;
  const current = matches.findIndex((match) => match.from === selection.from && match.to === selection.to);
  return current === -1 ? `${matches.length} results` : `${current + 1} / ${matches.length}`;
}

export type SearchContextFilter = "anywhere" | "comments" | "strings" | "exclude-comments";

export interface SearchFilterOptions {
  inSelection?: boolean;
  selectionRange?: { from: number; to: number } | null;
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
): Array<{ from: number; to: number }> {
  if (!query.valid || !query.search) return [];
  const matches: Array<{ from: number; to: number }> = [];
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

export type CasingStyle = "upper" | "lower" | "title" | "camel" | "pascal" | "other";

export function detectCasing(text: string): CasingStyle {
  if (!text) return "other";
  if (text === text.toUpperCase() && text !== text.toLowerCase()) return "upper";
  if (text === text.toLowerCase() && text !== text.toUpperCase()) return "lower";
  if (/^[A-Z][a-z0-9]*$/.test(text)) return "title";
  if (/^[A-Z][a-zA-Z0-9]*$/.test(text) && /[a-z]/.test(text) && /[A-Z]/.test(text.slice(1))) return "pascal";
  if (/^[a-z][a-zA-Z0-9]*$/.test(text) && /[A-Z]/.test(text)) return "camel";
  return "other";
}

export function applyPreserveCase(originalMatch: string, replacement: string): string {
  if (!originalMatch || !replacement) return replacement;
  const casing = detectCasing(originalMatch);
  switch (casing) {
    case "upper":
      return replacement.toUpperCase();
    case "lower":
      return replacement.toLowerCase();
    case "title":
      return replacement.charAt(0).toUpperCase() + replacement.slice(1).toLowerCase();
    case "pascal":
      return replacement.charAt(0).toUpperCase() + replacement.slice(1);
    case "camel":
      return replacement.charAt(0).toLowerCase() + replacement.slice(1);
    default:
      return replacement;
  }
}

function unquoteReplacement(text: string): string {
  return text.replace(/\\([nrt\\])/g, (_match, character: string) => {
    if (character === "n") return "\n";
    if (character === "r") return "\r";
    if (character === "t") return "\t";
    return "\\";
  });
}

function expandRegexpReplacement(replacement: string, match: RegExpExecArray): string {
  return unquoteReplacement(replacement).replace(/\$([$&]|\d+)/g, (token, reference: string) => {
    if (reference === "&") return match[0] ?? "";
    if (reference === "$") return "$";

    // Match CodeMirror's replacement rule: prefer the longest valid group
    // prefix so `$10` means group 10 when it exists, otherwise group 1 + `0`.
    for (let length = reference.length; length > 0; length -= 1) {
      const group = Number(reference.slice(0, length));
      if (group > 0 && group < match.length) {
        return `${match[group] ?? ""}${reference.slice(length)}`;
      }
    }
    return token;
  });
}

function replacementForMatch(
  view: EditorView,
  query: SearchQuery,
  from: number,
  to: number,
): string {
  if (!query.regexp) return unquoteReplacement(query.replace);

  // SearchQuery.getCursor intentionally exposes only ranges. Re-run the same
  // pattern through the public RegExpCursor to retain capture groups for the
  // exact range selected by the query, including multiline expressions.
  const cursor = new RegExpCursor(view.state.doc, query.search, {
    ignoreCase: !query.caseSensitive,
  });
  for (let item = cursor.next(); !item.done; item = cursor.next()) {
    if (item.value.from === from && item.value.to === to) {
      return expandRegexpReplacement(query.replace, item.value.match);
    }
  }

  // The range came from SearchQuery, so this is only a defensive fallback for
  // a future CodeMirror cursor mismatch. It preserves the literal token text.
  return unquoteReplacement(query.replace);
}

export function replaceNextPreserveCase(
  view: EditorView,
  query: SearchQuery,
  preserveCase: boolean,
): boolean {
  if (view.state.readOnly || !query.valid || !query.search) return false;
  if (!preserveCase) return replaceNext(view);

  const sel = view.state.selection.main;
  const cursor = query.getCursor(view.state);
  let targetMatch: { from: number; to: number } | null = null;
  let nextMatch: { from: number; to: number } | null = null;

  for (let item = cursor.next(); !item.done; item = cursor.next()) {
    if (item.value.from === sel.from && item.value.to === sel.to) {
      targetMatch = item.value;
      const next = cursor.next();
      if (!next.done) nextMatch = next.value;
      break;
    } else if (item.value.from >= sel.to && !targetMatch) {
      targetMatch = item.value;
      break;
    }
  }

  // If no match found at or after current selection, wrap around to first match
  if (!targetMatch) {
    const wrapCursor = query.getCursor(view.state);
    const first = wrapCursor.next();
    if (!first.done) targetMatch = first.value;
  }

  if (!targetMatch) return false;

  const matchedText = view.state.sliceDoc(targetMatch.from, targetMatch.to);
  const replacement = applyPreserveCase(
    matchedText,
    replacementForMatch(view, query, targetMatch.from, targetMatch.to),
  );

  view.dispatch({
    changes: { from: targetMatch.from, to: targetMatch.to, insert: replacement },
    selection: { anchor: targetMatch.from + replacement.length },
    scrollIntoView: true,
    userEvent: "input.replace",
  });

  // After replacing, advance selection to the next match if found
  if (!nextMatch) {
    const freshCursor = query.getCursor(view.state, targetMatch.from + replacement.length);
    const next = freshCursor.next();
    if (!next.done) {
      view.dispatch({
        selection: { anchor: next.value.from, head: next.value.to },
        scrollIntoView: true,
      });
    }
  } else {
    const offset = replacement.length - matchedText.length;
    view.dispatch({
      selection: { anchor: nextMatch.from + offset, head: nextMatch.to + offset },
      scrollIntoView: true,
    });
  }

  return true;
}

export function replaceAllPreserveCase(
  view: EditorView,
  query: SearchQuery,
  preserveCase: boolean,
  /** ED-PARITY-012 DEC-012-04: `from:to` keys of matches the user excluded. */
  excluded: ReadonlySet<string> = new Set(),
): boolean {
  if (view.state.readOnly || !query.valid || !query.search) return false;
  if (!preserveCase && excluded.size === 0) return replaceAll(view);

  const cursor = query.getCursor(view.state);
  const changes: Array<{ from: number; to: number; insert: string }> = [];

  for (let item = cursor.next(); !item.done; item = cursor.next()) {
    if (excluded.has(`${item.value.from}:${item.value.to}`)) continue;
    const matchedText = view.state.sliceDoc(item.value.from, item.value.to);
    const rawReplacement = replacementForMatch(view, query, item.value.from, item.value.to);
    const replacement = preserveCase ? applyPreserveCase(matchedText, rawReplacement) : rawReplacement;
    changes.push({ from: item.value.from, to: item.value.to, insert: replacement });
  }

  if (changes.length === 0) return false;

  view.dispatch({
    changes,
    userEvent: "input.replace.all",
  });

  return true;
}

// ED-PARITY-012 DEC-012-02/04: IDEA keeps the last Find/Replace strings in a
// per-user history. Session memory is authoritative; localStorage only carries
// it across reloads and may be unavailable (private window, blocked storage).
export type SearchHistoryKind = "find" | "replace";
export const SEARCH_HISTORY_LIMIT = 10;
const SEARCH_HISTORY_KEY = "taomni.editorSearchHistory.v1";
let searchHistory: Record<SearchHistoryKind, string[]> | null = null;

function loadSearchHistory(): Record<SearchHistoryKind, string[]> {
  if (searchHistory) return searchHistory;
  const empty: Record<SearchHistoryKind, string[]> = { find: [], replace: [] };
  try {
    const parsed = JSON.parse(globalThis.localStorage?.getItem(SEARCH_HISTORY_KEY) ?? "null") as unknown;
    if (parsed && typeof parsed === "object") {
      for (const kind of ["find", "replace"] as const) {
        const list = (parsed as Record<string, unknown>)[kind];
        if (Array.isArray(list)) {
          empty[kind] = list.filter((item): item is string => typeof item === "string" && item.length > 0)
            .slice(0, SEARCH_HISTORY_LIMIT);
        }
      }
    }
  } catch {
    // Unreadable storage: start from an empty session history.
  }
  searchHistory = empty;
  return searchHistory;
}

export function readSearchHistory(kind: SearchHistoryKind): readonly string[] {
  return loadSearchHistory()[kind];
}

export function recordSearchHistory(kind: SearchHistoryKind, value: string): void {
  if (!value) return;
  const history = loadSearchHistory();
  history[kind] = [value, ...history[kind].filter((item) => item !== value)].slice(0, SEARCH_HISTORY_LIMIT);
  try {
    globalThis.localStorage?.setItem(SEARCH_HISTORY_KEY, JSON.stringify(history));
  } catch {
    // Session history still works without storage.
  }
}

/** Test hook: forget the in-memory history so storage is read again. */
export function resetSearchHistoryForTests(): void {
  searchHistory = null;
}

type SearchField = HTMLInputElement | HTMLTextAreaElement;

const CONTEXT_FILTER_LABELS: Record<SearchContextFilter, string> = {
  anywhere: "Anywhere",
  comments: "In Comments",
  strings: "In Strings",
  "exclude-comments": "No Comments",
};

// The panel stays owned by CM. This registry only routes the existing Replace
// action to that view's panel; query/document state is never duplicated here.
const panels = new WeakMap<EditorView, WorkspaceSearchPanel>();

class WorkspaceSearchPanel implements Panel {
  readonly dom: HTMLElement;
  readonly top = true;

  private query: SearchQuery;
  private inSelection = false;
  private contextFilter: SearchContextFilter = "anywhere";
  private multiline = false;
  /** DEC-012-04: matches the user excluded from Replace All (mapped through edits). */
  private excluded: Array<{ from: number; to: number }> = [];
  private readonly searchField: HTMLInputElement;
  private readonly searchArea: HTMLTextAreaElement;
  private readonly replaceField: HTMLInputElement;
  private readonly clearButton: HTMLButtonElement;
  private readonly multilineButton: HTMLButtonElement;
  private readonly caseButton: HTMLButtonElement;
  private readonly wordButton: HTMLButtonElement;
  private readonly regexpButton: HTMLButtonElement;
  private readonly inSelectionButton: HTMLButtonElement;
  private readonly contextFilterButton: HTMLButtonElement;
  private readonly preserveCaseButton: HTMLButtonElement;
  private readonly selectAllButton: HTMLButtonElement;
  private readonly status: HTMLSpanElement;
  private readonly replaceRow: HTMLDivElement;
  private readonly expandButton: HTMLButtonElement;
  private readonly moreOptions: HTMLDivElement;
  private readonly moreButton: HTMLButtonElement;
  private readonly historyList: HTMLDivElement;
  private historyKind: SearchHistoryKind | null = null;
  private focusGeneration = 0;
  private destroyed = false;
  private composing = false;
  private cancelFocus: (() => void) | null = null;

  constructor(private readonly view: EditorView, private readonly focusOwner: () => number | null) {
    panels.set(view, this);
    this.query = getSearchQuery(view.state);
    // DEC-012-02: a custom clear × replaces the platform type=search control.
    this.searchField = input("Find", "search", "Find", "text");
    this.searchField.setAttribute("main-field", "true");
    this.searchField.setAttribute("role", "searchbox");
    // DEC-012-03: multiline Find swaps in a textarea (Enter = newline).
    this.searchArea = document.createElement("textarea");
    this.searchArea.className = "cm-workspace-search-input cm-workspace-search-textarea";
    this.searchArea.name = "search-multiline";
    this.searchArea.rows = 3;
    this.searchArea.placeholder = "Find";
    this.searchArea.spellcheck = false;
    this.searchArea.setAttribute("aria-label", "Find");
    this.searchArea.hidden = true;
    this.replaceField = input("Replace", "replace", "Replace", "text");
    this.clearButton = button("Clear search", "×", () => this.clearSearch());
    this.clearButton.classList.add("cm-workspace-search-clear");
    this.clearButton.hidden = true;
    this.multilineButton = button("Multiline", "↵", () => this.setMultiline(!this.multiline));
    this.multilineButton.setAttribute("aria-pressed", "false");
    this.caseButton = button("Match case", "Aa", () => this.toggle("caseSensitive"));
    this.wordButton = button("Match whole word", "W", () => this.toggle("wholeWord"));
    this.regexpButton = button("Use regular expression", ".*", () => this.toggle("regexp"));
    this.inSelectionButton = button("Find in selection", "In Sel", () => this.toggleInSelection());
    // DEC-012-02: the context filter is the IDEA funnel on the Find row.
    this.contextFilterButton = button("Filter context", "", () => this.cycleContextFilter());
    this.contextFilterButton.classList.add("cm-workspace-search-filter");
    this.renderContextFilter();
    this.preserveCaseButton = button("Preserve case", "AB/ab", () => this.togglePreserveCase());
    this.selectAllButton = button("Select all occurrences", "Select All", () => this.handleSelectAll());
    this.status = document.createElement("span");
    this.status.className = "cm-workspace-search-status";
    this.status.setAttribute("aria-live", "polite");

    this.expandButton = button("Show replace", "›", () => this.setReplaceOpen(this.replaceRow.hidden === true, "replace"));
    this.expandButton.setAttribute("aria-expanded", "false");
    this.moreOptions = document.createElement("div");
    this.moreOptions.className = "cm-workspace-search-options";
    this.moreOptions.hidden = true;
    this.moreOptions.append(this.inSelectionButton, this.selectAllButton);
    this.moreButton = button("More search options", "…", () => {
      this.moreOptions.hidden = !this.moreOptions.hidden;
      this.moreButton.setAttribute("aria-expanded", String(!this.moreOptions.hidden));
    });
    this.moreButton.setAttribute("aria-expanded", "false");
    this.historyList = document.createElement("div");
    this.historyList.className = "cm-workspace-search-history";
    this.historyList.setAttribute("role", "listbox");
    this.historyList.hidden = true;

    const findHistoryButton = button("Search history", "⌕", () => this.toggleHistory("find"));
    findHistoryButton.classList.add("cm-workspace-search-history-button");
    findHistoryButton.setAttribute("aria-haspopup", "listbox");
    const searchShell = document.createElement("div");
    searchShell.className = "cm-workspace-search-field";
    searchShell.append(
      findHistoryButton,
      this.searchField,
      this.searchArea,
      this.clearButton,
      this.multilineButton,
      this.caseButton,
      this.wordButton,
      this.regexpButton,
    );
    const findRow = document.createElement("div");
    findRow.className = "cm-workspace-search-row";
    findRow.append(
      this.expandButton,
      searchShell,
      this.status,
      button("Previous match", "↑", () => this.find(-1)),
      button("Next match", "↓", () => this.find(1)),
      this.contextFilterButton,
      this.moreButton,
      button("Close find and replace", "×", () => closeSearchPanel(this.view)),
    );

    const replaceHistoryButton = button("Replace history", "⌕", () => this.toggleHistory("replace"));
    replaceHistoryButton.classList.add("cm-workspace-search-history-button");
    replaceHistoryButton.setAttribute("aria-haspopup", "listbox");
    const replaceShell = fieldShell(this.replaceField);
    replaceShell.prepend(replaceHistoryButton);
    const replaceRow = document.createElement("div");
    this.replaceRow = replaceRow;
    replaceRow.hidden = true;
    replaceRow.className = "cm-workspace-search-row cm-workspace-replace-row";
    replaceRow.append(
      replaceShell,
      this.preserveCaseButton,
      button("Replace current match", "Replace", () => this.handleReplaceNext()),
      button("Replace all matches", "Replace All", () => this.handleReplaceAll()),
      button("Exclude current match", "Exclude", () => this.handleExclude()),
    );

    this.dom = document.createElement("div");
    this.dom.className = "cm-workspace-search";
    this.dom.setAttribute("data-testid", "code-workspace-editor-search");
    this.dom.append(findRow, replaceRow, this.historyList, this.moreOptions);
    this.dom.addEventListener("keydown", (event) => this.onKeyDown(event));
    this.searchField.addEventListener("input", () => this.commit());
    this.searchArea.addEventListener("input", () => this.commit());
    this.replaceField.addEventListener("input", () => this.commit());
    this.dom.addEventListener("compositionstart", () => { this.composing = true; });
    this.dom.addEventListener("compositionend", () => { this.composing = false; });
    this.syncQuery(this.query);
  }

  mount(): void {
    this.requestFocus(this.activeSearchField());
  }

  destroy(): void {
    this.destroyed = true;
    this.focusGeneration += 1;
    this.cancelFocus?.();
    recordSearchHistory("find", this.query.search);
    if (panels.get(this.view) === this) panels.delete(this.view);
  }

  /**
   * DEC-012-05: IDEA's Ctrl/Cmd+R shows the Replace row but keeps the caret
   * in the Find field; only the expand button moves focus to Replace.
   */
  setReplaceOpen(open: boolean, focus: "search" | "replace" = "search"): void {
    this.replaceRow.hidden = !open;
    this.expandButton.textContent = open ? "⌄" : "›";
    this.expandButton.setAttribute("aria-label", open ? "Hide replace" : "Show replace");
    this.expandButton.title = open ? "Hide replace" : "Show replace";
    this.expandButton.setAttribute("aria-expanded", String(open));
    this.requestFocus(open && focus === "replace" ? this.replaceField : this.activeSearchField());
  }

  private activeSearchField(): SearchField {
    return this.multiline ? this.searchArea : this.searchField;
  }

  private setMultiline(multiline: boolean, focus = true): void {
    if (this.multiline === multiline) return;
    const value = this.activeSearchField().value;
    this.multiline = multiline;
    this.searchField.hidden = multiline;
    this.searchArea.hidden = !multiline;
    // openSearchPanel focuses `[main-field]`, so it follows the visible field.
    this.searchField.toggleAttribute("main-field", !multiline);
    this.searchArea.toggleAttribute("main-field", multiline);
    this.multilineButton.setAttribute("aria-pressed", String(multiline));
    const next = this.activeSearchField();
    next.value = multiline ? value : value.replace(/\r?\n/g, " ");
    if (!focus) return;
    next.focus();
    this.commit();
  }

  private clearSearch(): void {
    const field = this.activeSearchField();
    field.value = "";
    this.commit();
    field.focus();
  }

  private toggleHistory(kind: SearchHistoryKind): void {
    if (this.historyKind === kind) {
      this.closeHistory();
      return;
    }
    const entries = readSearchHistory(kind);
    this.historyKind = kind;
    this.historyList.replaceChildren();
    this.historyList.setAttribute("aria-label", kind === "find" ? "Search history" : "Replace history");
    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "cm-workspace-search-history-empty";
      empty.textContent = "No recent searches";
      this.historyList.append(empty);
    }
    for (const entry of entries) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "cm-workspace-search-history-item";
      option.setAttribute("role", "option");
      option.textContent = entry;
      option.title = entry;
      option.addEventListener("click", () => this.applyHistory(kind, entry));
      this.historyList.append(option);
    }
    this.historyList.hidden = false;
    (this.historyList.querySelector<HTMLElement>("[role='option']") ?? null)?.focus();
  }

  private closeHistory(): void {
    const kind = this.historyKind;
    this.historyKind = null;
    this.historyList.hidden = true;
    this.historyList.replaceChildren();
    if (kind) (kind === "find" ? this.activeSearchField() : this.replaceField).focus();
  }

  private applyHistory(kind: SearchHistoryKind, value: string): void {
    if (kind === "find") {
      if (value.includes("\n")) this.setMultiline(true, false);
      this.activeSearchField().value = value;
    } else {
      this.replaceField.value = value;
    }
    this.commit();
    this.closeHistory();
  }

  private find(direction: 1 | -1): void {
    recordSearchHistory("find", this.query.search);
    (direction === 1 ? findNext : findPrevious)(this.view);
  }

  private requestFocus(field: SearchField): void {
    this.cancelFocus?.();
    const generation = ++this.focusGeneration;
    const owner = this.focusOwner();
    const origin = this.view.root.activeElement;
    // Remember intervening focus transfers, including A -> B -> A. Merely
    // testing isConnected or current focus would resurrect a stale request.
    const onFocus = (event: Event) => {
      if (event.target !== origin && !this.dom.contains(event.target as Node)) this.focusGeneration += 1;
    };
    const root = this.dom.ownerDocument;
    root.addEventListener("focusin", onFocus, true);
    const cancel = () => root.removeEventListener("focusin", onFocus, true);
    this.cancelFocus = cancel;
    queueMicrotask(() => {
      cancel();
      if (this.destroyed || generation !== this.focusGeneration || owner === null
        || this.focusOwner() !== owner || !this.dom.isConnected) return;
      field.focus();
      field.select();
      this.selectInitialMatch();
    });
  }

  private selectInitialMatch(): void {
    if (this.view.state.selection.ranges.length > 1) return;
    const matches = getFilteredMatches(this.view.state, this.query);
    const from = this.view.state.selection.main.from;
    const match = matches.find((candidate) => candidate.from >= from) ?? matches[0];
    if (!match) return;
    this.view.dispatch({ selection: { anchor: match.from, head: match.to }, scrollIntoView: true });
  }

  update(update: ViewUpdate): void {
    for (const transaction of update.transactions) {
      for (const effect of transaction.effects) {
        if (effect.is(setSearchQuery) && !effect.value.eq(this.query)) {
          this.syncQuery(effect.value);
        }
      }
    }
    if (update.docChanged && this.excluded.length > 0) {
      this.excluded = this.excluded
        .map(({ from, to }) => ({ from: update.changes.mapPos(from, 1), to: update.changes.mapPos(to, -1) }))
        .filter(({ from, to }) => to > from);
    }
    if (update.docChanged || update.selectionSet) this.updateStatus();
  }

  private commit(): void {
    const query = new SearchQuery({
      search: this.activeSearchField().value,
      replace: this.replaceField.value,
      caseSensitive: this.caseButton.getAttribute("aria-pressed") === "true",
      wholeWord: this.wordButton.getAttribute("aria-pressed") === "true",
      regexp: this.regexpButton.getAttribute("aria-pressed") === "true",
    });
    this.clearButton.hidden = query.search.length === 0;
    if (query.eq(this.query)) return;
    // DEC-012-04: exclusions belong to one query.
    if (query.search !== this.query.search || query.caseSensitive !== this.query.caseSensitive
      || query.wholeWord !== this.query.wholeWord || query.regexp !== this.query.regexp) {
      this.excluded = [];
    }
    this.query = query;
    this.view.dispatch({ effects: setSearchQuery.of(query) });
    this.selectInitialMatch();
    this.updateStatus();
  }

  private toggle(field: "caseSensitive" | "wholeWord" | "regexp"): void {
    const target = field === "caseSensitive"
      ? this.caseButton
      : field === "wholeWord"
        ? this.wordButton
        : this.regexpButton;
    target.setAttribute("aria-pressed", target.getAttribute("aria-pressed") !== "true" ? "true" : "false");
    this.commit();
    this.activeSearchField().focus();
  }

  private togglePreserveCase(): void {
    const current = this.preserveCaseButton.getAttribute("aria-pressed") === "true";
    this.preserveCaseButton.setAttribute("aria-pressed", current ? "false" : "true");
    this.replaceField.focus();
  }

  private toggleInSelection(): void {
    this.inSelection = !this.inSelection;
    this.inSelectionButton.setAttribute("aria-pressed", String(this.inSelection));
    this.updateStatus();
    this.activeSearchField().focus();
  }

  private renderContextFilter(): void {
    const label = CONTEXT_FILTER_LABELS[this.contextFilter];
    this.contextFilterButton.textContent = `▽ ${label}`;
    this.contextFilterButton.title = `Filter context: ${label}`;
    this.contextFilterButton.setAttribute("aria-pressed", this.contextFilter !== "anywhere" ? "true" : "false");
  }

  private cycleContextFilter(): void {
    if (!isSyntaxFilterAvailable(this.view.state)) {
      this.contextFilter = "anywhere";
      this.renderContextFilter();
      this.contextFilterButton.setAttribute("aria-disabled", "true");
      return;
    }
    const order: SearchContextFilter[] = ["anywhere", "comments", "strings", "exclude-comments"];
    this.contextFilter = order[(order.indexOf(this.contextFilter) + 1) % order.length];
    this.renderContextFilter();
    this.updateStatus();
    this.activeSearchField().focus();
  }

  private handleSelectAll(): void {
    recordSearchHistory("find", this.query.search);
    const sel = this.view.state.selection.main;
    const selectionRange = this.inSelection && !sel.empty ? { from: sel.from, to: sel.to } : null;
    selectAllOccurrences(this.view, this.query, {
      inSelection: this.inSelection,
      selectionRange,
      contextFilter: this.contextFilter,
    });
  }

  private isExcluded(range: { from: number; to: number }): boolean {
    return this.excluded.some((item) => item.from === range.from && item.to === range.to);
  }

  private handleExclude(): void {
    const selection = this.view.state.selection.main;
    const current = getFilteredMatches(this.view.state, this.query)
      .find((match) => match.from === selection.from && match.to === selection.to);
    if (current && !this.isExcluded(current)) this.excluded.push({ from: current.from, to: current.to });
    findNext(this.view);
    this.updateStatus();
  }

  private handleReplaceNext(): void {
    recordSearchHistory("find", this.query.search);
    recordSearchHistory("replace", this.query.replace);
    const selection = this.view.state.selection.main;
    if (this.isExcluded({ from: selection.from, to: selection.to })) {
      findNext(this.view);
      return;
    }
    const isPreserveCase = this.preserveCaseButton.getAttribute("aria-pressed") === "true";
    replaceNextPreserveCase(this.view, this.query, isPreserveCase);
    this.updateStatus();
  }

  private handleReplaceAll(): void {
    recordSearchHistory("find", this.query.search);
    recordSearchHistory("replace", this.query.replace);
    const isPreserveCase = this.preserveCaseButton.getAttribute("aria-pressed") === "true";
    const excluded = new Set(this.excluded.map(({ from, to }) => `${from}:${to}`));
    replaceAllPreserveCase(this.view, this.query, isPreserveCase, excluded);
    this.updateStatus();
  }

  private syncQuery(query: SearchQuery): void {
    this.query = query;
    if (query.search.includes("\n")) this.setMultiline(true, false);
    this.activeSearchField().value = query.search;
    this.replaceField.value = query.replace;
    this.clearButton.hidden = query.search.length === 0;
    this.caseButton.setAttribute("aria-pressed", String(query.caseSensitive));
    this.wordButton.setAttribute("aria-pressed", String(query.wholeWord));
    this.regexpButton.setAttribute("aria-pressed", String(query.regexp));
    this.updateStatus();
  }

  private updateStatus(): void {
    const excluded = this.excluded.length;
    this.status.textContent = matchStatus(this.view, this.query) + (excluded > 0 ? ` · ${excluded} excluded` : "");
    this.replaceRow.querySelectorAll<HTMLButtonElement>("button").forEach((control) => {
      control.disabled = this.view.state.readOnly;
      if (control.disabled) control.title = "Document is read-only";
    });
  }

  private onKeyDown(event: KeyboardEvent): void {
    if (event.isComposing || this.composing || event.keyCode === 229) return;
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === "r") {
      event.preventDefault();
      event.stopPropagation();
      this.setReplaceOpen(true);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      if (this.historyKind) {
        this.closeHistory();
        return;
      }
      if (!this.moreOptions.hidden) {
        this.moreOptions.hidden = true;
        this.moreButton.setAttribute("aria-expanded", "false");
        this.activeSearchField().focus();
        return;
      }
      closeSearchPanel(this.view);
      return;
    }
    const searchTarget = event.target === this.searchField || event.target === this.searchArea;
    // IDEA: Alt+Down opens the history of the focused field.
    if (event.altKey && event.key === "ArrowDown" && (searchTarget || event.target === this.replaceField)) {
      event.preventDefault();
      this.toggleHistory(searchTarget ? "find" : "replace");
      return;
    }
    // DEC-012-05: Tab moves Find -> Replace (and Shift+Tab back) like IDEA.
    if (event.key === "Tab" && !event.ctrlKey && !event.metaKey && !event.altKey && !this.replaceRow.hidden) {
      if (searchTarget && !event.shiftKey) {
        event.preventDefault();
        this.replaceField.focus();
        return;
      }
      if (event.target === this.replaceField && event.shiftKey) {
        event.preventDefault();
        this.activeSearchField().focus();
        return;
      }
    }
    if (event.key === "F3") {
      event.preventDefault();
      this.find(event.shiftKey ? -1 : 1);
      return;
    }
    if (event.key === "Enter" && event.target === this.searchField) {
      event.preventDefault();
      this.find(event.shiftKey ? -1 : 1);
      return;
    }
    // DEC-012-03: in multiline Find, Enter is a newline; Ctrl/Cmd+Enter searches.
    if (event.key === "Enter" && event.target === this.searchArea && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      this.find(event.shiftKey ? -1 : 1);
      return;
    }
    if (event.key === "Enter" && event.target === this.replaceField) {
      event.preventDefault();
      this.handleReplaceNext();
    }
  }
}

export function createWorkspaceSearchPanel(view: EditorView, focusOwner: () => number | null = () => 0): Panel {
  return new WorkspaceSearchPanel(view, focusOwner);
}

export function openWorkspaceReplacePanel(view: EditorView): boolean {
  openSearchPanel(view);
  panels.get(view)?.setReplaceOpen(true);
  return true;
}

export const WORKSPACE_SEARCH_STYLE = EditorView.theme({
  ".cm-panels-top": {
    borderBottom: "1px solid var(--taomni-code-border)",
  },
  ".cm-panel.cm-workspace-search": {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    padding: "6px 8px",
    background: "var(--taomni-code-gutter-bg)",
    color: "var(--taomni-code-text)",
    fontSize: "var(--taomni-ui-font-size, 12px)",
  },
  ".cm-workspace-search-row": {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    minWidth: "0",
  },
  ".cm-workspace-search-field": {
    position: "relative",
    display: "flex",
    alignItems: "center",
    flex: "1 1 320px",
    maxWidth: "520px",
    minWidth: "80px",
    border: "1px solid var(--taomni-code-border)",
    borderRadius: "4px",
    background: "var(--taomni-code-bg)",
    overflow: "hidden",
  },
  ".cm-workspace-search-field:focus-within": {
    borderColor: "var(--taomni-accent)",
    outline: "1px solid var(--taomni-accent)",
  },
  ".cm-workspace-search-input": {
    boxSizing: "border-box",
    width: "100%",
    minWidth: "0",
    height: "2.2em",
    border: "none",
    borderRadius: "4px",
    padding: "0 7px",
    outline: "none",
    background: "var(--taomni-code-bg)",
    color: "var(--taomni-code-text)",
    font: "inherit",
  },
  '.cm-workspace-search-input[type="search"]': {
    // Do not set appearance:none — it can suppress the platform clear control.
    WebkitAppearance: "textfield",
  },
  ".cm-workspace-search-input:focus": {
    borderColor: "var(--taomni-accent)",
  },
  ".cm-workspace-search-button": {
    boxSizing: "border-box",
    height: "2.2em",
    minWidth: "2em",
    flexShrink: "0",
    border: "1px solid transparent",
    borderRadius: "4px",
    padding: "0 6px",
    background: "transparent",
    color: "inherit",
    font: "inherit",
    cursor: "pointer",
  },
  ".cm-workspace-search-button:hover": {
    background: "var(--taomni-code-active-line-bg)",
  },
  '.cm-workspace-search-button[aria-pressed="true"]': {
    borderColor: "var(--taomni-code-border)",
    background: "var(--taomni-code-selection-match-bg)",
    color: "var(--taomni-accent)",
  },
  ".cm-workspace-search-status": {
    minWidth: "3.5em",
    marginLeft: "4px",
    color: "var(--taomni-code-muted)",
    whiteSpace: "nowrap",
  },
  ".cm-workspace-replace-row": {
    paddingLeft: "calc(2em + 4px)",
  },
  ".cm-workspace-search [hidden]": {
    display: "none",
  },
  ".cm-workspace-search-options": {
    display: "flex",
    flexWrap: "wrap",
    gap: "4px",
  },
  ".cm-workspace-search-button:focus-visible": {
    outline: "2px solid var(--taomni-accent)",
    outlineOffset: "-2px",
  },
  ".cm-workspace-search-button:disabled": {
    opacity: "0.5",
    cursor: "default",
  },
  ".cm-workspace-search-textarea": {
    height: "auto",
    minHeight: "4.4em",
    padding: "4px 7px",
    resize: "vertical",
  },
  ".cm-workspace-search-field .cm-workspace-search-button": {
    minWidth: "1.6em",
    padding: "0 4px",
  },
  ".cm-workspace-search-history-button": {
    color: "var(--taomni-code-muted)",
  },
  ".cm-workspace-search-filter": {
    whiteSpace: "nowrap",
  },
  ".cm-workspace-search-history": {
    display: "flex",
    flexDirection: "column",
    maxWidth: "520px",
    maxHeight: "12em",
    overflowY: "auto",
    border: "1px solid var(--taomni-code-border)",
    borderRadius: "4px",
    background: "var(--taomni-code-bg)",
  },
  ".cm-workspace-search-history-item": {
    border: "none",
    background: "transparent",
    color: "inherit",
    font: "inherit",
    textAlign: "left",
    padding: "2px 8px",
    whiteSpace: "pre",
    overflow: "hidden",
    textOverflow: "ellipsis",
    cursor: "pointer",
  },
  ".cm-workspace-search-history-item:hover, .cm-workspace-search-history-item:focus": {
    background: "var(--taomni-code-active-line-bg)",
    outline: "none",
  },
  ".cm-workspace-search-history-empty": {
    padding: "2px 8px",
    color: "var(--taomni-code-muted)",
  },
  ".cm-searchMatch": {
    backgroundColor: "var(--taomni-code-selection-match-bg)",
    outline: "1px solid color-mix(in srgb, var(--taomni-accent) 45%, transparent)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "color-mix(in srgb, var(--taomni-accent) 32%, transparent)",
  },
});
