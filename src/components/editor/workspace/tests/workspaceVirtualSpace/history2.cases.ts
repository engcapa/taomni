import { history, undo } from "@codemirror/commands";
import { ChangeSet, EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  desiredVisualColumnField,
  measureVisualPositions,
  setVirtualOverflow,
  virtualEnterCommand,
  virtualEscapeCommand,
  virtualOverflowAt,
  virtualOverflowRestoreField,
  virtualSpaceOverflowField,
  virtualSpaceTypingHandler,
} from "../../workspaceVirtualSpace";
import { POLICY } from "./harness";

export function registerworkspaceVirtualSpaceHistory2Cases() {

  describe("ED-AUDIT-002: virtual caret survives undo/redo", () => {
    const DOC = "short\nanother line\nend";

    /** Production extension set including the document history. */
    function mountWithHistory(): EditorView {
      return new EditorView({
        state: EditorState.create({
          doc: DOC,
          extensions: [
            EditorState.allowMultipleSelections.of(true),
            virtualOverflowRestoreField,
            virtualSpaceOverflowField,
            desiredVisualColumnField,
            POLICY,
            history(),
            virtualSpaceTypingHandler,
          ],
        }),
      });
    }

    /** Park a virtual caret at end of line 0 with 3 overflow columns. */
    function parkVirtualCaret(view: EditorView): void {
      view.dispatch({
        selection: EditorSelection.cursor(5),
        effects: setVirtualOverflow.of(new Map([[5, 3]])),
      });
      expect(virtualOverflowAt(view.state, 5)).toBe(3);
    }

    function typeViaProductionHandler(view: EditorView, text: string): void {
      expect((virtualSpaceTypingHandler as any).value(view, 5, 5, text)).toBe(true);
    }

    /**
     * Replays the production shared-owner undo dispatch exactly as
     * applySharedTransactionToView issues it: inverse changes, the live
     * selection mapped through the change set, and userEvent "undo".
     */
    function sharedOwnerUndo(
      view: EditorView,
      inverse: Array<{ from: number; to?: number; insert?: string; }>,
    ): void {
      const changeSet = ChangeSet.of(inverse, view.state.doc.length);
      view.dispatch({
        changes: inverse,
        selection: view.state.selection.map(changeSet),
        userEvent: "undo",
      });
    }

    it("restores the virtual caret together with the text after one undo (shared-owner path)", () => {
      const view = mountWithHistory();
      parkVirtualCaret(view);
      typeViaProductionHandler(view, "X");
      expect(view.state.doc.sliceString(0)).toBe("short   X\nanother line\nend");
      expect(view.state.selection.main.head).toBe(9);

      sharedOwnerUndo(view, [{ from: 5, to: 9, insert: "" }]);
      // One undo brings back BOTH the text and the virtual caret.
      expect(view.state.doc.sliceString(0)).toBe(DOC);
      expect(view.state.selection.main.head).toBe(5);
      expect(virtualOverflowAt(view.state, 5)).toBe(3);
      const positions = measureVisualPositions(view.state, 4);
      expect(positions[0].documentColumn).toBe(5);
      expect(positions[0].virtualColumns).toBe(3);

      // The restored caret is live: the next insertion re-manufactures padding.
      typeViaProductionHandler(view, "Z");
      expect(view.state.doc.sliceString(0)).toBe("short   Z\nanother line\nend");
      view.destroy();
    });

    it("restores the virtual caret after one undo via the standalone history command", () => {
      const view = mountWithHistory();
      parkVirtualCaret(view);
      typeViaProductionHandler(view, "X");
      expect(undo(view)).toBe(true);
      expect(view.state.doc.sliceString(0)).toBe(DOC);
      expect(view.state.selection.main.head).toBe(5);
      expect(virtualOverflowAt(view.state, 5)).toBe(3);
      view.destroy();
    });

    it("replays the insert on redo without a virtual caret, then restores it on undo again", () => {
      const view = mountWithHistory();
      parkVirtualCaret(view);
      typeViaProductionHandler(view, "X");
      sharedOwnerUndo(view, [{ from: 5, to: 9, insert: "" }]);
      expect(virtualOverflowAt(view.state, 5)).toBe(3);

      // Redo replays the forward change with userEvent "redo" (owner path).
      const changeSet = ChangeSet.of([{ from: 5, insert: "   X" }], view.state.doc.length);
      view.dispatch({
        changes: [{ from: 5, insert: "   X" }],
        selection: view.state.selection.map(changeSet),
        userEvent: "redo",
      });
      expect(view.state.doc.sliceString(0)).toBe("short   X\nanother line\nend");
      expect(virtualOverflowAt(view.state, view.state.selection.main.head)).toBe(0);

      // Undo after redo restores the virtual caret once more.
      sharedOwnerUndo(view, [{ from: 5, to: 9, insert: "" }]);
      expect(view.state.doc.sliceString(0)).toBe(DOC);
      expect(view.state.selection.main.head).toBe(5);
      expect(virtualOverflowAt(view.state, 5)).toBe(3);
      view.destroy();
    });

    it("does not resurrect a stale virtual caret after Escape cleared the overflow", () => {
      const view = mountWithHistory();
      parkVirtualCaret(view);
      typeViaProductionHandler(view, "X");
      sharedOwnerUndo(view, [{ from: 5, to: 9, insert: "" }]);
      expect(virtualOverflowAt(view.state, 5)).toBe(3);

      // Escape exits virtual space explicitly: overflow AND the pending
      // restore record are invalidated together.
      expect(virtualEscapeCommand(view)).toBe(true);
      expect(virtualOverflowAt(view.state, 5)).toBe(0);

      // Plain typing at the real EOL: the handler defers (no overflow) and the
      // default insertion advances the caret normally.
      expect((virtualSpaceTypingHandler as any).value(view, 5, 5, "Y")).toBe(false);
      view.dispatch({ changes: { from: 5, insert: "Y" }, userEvent: "input.type" });
      expect(view.state.doc.sliceString(0)).toBe("shortY\nanother line\nend");

      // Undo reverts Y to the real EOL caret — no stale virtual caret.
      sharedOwnerUndo(view, [{ from: 5, to: 6, insert: "" }]);
      expect(view.state.doc.sliceString(0)).toBe(DOC);
      expect(view.state.selection.main.head).toBe(5);
      expect(virtualOverflowAt(view.state, 5)).toBe(0);
      view.destroy();
    });

    it("does not manufacture padding while the editor is read-only", () => {
      const view = new EditorView({
        state: EditorState.create({
          doc: DOC,
          extensions: [
            EditorState.readOnly.of(true),
            EditorState.allowMultipleSelections.of(true),
            virtualOverflowRestoreField,
            virtualSpaceOverflowField,
            POLICY,
            virtualSpaceTypingHandler,
          ],
        }),
      });
      parkVirtualCaret(view);
      expect((virtualSpaceTypingHandler as any).value(view, 5, 5, "X")).toBe(false);
      expect(view.state.doc.sliceString(0)).toBe(DOC);
      expect(virtualEnterCommand(view)).toBe(false);
      expect(view.state.doc.sliceString(0)).toBe(DOC);
      view.destroy();
    });

    it("defers to the default handler while composing (no padding during IME)", () => {
      const view = mountWithHistory();
      parkVirtualCaret(view);
      Object.defineProperty(view, "composing", { value: true, configurable: true });
      expect((virtualSpaceTypingHandler as any).value(view, 5, 5, "X")).toBe(false);
      expect(view.state.doc.sliceString(0)).toBe(DOC);
      view.destroy();
    });

    it("restores every multi-caret overflow entry in the same single undo", () => {
      const view = mountWithHistory();
      // Two virtual carets: line 1 overflow 5, line 3 overflow 3.
      view.dispatch({
        selection: EditorSelection.create([
          EditorSelection.cursor(5),
          EditorSelection.cursor(22),
        ]),
        effects: setVirtualOverflow.of(new Map([[5, 5], [22, 3]])),
      });
      expect((virtualSpaceTypingHandler as any).value(view, 5, 5, "X")).toBe(true);
      expect(view.state.doc.sliceString(0)).toBe("short     X\nanother line\nend   X");

      sharedOwnerUndo(view, [{ from: 5, to: 11, insert: "" }, { from: 28, to: 32, insert: "" }]);
      expect(view.state.doc.sliceString(0)).toBe(DOC);
      expect(view.state.selection.ranges.map((range) => range.head)).toEqual([5, 22]);
      expect(virtualOverflowAt(view.state, 5)).toBe(5);
      expect(virtualOverflowAt(view.state, 22)).toBe(3);
      view.destroy();
    });

    it("collapses overflow on a remote-sync style change so later typing does not pad", () => {
      const view = mountWithHistory();
      parkVirtualCaret(view);
      // A remote-sync style transaction (docChanged, no user event) collapses
      // the live overflow: the virtual caret is no longer a padding source.
      view.dispatch({ changes: { from: DOC.length, insert: "!" } });
      expect(view.state.doc.sliceString(0)).toBe(`${DOC}!`);
      expect(virtualOverflowAt(view.state, view.state.selection.main.head)).toBe(0);
      expect((virtualSpaceTypingHandler as any).value(view, view.state.selection.main.head, view.state.selection.main.head, "X")).toBe(false);
      expect(view.state.doc.sliceString(0)).toBe(`${DOC}!`);
      view.destroy();
    });
  });
}
