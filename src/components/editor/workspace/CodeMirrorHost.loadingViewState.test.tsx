import { act, cleanup } from "@testing-library/react";
import { foldedRanges } from "@codemirror/language";
import { Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { afterEach, expect, it, vi } from "vitest";
import { CodeMirrorHost } from "./CodeMirrorHost";
import { documentTextIdentity } from "./host/viewState";
import { renderEditor } from "./tests/codeMirrorHost/harness";
import type { PersistedEditorViewState } from "./workspaceLayoutPersistence";
import { WorkspaceDocumentTransactionOwner } from "./workspaceDocumentTransactionOwner";

afterEach(cleanup);

const text = Text.of(Array.from({ length: 60 }, (_, index) => `line ${index + 1} contents`));

function snapshot(line: number): PersistedEditorViewState {
  const offset = text.line(line).from;
  return {
    mainSelection: { anchor: offset, head: offset },
    selections: [],
    scrollTop: 300,
    folds: [{ from: text.line(12).from, to: text.line(15).to }],
    textIdentity: documentTextIdentity(text),
  };
}

function viewIn(container: HTMLElement): EditorView {
  return EditorView.findFromDOM(container.querySelector<HTMLElement>(".cm-editor")!)!;
}

it("waits for a slow shared file before restoring each split's own snapshot", async () => {
  const owner = new WorkspaceDocumentTransactionOwner();
  const primaryState = vi.fn();
  const secondaryState = vi.fn();
  const primary = renderEditor("", vi.fn(), {
    fileKey: "long", path: "Long.java", viewId: "primary", transactionOwner: owner,
    documentReady: false, readOnly: true, initialViewState: snapshot(41), onViewStateChange: primaryState,
  });
  const secondary = renderEditor("", vi.fn(), {
    fileKey: "long", path: "Long.java", viewId: "secondary", transactionOwner: owner,
    documentReady: false, readOnly: true, initialViewState: snapshot(6), onViewStateChange: secondaryState,
  });
  const primaryView = viewIn(primary.container);
  const secondaryView = viewIn(secondary.container);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); });
  expect(primaryState).not.toHaveBeenCalled();
  expect(secondaryState).not.toHaveBeenCalled();
  primary.rerender(<CodeMirrorHost {...primary.props} doc={text.toString()} documentRevision={1} documentReady readOnly={false} />);
  secondary.rerender(<CodeMirrorHost {...secondary.props} doc={text.toString()} documentRevision={1} documentReady readOnly={false} />);
  expect(viewIn(primary.container)).toBe(primaryView);
  expect(viewIn(secondary.container)).toBe(secondaryView);
  expect(primaryView.state.selection.main.head).toBe(text.line(41).from);
  expect(secondaryView.state.selection.main.head).toBe(text.line(6).from);
  expect(foldedRanges(primaryView.state).size).toBe(1);
  expect(foldedRanges(secondaryView.state).size).toBe(1);
  expect(primary.onChange).not.toHaveBeenCalled();
  expect(secondary.onChange).not.toHaveBeenCalled();
  act(() => primaryView.dispatch({ selection: { anchor: text.line(20).from } }));
  primary.rerender(<CodeMirrorHost {...primary.props} doc={text.toString()} documentRevision={2} documentReady readOnly={false} initialViewState={snapshot(50)} />);
  expect(primaryView.state.selection.main.head).toBe(text.line(20).from);
});

it("does not persist or cache a loading placeholder when switching away or unloading", () => {
  const onState = vi.fn();
  const rendered = renderEditor("", vi.fn(), {
    fileKey: "long", path: "Long.java", documentReady: false, readOnly: true,
    initialViewState: snapshot(41), onViewStateChange: onState,
  });
  act(() => window.dispatchEvent(new Event("beforeunload")));
  expect(onState).not.toHaveBeenCalled();
  rendered.rerender(<CodeMirrorHost {...rendered.props} fileKey="other" path="other.txt" doc="other" documentReady onViewStateChange={undefined} />);
  expect(onState).not.toHaveBeenCalled();
  rendered.rerender(<CodeMirrorHost {...rendered.props} doc={text.toString()} documentReady readOnly={false} />);
  expect(viewIn(rendered.container).state.selection.main.head).toBe(text.line(41).from);
  rendered.unmount();
  expect(onState).toHaveBeenLastCalledWith(expect.objectContaining({ mainSelection: snapshot(41).mainSelection }));
});
