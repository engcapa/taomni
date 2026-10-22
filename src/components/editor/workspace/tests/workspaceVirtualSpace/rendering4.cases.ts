import { EditorSelection, EditorState, type SelectionRange } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { EditorActionBridge, WorkspaceActionHost } from "../../workspaceActionHost";
import { buildEditorHostActions } from "../../workspaceCodeMirrorKeymap";
import {
  desiredVisualColumnField,
  documentColumnForVisualColumn,
  isEditorGeometryReady,
  setVirtualOverflow,
  virtualMoveDown,
  virtualMoveRightCommand,
  virtualOverflowAt,
  virtualPageDown,
  virtualPageUp,
  virtualSelectPageDown,
  virtualSelectPageUp,
  virtualSpaceOverflowField,
  virtualSpaceTypingHandler,
} from "../../workspaceVirtualSpace";
import { POLICY, installPhysicalLineVerticalGeometry, mount, visualColumnOf } from "./harness";

export function registerworkspaceVirtualSpaceRendering4Cases() {

  describe("§ED-VSPACE-002: Real Display Geometry Page & Vertical Movement", () => {
    it("isEditorGeometryReady detects unready vs ready geometry", () => {
      const view = new EditorView({
        state: EditorState.create({ doc: "hello\nworld", extensions: [POLICY] }),
      });
      // Headless / jsdom view without layout geometry:
      expect(isEditorGeometryReady(view)).toBe(false);

      // With mock layout geometry:
      Object.defineProperty(view.scrollDOM, "clientHeight", { value: 200, configurable: true });
      Object.defineProperty(view, "defaultLineHeight", { value: 20, configurable: true });
      Object.defineProperty(view, "defaultCharacterWidth", { value: 8, configurable: true });
      expect(isEditorGeometryReady(view)).toBe(true);
    });

    it("yields to default handler (returns false) for PageUp/PageDown when geometry is not ready", () => {
      const view = new EditorView({
        state: EditorState.create({ doc: "line1\nline2\nline3", extensions: [POLICY] }),
      });
      expect(isEditorGeometryReady(view)).toBe(false);

      // Without geometry, PageUp/PageDown does NOT use fake 15-line fallback, but returns false
      expect(virtualPageDown(view)).toBe(false);
      expect(virtualPageUp(view)).toBe(false);
      expect(virtualSelectPageDown(view)).toBe(false);
      expect(virtualSelectPageUp(view)).toBe(false);
    });

    it("§ED-VSPACE-002: leaves PageDown unconsumed when the focused editor geometry is unavailable", async () => {
      const host = new WorkspaceActionHost({ workspaceId: "ws-vspace-geometry" });
      new EditorActionBridge(host).registerView("primary");
      let commandRuns = 0;
      host.registerActions(buildEditorHostActions({
        openReplacePanel: () => false,
        expandSemanticSelection: () => false,
        startBasicCompletion: () => false,
        escapeStack: () => false,
        isEditorGeometryReady: () => false,
        runEditorCommand: () => {
          commandRuns += 1;
          return false;
        },
      }), { ownerViewId: "primary" });
      const event = {
        key: "PageDown",
        code: "PageDown",
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };

      const result = host.dispatchKeydownV2({
        event,
        workspaceId: "ws-vspace-geometry",
        targetViewId: "primary",
      });

      expect(result).toMatchObject({ kind: "rejected", reason: "disabled" });
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(event.stopPropagation).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(commandRuns).toBe(0);
    });

    it("performs real geometry PageDown and PageUp based on viewport height and line height", () => {
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
      const view = new EditorView({
        state: EditorState.create({
          doc: lines,
          extensions: [virtualSpaceOverflowField, desiredVisualColumnField, POLICY],
        }),
      });

      // Mock 20px line height, 200px viewport -> 9 lines per page jump (200/20 - 1 = 9 lines)
      Object.defineProperty(view.scrollDOM, "clientHeight", { value: 200, configurable: true });
      Object.defineProperty(view, "defaultLineHeight", { value: 20, configurable: true });
      Object.defineProperty(view, "defaultCharacterWidth", { value: 8, configurable: true });
      Object.defineProperty(view, "contentHeight", { value: 1000, configurable: true });

      const moveVertically = installPhysicalLineVerticalGeometry(view, 20);

      // Caret on Line 1 offset 0
      view.dispatch({ selection: EditorSelection.cursor(0) });
      expect(virtualPageDown(view)).toBe(true);

      // Should land on Line 10 (1 + 9)
      const head1 = view.state.selection.main.head;
      const line1 = view.state.doc.lineAt(head1);
      expect(line1.number).toBe(10);
      expect(moveVertically).toHaveBeenNthCalledWith(
        1,
        expect.anything(),
        true,
        180,
      );

      // PageDown again -> Line 19
      expect(virtualPageDown(view)).toBe(true);
      const head2 = view.state.selection.main.head;
      expect(view.state.doc.lineAt(head2).number).toBe(19);

      // PageUp -> back to Line 10
      expect(virtualPageUp(view)).toBe(true);
      const head3 = view.state.selection.main.head;
      expect(view.state.doc.lineAt(head3).number).toBe(10);
    });

    it("dynamically adapts page jump distance upon viewport resize", () => {
      const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join("\n");
      const view = new EditorView({
        state: EditorState.create({
          doc: lines,
          extensions: [virtualSpaceOverflowField, desiredVisualColumnField, POLICY],
        }),
      });

      // Initial viewport 200px (9 lines)
      Object.defineProperty(view.scrollDOM, "clientHeight", { value: 200, configurable: true });
      Object.defineProperty(view, "defaultLineHeight", { value: 20, configurable: true });
      Object.defineProperty(view, "defaultCharacterWidth", { value: 8, configurable: true });
      Object.defineProperty(view, "contentHeight", { value: 1000, configurable: true });

      const moveVertically = installPhysicalLineVerticalGeometry(view, 20);

      // Resize viewport to 400px (400 - 20 = 380px = 19 lines jump)
      Object.defineProperty(view.scrollDOM, "clientHeight", { value: 400, configurable: true });

      view.dispatch({ selection: EditorSelection.cursor(0) });
      expect(virtualPageDown(view)).toBe(true);

      // Should land on Line 20 (1 + 19)
      const head = view.state.selection.main.head;
      expect(view.state.doc.lineAt(head).number).toBe(20);
      expect(moveVertically).toHaveBeenCalledWith(expect.anything(), true, 380);
    });

    it("§ED-VSPACE-002: delegates wrapped visual-line movement to CodeMirror geometry", () => {
      const doc = "0123456789ABCDEFGHIJ";
      const view = new EditorView({
        state: EditorState.create({
          doc,
          extensions: [
            virtualSpaceOverflowField,
            desiredVisualColumnField,
            POLICY,
            EditorView.lineWrapping,
          ],
        }),
      });

      Object.defineProperty(view.scrollDOM, "clientHeight", { value: 200, configurable: true });
      Object.defineProperty(view, "defaultLineHeight", { value: 20, configurable: true });
      Object.defineProperty(view, "defaultCharacterWidth", { value: 8, configurable: true });
      Object.defineProperty(view, "contentHeight", { value: 40, configurable: true });

      // Real CodeMirror lineBlockAt spans the physical line even when it wraps.
      (view as any).lineBlockAt = () => ({
        from: 0,
        to: 20,
        top: 0,
        bottom: 40,
        height: 40,
        type: 0,
      });
      (view as any).lineBlockAtHeight = () => ({
        from: 0,
        to: 20,
        top: 0,
        bottom: 40,
        height: 40,
        type: 0,
      });
      const moveVertically = vi.fn((start: SelectionRange) => {
        expect(start.goalColumn).toBeUndefined();
        return EditorSelection.cursor(13);
      });
      Object.defineProperty(view, "moveVertically", { value: moveVertically, configurable: true });

      view.dispatch({ selection: EditorSelection.cursor(3) });
      expect(virtualMoveDown(view)).toBe(true);
      expect(view.state.selection.main.head).toBe(13);
      expect(virtualOverflowAt(view.state, 13)).toBe(0);
      expect(moveVertically).toHaveBeenCalledOnce();
    });

    it("handles top and bottom boundaries and preserves virtual overflow at file bottom", () => {
      const view = new EditorView({
        state: EditorState.create({
          doc: "first line\nlast line",
          extensions: [virtualSpaceOverflowField, desiredVisualColumnField, POLICY],
        }),
      });

      Object.defineProperty(view.scrollDOM, "clientHeight", { value: 200, configurable: true });
      Object.defineProperty(view, "defaultLineHeight", { value: 20, configurable: true });
      Object.defineProperty(view, "defaultCharacterWidth", { value: 8, configurable: true });
      Object.defineProperty(view, "contentHeight", { value: 40, configurable: true });

      (view as any).lineBlockAt = (pos: number) => {
        const line = view.state.doc.lineAt(pos);
        const top = (line.number - 1) * 20;
        return { from: line.from, to: line.to, top, bottom: top + 20, height: 20, type: 0 };
      };
      (view as any).lineBlockAtHeight = (height: number) => {
        const lineNum = Math.min(2, Math.max(1, Math.floor(height / 20) + 1));
        const line = view.state.doc.line(lineNum);
        const top = (line.number - 1) * 20;
        return { from: line.from, to: line.to, top, bottom: top + 20, height: 20, type: 0 };
      };

      // Caret at top line 1
      view.dispatch({ selection: EditorSelection.cursor(0) });
      expect(virtualPageUp(view)).toBe(false); // already at top boundary

      // Caret at bottom line with desired column 30 (line length 9 -> overflow 21)
      view.dispatch({ selection: EditorSelection.cursor(11) }); // "last line" start
      // Place desired visual column 30
      view.dispatch({
        selection: EditorSelection.cursor(20),
        effects: [setVirtualOverflow.of(new Map([[20, 21]]))],
      });
      expect(virtualOverflowAt(view.state, 20)).toBe(21);

      // PageDown at bottom boundary preserves caret at file bottom and retains virtual overflow
      expect(virtualPageDown(view)).toBe(false);
      expect(view.state.selection.main.head).toBe(20);
    });

    it("keeps exact mixed-caret columns when rendered pixel goals include editor padding", () => {
      const view = new EditorView({
        state: EditorState.create({
          doc: "prefixX\nX\nlongprefixX",
          selection: EditorSelection.create([
            EditorSelection.cursor(7),
            EditorSelection.cursor(9),
            EditorSelection.cursor(21),
          ]),
          extensions: [
            EditorState.allowMultipleSelections.of(true),
            virtualSpaceOverflowField,
            desiredVisualColumnField,
            virtualSpaceTypingHandler,
            POLICY,
          ],
        }),
      });
      Object.defineProperty(view.scrollDOM, "clientHeight", { value: 200, configurable: true });
      Object.defineProperty(view, "defaultLineHeight", { value: 20, configurable: true });
      Object.defineProperty(view, "defaultCharacterWidth", { value: 15, configurable: true });
      Object.defineProperty(view, "moveVertically", {
        configurable: true,
        value: vi.fn((start: SelectionRange) => {
          if (start.head === 7) return EditorSelection.cursor(9, 1, undefined, 120);
          if (start.head === 9) return EditorSelection.cursor(12, 1, undefined, 30);
          return EditorSelection.cursor(21, 1, undefined, 180);
        }),
      });

      expect(virtualMoveDown(view)).toBe(true);
      expect(view.state.selection.ranges.map((range) => range.head)).toEqual([9, 11, 21]);
      expect(virtualOverflowAt(view.state, 9)).toBe(6);
      expect(virtualOverflowAt(view.state, 11)).toBe(0);
      expect(virtualOverflowAt(view.state, 21)).toBe(0);

      expect((virtualSpaceTypingHandler as any).value(view, 9, 9, "Z")).toBe(true);
      expect(view.state.doc.toString()).toBe("prefixX\nX      Z\nlZongprefixXZ");
    });

    it("collapses mixed-direction occurrence selections before entering virtual space", () => {
      const view = mount("prefixX\nX\nlongprefixX");
      view.dispatch({
        selection: EditorSelection.create([
          EditorSelection.range(7, 6),
          EditorSelection.range(8, 9),
          EditorSelection.range(20, 21),
        ]),
      });

      expect(virtualMoveRightCommand(view, false)).toBe(true);
      expect(view.state.selection.ranges.map((range) => range.head)).toEqual([7, 9, 21]);
      expect(view.state.selection.ranges.every((range) => range.empty)).toBe(true);
      expect(view.state.selection.ranges.map((range) => virtualOverflowAt(view.state, range.head)))
        .toEqual([0, 0, 0]);

      expect(virtualMoveDown(view)).toBe(true);
      expect((virtualSpaceTypingHandler as any).value(view, 9, 9, "Z")).toBe(true);
      expect(view.state.doc.toString()).toBe("prefixX\nX      Z\nlZongprefixXZ");
    });

    it("respects tabSize 2 vs tabSize 8 and wide CJK/Emoji characters in vertical navigation", () => {
      // In tabSize 2: "\tfoo" has "\t" (width 2) + "foo" (width 3) = visual col 5
      expect(visualColumnOf("\tfoo", 4, 2)).toBe(5);

      // In tabSize 8: "\tfoo" has "\t" (width 8) + "foo" (width 3) = visual col 11
      expect(visualColumnOf("\tfoo", 4, 8)).toBe(11);

      // CJK "你好" has 2 chars, each width 2 -> visual width 4
      expect(visualColumnOf("你好", 2, 4)).toBe(4);
      // Emoji "🚀" (astral code point, string length 2) -> visual width 2
      expect(visualColumnOf("🚀", 2, 4)).toBe(2);
      // Combining marks and ZWJ emoji are each one grapheme cluster.
      expect(visualColumnOf("e\u0301", 2, 4)).toBe(1);
      const family = "👨‍👩‍👧‍👦";
      expect(visualColumnOf(family, family.length, 4)).toBe(2);
      expect(documentColumnForVisualColumn(family, 2, 4)).toBe(family.length);
    });

    it("preserves tab and wide-grapheme desired columns through CodeMirror geometry", () => {
      const view = new EditorView({
        state: EditorState.create({
          doc: "\tfoo\n你好🚀",
          extensions: [
            EditorState.tabSize.of(2),
            virtualSpaceOverflowField,
            desiredVisualColumnField,
            POLICY,
          ],
        }),
      });
      Object.defineProperty(view.scrollDOM, "clientHeight", { value: 200, configurable: true });
      Object.defineProperty(view, "defaultLineHeight", { value: 20, configurable: true });
      Object.defineProperty(view, "defaultCharacterWidth", { value: 8, configurable: true });
      const secondLine = view.state.doc.line(2);
      const moveVertically = vi.fn((start: SelectionRange) => {
        expect(start.goalColumn).toBe(40); // tabSize 2: "\tfoo" is 5 visual columns
        return EditorSelection.cursor(secondLine.from + 2, 1, undefined, start.goalColumn ?? undefined);
      });
      Object.defineProperty(view, "moveVertically", { value: moveVertically, configurable: true });

      view.dispatch({ selection: EditorSelection.cursor(4, 1, undefined, 40) });
      expect(virtualMoveDown(view)).toBe(true);
      expect(view.state.selection.main.head).toBe(secondLine.from + 2);
      expect(view.state.field(desiredVisualColumnField)).toEqual([5]);
      expect(moveVertically).toHaveBeenCalledOnce();
    });
  });
}
