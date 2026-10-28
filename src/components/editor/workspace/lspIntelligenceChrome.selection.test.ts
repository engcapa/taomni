import { EditorState, EditorSelection } from "@codemirror/state";
import { drawSelection, EditorView } from "@codemirror/view";
import { history, redo, selectAll, undo } from "@codemirror/commands";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  createLspOverlayChrome, fallbackWordHighlights, updateLspOverlayChrome,
} from "./lspIntelligenceChrome";
import { createLspHyperlinkExtension } from "./lspHyperlink";
import type { LspDocumentHighlight } from "../../../lib/editor/lsp";

// Exercise CM's Chromium/Windows DOM-selection branch in jsdom as a retained
// behavior check. This does not emulate WebView2's native event scheduling.
vi.hoisted(() => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/142.0.0.0 Safari/537.36");
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
});
afterAll(() => vi.restoreAllMocks());

function mark(from: number, to: number, kind: number | null = null): LspDocumentHighlight {
  return { range: { start: { line: 0, character: from }, end: { line: 0, character: to } }, kind };
}

const SINGLE_TOKEN = "QA_RELEASE_CANVAS_SAVED";
const moveCases = [
  { name: "forward whole-document range", doc: SINGLE_TOKEN, anchor: 0, head: 23, endpoint: "focusNode" as const, initial: [], next: [mark(0, 23)] },
  { name: "backward whole-document range", doc: SINGLE_TOKEN, anchor: 23, head: 0, endpoint: "focusNode" as const, initial: [], next: [mark(0, 23)] },
  { name: "partial range", doc: SINGLE_TOKEN, anchor: 3, head: 12, endpoint: "focusNode" as const, initial: [], next: [mark(0, 23)] },
  { name: "caret", doc: SINGLE_TOKEN, anchor: 7, head: 7, endpoint: "focusNode" as const, initial: [], next: [mark(0, 23)] },
  { name: "anchor-only move", doc: "left right", anchor: 0, head: 10, endpoint: "anchorNode" as const, initial: [mark(5, 10, 2)], next: [mark(0, 5, 3), mark(5, 10, 2)] },
  { name: "focus-only move", doc: "left right", anchor: 10, head: 0, endpoint: "focusNode" as const, initial: [mark(5, 10, 2)], next: [mark(0, 5, 3), mark(5, 10, 2)] },
];

describe("selection across asynchronous intelligence decorations", () => {
  it.each(moveCases)("preserves $name when Chromium briefly reports old endpoints", ({ doc, anchor, head, endpoint, initial, next }) => {
    const state = EditorState.create({
      doc, extensions: [createLspOverlayChrome(EditorState.create({ doc }).doc, initial, [])],
    });
    const view = new EditorView({ parent: document.body, state });
    const readSelection = document.getSelection.bind(document);
    let selectionRead: { mockRestore: () => void } | undefined;
    try {
      view.focus();
      view.dispatch({ selection: { anchor, head }, userEvent: "select" });
      const selected = readSelection()!;
      const text = selected[endpoint]!;
      const parent = text.parentNode;
      const cached = {
        anchorNode: selected.anchorNode, anchorOffset: selected.anchorOffset,
        focusNode: selected.focusNode, focusOffset: selected.focusOffset,
      };
      let staleReads = 0;
      // Native TC-WS-054: overlay marks move this same #text from the line
      // into a span, leaving a collapsed DOM selection but unchanged CM state.
      // Model Chromium's cached-endpoint read during that redraw. The browser
      // boundary alone is substituted; decoration diffing and DOM moves are real.
      selectionRead = vi.spyOn(document, "getSelection").mockImplementation(() => {
        if (text.parentNode !== parent && staleReads === 0) {
          staleReads++;
          return cached as Selection;
        }
        return readSelection();
      });
      view.dispatch({ effects: updateLspOverlayChrome(next, []) });
      expect(staleReads).toBe(1);
      expect(text.parentElement).toHaveClass("cm-lsp-usage");
      expect(view.state.selection).toEqual(EditorSelection.single(anchor, head));
      const actual = readSelection()!;
      expect(view.posAtDOM(actual.anchorNode!, actual.anchorOffset)).toBe(anchor);
      expect(view.posAtDOM(actual.focusNode!, actual.focusOffset)).toBe(head);
      expect(actual.toString()).toBe(doc.slice(Math.min(anchor, head), Math.max(anchor, head)));
    } finally { selectionRead?.mockRestore(); view.destroy(); view.dom.remove(); }
  });

  it("preserves a whole-document selection when usage marks appear and disappear", () => {
    const doc = "QA_RELEASE_CANVAS_SAVED";
    const state = EditorState.create({
      doc,
      extensions: [createLspOverlayChrome(EditorState.create({ doc }).doc, [], [])],
    });
    const view = new EditorView({ parent: document.body, state });
    try {
      view.focus();
      selectAll(view);
      const selected = () => expect(document.getSelection()?.toString()).toBe(doc);
      selected();
      for (const highlights of [fallbackWordHighlights(doc, { line: 0, character: 0 }), []]) {
        view.dispatch({ effects: updateLspOverlayChrome(highlights, []) });
        expect(view.state.selection).toEqual(EditorSelection.single(0, doc.length));
        selected();
      }
    } finally { view.destroy(); view.dom.remove(); }
  });

  it("keeps history and another editor's focused selection across decoration refreshes", () => {
    const doc = "left right";
    const first = new EditorView({ parent: document.body, state: EditorState.create({
      doc, extensions: [history(), createLspOverlayChrome(EditorState.create({ doc }).doc, [], [])],
    }) });
    const second = new EditorView({ parent: document.body, state: EditorState.create({ doc: "other editor" }) });
    try {
      first.focus();
      first.dispatch({ changes: { from: 0, to: doc.length, insert: SINGLE_TOKEN }, userEvent: "input" });
      selectAll(first);
      first.dispatch({ effects: updateLspOverlayChrome([mark(0, SINGLE_TOKEN.length)], []) });
      expect(undo(first)).toBe(true);
      expect(first.state.doc.toString()).toBe(doc);
      expect(redo(first)).toBe(true);
      expect(first.state.doc.toString()).toBe(SINGLE_TOKEN);
      selectAll(first);
      second.focus();
      second.dispatch({ selection: { anchor: 1, head: 5 } });
      for (const marks of [[], [mark(0, SINGLE_TOKEN.length)], []]) {
        first.dispatch({ effects: updateLspOverlayChrome(marks, []) });
        expect(document.activeElement).toBe(second.contentDOM);
        expect(document.getSelection()?.toString()).toBe("ther");
        expect(second.state.selection).toEqual(EditorSelection.single(1, 5));
        expect(first.state.selection).toEqual(EditorSelection.single(0, SINGLE_TOKEN.length));
      }
    } finally {
      first.destroy(); first.dom.remove(); second.destroy(); second.dom.remove();
    }
  });

  it.each([false, true])("keeps selection after modifier release with initial usage marks=%s", async (marked) => {
    const doc = "QA_RELEASE_CANVAS_SAVED";
    const highlights = fallbackWordHighlights(doc, { line: 0, character: 0 });
    const state = EditorState.create({
      doc, extensions: [
        drawSelection(),
        createLspOverlayChrome(EditorState.create({ doc }).doc, marked ? highlights : [], []),
        createLspHyperlinkExtension({ onDefinition: () => true }),
      ],
    });
    const view = new EditorView({ parent: document.body, state });
    const position = vi.spyOn(view, "posAtCoords").mockReturnValue(4);
    try {
      view.focus();
      view.contentDOM.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }));
      expect(view.dom.querySelector(".cm-lsp-hyperlink")).toHaveTextContent(doc);
      selectAll(view);
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }));
      await Promise.resolve();
      expect(view.dom.querySelector(".cm-lsp-hyperlink")).toBeNull();
      expect(document.getSelection()?.toString()).toBe(doc);
      view.dispatch({ effects: updateLspOverlayChrome(marked ? [] : highlights, []) });
      expect(document.getSelection()?.toString()).toBe(doc);
      expect(view.state.selection).toEqual(EditorSelection.single(0, doc.length));
    } finally { position.mockRestore(); view.destroy(); view.dom.remove(); }
  });
});
