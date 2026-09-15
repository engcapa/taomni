import { StrictMode, type ComponentProps } from "react";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { CodeMirrorHost } from "./CodeMirrorHost";
import { closeSearchPanel, openSearchPanel } from "@codemirror/search";
import { WorkspaceDocumentTransactionOwner } from "./workspaceDocumentTransactionOwner";
import { WorkspaceActionHost } from "./workspaceActionHost";

const F0 = "Project tree example\nThe editor buffer should survive tree navigation.\n";

function mountEditor(overrides: Partial<ComponentProps<typeof CodeMirrorHost>> = {}) {
  const props: ComponentProps<typeof CodeMirrorHost> = {
    path: "example.txt", fileKey: "example.txt", viewId: "primary", doc: F0,
    visible: true, active: true, diagnostics: [], reveal: null,
    onChange: vi.fn(), onSave: vi.fn(), onHover: vi.fn(async () => null),
    onDefinition: vi.fn(async () => false), onReferences: vi.fn(async () => undefined),
    getCompletionIdentity: () => null, onCompletionDiagnostic: vi.fn(), ...overrides,
  };
  const result = render(<StrictMode><CodeMirrorHost {...props} /></StrictMode>);
  const view = EditorView.findFromDOM(result.container.querySelector(".cm-editor")!)!;
  return { ...result, view, props };
}

async function openFind(view: EditorView, actionHost?: WorkspaceActionHost) {
  act(() => { view.contentDOM.focus(); });
  expect(view.hasFocus).toBe(true);
  fireEvent.keyDown(view.contentDOM, { key: "Control", ctrlKey: true });
  if (actionHost) {
    await act(async () => {
      expect(await actionHost.execute("editor.find", { focus: "editor", hasActiveFile: true })).toMatchObject({ kind: "applied" });
    });
  } else {
    fireEvent.keyDown(view.contentDOM, { key: "f", code: "KeyF", ctrlKey: true });
  }
  fireEvent.keyUp(document.activeElement!, { key: "Control" });
  const field = view.dom.querySelector<HTMLInputElement>('input[name="search"]')!;
  await waitFor(() => expect(field).toHaveFocus());
  return field;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe("ED-FINDFOCUS-001 real focus with StrictMode", () => {
  it("publishes search selections without a floating toolbar anchor and restores the anchor after close", async () => {
    const onSelectionChange = vi.fn();
    const { view } = mountEditor({ onSelectionChange });
    vi.spyOn(view, "coordsAtPos").mockReturnValue({ top: 100, bottom: 120, left: 30, right: 60 });
    const field = await openFind(view);
    fireEvent.input(field, { target: { value: "tree" } });
    expect(onSelectionChange).toHaveBeenLastCalledWith(expect.objectContaining({ text: "tree", rect: null }));
    fireEvent.keyDown(field, { key: "Escape" });
    expect(onSelectionChange).toHaveBeenLastCalledWith(expect.objectContaining({ text: "tree", rect: expect.any(Object) }));
  });

  it.each(["external focus", "close", "destroy", "workspace roundtrip", "leaf roundtrip"])(
    "cancels deferred opening permanently after %s", async (reason) => {
      const rendered = mountEditor();
      const { view, props } = rendered;
      const outside = document.createElement("input");
      document.body.append(outside);
      try {
        act(() => {
          view.contentDOM.focus();
          openSearchPanel(view);
          if (reason === "close") closeSearchPanel(view);
          if (reason === "destroy") rendered.unmount();
          if (reason === "external focus") { outside.focus(); view.contentDOM.focus(); }
        });
        if (reason === "workspace roundtrip" || reason === "leaf roundtrip") {
          rendered.rerender(<StrictMode><CodeMirrorHost {...props}
            visible={reason !== "workspace roundtrip"} active={reason !== "leaf roundtrip"} /></StrictMode>);
          rendered.rerender(<StrictMode><CodeMirrorHost {...props} /></StrictMode>);
        }
        await act(async () => { await Promise.resolve(); });
        expect(document.activeElement?.getAttribute("name")).not.toBe("search");
        expect(view.state.doc.toString()).toBe(F0);
      } finally { outside.remove(); }
    },
  );

  it("keeps one shared replacement undo and independent sibling selection while Find is open", async () => {
    const owner = new WorkspaceDocumentTransactionOwner();
    const actionHost = new WorkspaceActionHost({ workspaceId: "find-focus-shared" });
    const first = mountEditor({ transactionOwner: owner, workspaceActionHost: actionHost });
    const second = mountEditor({ transactionOwner: owner, viewId: "secondary", active: false });
    act(() => { second.view.dispatch({ selection: { anchor: 20 } }); });
    const field = await openFind(first.view, actionHost);
    fireEvent.input(field, { target: { value: "tree" } });
    expect(second.view.state.selection.main.head).toBe(20);
    expect(owner.getHistoryState("example.txt").undoDepth).toBe(0);
    act(() => { second.view.dispatch({ changes: { from: F0.length, insert: "!" }, userEvent: "input.type" }); });
    expect(first.view.state.doc.toString()).toBe(F0 + "!");
    expect(first.view.state.selection.main).toMatchObject({ from: 8, to: 12 });
    fireEvent.click(first.getByRole("button", { name: "Show replace" }));
    const replacement = first.container.querySelector<HTMLInputElement>('input[name="replace"]')!;
    fireEvent.input(replacement, { target: { value: "bush" } });
    fireEvent.click(first.getByRole("button", { name: "Replace all matches" }));
    expect(second.view.state.doc.toString()).toBe(F0.replaceAll("tree", "bush") + "!");
    fireEvent.keyDown(replacement, { key: "Escape" });
    await act(async () => {
      expect(await actionHost.execute("workspace.undo", { focus: "editor", hasActiveFile: true })).toMatchObject({ kind: "applied" });
    });
    await waitFor(() => expect(second.view.state.doc.toString()).toBe(F0 + "!"));
    expect(owner.getHistoryState("example.txt").undoDepth).toBe(1);
  });

  it("keeps empty query selection, invalid/zero recovery and composition keys in the input", async () => {
    const { view } = mountEditor();
    const field = await openFind(view);
    fireEvent.input(field, { target: { value: "tree" } });
    fireEvent.input(field, { target: { value: "" } });
    expect(view.state.selection.main).toMatchObject({ from: 8, to: 12 });
    fireEvent.compositionStart(field);
    fireEvent.keyDown(field, { key: "Escape", isComposing: true });
    fireEvent.keyDown(field, { key: "Enter", isComposing: true });
    expect(field).toHaveFocus();
    expect(view.state.selection.main).toMatchObject({ from: 8, to: 12 });
    fireEvent.compositionEnd(field);
    fireEvent.input(field, { target: { value: "not-present" } });
    expect(view.dom.querySelector(".cm-workspace-search-status")).toHaveTextContent("0 matches");
    fireEvent.input(field, { target: { value: "tree" } });
    expect(view.state.selection.main).toMatchObject({ from: 8, to: 12 });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(view.hasFocus).toBe(true);
    expect(view.state.doc.toString()).toBe(F0);
  });

  it("allows read-only Find and disables replacement including preserve case", async () => {
    const rendered = mountEditor({ readOnly: true });
    const field = await openFind(rendered.view);
    fireEvent.input(field, { target: { value: "tree" } });
    expect(rendered.queryByRole("textbox", { name: "Replace" })).toBeNull();
    fireEvent.click(rendered.getByRole("button", { name: "Show replace" }));
    expect(rendered.getByRole("button", { name: "Replace all matches" })).toBeDisabled();
    expect(rendered.getByRole("button", { name: "Preserve case" })).toBeDisabled();
    expect(rendered.view.state.doc.toString()).toBe(F0);
  });

  it("opens from focused content without a nested EditorView update", async () => {
    const errors: unknown[] = [];
    const onError = (event: ErrorEvent) => { errors.push(event.error); event.preventDefault(); };
    window.addEventListener("error", onError);
    const consoleError = vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));
    try {
      const { view } = mountEditor();
      await openFind(view);
      expect(errors).toEqual([]);
      expect(consoleError).not.toHaveBeenCalled();
      expect(view.state.doc.toString()).toBe(F0);
    } finally {
      window.removeEventListener("error", onError);
    }
  });

  it("selects first, next, previous and returns the current selection to the same view twice", async () => {
    const { view, props } = mountEditor();
    for (let cycle = 0; cycle < 2; cycle += 1) {
      act(() => { view.dispatch({ selection: { anchor: 0 } }); });
      const field = await openFind(view);
      fireEvent.input(field, { target: { value: "tree" } });
      expect(view.state.selection.main).toMatchObject({ from: 8, to: 12 });
      expect(view.dom.querySelector(".cm-workspace-search-status")).toHaveTextContent("1 / 2");
      expect(field).toHaveFocus();
      fireEvent.keyDown(field, { key: "Enter" });
      expect(view.state.selection.main).toMatchObject({ from: 54, to: 58 });
      expect(field).toHaveFocus();
      fireEvent.keyDown(field, { key: "Enter", shiftKey: true });
      expect(view.state.selection.main).toMatchObject({ from: 8, to: 12 });
      fireEvent.keyDown(field, { key: "Escape" });
      expect(view.dom.querySelector(".cm-workspace-search")).toBeNull();
      expect(view.hasFocus).toBe(true);
      expect(view.state.selection.main).toMatchObject({ from: 8, to: 12 });
      expect(view.state.doc.toString()).toBe(F0);
    }
    expect(props.onChange).not.toHaveBeenCalled();
  });
});
