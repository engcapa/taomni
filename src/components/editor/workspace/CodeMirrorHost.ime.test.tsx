import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  advanceLspSnippetTabstop,
  cancelLspSnippetSession,
  retreatLspSnippetTabstop,
  seedLspSnippetSessionForTest,
} from "./lspCompletion";
import { escapeEditorSelections } from "./workspaceEditorCommands";

function composingMultiCaretView(): EditorView {
  const view = new EditorView({
    state: EditorState.create({
      doc: "ab\ncd",
      selection: EditorSelection.create([
        EditorSelection.cursor(0),
        EditorSelection.cursor(3),
      ]),
      extensions: [EditorState.allowMultipleSelections.of(true)],
    }),
  });
  Object.defineProperty(view, "composing", { value: true, configurable: true });
  return view;
}

/**
 * ED-AUDIT-011: workspace Tab/Escape owners must not steal IME
 * Enter/Escape/Tab/candidate keys while composition is active.
 * Synthetic composing flag is guard regression only, not IME proof.
 */
describe("ED-AUDIT-011 IME composition isolates workspace Tab/Escape", () => {
  it("suppresses selection collapse (Escape) during composition", () => {
    const view = composingMultiCaretView();
    // Baseline returns true and collapses to one caret, stealing the IME
    // Escape that must cancel the candidate window instead.
    expect(escapeEditorSelections(view)).toBe(false);
    expect(view.state.selection.ranges.length).toBe(2);
    view.destroy();
  });

  it("suppresses snippet Tab/Escape owners while a session is live", () => {
    const view = new EditorView({
      state: EditorState.create({ doc: "call()" }),
    });
    seedLspSnippetSessionForTest(view, "call(${1:first}, ${2:second})");
    Object.defineProperty(view, "composing", { value: true, configurable: true });
    expect(advanceLspSnippetTabstop(view)).toBe(false);
    expect(retreatLspSnippetTabstop(view)).toBe(false);
    expect(cancelLspSnippetSession(view)).toBe(false);
    view.destroy();
  });
});
