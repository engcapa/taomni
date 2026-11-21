import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import {
  applyBookmarkLinesOp,
  bookmarkStateField,
  markHistoryBaselineEffect,
  nextBookmarkPos,
  setBookmarksEffect,
} from "./bookmarksAndHistory";
import {
  applyColumnEditorToView,
  applyColumnPasteToView,
  buildRectangularSelection,
} from "./columnSelection";
import { buildNotepadExtensions, createNotepadCompartments } from "./extensions";
import {
  computeMarkSpans,
  extractMarkedMatchesText,
  jumpMarkSpan,
  setMarkHighlightsEffect,
} from "./marksAndTokens";
import { setOverwriteModeEffect, setVirtualSpaceEffect } from "./overwriteAndVirtualSpace";
import { createSplitScrollCoordinator, syncViewDocumentText } from "./splitSync";
import { setSymbolConfigEffect } from "./symbols";

function createTestView(doc: string, options?: { bookmarks?: number[]; onToggleInsertMode?: (ins: boolean) => void }) {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const compartments = createNotepadCompartments();
  const state = EditorState.create({
    doc,
    extensions: buildNotepadExtensions({
      compartments,
      readOnly: false,
      wrap: false,
      showLineNumbers: true,
      fontSizePx: 13,
      symbols: { space: false, tab: false, eol: false, nonprint: false, indent: false, wrap: false, eolLabel: "LF", showRuler: true, rulerCol: 80, tabSize: 4 },
      bookmarks: options?.bookmarks ?? [],
      baselineLines: doc.split("\n"),
      showChangeHistory: true,
      marks: [],
      onToggleInsertMode: options?.onToggleInsertMode,
    }),
  });
  const view = new EditorView({ state, parent: host });
  return { view, host, cleanup: () => { view.destroy(); host.remove(); } };
}

describe("notepad cm6 extensions (V-12..V-17)", () => {
  it("supports virtual space padding and rectangular column editor + paste (V-12, V-13)", () => {
    const { view, cleanup } = createTestView("aa\nbb\ncc");
    try {
      view.dispatch({ effects: setVirtualSpaceEffect.of(true), selection: { anchor: 2 } });
      expect(view.state.doc.toString()).toBe("aa\nbb\ncc");

      // Rectangular selection covering rows 1..3 columns 1..2
      const rect = buildRectangularSelection(view.state.doc, 1, 1, 3, 2);
      expect(rect.ranges).toHaveLength(3);
      view.dispatch({ selection: rect });

      applyColumnEditorToView(view, {
        mode: "number",
        initial: 10,
        increment: 5,
        repeat: 1,
        radix: 10,
        leadingZeros: true,
        width: 3,
      });
      expect(view.state.doc.toString()).toBe("a010\nb015\nc020");

      view.dispatch({ selection: { anchor: 0 } });
      applyColumnPasteToView(view, "X\nY");
      expect(view.state.doc.toString()).toBe("Xa010\nYb015\nc020");

      // Overwrite state effect toggles cleanly
      view.dispatch({ effects: setOverwriteModeEffect.of(true) });
      expect(view.dom.classList.contains("np-overwrite")).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("renders symbol decorations without altering .cm-line textContent (V-14)", () => {
    const { view, cleanup } = createTestView("a b\tc\nline2");
    try {
      view.dispatch({
        effects: setSymbolConfigEffect.of({
          space: true,
          tab: true,
          eol: true,
          nonprint: true,
          indent: true,
          wrap: false,
          eolLabel: "CRLF",
          showRuler: true,
          rulerCol: 80,
          tabSize: 4,
        }),
      });
      const lines = Array.from(view.dom.querySelectorAll(".cm-line")).map((el) => el.textContent);
      expect(lines).toEqual(["a b\tc", "line2"]);
      expect(view.dom.querySelector(".np-sym-space")).not.toBeNull();
      expect(view.dom.querySelector(".np-sym-tab")).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  it("tracks bookmarks across edits, jumps circularly, and executes bookmark line ops (V-15)", () => {
    const { view, cleanup } = createTestView("one\ntwo\nthree\nfour", { bookmarks: [1, 3] });
    try {
      expect(nextBookmarkPos(view.state.doc, [1, 3], 0, false)).toBe(view.state.doc.line(2).from);
      expect(nextBookmarkPos(view.state.doc, [1, 3], 3, false)).toBe(view.state.doc.line(2).from);
      expect(nextBookmarkPos(view.state.doc, [1, 3], 1, true)).toBe(view.state.doc.line(4).from);

      // Inserting a newline on line 1 shifts bookmark 1 -> 2, 3 -> 4
      view.dispatch({ changes: { from: 0, to: 0, insert: "zero\n" } });
      expect([...view.state.field(bookmarkStateField)]).toEqual([2, 4]);

      view.dispatch({ effects: [setBookmarksEffect.of([0, 2]), markHistoryBaselineEffect.of(["x"])] });
      const cut = applyBookmarkLinesOp("A\nB\nC", [0, 2], "cut");
      expect(cut.extractedText).toBe("A\nC");
      expect(cut.nextText).toBe("B");

      const inv = applyBookmarkLinesOp("A\nB\nC", [1], "inverse");
      expect(inv.nextBookmarks).toEqual([0, 2]);
    } finally {
      cleanup();
    }
  });

  it("applies 5-style token marks, jumps between spans, and prevents split scroll ping-pong (V-16, V-17)", () => {
    const { view, cleanup } = createTestView("alpha beta alpha gamma alpha");
    try {
      const rules = [
        { id: "r1", style: 1, query: "alpha", mode: "normal" as const, caseSensitive: false, wholeWord: true },
        { id: "r2", style: 3, query: "beta", mode: "normal" as const, caseSensitive: false, wholeWord: true },
      ];
      view.dispatch({ effects: setMarkHighlightsEffect.of({ rules, activeMatch: { from: 6, to: 10 } }) });
      const spans = computeMarkSpans(view.state.doc.toString(), { rules });
      expect(spans).toHaveLength(4);
      expect(extractMarkedMatchesText(view.state.doc.toString(), rules, 1)).toBe("alpha\nalpha\nalpha");
      expect(jumpMarkSpan(view.state.doc.toString(), rules, 1, 2, false)).toEqual({ from: 11, to: 16, className: "np-mark-style-1" });

      expect(view.dom.querySelectorAll(".np-mark-style-1").length).toBeGreaterThan(0);

      // Sync test
      expect(syncViewDocumentText(view, "updated text")).toBe(true);
      expect(syncViewDocumentText(view, "updated text")).toBe(false);

      const src = { scrollTop: 120, scrollLeft: 40 } as HTMLElement;
      const dst = { scrollTop: 0, scrollLeft: 0 } as HTMLElement;
      const coord = createSplitScrollCoordinator();
      vi.spyOn(globalThis, "requestAnimationFrame").mockImplementation(() => 1);
      coord.sync(src, dst, true, true);
      expect(dst.scrollTop).toBe(120);
      expect(dst.scrollLeft).toBe(40);
      // Immediate reverse sync while locked is suppressed
      src.scrollTop = 999;
      coord.sync(dst, src, true, true);
      expect(src.scrollTop).toBe(999);
    } finally {
      cleanup();
    }
  });
});
