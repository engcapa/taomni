import { EditorSelection, Transaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeMirrorHost } from "./CodeMirrorHost";
import { WorkspaceDocumentTransactionOwner } from "./workspaceDocumentTransactionOwner";
import { renderEditor } from "./tests/codeMirrorHost/harness";

// jsdom has no native contenteditable default action. Feed the real CM input
// handlers and their default transaction; hosted native checks cover DOM diffing.
function input(view: EditorView, text: string): void {
  const { from, to } = view.state.selection.main;
  const defaultInsert = () => view.state.update({
    changes: { from, to, insert: text },
    selection: EditorSelection.cursor(from + text.length),
    annotations: Transaction.userEvent.of("input.type"),
  });
  const handled = view.state.facet(EditorView.inputHandler)
    .some((handler) => handler(view, from, to, text, defaultInsert));
  if (!handled) view.dispatch(defaultInsert());
}

describe("source replacement preserves bracket input across controlled echoes", () => {
  afterEach(cleanup);

  it.each([false, true])("keeps one closing brace with delayed echo=%s", async (delayed) => {
    const owner = new WorkspaceDocumentTransactionOwner();
    const original = "public class Main { int value = 1; }\n";
    const expected = "public class Main { int value = 7; }";
    const onChange = vi.fn();
    const mounted = renderEditor(original, onChange, {
      path: "src/Main.java",
      fileKey: "Main.java",
      viewId: "primary",
      transactionOwner: owner,
      documentRevision: 0,
    });
    const view = EditorView.findFromDOM(mounted.container.querySelector(".cm-editor")!)!;
    await act(async () => {
      view.dispatch({ selection: EditorSelection.range(0, view.state.doc.length) });
    });
    let revision = 0;
    const echoes: Array<{ doc: string; revision: number }> = [];
    for (const character of expected) {
      await act(async () => input(view, character));
      const echo = { doc: view.state.doc.toString(), revision: ++revision };
      echoes.push(echo);
      const next = delayed ? echoes[echoes.length - 3] : echo;
      if (next) {
        mounted.rerender(<CodeMirrorHost {...mounted.props} doc={next.doc} documentRevision={next.revision} />);
      }
    }
    const final = echoes[echoes.length - 1]!;
    mounted.rerender(<CodeMirrorHost {...mounted.props} doc={final.doc} documentRevision={final.revision} />);
    expect(EditorView.findFromDOM(mounted.container.querySelector(".cm-editor")!)).toBe(view);
    expect(view.state.doc.toString()).toBe(expected);
    expect(view.state.selection.main.head).toBe(expected.length);
    expect(owner.getDocument("Main.java")).toBe(expected);
    expect(onChange).toHaveBeenLastCalledWith(expected, expect.anything(), expected.length);
  });
});
