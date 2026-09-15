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

function fieldShell(field: HTMLInputElement): HTMLDivElement {
  const shell = document.createElement("div");
  shell.className = "cm-workspace-search-field";
  shell.append(field);
  return shell;
}

function matchStatus(view: EditorView, query: SearchQuery): string {
  if (!query.search) return "0 matches";
  if (!query.valid) return "Invalid pattern";
  const matches: Array<{ from: number; to: number }> = [];
  const cursor = query.getCursor(view.state);
  for (let item = cursor.next(); !item.done; item = cursor.next()) {
    matches.push(item.value);
  }
  if (matches.length === 0) return "0 matches";
  const selection = view.state.selection.main;
  const current = matches.findIndex((match) => match.from === selection.from && match.to === selection.to);
  return current === -1 ? `${matches.length} matches` : `${current + 1} / ${matches.length}`;
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
): boolean {
  if (view.state.readOnly || !query.valid || !query.search) return false;
  if (!preserveCase) return replaceAll(view);

  const cursor = query.getCursor(view.state);
  const changes: Array<{ from: number; to: number; insert: string }> = [];

  for (let item = cursor.next(); !item.done; item = cursor.next()) {
    const matchedText = view.state.sliceDoc(item.value.from, item.value.to);
    const replacement = applyPreserveCase(
      matchedText,
      replacementForMatch(view, query, item.value.from, item.value.to),
    );
    changes.push({ from: item.value.from, to: item.value.to, insert: replacement });
  }

  if (changes.length === 0) return false;

  view.dispatch({
    changes,
    userEvent: "input.replace.all",
  });

  return true;
}

// The panel stays owned by CM. This registry only routes the existing Replace
// action to that view's panel; query/document state is never duplicated here.
const panels = new WeakMap<EditorView, WorkspaceSearchPanel>();

class WorkspaceSearchPanel implements Panel {
  readonly dom: HTMLElement;
  readonly top = true;

  private query: SearchQuery;
  private inSelection = false;
  private contextFilter: SearchContextFilter = "anywhere";
  private readonly searchField: HTMLInputElement;
  private readonly replaceField: HTMLInputElement;
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
  private focusGeneration = 0;
  private destroyed = false;
  private composing = false;
  private cancelFocus: (() => void) | null = null;

  constructor(private readonly view: EditorView, private readonly focusOwner: () => number | null) {
    panels.set(view, this);
    this.query = getSearchQuery(view.state);
    // type=search lets the platform show a native clear; do not add a custom ×.
    this.searchField = input("Find", "search", "Find", "search");
    this.searchField.setAttribute("main-field", "true");
    this.replaceField = input("Replace", "replace", "Replace", "text");
    this.caseButton = button("Match case", "Aa", () => this.toggle("caseSensitive"));
    this.wordButton = button("Match whole word", "W", () => this.toggle("wholeWord"));
    this.regexpButton = button("Use regular expression", ".*", () => this.toggle("regexp"));
    this.inSelectionButton = button("Find in selection", "In Sel", () => this.toggleInSelection());
    this.contextFilterButton = button("Filter context", "Anywhere", () => this.cycleContextFilter());
    this.preserveCaseButton = button("Preserve case", "AB/ab", () => this.togglePreserveCase());
    this.selectAllButton = button("Select all occurrences", "Select All", () => this.handleSelectAll());
    this.status = document.createElement("span");
    this.status.className = "cm-workspace-search-status";
    this.status.setAttribute("aria-live", "polite");

    this.expandButton = button("Show replace", "›", () => this.setReplaceOpen(this.replaceRow.hidden === true));
    this.expandButton.setAttribute("aria-expanded", "false");
    this.moreOptions = document.createElement("div");
    this.moreOptions.className = "cm-workspace-search-options";
    this.moreOptions.hidden = true;
    this.moreOptions.append(this.inSelectionButton, this.contextFilterButton, this.selectAllButton);
    this.moreButton = button("More search options", "…", () => {
      this.moreOptions.hidden = !this.moreOptions.hidden;
      this.moreButton.setAttribute("aria-expanded", String(!this.moreOptions.hidden));
    });
    this.moreButton.setAttribute("aria-expanded", "false");
    const searchShell = fieldShell(this.searchField);
    searchShell.append(this.caseButton, this.wordButton, this.regexpButton);
    const findRow = document.createElement("div");
    findRow.className = "cm-workspace-search-row";
    findRow.append(
      this.expandButton,
      searchShell,
      this.status,
      button("Previous match", "↑", () => findPrevious(this.view)),
      button("Next match", "↓", () => findNext(this.view)),
      this.moreButton,
      button("Close find and replace", "×", () => closeSearchPanel(this.view)),
    );

    const replaceRow = document.createElement("div");
    this.replaceRow = replaceRow;
    replaceRow.hidden = true;
    replaceRow.className = "cm-workspace-search-row cm-workspace-replace-row";
    replaceRow.append(
      fieldShell(this.replaceField),
      this.preserveCaseButton,
      button("Replace current match", "Replace", () => this.handleReplaceNext()),
      button("Replace all matches", "Replace All", () => this.handleReplaceAll()),
    );

    this.dom = document.createElement("div");
    this.dom.className = "cm-workspace-search";
    this.dom.setAttribute("data-testid", "code-workspace-editor-search");
    this.dom.append(findRow, replaceRow, this.moreOptions);
    this.dom.addEventListener("keydown", (event) => this.onKeyDown(event));
    this.searchField.addEventListener("input", () => this.commit());
    this.replaceField.addEventListener("input", () => this.commit());
    this.dom.addEventListener("compositionstart", () => { this.composing = true; });
    this.dom.addEventListener("compositionend", () => { this.composing = false; });
    this.syncQuery(this.query);
  }

  mount(): void {
    this.requestFocus(this.searchField);
  }

  destroy(): void {
    this.destroyed = true;
    this.focusGeneration += 1;
    this.cancelFocus?.();
    if (panels.get(this.view) === this) panels.delete(this.view);
  }

  setReplaceOpen(open: boolean): void {
    this.replaceRow.hidden = !open;
    this.expandButton.textContent = open ? "⌄" : "›";
    this.expandButton.setAttribute("aria-label", open ? "Hide replace" : "Show replace");
    this.expandButton.title = open ? "Hide replace" : "Show replace";
    this.expandButton.setAttribute("aria-expanded", String(open));
    this.requestFocus(open ? this.replaceField : this.searchField);
  }

  private requestFocus(field: HTMLInputElement): void {
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
    if (update.docChanged || update.selectionSet) this.updateStatus();
  }

  private commit(): void {
    const query = new SearchQuery({
      search: this.searchField.value,
      replace: this.replaceField.value,
      caseSensitive: this.caseButton.getAttribute("aria-pressed") === "true",
      wholeWord: this.wordButton.getAttribute("aria-pressed") === "true",
      regexp: this.regexpButton.getAttribute("aria-pressed") === "true",
    });
    if (query.eq(this.query)) return;
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
    this.searchField.focus();
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
    this.searchField.focus();
  }

  private cycleContextFilter(): void {
    if (!isSyntaxFilterAvailable(this.view.state)) {
      this.contextFilter = "anywhere";
      this.contextFilterButton.textContent = "Anywhere";
      this.contextFilterButton.setAttribute("aria-disabled", "true");
      return;
    }
    const order: SearchContextFilter[] = ["anywhere", "comments", "strings", "exclude-comments"];
    const currentIdx = order.indexOf(this.contextFilter);
    const next = order[(currentIdx + 1) % order.length];
    this.contextFilter = next;
    const labels: Record<SearchContextFilter, string> = {
      anywhere: "Anywhere",
      comments: "In Comments",
      strings: "In Strings",
      "exclude-comments": "No Comments",
    };
    this.contextFilterButton.textContent = labels[next];
    this.contextFilterButton.setAttribute("aria-pressed", next !== "anywhere" ? "true" : "false");
    this.updateStatus();
    this.searchField.focus();
  }

  private handleSelectAll(): void {
    const sel = this.view.state.selection.main;
    const selectionRange = this.inSelection && !sel.empty ? { from: sel.from, to: sel.to } : null;
    selectAllOccurrences(this.view, this.query, {
      inSelection: this.inSelection,
      selectionRange,
      contextFilter: this.contextFilter,
    });
  }

  private handleReplaceNext(): void {
    const isPreserveCase = this.preserveCaseButton.getAttribute("aria-pressed") === "true";
    replaceNextPreserveCase(this.view, this.query, isPreserveCase);
    this.updateStatus();
  }

  private handleReplaceAll(): void {
    const isPreserveCase = this.preserveCaseButton.getAttribute("aria-pressed") === "true";
    replaceAllPreserveCase(this.view, this.query, isPreserveCase);
    this.updateStatus();
  }

  private syncQuery(query: SearchQuery): void {
    this.query = query;
    this.searchField.value = query.search;
    this.replaceField.value = query.replace;
    this.caseButton.setAttribute("aria-pressed", String(query.caseSensitive));
    this.wordButton.setAttribute("aria-pressed", String(query.wholeWord));
    this.regexpButton.setAttribute("aria-pressed", String(query.regexp));
    this.updateStatus();
  }

  private updateStatus(): void {
    this.status.textContent = matchStatus(this.view, this.query);
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
      if (!this.moreOptions.hidden) {
        this.moreOptions.hidden = true;
        this.moreButton.setAttribute("aria-expanded", "false");
        this.searchField.focus();
        return;
      }
      closeSearchPanel(this.view);
      return;
    }
    if (event.key === "F3" || (event.key === "Enter" && event.target === this.searchField)) {
      event.preventDefault();
      (event.shiftKey ? findPrevious : findNext)(this.view);
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
  ".cm-searchMatch": {
    backgroundColor: "var(--taomni-code-selection-match-bg)",
    outline: "1px solid color-mix(in srgb, var(--taomni-accent) 45%, transparent)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "color-mix(in srgb, var(--taomni-accent) 32%, transparent)",
  },
});
