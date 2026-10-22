import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CodeMirrorHost } from "../../CodeMirrorHost";
import { renderEditor } from "./harness";

export function registerCodeMirrorHostLifecycle1Cases() {

  describe("ED-DOC-001 mounted Reader Mode", () => {
    afterEach(() => cleanup());

    it("renders in place, returns to source, and preserves document selection", async () => {
      const source = "/** Hello **world** */\nconst answer = 42;";
      const onRaw = vi.fn();
      const rendered = renderEditor(source, vi.fn(), {
        renderedDocEnabled: true,
        renderedDocLanguageId: "typescript",
        onToggleRenderedDocRaw: onRaw,
      });
      const editor = rendered.container.querySelector<HTMLElement>(".cm-editor");
      const view = EditorView.findFromDOM(editor!);
      expect(view).not.toBeNull();
      expect(rendered.container.querySelector(".cm-rendered-doc-comment")).toBeInTheDocument();
      expect(rendered.container.querySelector(".cm-rendered-doc-body")).toHaveTextContent("Hello world");

      view!.dispatch({ selection: EditorSelection.range(4, 16) });
      const selectionBeforeToggle = view!.state.selection;
      fireEvent.click(screen.getByRole("button", { name: "View raw documentation comment" }));
      expect(onRaw).toHaveBeenCalledTimes(1);

      rendered.rerender(
        <CodeMirrorHost
          {...rendered.props}
          renderedDocEnabled={false}
        />,
      );
      await waitFor(() => expect(rendered.container.querySelector(".cm-rendered-doc-comment")).toBeNull());
      expect(view!.state.doc.toString()).toBe(source);
      expect(view!.state.selection.eq(selectionBeforeToggle, true)).toBe(true);
    });

    it("rebuilds rendered blocks from the live document after an edit", async () => {
      const rendered = renderEditor("/** Before */\nconst value = 1;", vi.fn(), {
        renderedDocEnabled: true,
        renderedDocLanguageId: "ts",
      });
      const editor = rendered.container.querySelector<HTMLElement>(".cm-editor");
      const view = EditorView.findFromDOM(editor!);
      expect(view).not.toBeNull();
      expect(rendered.container.querySelector(".cm-rendered-doc-body")).toHaveTextContent("Before");

      view!.dispatch({ changes: { from: 4, to: 10, insert: "After" } });
      await waitFor(() => expect(rendered.container.querySelector(".cm-rendered-doc-body")).toHaveTextContent("After"));
      expect(view!.state.doc.toString()).toContain("/** After */");
    });
  });
}
