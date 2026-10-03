import { beforeEach, describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { history, undo, undoDepth } from "@codemirror/commands";
import { SearchQuery, closeSearchPanel, getSearchQuery, openSearchPanel, search } from "@codemirror/search";
import { javascript } from "@codemirror/lang-javascript";
import { java } from "@codemirror/lang-java";
import {
  applyPreserveCase,
  createWorkspaceSearchPanel,
  detectCasing,
  getFilteredMatches,
  isSyntaxFilterAvailable,
  matchContextFilter,
  openWorkspaceReplacePanel,
  readSearchHistory,
  recordSearchHistory,
  replaceAllPreserveCase,
  replaceNextPreserveCase,
  resetSearchHistoryForTests,
  selectAllOccurrences,
  SEARCH_HISTORY_LIMIT,
} from "./editorSearchPanel";

describe("§8.26 / ED-FIND-001: editorSearchPanel Preserve Case", () => {
  it("accurately detects casing styles across words and identifiers", () => {
    expect(detectCasing("FOO_BAR")).toBe("upper");
    expect(detectCasing("ALPHA")).toBe("upper");
    expect(detectCasing("foo_bar")).toBe("lower");
    expect(detectCasing("alpha")).toBe("lower");
    expect(detectCasing("Alpha")).toBe("title");
    expect(detectCasing("FooBar")).toBe("pascal");
    expect(detectCasing("fooBar")).toBe("camel");
    expect(detectCasing("123")).toBe("other");
    expect(detectCasing("")).toBe("other");
  });

  it("applies case preservation to replacement strings matching target patterns", () => {
    // UPPERCASE
    expect(applyPreserveCase("FOO", "bar")).toBe("BAR");
    expect(applyPreserveCase("HELLO_WORLD", "foo_bar")).toBe("FOO_BAR");

    // lowercase
    expect(applyPreserveCase("foo", "BAR")).toBe("bar");
    expect(applyPreserveCase("hello_world", "FOO_BAR")).toBe("foo_bar");

    // Title Case
    expect(applyPreserveCase("Foo", "bar")).toBe("Bar");
    expect(applyPreserveCase("Alpha", "omega")).toBe("Omega");

    // PascalCase
    expect(applyPreserveCase("FooBar", "alphaBeta")).toBe("AlphaBeta");

    // camelCase
    expect(applyPreserveCase("fooBar", "AlphaBeta")).toBe("alphaBeta");

    // Zero-length / empty
    expect(applyPreserveCase("", "fallback")).toBe("fallback");
  });

  it("replaces all matches in CodeMirror buffer with preserved casing", () => {
    const doc = "FOO foo Foo fooBar FooBar";
    const state = EditorState.create({
      doc,
      extensions: [search()],
    });
    const view = new EditorView({ state });

    const query = new SearchQuery({
      search: "foo",
      replace: "bar",
      caseSensitive: false,
      wholeWord: false,
    });

    const replaced = replaceAllPreserveCase(view, query, true);
    expect(replaced).toBe(true);
    expect(view.state.doc.toString()).toBe("BAR bar Bar barBar BarBar");
  });

  it("replaces next match sequentially while preserving case", () => {
    const doc = "FOO foo Foo";
    const state = EditorState.create({
      doc,
      extensions: [search()],
    });
    const view = new EditorView({ state });

    const query = new SearchQuery({
      search: "foo",
      replace: "bar",
      caseSensitive: false,
    });

    // First replace (FOO -> BAR)
    replaceNextPreserveCase(view, query, true);
    expect(view.state.doc.toString()).toBe("BAR foo Foo");

    // Second replace (foo -> bar)
    replaceNextPreserveCase(view, query, true);
    expect(view.state.doc.toString()).toBe("BAR bar Foo");

    // Third replace (Foo -> Bar)
    replaceNextPreserveCase(view, query, true);
    expect(view.state.doc.toString()).toBe("BAR bar Bar");
  });

  it("expands regex groups and composes preserve case with whole-word matching", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "FOOBAR fooBar foobarbaz",
        extensions: [search()],
      }),
    });
    const query = new SearchQuery({
      search: "(foo)(bar)",
      replace: "$2_$1",
      caseSensitive: false,
      wholeWord: true,
      regexp: true,
    });

    expect(replaceAllPreserveCase(view, query, true)).toBe(true);
    expect(view.state.doc.toString()).toBe("BAR_FOO bar_foo foobarbaz");
  });

  it("records replace-all as one undo transaction", () => {
    const original = "FOO foo Foo";
    const view = new EditorView({
      state: EditorState.create({
        doc: original,
        extensions: [search(), history()],
      }),
    });
    const query = new SearchQuery({
      search: "foo",
      replace: "bar",
      caseSensitive: false,
    });

    expect(replaceAllPreserveCase(view, query, true)).toBe(true);
    expect(view.state.doc.toString()).toBe("BAR bar Bar");
    expect(undoDepth(view.state)).toBe(1);
    expect(undo(view)).toBe(true);
    expect(view.state.doc.toString()).toBe(original);
  });
});

describe("ED-FIND-002: selection / comments / strings search filtering", () => {
  it("determines syntax filter availability accurately", () => {
    const plainState = EditorState.create({ doc: "hello world" });
    expect(isSyntaxFilterAvailable(plainState)).toBe(false);

    const jsState = EditorState.create({
      doc: "const x = 1; // comment",
      extensions: [javascript()],
    });
    expect(isSyntaxFilterAvailable(jsState)).toBe(true);

    const javaState = EditorState.create({
      doc: "class App { String s = \"val\"; }",
      extensions: [java()],
    });
    expect(isSyntaxFilterAvailable(javaState)).toBe(true);
  });

  it("filters search matches by comments, strings, and excluding comments", () => {
    const code = `
      // findMe in single-line comment
      /* findMe in multi-line block */
      const findMe = "findMe inside string literal";
    `;
    const state = EditorState.create({
      doc: code,
      extensions: [javascript()],
    });

    const query = new SearchQuery({
      search: "findMe",
      caseSensitive: true,
    });

    // Anywhere -> 4 matches
    const allMatches = getFilteredMatches(state, query, { contextFilter: "anywhere" });
    expect(allMatches.length).toBe(4);

    // Comments only -> 2 matches
    const commentMatches = getFilteredMatches(state, query, { contextFilter: "comments" });
    expect(commentMatches.length).toBe(2);

    // Strings only -> 1 match
    const stringMatches = getFilteredMatches(state, query, { contextFilter: "strings" });
    expect(stringMatches.length).toBe(1);

    // Exclude comments -> 2 matches (code identifier + string literal)
    const noCommentMatches = getFilteredMatches(state, query, { contextFilter: "exclude-comments" });
    expect(noCommentMatches.length).toBe(2);

    // Direct matchContextFilter checks
    expect(matchContextFilter(state, commentMatches[0].from, commentMatches[0].to, "comments")).toBe(true);
    expect(matchContextFilter(state, stringMatches[0].from, stringMatches[0].to, "strings")).toBe(true);
    expect(matchContextFilter(state, stringMatches[0].from, stringMatches[0].to, "comments")).toBe(false);
  });

  it("bounds search to selection range when inSelection is enabled", () => {
    const code = "foo 123 foo 456 foo 789 foo";
    const state = EditorState.create({
      doc: code,
      extensions: [javascript()],
    });

    const query = new SearchQuery({
      search: "foo",
      caseSensitive: true,
    });

    // In selection between char 5 and 20 ("foo 456 foo")
    const inSelMatches = getFilteredMatches(state, query, {
      inSelection: true,
      selectionRange: { from: 5, to: 20 },
    });
    expect(inSelMatches.length).toBe(2);
  });

  it("selects all matching occurrences with multiple selections", () => {
    const code = "foo bar foo baz foo";
    const state = EditorState.create({
      doc: code,
      extensions: [javascript(), EditorState.allowMultipleSelections.of(true)],
    });
    const view = new EditorView({ state });

    const query = new SearchQuery({
      search: "foo",
      caseSensitive: true,
    });

    const success = selectAllOccurrences(view, query, { contextFilter: "anywhere" });
    expect(success).toBe(true);
    expect(view.state.selection.ranges.length).toBe(3);
    expect(view.state.selection.ranges[0].from).toBe(0);
    expect(view.state.selection.ranges[0].to).toBe(3);
  });

  it("ED-FIND-002-A3: edits that stale the query recompute fresh matching ranges before replace", () => {
    const code = "const name = 'alice'; // alice in comment";
    const state = EditorState.create({
      doc: code,
      extensions: [javascript()],
    });
    const query = new SearchQuery({
      search: "alice",
      caseSensitive: true,
    });

    const initialCommentMatches = getFilteredMatches(state, query, { contextFilter: "comments" });
    expect(initialCommentMatches.length).toBe(1);
    expect(initialCommentMatches[0].from).toBe(25);

    // Edit doc by inserting text in front
    const tr = state.update({
      changes: { from: 0, insert: "/* preamble prefix */ " },
    });
    const updatedState = tr.state;

    // Fresh recomputation on updated state yields new ranges shifted by prefix length
    const updatedCommentMatches = getFilteredMatches(updatedState, query, { contextFilter: "comments" });
    expect(updatedCommentMatches.length).toBe(1);
    expect(updatedCommentMatches[0].from).toBe(25 + 22);
    expect(updatedState.sliceDoc(updatedCommentMatches[0].from, updatedCommentMatches[0].to)).toBe("alice");
  });
});

describe("ED-PARITY-012: IDEA Find/Replace row", () => {
  beforeEach(() => {
    localStorage.clear();
    resetSearchHistoryForTests();
  });

  function mountPanel(doc: string) {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc,
        extensions: [history(), search({ createPanel: (v) => createWorkspaceSearchPanel(v) })],
      }),
    });
    openSearchPanel(view);
    const panel = view.dom.querySelector<HTMLElement>("[data-testid='code-workspace-editor-search']")!;
    const find = panel.querySelector<HTMLInputElement>("input[name='search']")!;
    const type = (field: HTMLInputElement | HTMLTextAreaElement, value: string) => {
      field.value = value;
      field.dispatchEvent(new Event("input", { bubbles: true }));
    };
    const buttonNamed = (name: string) => panel.querySelector<HTMLButtonElement>(`button[aria-label='${name}']`)!;
    return { view, panel, find, type, buttonNamed, cleanup: () => { view.destroy(); parent.remove(); } };
  }

  it("keeps a bounded, deduplicated, persisted history", () => {
    for (let i = 0; i < SEARCH_HISTORY_LIMIT + 3; i += 1) recordSearchHistory("find", `q${i}`);
    recordSearchHistory("find", "q5");
    const history = readSearchHistory("find");
    expect(history).toHaveLength(SEARCH_HISTORY_LIMIT);
    expect(history[0]).toBe("q5");
    expect(history.filter((item) => item === "q5")).toHaveLength(1);
    resetSearchHistoryForTests();
    expect(readSearchHistory("find")[0]).toBe("q5");
  });

  it("shows the clear button only for a non-empty query and clears it", () => {
    const { find, type, buttonNamed, view, cleanup } = mountPanel("alpha beta alpha");
    const clear = buttonNamed("Clear search");
    expect(clear.hidden).toBe(true);
    type(find, "alpha");
    expect(clear.hidden).toBe(false);
    expect(getSearchQuery(view.state).search).toBe("alpha");
    clear.click();
    expect(find.value).toBe("");
    expect(clear.hidden).toBe(true);
    expect(getSearchQuery(view.state).search).toBe("");
    cleanup();
  });

  it("records the query on close and offers it from the history dropdown", () => {
    const first = mountPanel("alpha beta");
    first.type(first.find, "alpha");
    closeSearchPanel(first.view);
    first.cleanup();

    const second = mountPanel("alpha beta");
    second.buttonNamed("Search history").click();
    const option = second.panel.querySelector<HTMLButtonElement>("[role='listbox'] [role='option']");
    expect(option?.textContent).toBe("alpha");
    option!.click();
    expect(second.find.value).toBe("alpha");
    expect(getSearchQuery(second.view.state).search).toBe("alpha");
    expect(second.panel.querySelector("[role='listbox']")?.hasAttribute("hidden")).toBe(true);
    second.cleanup();
  });

  it("switches to a multiline textarea and back", () => {
    const { panel, find, type, buttonNamed, view, cleanup } = mountPanel("one\ntwo\none");
    type(find, "one");
    const toggle = buttonNamed("Multiline");
    toggle.click();
    const area = panel.querySelector<HTMLTextAreaElement>("textarea[name='search-multiline']")!;
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(area.hidden).toBe(false);
    expect(find.hidden).toBe(true);
    expect(area.value).toBe("one");
    type(area, "one\ntwo");
    expect(getSearchQuery(view.state).search).toBe("one\ntwo");
    toggle.click();
    expect(find.hidden).toBe(false);
    expect(find.value).toBe("one two");
    cleanup();
  });

  it("Exclude skips a match in Replace All, and one undo restores the rest", () => {
    const { panel, find, type, buttonNamed, view, cleanup } = mountPanel("foo foo foo");
    openWorkspaceReplacePanel(view);
    type(find, "foo");
    type(panel.querySelector<HTMLInputElement>("input[name='replace']")!, "bar");
    // The first match is selected when the query is committed.
    expect(view.state.selection.main.from).toBe(0);
    buttonNamed("Exclude current match").click();
    expect(panel.querySelector(".cm-workspace-search-status")?.textContent).toContain("1 excluded");
    buttonNamed("Replace all matches").click();
    expect(view.state.doc.toString()).toBe("foo bar bar");
    undo(view);
    expect(view.state.doc.toString()).toBe("foo foo foo");
    // A new query forgets the exclusions.
    type(find, "fo");
    expect(panel.querySelector(".cm-workspace-search-status")?.textContent).not.toContain("excluded");
    cleanup();
  });

  it("Ctrl+R opens Replace while focus stays in Find", async () => {
    const { panel, find, view, cleanup } = mountPanel("alpha");
    find.focus();
    find.dispatchEvent(new KeyboardEvent("keydown", { key: "r", ctrlKey: true, bubbles: true }));
    await Promise.resolve();
    expect(panel.querySelector<HTMLElement>(".cm-workspace-replace-row")?.hidden).toBe(false);
    expect(document.activeElement).toBe(find);
    expect(view.state.doc.toString()).toBe("alpha");
    cleanup();
  });
});
