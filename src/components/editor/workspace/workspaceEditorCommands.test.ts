import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { javascript } from "@codemirror/lang-javascript";
import { describe, expect, it } from "vitest";
import {
  expandSyntaxSelection,
  expandSelectionFromLspRanges,
  selectionHistoryField,
  shrinkSyntaxSelection,
  workspaceEditorKeymap,
} from "./workspaceEditorCommands";

describe("workspace editor commands", () => {
  it("expands and shrinks syntax selections through selection history", () => {
    const doc = "const answer = value + 1;";
    const cursor = doc.indexOf("value") + 2;
    const view = new EditorView({
      state: EditorState.create({
        doc,
        selection: { anchor: cursor },
        extensions: [javascript(), selectionHistoryField],
      }),
    });

    expect(expandSyntaxSelection(view)).toBe(true);
    const identifier = view.state.selection;
    expect(view.state.sliceDoc(identifier.main.from, identifier.main.to)).toBe("value");

    expect(expandSyntaxSelection(view)).toBe(true);
    expect(view.state.selection.eq(identifier)).toBe(false);

    expect(shrinkSyntaxSelection(view)).toBe(true);
    expect(view.state.selection.eq(identifier)).toBe(true);
    view.destroy();
  });

  it("registers the designed comment and selection shortcuts", () => {
    expect(workspaceEditorKeymap.map((binding) => binding.key)).toEqual([
      "Mod-/",
      "Mod-Shift-/",
      "Mod-d",
      "Mod-y",
      "Shift-Alt-ArrowUp",
      "Shift-Alt-ArrowDown",
      "Mod-w",
      "Mod-Shift-w",
      "Mod-g",
    ]);
  });

  it("expands through semantic LSP ranges before shrinking from shared history", () => {
    const view = new EditorView({
      state: EditorState.create({
        doc: "const value = 1;",
        selection: { anchor: 8 },
        extensions: [selectionHistoryField],
      }),
    });
    expect(expandSelectionFromLspRanges(view, [
      { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
      { start: { line: 0, character: 0 }, end: { line: 0, character: 16 } },
    ])).toBe(true);
    expect(view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to)).toBe("value");
    expect(shrinkSyntaxSelection(view)).toBe(true);
    expect(view.state.selection.main.empty).toBe(true);
    view.destroy();
  });
});
