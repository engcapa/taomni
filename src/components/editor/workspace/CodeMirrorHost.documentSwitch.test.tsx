import { act, cleanup } from "@testing-library/react";
import { foldEffect, foldedRanges } from "@codemirror/language";
import { undo } from "@codemirror/commands";
import { EditorView } from "@codemirror/view";
import { afterEach, expect, it, vi } from "vitest";
import { CodeMirrorHost } from "./CodeMirrorHost";
import { renderEditor } from "./tests/codeMirrorHost/harness";
import { WorkspaceDocumentTransactionOwner } from "./workspaceDocumentTransactionOwner";

afterEach(cleanup);

it("keeps the editor DOM, per-file selection, folds and standalone undo across consecutive switches", () => {
  const first = "first line\nfolded line\nlast line";
  const onChange = vi.fn();
  const onFirstState = vi.fn();
  const onSecondState = vi.fn();
  const rendered = renderEditor(first, onChange, { fileKey: "a", path: "a.txt", onViewStateChange: onFirstState });
  const dom = rendered.container.querySelector<HTMLElement>(".cm-editor")!;
  const view = EditorView.findFromDOM(dom)!;
  act(() => view.dispatch({ changes: { from: 0, insert: "A " }, selection: { anchor: 3, head: 7 }, effects: foldEffect.of({ from: 12, to: 22 }) }));
  const edited = view.state.doc.toString();
  const selection = view.state.selection;
  onChange.mockClear();
  rendered.rerender(<CodeMirrorHost {...rendered.props} fileKey="b" path="b.txt" doc="second" onViewStateChange={onSecondState} />);
  expect(rendered.container.querySelector(".cm-editor")).toBe(dom);
  expect(EditorView.findFromDOM(dom)).toBe(view);
  expect(view.state.doc.toString()).toBe("second");
  expect(view.state.selection.main.head).toBe(0);
  expect(onFirstState).toHaveBeenCalled();
  expect(onSecondState).not.toHaveBeenCalled();
  act(() => view.dispatch({ changes: { from: 0, insert: "B " }, selection: { anchor: 1 } }));
  rendered.rerender(<CodeMirrorHost {...rendered.props} doc={edited} />);
  expect(view.state.doc.toString()).toBe(edited);
  expect(view.state.selection.eq(selection)).toBe(true);
  expect(foldedRanges(view.state).size).toBe(1);
  expect(onSecondState).toHaveBeenCalled();
  act(() => { expect(undo(view)).toBe(true); });
  expect(view.state.doc.toString()).toBe(first);
});

it("acquires the current shared document, isolates transactions and releases every lease on unmount", () => {
  const owner = new WorkspaceDocumentTransactionOwner();
  owner.retainDocument("a");
  owner.retainDocument("b");
  const rendered = renderEditor("alpha", vi.fn(), { fileKey: "a", path: "a.txt", viewId: "pane", transactionOwner: owner });
  const view = EditorView.findFromDOM(rendered.container.querySelector<HTMLElement>(".cm-editor")!)!;
  act(() => view.dispatch({ changes: { from: 5, insert: "!" } }));
  rendered.rerender(<CodeMirrorHost {...rendered.props} fileKey="b" path="b.txt" doc="bravo" />);
  act(() => view.dispatch({ changes: { from: 5, insert: "?" } }));
  expect(owner.getDocument("a")).toBe("alpha!");
  expect(owner.getDocument("b")).toBe("bravo?");
  act(() => { owner.replaceDocument("a", "other-pane", "external alpha", "external-disk"); });
  rendered.rerender(<CodeMirrorHost {...rendered.props} doc="external alpha" documentRevision={2} />);
  expect(view.state.doc.toString()).toBe("external alpha");
  rendered.unmount();
  owner.releaseDocument("a");
  owner.releaseDocument("b");
  expect(owner.getDocument("a")).toBeNull();
  expect(owner.getDocument("b")).toBeNull();
});

it("does not restore a closed file's cached selection or undo history on reopen", () => {
  const rendered = renderEditor("first", vi.fn(), { fileKey: "a", path: "a.txt", retainedFileKeys: ["a", "b"] });
  const view = EditorView.findFromDOM(rendered.container.querySelector<HTMLElement>(".cm-editor")!)!;
  act(() => view.dispatch({ changes: { from: 0, insert: "old " }, selection: { anchor: 3 } }));
  rendered.rerender(<CodeMirrorHost {...rendered.props} fileKey="b" path="b.txt" doc="second" retainedFileKeys={["b"]} />);
  rendered.rerender(<CodeMirrorHost {...rendered.props} doc="reopened" />);
  expect(view.state.doc.toString()).toBe("reopened");
  expect(view.state.selection.main.head).toBe(0);
  expect(undo(view)).toBe(false);
});

it("applies current read-only and wrapping settings when returning to a cached document", () => {
  const rendered = renderEditor("first", vi.fn(), { fileKey: "a", path: "a.txt", softWrap: false });
  const view = EditorView.findFromDOM(rendered.container.querySelector<HTMLElement>(".cm-editor")!)!;
  rendered.rerender(<CodeMirrorHost {...rendered.props} fileKey="b" path="b.txt" doc="second" readOnly softWrap />);
  rendered.rerender(<CodeMirrorHost {...rendered.props} readOnly softWrap />);
  expect(view.state.doc.toString()).toBe("first");
  expect(view.state.readOnly).toBe(true);
  expect(view.contentDOM).toHaveClass("cm-lineWrapping");
  expect(view.contentDOM).toHaveAttribute("aria-readonly", "true");
  act(() => view.dispatch({ changes: { from: 0, insert: "blocked " }, userEvent: "input.type" }));
  expect(view.state.doc.toString()).toBe("first");
  rendered.rerender(<CodeMirrorHost {...rendered.props} />);
  expect(view.state.readOnly).toBe(false);
  expect(view.contentDOM).not.toHaveClass("cm-lineWrapping");
});

it("does not carry a standalone file's undo history or selection into another workspace", () => {
  const rendered = renderEditor("first", vi.fn(), { fileKey: "a", clipboardWorkspaceId: "one" });
  const view = EditorView.findFromDOM(rendered.container.querySelector<HTMLElement>(".cm-editor")!)!;
  act(() => view.dispatch({ changes: { from: 0, insert: "draft " }, selection: { anchor: 3 } }));
  rendered.rerender(<CodeMirrorHost {...rendered.props} clipboardWorkspaceId="two" doc="other workspace" />);
  expect(view.state.doc.toString()).toBe("other workspace");
  expect(view.state.selection.main.head).toBe(0);
  expect(undo(view)).toBe(false);
});

it("updates a cached tab after the global appearance and editing settings change in another file", () => {
  const appearance = { fontFamily: "monospace", fontSizePx: 14, lineHeight: 1.5, ligatures: false, colorSchemeId: "app", highContrast: false };
  const rendered = renderEditor("first", vi.fn(), { fileKey: "a", path: "a.txt", appearance });
  const view = EditorView.findFromDOM(rendered.container.querySelector<HTMLElement>(".cm-editor")!)!;
  rendered.rerender(<CodeMirrorHost {...rendered.props} fileKey="b" path="b.txt" doc="second" />);
  const current = { ...appearance, fontSizePx: 18, ligatures: true, highContrast: true };
  rendered.rerender(<CodeMirrorHost {...rendered.props} fileKey="b" path="b.txt" doc="second" appearance={current} readOnly softWrap />);
  rendered.rerender(<CodeMirrorHost {...rendered.props} appearance={current} readOnly softWrap />);
  expect(view.state.doc.toString()).toBe("first");
  expect(view.state.readOnly).toBe(true);
  expect(view.contentDOM).toHaveClass("cm-lineWrapping");
  expect(view.contentDOM).toHaveAttribute("data-editor-ligatures", "true");
  expect(view.contentDOM).toHaveAttribute("data-editor-color-scheme", "high-contrast");
});

it("ignores an old semantic selection result after switching files on the same view", async () => {
  let resolve!: (value: null) => void;
  const onExpandSelection = vi.fn(() => new Promise<null>((reply) => { resolve = reply; }));
  const rendered = renderEditor("const alpha = 1;", vi.fn(), { fileKey: "a", onExpandSelection });
  const view = EditorView.findFromDOM(rendered.container.querySelector<HTMLElement>(".cm-editor")!)!;
  act(() => {
    view.focus();
    view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "w", ctrlKey: true, bubbles: true }));
  });
  expect(onExpandSelection).toHaveBeenCalledTimes(1);
  rendered.rerender(<CodeMirrorHost {...rendered.props} fileKey="b" path="b.txt" doc="second text" />);
  await act(async () => resolve(null));
  expect(view.state.selection.main.empty).toBe(true);
});
