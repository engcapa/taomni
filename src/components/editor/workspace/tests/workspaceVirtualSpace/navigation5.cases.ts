import { history, undo } from "@codemirror/commands";
import { EditorSelection, EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it, vi } from "vitest";
import { EditorActionBridge, WorkspaceActionHost } from "../../workspaceActionHost";
import { buildEditorHostActions } from "../../workspaceCodeMirrorKeymap";
import {
  desiredVisualColumnField,
  setVirtualOverflow,
  virtualMoveDown,
  virtualOverflowAt,
  virtualSelectDown,
  virtualSelectUp,
  virtualSpaceOverflowField,
  virtualSpaceTypingHandler,
} from "../../workspaceVirtualSpace";
import { POLICY, mount } from "./harness";

export function registerworkspaceVirtualSpaceNavigation5Cases() {

  describe("§ED-VSPACE-003: Multi-Caret, Selection, and Composition Transactions", () => {
    it("leaves vertical movement unconsumed while the editor is composing", () => {
      const view = mount("first\nsecond");
      view.dispatch({ selection: EditorSelection.cursor(2) });
      Object.defineProperty(view, "composing", { value: true, configurable: true });

      expect(virtualMoveDown(view)).toBe(false);
      expect(view.state.selection.main.head).toBe(2);
      expect(view.state.doc.toString()).toBe("first\nsecond");
      expect(virtualOverflowAt(view.state, 2)).toBe(0);
    });

    it("falls back to the ordinary CodeMirror command when no virtual movement applies", async () => {
      const view = mount("abc");
      view.dispatch({ selection: EditorSelection.cursor(1) });

      const host = new WorkspaceActionHost({ workspaceId: "ws-vspace-fallback" });
      new EditorActionBridge(host).registerView("primary");
      host.registerActions(buildEditorHostActions({
        openReplacePanel: () => false,
        expandSemanticSelection: () => false,
        startBasicCompletion: () => false,
        escapeStack: () => false,
        runEditorCommand: (command) => command(view),
      }), { ownerViewId: "primary" });

      const event = {
        key: "ArrowLeft",
        code: "ArrowLeft",
        shiftKey: false,
        ctrlKey: false,
        altKey: false,
        metaKey: false,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      };
      expect(host.dispatchKeydownV2({
        event,
        workspaceId: "ws-vspace-fallback",
        targetViewId: "primary",
      })).toMatchObject({ kind: "executed", actionId: "editor.moveLeft" });

      await vi.waitFor(() => expect(view.state.selection.main.head).toBe(0));
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(event.stopPropagation).toHaveBeenCalledOnce();
    });

    it.each([
      { actionId: "editor.moveRight", doc: "abc", head: 1, expectedDoc: "abc", expectedHead: 2 },
      { actionId: "editor.moveToLineStart", doc: "  abc", head: 4, expectedDoc: "  abc", expectedHead: 2 },
      { actionId: "editor.moveToLineEnd", doc: "abc", head: 1, expectedDoc: "abc", expectedHead: 3 },
      { actionId: "editor.deleteBackward", doc: "abc", head: 1, expectedDoc: "bc", expectedHead: 0 },
      { actionId: "editor.deleteForward", doc: "abc", head: 1, expectedDoc: "ac", expectedHead: 1 },
      { actionId: "editor.insertNewline", doc: "abc", head: 1, expectedDoc: "a\nbc", expectedHead: 2 },
    ])("preserves the ordinary $actionId behavior outside virtual space", async ({
      actionId,
      doc,
      head,
      expectedDoc,
      expectedHead,
    }) => {
      const view = mount(doc);
      view.dispatch({ selection: EditorSelection.cursor(head) });
      const action = buildEditorHostActions({
        openReplacePanel: () => false,
        expandSemanticSelection: () => false,
        startBasicCompletion: () => false,
        escapeStack: () => false,
        runEditorCommand: (command) => command(view),
      }).find((candidate) => candidate.id === actionId);

      expect(action).toBeDefined();
      await expect(action!.run({ focus: "editor", hasActiveFile: true } as never))
        .resolves.toMatchObject({ kind: "applied" });
      expect(view.state.doc.toString()).toBe(expectedDoc);
      expect(view.state.selection.main.head).toBe(expectedHead);
    });

    it("tracks independent desired visual column and anchor for each caret across short and long lines", () => {
      // 3 lines: line 1 (11 chars), line 2 (3 chars), line 3 (13 chars)
      const doc = "hello world\nabc\ngoodbye world";
      const view = new EditorView({
        state: EditorState.create({
          doc,
          extensions: [
            EditorState.allowMultipleSelections.of(true),
            virtualSpaceOverflowField,
            desiredVisualColumnField,
            POLICY,
          ],
        }),
      });

      // Place 2 carets: Caret 1 at line 1 end (col 11), Caret 2 at line 2 end (col 3)
      view.dispatch({
        selection: EditorSelection.create([
          EditorSelection.cursor(11), // "hello world" end
          EditorSelection.cursor(15), // "abc" end (12 + 3)
        ]),
      });

      // Move down: Caret 1 moves to line 2 with overflow 8 (desired visual col 11 - 3), Caret 2 moves to line 3 col 3
      expect(virtualMoveDown(view)).toBe(true);
      expect(view.state.selection.ranges).toHaveLength(2);
      expect(view.state.selection.ranges[0].head).toBe(15); // line 2 end
      expect(virtualOverflowAt(view.state, 15)).toBe(8);
      expect(view.state.selection.ranges[1].head).toBe(19); // line 3 offset 3 ("goo")
      expect(virtualOverflowAt(view.state, 19)).toBe(0);

      // Move down again: Caret 1 moves to line 3 col 11 (offset 27), Caret 2 clamped on line 3 col 3 (offset 19)
      // CodeMirror sorts selection ranges by document offset (19, then 27)
      expect(virtualMoveDown(view)).toBe(true);
      expect(view.state.selection.ranges).toHaveLength(2);
      expect(view.state.selection.ranges[0].head).toBe(19); // line 3 offset 3
      expect(view.state.selection.ranges[1].head).toBe(27); // line 3 offset 11
      expect(virtualOverflowAt(view.state, 27)).toBe(0);
    });

    it("preserves selection anchors independently during multi-caret Shift extension", () => {
      const doc = "line 1\nline 2\nline 3";
      const view = new EditorView({
        state: EditorState.create({
          doc,
          extensions: [
            EditorState.allowMultipleSelections.of(true),
            virtualSpaceOverflowField,
            desiredVisualColumnField,
            POLICY,
          ],
        }),
      });

      // 2 carets with initial positions at line starts
      view.dispatch({
        selection: EditorSelection.create([
          EditorSelection.cursor(0), // line 1 start
          EditorSelection.cursor(7), // line 2 start
        ]),
      });

      // Select down with Shift
      expect(virtualSelectDown(view)).toBe(true);
      expect(view.state.selection.ranges).toHaveLength(2);

      // Range 0: anchor 0, head 7
      expect(view.state.selection.ranges[0].anchor).toBe(0);
      expect(view.state.selection.ranges[0].head).toBe(7);

      // Range 1: anchor 7, head 14
      expect(view.state.selection.ranges[1].anchor).toBe(7);
      expect(view.state.selection.ranges[1].head).toBe(14);
    });

    it("keeps the anchor stable when Shift movement reverses through it", () => {
      const view = mount("line 1\nline 2\nline 3");
      view.dispatch({ selection: EditorSelection.range(7, 14) });

      expect(virtualSelectUp(view)).toBe(true);
      expect(view.state.selection.main.anchor).toBe(7);
      expect(view.state.selection.main.head).toBe(7);

      expect(virtualSelectUp(view)).toBe(true);
      expect(view.state.selection.main.anchor).toBe(7);
      expect(view.state.selection.main.head).toBe(0);
      expect(view.state.selection.main.from).toBe(0);
      expect(view.state.selection.main.to).toBe(7);
    });

    it("materializes multi-caret padding in a single atomic transaction that undoes in 1 step", () => {
      const doc = "short\nanother line\nend";
      const view = new EditorView({
        state: EditorState.create({
          doc,
          extensions: [
            EditorState.allowMultipleSelections.of(true),
            virtualSpaceOverflowField,
            desiredVisualColumnField,
            POLICY,
            history(),
            virtualSpaceTypingHandler,
          ],
        }),
      });

      // Place 2 virtual carets: Caret 1 at line 1 with overflow 5, Caret 2 at line 3 with overflow 3
      // line 1 "short" -> offset 5
      // line 2 "another line" -> length 12
      // line 3 "end" -> offset 5 + 1 + 12 + 1 + 3 = 22
      view.dispatch({
        selection: EditorSelection.create([
          EditorSelection.cursor(5),
          EditorSelection.cursor(22),
        ]),
        effects: [
          setVirtualOverflow.of(new Map([
            [5, 5],
            [22, 3],
          ])),
        ],
      });

      expect(virtualOverflowAt(view.state, 5)).toBe(5);
      expect(virtualOverflowAt(view.state, 22)).toBe(3);

      // Type character 'X' across both carets
      // In CodeMirror, inputHandler handles insertion
      const handled = (virtualSpaceTypingHandler as any).value(view, 5, 5, "X");
      expect(handled).toBe(true);

      // Check document content:
      // Line 1: "short     X"
      // Line 2: "another line"
      // Line 3: "end   X"
      expect(view.state.doc.sliceString(0)).toBe("short     X\nanother line\nend   X");

      // Verify that a single undo reverts BOTH insertions atomically:
      expect(undo(view)).toBe(true);
      expect(view.state.doc.sliceString(0)).toBe("short\nanother line\nend");
    });

    it("rejects composing, dead key, process key, and AltGraph events from dispatching actions", () => {
      const host = new WorkspaceActionHost({ workspaceId: "ws-vspace-comp" });
      const bridge = new EditorActionBridge(host);
      bridge.registerView("editor-view-comp");

      let commandRunCount = 0;
      const actions = buildEditorHostActions({
        openReplacePanel: () => false,
        expandSemanticSelection: () => false,
        startBasicCompletion: () => false,
        escapeStack: () => false,
        runEditorCommand: () => {
          commandRunCount += 1;
          return true;
        },
      });
      host.registerActions(actions);

      const makeEvent = (key: string, code: string, extra: Record<string, any> = {}) => ({
        key,
        code,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        preventDefault: () => { },
        stopPropagation: () => { },
        ...extra,
      });

      // 1. Composition active (isComposing: true)
      const res1 = host.dispatchKeydownV2({
        event: makeEvent("a", "KeyA", { isComposing: true }),
        workspaceId: "ws-vspace-comp",
        targetViewId: "editor-view-comp",
      });
      expect(res1.kind).toBe("rejected");
      expect((res1 as any).reason).toBe("composing");

      // 2. Process key (IME in flight)
      const res2 = host.dispatchKeydownV2({
        event: makeEvent("Process", "Process"),
        workspaceId: "ws-vspace-comp",
        targetViewId: "editor-view-comp",
      });
      expect(res2.kind).toBe("rejected");
      expect((res2 as any).reason).toBe("composing");

      // 3. Dead key
      const res3 = host.dispatchKeydownV2({
        event: makeEvent("Dead", "Dead"),
        workspaceId: "ws-vspace-comp",
        targetViewId: "editor-view-comp",
      });
      expect(res3.kind).toBe("rejected");
      expect((res3 as any).reason).toBe("dead-key");

      // 4. AltGraph modifier
      const res4 = host.dispatchKeydownV2({
        event: makeEvent("@", "Digit2", { getModifierState: (m: string) => m === "AltGraph" }),
        workspaceId: "ws-vspace-comp",
        targetViewId: "editor-view-comp",
      });
      expect(res4.kind).toBe("rejected");
      expect((res4 as any).reason).toBe("alt-graph");

      expect(commandRunCount).toBe(0);
    });
  });
}
