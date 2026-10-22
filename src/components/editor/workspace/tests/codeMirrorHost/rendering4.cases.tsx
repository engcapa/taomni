import { foldedRanges, unfoldAll } from "@codemirror/language";
import { EditorSelection, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeMirrorHost, documentTextIdentity } from "../../CodeMirrorHost";
import { WorkspaceDocumentTransactionOwner } from "../../workspaceDocumentTransactionOwner";
import { textIdentityFromString } from "../../workspaceLayoutPersistence";
import { renderEditor } from "./harness";

export function registerCodeMirrorHostRendering4Cases() {

  describe("ED-IMPROVE-007 leaf/file view snapshots", () => {
    afterEach(() => cleanup());

    it.each([false, true])("restores deferred axes independently unless the user intervenes: %s", (intervene) => {
      const rendered = renderEditor("hello world", vi.fn(), {
        initialViewState: { mainSelection: { anchor: 4, head: 4 }, selections: [], scrollTop: 100, scrollLeft: 80, folds: [] },
      });
      const view = findView(rendered);
      expect(view.state.selection.main.head).toBe(4);
      if (intervene) fireEvent.wheel(view.scrollDOM);
      Object.defineProperties(view.scrollDOM, {
        clientHeight: { configurable: true, value: 100 },
        scrollHeight: { configurable: true, value: 500 },
      });
      act(() => view.dispatch({}));
      expect(view.scrollDOM.scrollTop).toBe(intervene ? 0 : 100);
      Object.defineProperties(view.scrollDOM, {
        clientWidth: { configurable: true, value: 100 },
        scrollWidth: { configurable: true, value: 500 },
      });
      act(() => view.dispatch({}));
      expect(view.scrollDOM.scrollLeft).toBe(intervene ? 0 : 80);
      expect(view.state.selection.main.head).toBe(4);
    });

    function findView(rendered: { container: HTMLElement; }): EditorView {
      const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!);
      expect(view).not.toBeNull();
      return view!;
    }

    it("applies a persisted main selection and multi-cursor once at mount", () => {
      const doc = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8";
      const rendered = renderEditor(doc, vi.fn(), {
        initialViewState: {
          mainSelection: { anchor: 12, head: 12 },
          selections: [{ anchor: 6, head: 6 }],
          scrollTop: 0,
          folds: [],
        },
      });
      const view = findView(rendered);
      expect(view.state.selection.main.head).toBe(12);
      expect(view.state.selection.ranges).toHaveLength(2);
      expect(view.state.selection.ranges.map((range) => range.head).sort((a, b) => a - b)).toEqual([6, 12]);
    });

    it("applies persisted folds and reports them in the captured state", async () => {
      const doc = "function a() {\n  body1;\n  body2;\n}\nfunction b() {\n  other;\n}\n";
      const onViewStateChange = vi.fn();
      const rendered = renderEditor(doc, vi.fn(), {
        initialViewState: {
          mainSelection: { anchor: 0, head: 0 },
          selections: [],
          scrollTop: 0,
          folds: [{ from: 0, to: doc.indexOf("function b") }],
        },
        onViewStateChange,
      });
      const view = findView(rendered);
      expect(foldedRanges(view.state).size).toBeGreaterThan(0);
      await waitFor(() => expect(onViewStateChange).toHaveBeenCalled());
      const captured = onViewStateChange.mock.calls.at(-1)![0];
      expect(captured.folds.length).toBeGreaterThan(0);
    });

    it("ED-PARITY-012: default import fold on open; user-expanded imports stay expanded on remount", async () => {
      const doc = "package demo;\nimport a.B;\nimport c.D;\nclass Demo {}\n";
      const onViewStateChange = vi.fn();
      const first = renderEditor(doc, vi.fn(), { path: "src/Demo.java", onViewStateChange });
      const view = findView(first);
      expect(foldedRanges(view.state).size).toBe(1);
      unfoldAll(view);
      expect(foldedRanges(view.state).size).toBe(0);
      view.dispatch({ selection: { anchor: 1 } });
      await waitFor(() => expect(onViewStateChange.mock.calls.at(-1)?.[0]?.importsExpanded).toBe(true));
      const snapshot = onViewStateChange.mock.calls.at(-1)![0];
      first.unmount();

      const second = renderEditor(doc, vi.fn(), { path: "src/Demo.java", initialViewState: snapshot });
      expect(foldedRanges(findView(second).state).size).toBe(0);
      second.unmount();

      // A snapshot from a view that never held the import fold keeps the default.
      const third = renderEditor(doc, vi.fn(), {
        path: "src/Demo.java",
        initialViewState: { ...snapshot, importsExpanded: undefined },
      });
      expect(foldedRanges(findView(third).state).size).toBe(1);
    });

    it("clamps corrupt or out-of-range persisted offsets instead of throwing", () => {
      const doc = "short";
      const rendered = renderEditor(doc, vi.fn(), {
        initialViewState: {
          mainSelection: { anchor: 9999, head: -5 },
          selections: [{ anchor: 4000, head: 4000 }],
          scrollTop: 5000,
          folds: [{ from: 100, to: 200 }, { from: 3, to: 1 }],
        },
      });
      const view = findView(rendered);
      for (const range of view.state.selection.ranges) {
        expect(range.anchor).toBeGreaterThanOrEqual(0);
        expect(range.anchor).toBeLessThanOrEqual(doc.length);
        expect(range.head).toBeGreaterThanOrEqual(0);
        expect(range.head).toBeLessThanOrEqual(doc.length);
      }
      expect(foldedRanges(view.state).size).toBe(0);
    });

    it("emits the captured state on selection changes and dedupes identical snapshots", async () => {
      const doc = Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n");
      const onViewStateChange = vi.fn();
      const rendered = renderEditor(doc, vi.fn(), { onViewStateChange });
      const view = findView(rendered);
      act(() => {
        view.dispatch({ selection: EditorSelection.cursor(10) });
      });
      await waitFor(() => expect(onViewStateChange).toHaveBeenCalled());
      const captured = onViewStateChange.mock.calls.at(-1)![0];
      expect(captured.mainSelection.head).toBe(10);
      const callsAfterSelection = onViewStateChange.mock.calls.length;
      act(() => {
        view.dispatch({ selection: EditorSelection.cursor(10) });
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 220));
      });
      expect(onViewStateChange.mock.calls.length).toBe(callsAfterSelection);
    });

    it("never re-applies a later initialViewState prop over live user input", async () => {
      const doc = "alpha\nbeta\ngamma\ndelta\nepsilon";
      const onChange = vi.fn();
      const rendered = renderEditor(doc, onChange, {
        initialViewState: {
          mainSelection: { anchor: 0, head: 0 },
          selections: [],
          scrollTop: 0,
          folds: [],
        },
      });
      const view = findView(rendered);
      act(() => {
        view.dispatch({ selection: EditorSelection.cursor(doc.indexOf("delta")) });
      });
      // A late prop update carrying a stale snapshot must not move the caret.
      rendered.rerender(
        <CodeMirrorHost
          {...rendered.props}
          initialViewState={{
            mainSelection: { anchor: 0, head: 0 },
            selections: [],
            scrollTop: 0,
            folds: [],
          }}
        />,
      );
      const after = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!);
      expect(after!.state.selection.main.head).toBe(doc.indexOf("delta"));
    });

    it("identifies different same-length documents with distinct identities (ED-MAIN-009)", () => {
      const a = Text.of(["abc", "def"]);
      const b = Text.of(["abc", "deg"]);
      expect(a.length).toBe(b.length);
      expect(documentTextIdentity(a)).not.toBe(documentTextIdentity(b));
      expect(documentTextIdentity(a)).toBe(documentTextIdentity(Text.of(["abc", "def"])));
      // The iterator hash must equal the persist-time string hash for the same
      // content, including CRLF input.
      expect(documentTextIdentity(a)).toBe(textIdentityFromString("abc\ndef"));
      expect(documentTextIdentity(a)).toBe(textIdentityFromString("abc\r\ndef"));
    });

    it("restores a captured snapshot only while the text identity matches (ED-MAIN-009)", async () => {
      const doc = "line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8";
      const onViewStateChange = vi.fn();
      const first = renderEditor(doc, vi.fn(), { onViewStateChange });
      const firstView = findView(first);
      act(() => {
        firstView.dispatch({ selection: EditorSelection.cursor(12) });
      });
      await waitFor(() => expect(onViewStateChange).toHaveBeenCalled());
      const captured = onViewStateChange.mock.calls.at(-1)![0];
      expect(captured.textIdentity).toBe(documentTextIdentity(firstView.state.doc));
      cleanup();

      // Same text: the persisted caret is restored.
      const restored = renderEditor(doc, vi.fn(), { initialViewState: captured });
      expect(findView(restored).state.selection.main.head).toBe(12);
      cleanup();

      // Same length, changed content: the stale positioning is dropped, not
      // re-anchored onto the new text.
      const changed = `${doc.slice(0, 12)}X${doc.slice(13)}`;
      expect(changed.length).toBe(doc.length);
      const dropped = renderEditor(changed, vi.fn(), { initialViewState: captured });
      expect(findView(dropped).state.selection.main.head).toBe(0);
    });

    it("captures a horizontal scroll offset with the view state (ED-MAIN-009)", async () => {
      const doc = Array.from({ length: 20 }, (_, index) => `line ${index}`).join("\n");
      const onViewStateChange = vi.fn();
      const rendered = renderEditor(doc, vi.fn(), { onViewStateChange });
      const view = findView(rendered);
      if (view.scrollDOM) view.scrollDOM.scrollLeft = 42;
      act(() => {
        view.dispatch({ selection: EditorSelection.cursor(10) });
      });
      await waitFor(() => expect(onViewStateChange).toHaveBeenCalled());
      const captured = onViewStateChange.mock.calls.at(-1)![0];
      expect(captured.scrollLeft).toBe(view.scrollDOM?.scrollLeft ?? 0);
    });

    it("captures new text identity within 1s of typing without using stale wall-clock identity (ED-REPAIR-009-A1)", async () => {
      const initialText = "hello world\nsecond line";
      const onViewStateChange = vi.fn();
      const rendered = renderEditor(initialText, vi.fn(), { onViewStateChange });
      const view = findView(rendered);

      // Edit the text within 1s of mounting
      act(() => {
        view.dispatch({
          changes: { from: 6, to: 11, insert: "taomni" },
          selection: EditorSelection.cursor(12),
        });
      });

      await waitFor(() => expect(onViewStateChange).toHaveBeenCalled());
      const captured = onViewStateChange.mock.calls.at(-1)![0];
      // Captured identity must match the new doc, NOT the initial text
      expect(captured.textIdentity).toBe(documentTextIdentity(view.state.doc));
      expect(captured.textIdentity).not.toBe(textIdentityFromString(initialText));
      expect(captured.mainSelection.head).toBe(12);
      cleanup();

      // Reopening with the new text must restore the caret at 12
      const updatedText = "hello taomni\nsecond line";
      const restored = renderEditor(updatedText, vi.fn(), { initialViewState: captured });
      expect(findView(restored).state.selection.main.head).toBe(12);
      cleanup();
    });

    it("performs tail capture on unmount when view state emit is pending (ED-REPAIR-009-A1, A2)", () => {
      const doc = "alpha\nbeta\ngamma";
      const onViewStateChange = vi.fn();
      const rendered = renderEditor(doc, vi.fn(), { onViewStateChange });
      const view = findView(rendered);

      // Move selection but unmount immediately before the 150ms debounce fires
      act(() => {
        view.dispatch({ selection: EditorSelection.cursor(7) });
      });
      expect(onViewStateChange).not.toHaveBeenCalled();

      // Cleanup triggers synchronous unmount tail capture
      cleanup();

      expect(onViewStateChange).toHaveBeenCalledTimes(1);
      const captured = onViewStateChange.mock.calls[0]![0];
      expect(captured.mainSelection.head).toBe(7);
      expect(captured.textIdentity).toBe(textIdentityFromString(doc));
    });
  });

  describe("ED-IMPROVE-008 IME composition lifecycle wiring", () => {
    afterEach(() => cleanup());

    it("finalizes composition ownership on compositionend and blur and keeps typing working", async () => {
      const owner = new WorkspaceDocumentTransactionOwner();
      const rendered = renderEditor("hello ", vi.fn(), {
        transactionOwner: owner,
        viewId: "primary",
        fileKey: "ime.ts",
      });
      const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
      act(() => {
        content.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        content.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "n" }));
      });
      const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!)!;
      act(() => {
        view.dispatch({ changes: { from: 6, insert: "x" } });
      });
      await waitFor(() => expect(owner.getDocument("ime.ts")).toBe("hello x"));
      // Blur during a fresh composition must release ownership without losing text.
      act(() => {
        content.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
        content.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
      });
      act(() => {
        view.dispatch({ changes: { from: 7, insert: "y" } });
      });
      await waitFor(() => expect(owner.getDocument("ime.ts")).toBe("hello xy"));
    });

    // ED-MAIN-006: CodeMirror schedules its final composition flush in a
    // microtask (`Promise.resolve().then(flush)`) after compositionend. A
    // capture-phase finalize would split that final update into a second undo
    // entry, so one undo must still return to the pre-composition text.
    it("keeps one undo when CodeMirror flushes the final composition change after compositionend", async () => {
      const owner = new WorkspaceDocumentTransactionOwner();
      const rendered = renderEditor("hello ", vi.fn(), {
        transactionOwner: owner,
        viewId: "primary",
        fileKey: "ime.ts",
      });
      const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
      const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!)!;
      const appendCompose = (text: string) => {
        view.dispatch({
          changes: { from: view.state.doc.length, insert: text },
          userEvent: "input.type.compose",
        });
      };

      act(() => {
        content.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      });
      act(() => appendCompose("n"));
      act(() => appendCompose("i"));
      // compositionend fires before CodeMirror's deferred final flush.
      act(() => {
        content.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你" }));
      });
      await act(async () => {
        await Promise.resolve();
        appendCompose("你");
        await new Promise((resolve) => setTimeout(resolve, 5));
      });

      expect(owner.getDocument("ime.ts")).toBe("hello ni你");
      expect(owner.getHistoryState("ime.ts").undoDepth).toBe(1);
      owner.undo("ime.ts", "primary");
      expect(owner.getDocument("ime.ts")).toBe("hello ");
    });
  });
}
