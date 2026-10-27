import { EditorState, EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { selectAll } from "@codemirror/commands";
import { describe, expect, it } from "vitest";
import {
  createLspOverlayChrome, fallbackWordHighlights, updateLspOverlayChrome,
} from "./lspIntelligenceChrome";
import { createLspHyperlinkExtension } from "./lspHyperlink";

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

  it("keeps the selection across modifier release and the following fallback refresh", async () => {
    const doc = "QA_RELEASE_CANVAS_SAVED";
    const state = EditorState.create({
      doc, extensions: [
        createLspOverlayChrome(EditorState.create({ doc }).doc, [], []),
        createLspHyperlinkExtension({ onDefinition: () => true }),
      ],
    });
    const view = new EditorView({ parent: document.body, state });
    try {
      view.focus();
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Control", ctrlKey: true }));
      selectAll(view);
      window.dispatchEvent(new KeyboardEvent("keyup", { key: "Control" }));
      await Promise.resolve();
      view.dispatch({ effects: updateLspOverlayChrome(fallbackWordHighlights(doc, { line: 0, character: 0 }), []) });
      expect(document.getSelection()?.toString()).toBe(doc);
      expect(view.state.selection).toEqual(EditorSelection.single(0, doc.length));
    } finally { view.destroy(); view.dom.remove(); }
  });
});
