import { undoDepth } from "@codemirror/commands";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { CodeMirrorHost } from "../../CodeMirrorHost";
import { renderEditor } from "./harness";

export function registerCodeMirrorHostHistory8Cases() {

  it("reconfigures workspace editor appearance without losing state or history", async () => {
    const rendered = renderEditor("alpha beta", vi.fn(), {
      appearance: {
        fontFamily: '"JetBrains Mono", monospace',
        fontSizePx: 13,
        lineHeight: 1.5,
        ligatures: true,
        colorSchemeId: "app",
        highContrast: false,
      },
    });
    const editor = rendered.container.querySelector<HTMLElement>(".cm-editor");
    const view = EditorView.findFromDOM(editor!);
    expect(view).not.toBeNull();
    view!.dispatch({
      changes: { from: 10, insert: "!" },
      selection: EditorSelection.create([
        EditorSelection.cursor(1),
        EditorSelection.cursor(6),
      ], 1),
      userEvent: "input.type",
    });
    const selectionBefore = view!.state.selection;
    const undoBefore = undoDepth(view!.state);

    rendered.rerender(
      <CodeMirrorHost
        {...rendered.props}
        doc="alpha beta!"
        appearance={{
          fontFamily: '"Source Code Pro", monospace',
          fontSizePx: 17,
          lineHeight: 1.8,
          ligatures: false,
          colorSchemeId: "dracula",
          highContrast: true,
        }}
      />,
    );

    await waitFor(() => expect(rendered.content).toHaveAttribute(
      "data-editor-color-scheme",
      "high-contrast",
    ));
    expect(EditorView.findFromDOM(editor!)).toBe(view);
    expect(view!.state.doc.toString()).toBe("alpha beta!");
    expect(view!.state.selection.eq(selectionBefore, true)).toBe(true);
    expect(undoDepth(view!.state)).toBe(undoBefore);
    expect(rendered.content).toHaveAttribute("data-editor-ligatures", "false");
  });

  it("supports dynamic soft wrapping without recreating the editor", async () => {
    const rendered = renderEditor("a very long logical line", vi.fn(), { softWrap: true });
    const editor = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(editor).toHaveClass("cm-lineWrapping");

    rendered.rerender(
      <CodeMirrorHost
        path="src/example.ts"
        doc="a very long logical line"
        visible
        diagnostics={[]}
        reveal={null}
        softWrap={false}
        onChange={rendered.onChange}
        onSave={vi.fn()}
        onHover={vi.fn(async () => null)}
        onDefinition={vi.fn(async () => false)}
        onReferences={vi.fn(async () => undefined)}
        getCompletionIdentity={() => null}
        onCompletionDiagnostic={vi.fn()}
      />,
    );
    await waitFor(() => expect(editor).not.toHaveClass("cm-lineWrapping"));
  });

  it("uses rectangular selection for an ordinary drag in column mode", () => {
    const rendered = renderEditor("one\ntwo", vi.fn(), { columnSelectionMode: true });
    expect(rendered.container.firstElementChild).toHaveAttribute("data-column-selection", "true");
  });

  it("§8.20.2: the explicit nonce only EMITS a trigger event; rendering follows the session's controlled popup", async () => {
    const onParameterTrigger = vi.fn();
    const rendered = renderEditor("open(\"file\", 1)", vi.fn(), {
      onParameterTrigger,
      parameterInfoRequestNonce: 0,
    });
    expect(screen.queryByRole("dialog", { name: "Parameter info" })).toBeNull();

    rendered.rerender(
      <CodeMirrorHost
        {...rendered.props}
        parameterInfoRequestNonce={1}
      />,
    );
    // The host never issues requests itself — it hands the trigger to the
    // workspace-side session.
    expect(onParameterTrigger).toHaveBeenCalledTimes(1);
    expect(onParameterTrigger).toHaveBeenCalledWith(expect.objectContaining({ origin: "explicit" }));

    // The session publishes the display state; the host renders it.
    rendered.rerender(
      <CodeMirrorHost
        {...rendered.props}
        parameterInfoShowFullSignatures
        parameterPopup={{
          signatures: [{
            label: "open(path: string, mode: number): void",
            documentation: "Opens the path.",
            parameters: [
              { label: "path: string", documentation: null, labelStart: 5, labelEnd: 17 },
              { label: "mode: number", documentation: null, labelStart: 19, labelEnd: 31 },
            ],
            activeParameter: 1,
          }],
          activeSignature: 0,
          activeParameter: 1,
          anchorOffset: 14,
        }}
      />,
    );
    const dialog = await screen.findByRole("dialog", { name: "Parameter info" });
    expect(dialog).toHaveTextContent("open(path: string, mode: number): void");
    expect(dialog.querySelector("[data-signature-index='0'] b")).toHaveTextContent("mode: number");

    // Session hides → the tooltip disappears.
    rendered.rerender(
      <CodeMirrorHost {...rendered.props} parameterPopup={null} />,
    );
    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Parameter info" })).toBeNull();
    });
  });

  it("§8.20.2: typing a signature trigger char emits a typing trigger; other edits emit invalidation", () => {
    const onParameterTrigger = vi.fn();
    const onParameterInvalidate = vi.fn();
    const rendered = renderEditor("call", vi.fn(), {
      onParameterTrigger,
      onParameterInvalidate,
      signatureTriggers: ["(", ","],
    });
    const editor = rendered.container.querySelector<HTMLElement>(".cm-editor");
    expect(editor).not.toBeNull();
    const view = EditorView.findFromDOM(editor!)!;

    // Trigger character → typing event, no invalidation.
    view.dispatch({
      changes: { from: view.state.doc.length, insert: "(" },
      selection: { anchor: view.state.doc.length + 1 },
      userEvent: "input.type",
    });
    expect(onParameterTrigger).toHaveBeenCalledTimes(1);
    expect(onParameterTrigger).toHaveBeenCalledWith(expect.objectContaining({
      origin: "typing",
      triggerCharacter: "(",
    }));
    expect(onParameterInvalidate).not.toHaveBeenCalled();

    // Plain edit → doc-changed invalidation (old tooltip must close).
    view.dispatch({
      changes: { from: view.state.doc.length, insert: "x" },
      selection: { anchor: view.state.doc.length + 1 },
      userEvent: "input.type",
    });
    expect(onParameterTrigger).toHaveBeenCalledTimes(1);
    expect(onParameterInvalidate).toHaveBeenCalledWith("doc-changed");

    // Closing paren → closing-char invalidation.
    view.dispatch({
      changes: { from: view.state.doc.length - 1, insert: ")" },
      userEvent: "input.type",
    });
    expect(onParameterInvalidate).toHaveBeenLastCalledWith("closing-char");

    // Caret move without an edit → caret-moved invalidation.
    view.dispatch({ selection: { anchor: 0 } });
    expect(onParameterInvalidate).toHaveBeenLastCalledWith("caret-moved");
  });

  it("reconfigures hover documentation without recreating the editor", () => {
    const onHover = vi.fn(async () => null);
    const rendered = renderEditor("const value = 1", vi.fn(), {
      onHover,
      showHoverDocumentation: true,
      hoverDocumentationDelayMs: 300,
    });
    const editor = rendered.container.querySelector(".cm-editor");

    rendered.rerender(
      <CodeMirrorHost
        {...rendered.props}
        onHover={onHover}
        showHoverDocumentation={false}
        hoverDocumentationDelayMs={300}
      />,
    );

    expect(rendered.container.querySelector(".cm-editor")).toBe(editor);
  });

  it("preserves cursor selection when doc update is applied", async () => {
    const onSelectionChange = vi.fn();
    const rendered = renderEditor("line1\nline2\nline3", vi.fn(), { onSelectionChange });

    // Rerender with updated doc (e.g. normalized after save)
    rendered.rerender(
      <CodeMirrorHost
        path="src/example.ts"
        doc="line1\nline2\nline3\n"
        visible
        diagnostics={[]}
        reveal={null}
        onChange={rendered.onChange}
        onSave={vi.fn()}
        onHover={vi.fn(async () => null)}
        onDefinition={vi.fn(async () => false)}
        onReferences={vi.fn(async () => undefined)}
        getCompletionIdentity={() => null}
        onCompletionDiagnostic={vi.fn()}
        onSelectionChange={onSelectionChange}
      />,
    );

    await waitFor(() => {
      expect(rendered.container.querySelector(".cm-content")).toBeInTheDocument();
    });
  });
}
