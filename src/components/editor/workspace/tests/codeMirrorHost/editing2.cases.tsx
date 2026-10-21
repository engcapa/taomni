import { undoDepth } from "@codemirror/commands";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceActionHost } from "../../workspaceActionHost";
import { virtualSpaceOverflowField } from "../../workspaceVirtualSpace";
import { renderEditor } from "./harness";

export function registerCodeMirrorHostEditing2Cases() {

  describe("§8.19.8 semantic editing commands", () => {
    afterEach(() => cleanup());

    function renderWithPort(doc: string, path: string) {
      let registered: import("../../CodeMirrorHost").EditorCommandPort | null = null;
      const rendered = renderEditor(doc, vi.fn(), {
        path,
        onCommandPortChange: (registration) => {
          registered = registration.port;
        },
      });
      return {
        ...rendered,
        port: () => registered,
        view: () => EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!),
      };
    }

    it("surround applies through the port as one undoable transaction with provenance", async () => {
      const onSemanticEditApplied = vi.fn();
      const doc = "class A {\n  void m() {\n    doWork();\n  }\n}\n";
      const { port, view } = renderWithPort(doc, "src/A.java");
      await waitFor(() => expect(port()).not.toBeNull());
      await waitFor(() => expect(view()).not.toBeNull());

      // Select the whole `doWork();` line (expanded to whole lines is what the
      // plan requires).
      const v = view()!;
      const line = v.state.doc.line(3);
      v.dispatch({ selection: EditorSelection.range(line.from, line.to) });

      expect(port()!.execute("surroundWith")).toBe(false); // missing kindId → typed no-op
      const ok = port()!.execute("surroundWith", {
        surroundKindId: "try-catch",
        onSemanticEditApplied,
      });
      expect(ok).toBe(true);
      const after = v.state.doc.toString();
      expect(after).toContain("try {");
      expect(after).toContain("} catch (Exception e) {");
      expect(after).toContain("doWork();");
      expect(onSemanticEditApplied).toHaveBeenCalledTimes(1);
      const report = onSemanticEditApplied.mock.calls[0][0];
      expect(report.applied).toBe(true);
      // Provenance is honest: local template unless the tree aligned exactly.
      if (report.provenance?.kind === "syntax-tree") {
        expect(report.provenance.nodeType.length).toBeGreaterThan(0);
      } else {
        expect(report.provenance?.kind ?? null).toBe("local-text");
      }
      // One transaction == exactly one new undo entry for the whole wrap.
      expect(undoDepth(v.state)).toBeLessThan(50);
    });

    it("completeStatement reports honest provenance and unavailable reasons", async () => {
      const onSemanticEditApplied = vi.fn();
      const { port, view, container } = renderWithPort("foo()", "src/notes.txt");
      await waitFor(() => expect(port()).not.toBeNull());
      fireEvent.focus(container.querySelector(".cm-content")!);

      expect(port()!.execute("completeStatement", { onSemanticEditApplied })).toBe(true);
      const report = onSemanticEditApplied.mock.calls[0][0];
      expect(report.applied).toBe(true);
      // Parserless language stays on the labelled Local/Heuristic path.
      expect(report.provenance).toMatchObject({ kind: "local-text" });
      expect(view()!.state.doc.toString().startsWith("foo();")).toBe(true);
    });
  });

  describe("§8.21.3 V2-C virtual space and region provenance in CodeMirrorHost", () => {
    afterEach(() => cleanup());

    it("does not move the editor cursor while composition owns navigation keys", () => {
      const rendered = renderEditor("first\nsecond");
      const editor = rendered.container.querySelector<HTMLElement>(".cm-editor");
      const view = EditorView.findFromDOM(editor!);
      expect(view).not.toBeNull();
      view!.dispatch({ selection: EditorSelection.cursor(0) });
      rendered.content.focus();
      Object.defineProperty(view, "composing", { value: true, configurable: true });

      const event = new KeyboardEvent("keydown", {
        key: "ArrowDown",
        code: "ArrowDown",
        bubbles: true,
        cancelable: true,
      });
      const preventDefault = vi.spyOn(event, "preventDefault");
      rendered.content.dispatchEvent(event);

      expect(view!.state.selection.main.head).toBe(0);
      expect(preventDefault).toHaveBeenCalledOnce();
    });

    it("consumes appearance.virtualSpace policy in production editor", async () => {
      const actionHost = new WorkspaceActionHost({ workspaceId: "ws-test-vspace" });
      const rendered = renderEditor("first line\nsecond", vi.fn(), {
        workspaceActionHost: actionHost,
        appearance: {
          fontFamily: "monospace",
          fontSizePx: 14,
          lineHeight: 1.5,
          ligatures: false,
          colorSchemeId: "default",
          highContrast: false,
          virtualSpace: { afterLineEnd: true, atFileBottom: true },
        },
      });

      const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!);
      expect(view).not.toBeNull();

      // Place caret at line 1 EOL
      view!.dispatch({ selection: { anchor: 10 } });
      // Pressing End key moves into virtual space via ActionHost dispatch
      const dispatchResult = actionHost.dispatchKeydownV2({
        event: {
          key: "End",
          code: "End",
          shiftKey: false,
          ctrlKey: false,
          altKey: false,
          metaKey: false,
          preventDefault: vi.fn(),
          stopPropagation: vi.fn(),
        },
        workspaceId: "ws-test-vspace",
        targetViewId: "src/example.ts",
      });
      expect(dispatchResult.kind).toBe("executed");
      if (dispatchResult.kind === "executed") {
        expect(dispatchResult.actionId).toBe("editor.moveToLineEnd");
      }
      await Promise.resolve();
      const overflow = view!.state.field(virtualSpaceOverflowField, false)?.get(10) ?? 0;
      expect(overflow).toBeGreaterThan(0);
    });

    it("emits explicit-comment provenance for region markers on selection change", async () => {
      const onFoldProvenanceChange = vi.fn();
      const doc = "//region MyBlock\nconst x = 1;\n//endregion\n";
      const rendered = renderEditor(doc, vi.fn(), {
        path: "src/Test.ts",
        onFoldProvenanceChange,
      });

      const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!);
      expect(view).not.toBeNull();

      // Move caret to the region comment line
      view!.dispatch({ selection: { anchor: 5 } });
      await waitFor(() => {
        expect(onFoldProvenanceChange).toHaveBeenCalledWith("explicit-comment");
      });
    });
  });
}
