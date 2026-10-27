import { EditorState, EditorSelection } from "@codemirror/state";
import { drawSelection, EditorView } from "@codemirror/view";
import { selectAll } from "@codemirror/commands";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  createLspOverlayChrome, fallbackWordHighlights, updateLspOverlayChrome,
} from "./lspIntelligenceChrome";
import { createLspHyperlinkExtension } from "./lspHyperlink";

// Exercise CM's Chromium/Windows DOM-selection branch in jsdom as a retained
// behavior check. This does not emulate WebView2's native event scheduling.
vi.hoisted(() => {
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/142.0.0.0 Safari/537.36");
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
});
afterAll(() => vi.restoreAllMocks());

describe("selection across asynchronous intelligence decorations", () => {
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
