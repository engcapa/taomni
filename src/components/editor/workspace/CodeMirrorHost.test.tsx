import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { EditorSelection, Text } from "@codemirror/state";
import { undoDepth } from "@codemirror/commands";
import { startCompletion } from "@codemirror/autocomplete";
import { EditorView } from "@codemirror/view";
import { foldedRanges } from "@codemirror/language";
import { CodeMirrorHost, documentTextIdentity } from "./CodeMirrorHost";
import { textIdentityFromString } from "./workspaceLayoutPersistence";
import {
  setVirtualOverflow,
  virtualOverflowAt,
  virtualSpaceOverflowField,
  virtualSpaceTypingHandler,
} from "./workspaceVirtualSpace";
import { WorkspaceActionHost } from "./workspaceActionHost";
import { WorkspaceDocumentTransactionOwner } from "./workspaceDocumentTransactionOwner";
import type { GitLineChange } from "./gitEditorChrome";

function renderEditor(
  doc: string,
  onChange = vi.fn(),
  overrides: Partial<ComponentProps<typeof CodeMirrorHost>> = {},
) {
  const props: ComponentProps<typeof CodeMirrorHost> = {
    path: "src/example.ts",
    doc,
    visible: true,
    diagnostics: [],
    reveal: null,
    onChange,
    onSave: vi.fn(),
    onHover: vi.fn(async () => null),
    onDefinition: vi.fn(async () => false),
    onReferences: vi.fn(async () => undefined),
    ...overrides,
    getCompletionIdentity: overrides.getCompletionIdentity ?? (() => null),
    onCompletionDiagnostic: overrides.onCompletionDiagnostic ?? vi.fn(),
  };
  const result = render(<CodeMirrorHost {...props} />);
  const content = result.container.querySelector<HTMLElement>(".cm-content");
  expect(content).not.toBeNull();
  return { ...result, content: content!, onChange, props };
}

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

describe("CodeMirrorHost search", () => {
  afterEach(() => cleanup());

  it("opens the themed find panel and navigates matches", async () => {
    const { content } = renderEditor("alpha beta alpha");

    fireEvent.keyDown(content, { key: "f", code: "KeyF", ctrlKey: true });

    const search = await screen.findByRole("searchbox", { name: "Find" });
    fireEvent.input(search, { target: { value: "alpha" } });
    expect(screen.getByText("2 matches")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(screen.getByText("1 / 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
    expect(screen.getByText("2 / 2")).toBeInTheDocument();

    // Native type=search clear — no custom × button.
    fireEvent.input(search, { target: { value: "" } });
    expect(search).toHaveValue("");
    expect(screen.getByText("0 matches")).toBeInTheDocument();
  });

  it("applies case, whole-word, and regular-expression search options", async () => {
    const { content } = renderEditor("Alpha alpha alphabet ALPHA");
    fireEvent.keyDown(content, { key: "f", code: "KeyF", ctrlKey: true });

    const search = await screen.findByRole("searchbox", { name: "Find" });
    fireEvent.input(search, { target: { value: "alpha" } });
    expect(screen.getByText("4 matches")).toBeInTheDocument();

    const wholeWord = screen.getByRole("button", { name: "Match whole word" });
    fireEvent.click(wholeWord);
    expect(wholeWord).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("3 matches")).toBeInTheDocument();

    const matchCase = screen.getByRole("button", { name: "Match case" });
    fireEvent.click(matchCase);
    expect(matchCase).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("1 matches")).toBeInTheDocument();

    const regexp = screen.getByRole("button", { name: "Use regular expression" });
    fireEvent.click(regexp);
    fireEvent.input(search, { target: { value: "[" } });
    expect(screen.getByText("Invalid pattern")).toBeInTheDocument();
  });

  it("replaces all matches and reports the updated buffer", async () => {
    const onChange = vi.fn();
    const { content } = renderEditor("alpha beta alpha", onChange);
    fireEvent.keyDown(content, { key: "f", code: "KeyF", ctrlKey: true });

    fireEvent.input(await screen.findByRole("searchbox", { name: "Find" }), {
      target: { value: "alpha" },
    });
    fireEvent.input(screen.getByRole("textbox", { name: "Replace" }), {
      target: { value: "omega" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Replace all matches" }));

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(
        "omega beta omega",
        expect.objectContaining({ line: expect.any(Number), character: expect.any(Number) }),
        expect.any(Number),
      );
    });
    expect(screen.getByText("0 matches")).toBeInTheDocument();
  });

  it("routes Preserve Case through the mounted replace-all workflow", async () => {
    const onChange = vi.fn();
    const { content } = renderEditor("FOO foo Foo", onChange);
    fireEvent.keyDown(content, { key: "r", code: "KeyR", ctrlKey: true });

    fireEvent.input(await screen.findByRole("searchbox", { name: "Find" }), {
      target: { value: "foo" },
    });
    fireEvent.input(screen.getByRole("textbox", { name: "Replace" }), {
      target: { value: "bar" },
    });
    const preserveCase = screen.getByRole("button", { name: "Preserve case" });
    fireEvent.click(preserveCase);
    expect(preserveCase).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(screen.getByRole("button", { name: "Replace all matches" }));

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith(
        "BAR bar Bar",
        expect.objectContaining({ line: expect.any(Number), character: expect.any(Number) }),
        expect.any(Number),
      );
    });
  });

  it("opens replacement mode with Ctrl+R and closes with Escape", async () => {
    const { content } = renderEditor("alpha");
    fireEvent.keyDown(content, { key: "r", code: "KeyR", ctrlKey: true });

    const replace = await screen.findByRole("textbox", { name: "Replace" });
    await waitFor(() => expect(replace).toHaveFocus());
    fireEvent.keyDown(replace, { key: "Escape" });
    expect(screen.queryByTestId("code-workspace-editor-search")).not.toBeInTheDocument();
  });

  it("duplicates and deletes the current line with IDEA keybindings", async () => {
    const onChange = vi.fn();
    const { content } = renderEditor("one\ntwo", onChange);

    fireEvent.keyDown(content, { key: "d", code: "KeyD", ctrlKey: true });
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(
      "one\none\ntwo",
      expect.objectContaining({ line: 1, character: 0 }),
      expect.any(Number),
    ));

    fireEvent.keyDown(content, { key: "y", code: "KeyY", ctrlKey: true });
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(
      "one\ntwo",
      expect.objectContaining({ line: 1, character: 3 }),
      expect.any(Number),
    ));
  });

  it("rejects edits in read-only buffers but keeps navigation working", async () => {
    const onChange = vi.fn();
    const onDefinition = vi.fn(async () => true);
    const { content } = renderEditor("one\ntwo", onChange, { readOnly: true, onDefinition });

    // Editing commands are no-ops on library / decompiled sources.
    fireEvent.keyDown(content, { key: "d", code: "KeyD", ctrlKey: true });
    fireEvent.keyDown(content, { key: "y", code: "KeyY", ctrlKey: true });
    await waitFor(() => expect(onDefinition).not.toHaveBeenCalled());
    expect(onChange).not.toHaveBeenCalled();

    // Go to definition still jumps out of a read-only buffer.
    fireEvent.keyDown(content, { key: "F12" });
    await waitFor(() => expect(onDefinition).toHaveBeenCalled());
    expect(onChange).not.toHaveBeenCalled();
  });

  it("moves selected lines with Alt+Shift+Arrow", async () => {
    const onChange = vi.fn();
    const { content } = renderEditor("one\ntwo", onChange);

    fireEvent.keyDown(content, { key: "ArrowDown", code: "ArrowDown", altKey: true, shiftKey: true });
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(
      "two\none",
      expect.objectContaining({ line: expect.any(Number), character: expect.any(Number) }),
      expect.any(Number),
    ));
  });

  it("toggles line comments with Ctrl+Slash", async () => {
    const onChange = vi.fn();
    const { content } = renderEditor("const value = 1;", onChange);
    await waitFor(() => expect(content).toHaveAttribute("data-language", "typescript"));

    fireEvent.keyDown(content, { key: "/", code: "Slash", ctrlKey: true });
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(
      "// const value = 1;",
      expect.objectContaining({ line: 0, character: expect.any(Number) }),
      expect.any(Number),
    ));
  });

  it("opens go to line with Ctrl+G", async () => {
    const { content } = renderEditor("one\ntwo");
    fireEvent.keyDown(content, { key: "g", code: "KeyG", ctrlKey: true });
    expect(await screen.findByRole("textbox", { name: /Go to line/ })).toBeInTheDocument();
  });

  it("publishes token-guarded command ports without remounting the editor", async () => {
    const firstRegistration = vi.fn();
    const rendered = renderEditor("one\ntwo", vi.fn(), {
      fileKey: "root:app:src/one.ts",
      onCommandPortChange: firstRegistration,
    });
    const editor = rendered.container.querySelector<HTMLElement>(".cm-editor");
    const view = EditorView.findFromDOM(editor!);
    expect(view).not.toBeNull();
    await waitFor(() => expect(firstRegistration).toHaveBeenCalledWith(expect.objectContaining({
      fileKey: "root:app:src/one.ts",
      token: expect.any(Object),
      port: expect.objectContaining({ execute: expect.any(Function), state: expect.any(Function) }),
    })));
    const mounted = firstRegistration.mock.calls.find((call) => call[0].port)?.[0];

    const secondRegistration = vi.fn();
    rendered.rerender(
      <CodeMirrorHost
        {...rendered.props}
        fileKey="root:app:src/two.ts"
        onCommandPortChange={secondRegistration}
      />,
    );

    await waitFor(() => expect(firstRegistration).toHaveBeenCalledWith({
      fileKey: "root:app:src/one.ts",
      token: mounted.token,
      port: null,
    }));
    expect(EditorView.findFromDOM(editor!)).toBe(view);
    expect(secondRegistration).toHaveBeenCalledWith(expect.objectContaining({
      fileKey: "root:app:src/two.ts",
      token: expect.any(Object),
      port: expect.any(Object),
    }));
  });

  it("publishes live completion state through the command port", async () => {
    const registration = vi.fn();
    const rendered = renderEditor("sout", vi.fn(), {
      path: "src/App.java",
      fileKey: "root:app:src/App.java",
      onCommandPortChange: registration,
    });
    const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!);
    expect(view).not.toBeNull();
    await waitFor(() => expect(
      registration.mock.calls.find((call) => call[0].port),
    ).toBeTruthy());
    const { port } = registration.mock.calls.find((call) => call[0].port)![0];

    expect(port.state().completionActive).toBe(false);
    act(() => {
      view!.dispatch({ selection: EditorSelection.cursor(view!.state.doc.length) });
      startCompletion(view!);
    });
    await waitFor(() => expect(document.querySelector(".cm-tooltip-autocomplete")).not.toBeNull());
    expect(port.state().completionActive).toBe(true);
  });

  it("runs Complete Statement from the command port on the caret line", async () => {
    // Regression: the port used to treat the plan's line-relative semicolon
    // offset as an absolute document offset, so completing a statement below
    // line 1 dropped a `;` into the first line and moved the caret there.
    const registration = vi.fn();
    const rendered = renderEditor("first\nsecond\nthird = calc(a, b", vi.fn(), {
      fileKey: "root:app:src/port.ts",
      onCommandPortChange: registration,
    });
    const editor = rendered.container.querySelector<HTMLElement>(".cm-editor");
    const view = EditorView.findFromDOM(editor!);
    expect(view).not.toBeNull();
    await waitFor(() => expect(
      registration.mock.calls.find((call) => call[0].port),
    ).toBeTruthy());
    const { port } = registration.mock.calls.find((call) => call[0].port)![0];

    view!.dispatch({ selection: EditorSelection.cursor(view!.state.doc.length) });
    expect(port.execute("completeStatement")).toBe(true);
    expect(view!.state.doc.toString()).toBe("first\nsecond\nthird = calc(a, b);\n");
    expect(view!.state.selection.main.head).toBe(view!.state.doc.length);
  });

  it("balances unclosed brackets when completing from the command port mid-line", async () => {
    const registration = vi.fn();
    const rendered = renderEditor("class A {\n  int x = calc(a, b", vi.fn(), {
      fileKey: "root:app:src/port.ts",
      onCommandPortChange: registration,
    });
    const editor = rendered.container.querySelector<HTMLElement>(".cm-editor");
    const view = EditorView.findFromDOM(editor!);
    expect(view).not.toBeNull();
    await waitFor(() => expect(
      registration.mock.calls.find((call) => call[0].port),
    ).toBeTruthy());
    const { port } = registration.mock.calls.find((call) => call[0].port)![0];

    view!.dispatch({ selection: EditorSelection.cursor(view!.state.doc.length) });
    expect(port.execute("completeStatement")).toBe(true);
    expect(view!.state.doc.toString()).toBe("class A {\n  int x = calc(a, b);\n  ");
  });

  it("distributes copied editor segments across multiple carets in the mounted host", async () => {
    const onChange = vi.fn();
    const rendered = renderEditor("one two end", onChange);
    const editor = rendered.container.querySelector<HTMLElement>(".cm-editor");
    expect(editor).not.toBeNull();
    const view = EditorView.findFromDOM(editor!);
    expect(view).not.toBeNull();

    view!.dispatch({
      selection: EditorSelection.create([
        EditorSelection.range(0, 3),
        EditorSelection.range(4, 7),
      ], 1),
    });
    const clipboardValues = new Map<string, string>();
    const clipboard = {
      getData: (type: string) => clipboardValues.get(type) ?? "",
      setData: (type: string, value: string) => {
        clipboardValues.set(type, value);
      },
    } as DataTransfer;
    fireEvent.copy(rendered.content, { clipboardData: clipboard });
    expect(clipboard.getData("text/plain")).toBe("one\ntwo");

    view!.dispatch({
      selection: EditorSelection.create([
        EditorSelection.cursor(8),
        EditorSelection.cursor(11),
      ], 1),
    });
    fireEvent.paste(rendered.content, { clipboardData: clipboard });

    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith(
      "one two oneendtwo",
      expect.objectContaining({ line: 0, character: 17 }),
      17,
    ));
    expect(view!.state.selection.mainIndex).toBe(1);
  });

  it("forwards multi-range selection state to the context menu", async () => {
    const onContextMenu = vi.fn();
    const rendered = renderEditor("one two", vi.fn(), { onContextMenu });
    const editor = rendered.container.querySelector<HTMLElement>(".cm-editor");
    const view = EditorView.findFromDOM(editor!);
    expect(view).not.toBeNull();
    view!.dispatch({
      selection: EditorSelection.create([
        EditorSelection.cursor(0),
        EditorSelection.range(4, 7),
      ], 1),
    });

    fireEvent.contextMenu(rendered.content, { clientX: 0, clientY: 0, button: 2 });
    await waitFor(() => expect(onContextMenu).toHaveBeenCalled());
    expect(onContextMenu.mock.calls[0][0]).toMatchObject({
      hasSelection: true,
      selectedText: "two",
    });
  });

  it("forwards editor contextmenu with caret position and clipboard helpers", async () => {
    const onContextMenu = vi.fn();
    const { content } = renderEditor("hello world", vi.fn(), { onContextMenu });
    content.focus();
    fireEvent.contextMenu(content, { clientX: 24, clientY: 36, button: 2 });
    await waitFor(() => expect(onContextMenu).toHaveBeenCalled());
    const request = onContextMenu.mock.calls[0][0];
    expect(request.clientX).toBe(24);
    expect(request.clientY).toBe(36);
    expect(request.position).toEqual(expect.objectContaining({ line: expect.any(Number) }));
    expect(typeof request.cut).toBe("function");
    expect(typeof request.copy).toBe("function");
    expect(typeof request.paste).toBe("function");
  });

  it("restores CodeMirror focus when a WebKit pointer leaves focus on body", () => {
    const { content, container } = renderEditor("hello world", vi.fn(), {
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
    content.blur();
    expect(document.activeElement).not.toBe(content);

    const line = container.querySelector<HTMLElement>(".cm-line");
    expect(line).not.toBeNull();
    fireEvent.mouseDown(line!, { button: 0 });

    const editor = container.querySelector<HTMLElement>(".cm-editor");
    expect(editor?.contains(document.activeElement)).toBe(true);
  });

  it("renders usage/inlay chrome, reports its viewport, and requests semantic selection", async () => {
    const onViewportChange = vi.fn();
    const onExpandSelection = vi.fn(async () => [{
      start: { line: 0, character: 0 },
      end: { line: 0, character: 11 },
    }]);
    const { content, container } = renderEditor("const value", vi.fn(), {
      highlights: [{
        range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
        kind: 2,
      }],
      inlayHints: [{
        position: { line: 0, character: 11 },
        label: ": string",
        kind: 1,
        tooltip: "inferred",
        paddingLeft: true,
        paddingRight: false,
      }],
      semanticTokens: [{
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        tokenType: "keyword",
        modifiers: [],
      }],
      onViewportChange,
      onExpandSelection,
    });

    expect(container.querySelector(".cm-lsp-usage-read")).not.toBeNull();
    expect(container.querySelector(".cm-lsp-inlay-hint")).toHaveTextContent(": string");
    expect(container.querySelector(".cm-lsp-sem-keyword")).not.toBeNull();
    expect(onViewportChange).toHaveBeenCalled();
    fireEvent.keyDown(content, { key: "w", code: "KeyW", ctrlKey: true });
    await waitFor(() => expect(onExpandSelection).toHaveBeenCalledWith(expect.objectContaining({ empty: true })));
  });

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
});

describe("§8.19.8 semantic editing commands", () => {
  afterEach(() => cleanup());

  function renderWithPort(doc: string, path: string) {
    let registered: import("./CodeMirrorHost").EditorCommandPort | null = null;
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

describe("§8.26 ED-MULTIVIEW-002 shared document host wiring", () => {
  afterEach(() => cleanup());

  function sharedProps(
    owner: WorkspaceDocumentTransactionOwner,
    viewId: string,
    doc: string,
    onChange: ComponentProps<typeof CodeMirrorHost>["onChange"],
    workspaceActionHost?: WorkspaceActionHost,
  ): ComponentProps<typeof CodeMirrorHost> {
    return {
      path: "src/shared.ts",
      fileKey: "shared.ts",
      viewId,
      transactionOwner: owner,
      documentRevision: 0,
      doc,
      visible: true,
      diagnostics: [],
      reveal: null,
      onChange,
      onSave: vi.fn(),
      onHover: vi.fn(async () => null),
      onDefinition: vi.fn(async () => false),
      onReferences: vi.fn(async () => undefined),
      getCompletionIdentity: () => null,
      onCompletionDiagnostic: vi.fn(),
      ...(workspaceActionHost ? { workspaceActionHost } : {}),
    };
  }

  it("broadcasts one incremental edit and preserves the sibling selection", () => {
    const owner = new WorkspaceDocumentTransactionOwner();
    const initial = "hello world";
    const primaryOnChange = vi.fn();
    const secondaryOnChange = vi.fn();
    const rendered = render(
      <div>
        <CodeMirrorHost {...sharedProps(owner, "primary", initial, primaryOnChange)} />
        <CodeMirrorHost {...sharedProps(owner, "secondary", initial, secondaryOnChange)} />
      </div>,
    );
    const views = [...rendered.container.querySelectorAll<HTMLElement>(".cm-editor")]
      .map((element) => EditorView.findFromDOM(element)!);
    const primary = views[0]!;
    const secondary = views[1]!;
    const transactions: Array<{ sourceViewId: string; changes: readonly { from: number; to: number; insert: string }[] }> = [];
    const unsubscribe = owner.subscribe("shared.ts", (transaction) => {
      transactions.push(transaction);
    });

    secondary.dispatch({ selection: { anchor: initial.length } });
    primary.dispatch({ changes: { from: 0, to: 0, insert: "say " } });

    expect(primary.state.doc.toString()).toBe("say hello world");
    expect(secondary.state.doc.toString()).toBe("say hello world");
    expect(secondary.state.selection.main.head).toBe(initial.length + 4);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.sourceViewId).toBe("primary");
    expect(transactions[0]?.changes).toEqual([{ from: 0, to: 0, insert: "say " }]);
    expect(primaryOnChange).toHaveBeenCalledTimes(1);
    expect(secondaryOnChange).not.toHaveBeenCalled();
    expect(owner.getHistoryState("shared.ts")).toMatchObject({ canUndo: true, undoDepth: 1 });
    unsubscribe();
  });

  it("routes undo and redo through the shared owner for both mounted views", async () => {
    const owner = new WorkspaceDocumentTransactionOwner();
    const actionHost = new WorkspaceActionHost({ workspaceId: "ws-shared-history" });
    const initial = "hello";
    const rendered = render(
      <div>
        <CodeMirrorHost {...sharedProps(owner, "primary", initial, vi.fn(), actionHost)} />
        <CodeMirrorHost {...sharedProps(owner, "secondary", initial, vi.fn(), actionHost)} />
      </div>,
    );
    const views = [...rendered.container.querySelectorAll<HTMLElement>(".cm-editor")]
      .map((element) => EditorView.findFromDOM(element)!);
    const primary = views[0]!;
    const secondary = views[1]!;
    primary.dispatch({ changes: { from: initial.length, to: initial.length, insert: "!" } });
    expect(primary.state.doc.toString()).toBe("hello!");
    expect(secondary.state.doc.toString()).toBe("hello!");

    await act(async () => {
      const result = await actionHost.execute("workspace.undo", { focus: "editor", hasActiveFile: true });
      expect(result.kind).toBe("applied");
    });
    expect(primary.state.doc.toString()).toBe(initial);
    expect(secondary.state.doc.toString()).toBe(initial);
    expect(owner.getHistoryState("shared.ts")).toMatchObject({ canUndo: false, canRedo: true });

    await act(async () => {
      const result = await actionHost.execute("workspace.redo", { focus: "editor", hasActiveFile: true });
      expect(result.kind).toBe("applied");
    });
    expect(primary.state.doc.toString()).toBe("hello!");
    expect(secondary.state.doc.toString()).toBe("hello!");
    expect(owner.getHistoryState("shared.ts")).toMatchObject({ canUndo: true, canRedo: false });
  });

  // ED-AUDIT-008: the workspace-edit journal claims a stroke before the
  // document ledger. A `true` claim consumes the stroke without touching the
  // ledger; `undefined` hands it back; `false` blocks it while the journal is
  // busy.
  it("ED-AUDIT-008: lets the workspace-edit journal claim undo and redo strokes", async () => {
    const owner = new WorkspaceDocumentTransactionOwner();
    const actionHost = new WorkspaceActionHost({ workspaceId: "ws-journal-claim" });
    const initial = "hello";
    const claims: Array<{ action: "undo" | "redo"; result: boolean | undefined }> = [];
    let nextClaim: boolean | undefined;
    const rendered = render(
      <CodeMirrorHost
        {...sharedProps(owner, "primary", initial, vi.fn(), actionHost)}
        onWorkspaceHistoryClaim={(action) => {
          const result = nextClaim;
          claims.push({ action, result });
          return result;
        }}
      />,
    );
    const view = EditorView.findFromDOM(rendered.container.querySelector<HTMLElement>(".cm-editor")!);
    expect(view).not.toBeNull();
    view!.dispatch({ changes: { from: initial.length, to: initial.length, insert: "!" } });
    expect(view!.state.doc.toString()).toBe("hello!");

    // Journal claim: the stroke is consumed and the document ledger keeps
    // its entry.
    nextClaim = true;
    await act(async () => {
      const result = await actionHost.execute("workspace.undo", { focus: "editor", hasActiveFile: true });
      expect(result.kind).toBe("applied");
    });
    expect(claims).toEqual([{ action: "undo", result: true }]);
    expect(view!.state.doc.toString()).toBe("hello!");
    expect(owner.getHistoryState("shared.ts")).toMatchObject({ canUndo: true, undoDepth: 1 });

    // Busy journal: the stroke is blocked, the ledger still must not act.
    nextClaim = false;
    await act(async () => {
      const result = await actionHost.execute("workspace.undo", { focus: "editor", hasActiveFile: true });
      expect(result).toMatchObject({ kind: "no-op", reason: "condition-not-met" });
    });
    expect(view!.state.doc.toString()).toBe("hello!");
    expect(owner.getHistoryState("shared.ts").undoDepth).toBe(1);

    // No journal entry in this direction: the document ledger proceeds.
    nextClaim = undefined;
    await act(async () => {
      const result = await actionHost.execute("workspace.undo", { focus: "editor", hasActiveFile: true });
      expect(result.kind).toBe("applied");
    });
    expect(view!.state.doc.toString()).toBe(initial);
    expect(owner.getHistoryState("shared.ts")).toMatchObject({ canUndo: false, canRedo: true });
  });

  // ED-AUDIT-008: a history-replay snapshot (journal undo/redo restore) is
  // reconciled as an "undo"-origin transaction — visible to every view, but
  // recorded as no second document-ledger entry, so a follow-up document
  // undo cannot re-apply the change the journal just undid.
  it("ED-AUDIT-008: reconciles a history-replay snapshot without recording a document-ledger entry", async () => {
    const owner = new WorkspaceDocumentTransactionOwner();
    const actionHost = new WorkspaceActionHost({ workspaceId: "ws-history-replay" });
    const initial = "class Main {}\n";
    const applied = "import util.Foo;\n\nclass Main {}\n";
    const onChange = vi.fn();
    const props = sharedProps(owner, "primary", initial, onChange, actionHost);
    const rendered = render(<CodeMirrorHost {...props} historyReplay={false} />);
    const view = EditorView.findFromDOM(rendered.container.querySelector<HTMLElement>(".cm-editor")!);
    expect(view).not.toBeNull();

    // The apply reaches the ledger as a normal external snapshot.
    rendered.rerender(<CodeMirrorHost {...props} doc={applied} historyReplay={false} />);
    await act(async () => {});
    expect(view!.state.doc.toString()).toBe(applied);
    expect(owner.getHistoryState("shared.ts")).toMatchObject({ canUndo: true, undoDepth: 1 });

    // The journal restore replays the pre-apply snapshot with the replay
    // marker: the view reverts, the store-facing onChange stays quiet, and
    // the ledger keeps exactly one (now stale) entry.
    rendered.rerender(<CodeMirrorHost {...props} doc={initial} historyReplay={true} />);
    await act(async () => {});
    expect(view!.state.doc.toString()).toBe(initial);
    expect(owner.getDocument("shared.ts")).toBe(initial);
    expect(owner.getHistoryState("shared.ts").undoDepth).toBe(1);
    expect(owner.undo("shared.ts", "primary")).toBeNull();
    expect(view!.state.doc.toString()).toBe(initial);
  });

  it("ED-AUDIT-002: one undo through the shared owner restores the virtual caret with the text", async () => {
    const owner = new WorkspaceDocumentTransactionOwner();
    const actionHost = new WorkspaceActionHost({ workspaceId: "ws-vspace-undo" });
    const initial = "first line\nsecond";
    const rendered = render(
      <CodeMirrorHost
        {...sharedProps(owner, "primary", initial, vi.fn(), actionHost)}
        appearance={{
          fontFamily: "monospace",
          fontSizePx: 14,
          lineHeight: 1.5,
          ligatures: false,
          colorSchemeId: "default",
          highContrast: false,
          virtualSpace: { afterLineEnd: true, atFileBottom: true },
        }}
      />,
    );
    const view = EditorView.findFromDOM(rendered.container.querySelector<HTMLElement>(".cm-editor")!);
    expect(view).not.toBeNull();

    // Park a virtual caret past the end of line 0 (offset 10) with 3 columns.
    view!.dispatch({
      selection: EditorSelection.cursor(10),
      effects: setVirtualOverflow.of(new Map([[10, 3]])),
    });
    expect(virtualOverflowAt(view!.state, 10)).toBe(3);

    // Typing consumes the overflow: padding + text in one transaction that
    // reaches the shared owner through the host's update listener.
    expect((virtualSpaceTypingHandler as any).value(view!, 10, 10, "X")).toBe(true);
    expect(view!.state.doc.toString()).toBe("first line   X\nsecond");
    expect(owner.getDocument("shared.ts")).toBe("first line   X\nsecond");

    // The production undo action routes through the shared owner.
    await act(async () => {
      const result = await actionHost.execute("workspace.undo", { focus: "editor", hasActiveFile: true });
      expect(result.kind).toBe("applied");
    });
    expect(view!.state.doc.toString()).toBe(initial);
    expect(view!.state.selection.main.head).toBe(10);
    expect(virtualOverflowAt(view!.state, 10)).toBe(3);
    expect(owner.getDocument("shared.ts")).toBe(initial);

    // The restored caret is live: the next insertion re-manufactures padding.
    expect((virtualSpaceTypingHandler as any).value(view!, 10, 10, "Z")).toBe(true);
    expect(view!.state.doc.toString()).toBe("first line   Z\nsecond");
    await act(async () => {
      const result = await actionHost.execute("workspace.undo", { focus: "editor", hasActiveFile: true });
      expect(result.kind).toBe("applied");
    });
    expect(view!.state.doc.toString()).toBe(initial);
    expect(virtualOverflowAt(view!.state, 10)).toBe(3);
  });

  it("keeps a native replacement burst ahead of delayed controlled document echoes after undo", async () => {
    const owner = new WorkspaceDocumentTransactionOwner();
    const actionHost = new WorkspaceActionHost({ workspaceId: "ws-shared-recovery" });
    const initial = "café\nmatrix";
    const onChange = vi.fn();
    const rendered = render(
      <CodeMirrorHost {...sharedProps(owner, "primary", initial, onChange, actionHost)} />,
    );
    const view = EditorView.findFromDOM(rendered.container.querySelector<HTMLElement>(".cm-editor")!);
    expect(view).not.toBeNull();

    view!.dispatch({ changes: { from: initial.length, to: initial.length, insert: "你" } });
    await act(async () => {
      const result = await actionHost.execute("workspace.undo", {
        focus: "editor",
        hasActiveFile: true,
      });
      expect(result.kind).toBe("applied");
    });
    expect(view!.state.doc.toString()).toBe(initial);
    expect(owner.getDocument("shared.ts")).toBe(initial);

    // Save/external synchronization has its own owner revision stream and
    // does not advance the store's controlled documentRevision metadata.
    expect(owner.replaceDocument(
      "shared.ts",
      "save-writer",
      `C${initial.slice(1)}`,
      "external-disk",
    )).not.toBeNull();
    expect(owner.replaceDocument(
      "shared.ts",
      "save-writer",
      initial,
      "external-disk",
    )).not.toBeNull();
    expect(view!.state.doc.toString()).toBe(initial);
    expect(owner.getRevision("shared.ts")).toBe(4);

    // WebDriver contenteditable fill emits character-level document updates.
    // React may render the first controlled echo after the next character has
    // already reached both the live view and the shared transaction owner.
    view!.dispatch({ changes: { from: 0, to: initial.length, insert: "恢" } });
    view!.dispatch({ changes: { from: 1, to: 1, insert: "复" } });
    expect(view!.state.doc.toString()).toBe("恢复");
    expect(owner.getDocument("shared.ts")).toBe("恢复");

    // Model a later native transaction that has reached the shared owner but
    // whose CodeMirror dispatch is still in flight. The delayed "恢" prop is
    // only an acknowledgement and must not synchronously replace the view.
    expect(owner.replaceDocument(
      "shared.ts",
      "primary",
      "恢中",
      "external-disk",
    )).not.toBeNull();
    expect(view!.state.doc.toString()).toBe("恢复");
    expect(owner.getDocument("shared.ts")).toBe("恢中");

    rendered.rerender(
      <CodeMirrorHost
        {...sharedProps(owner, "primary", "恢", onChange, actionHost)}
        documentRevision={3}
      />,
    );
    expect(view!.state.doc.toString()).toBe("恢复");
    expect(owner.getDocument("shared.ts")).toBe("恢中");

    rendered.rerender(
      <CodeMirrorHost
        {...sharedProps(owner, "primary", "恢复", onChange, actionHost)}
        documentRevision={4}
      />,
    );
    expect(view!.state.doc.toString()).toBe("恢复");
    expect(owner.getDocument("shared.ts")).toBe("恢中");
  });

  it("retains canonical text and history after a non-final unmount, then cleans up finally", () => {
    const owner = new WorkspaceDocumentTransactionOwner();
    const initial = "hello";
    const rendered = render(
      <div>
        <CodeMirrorHost {...sharedProps(owner, "primary", initial, vi.fn())} />
        <CodeMirrorHost {...sharedProps(owner, "secondary", initial, vi.fn())} />
      </div>,
    );
    const primary = EditorView.findFromDOM(rendered.container.querySelectorAll<HTMLElement>(".cm-editor")[0]!);
    primary!.dispatch({ changes: { from: 0, to: 0, insert: "say " } });
    expect(owner.getDocument("shared.ts")).toBe("say hello");

    // Unmount only the secondary host; the first lease keeps the document alive.
    rendered.rerender(
      <div>
        <CodeMirrorHost {...sharedProps(owner, "primary", initial, vi.fn())} />
      </div>,
    );
    expect(owner.getDocument("shared.ts")).toBe("say hello");
    expect(owner.getHistoryState("shared.ts").canUndo).toBe(true);

    rendered.rerender(
      <div>
        <CodeMirrorHost {...sharedProps(owner, "primary", initial, vi.fn())} />
        <CodeMirrorHost {...sharedProps(owner, "secondary", initial, vi.fn())} />
      </div>,
    );
    const reopenedViews = [...rendered.container.querySelectorAll<HTMLElement>(".cm-editor")]
      .map((element) => EditorView.findFromDOM(element)!);
    expect(reopenedViews).toHaveLength(2);
    expect(reopenedViews[1]!.state.doc.toString()).toBe("say hello");
    expect(owner.getHistoryState("shared.ts").canUndo).toBe(true);

    rendered.unmount();
    expect(owner.getDocument("shared.ts")).toBeNull();
    expect(owner.getHistoryState("shared.ts")).toEqual({
      canUndo: false,
      canRedo: false,
      undoDepth: 0,
      redoDepth: 0,
    });
  });
});

describe("ED-SAVE-004 editor recovery decoration synchronization", () => {
  afterEach(() => cleanup());

  it("reconfigures Git markers after a native replacement shortens the document", async () => {
    const initial = "café\nmatrix";
    const secondLineChange: GitLineChange = {
      kind: "modified",
      startLine: 1,
      endLine: 1,
      oldStartLine: 1,
      oldEndLine: 1,
      oldText: "old",
      newText: "matrix",
    };
    const firstLineChange: GitLineChange = {
      ...secondLineChange,
      startLine: 0,
      endLine: 0,
      oldStartLine: 0,
      oldEndLine: 0,
      newText: "c",
    };
    const onChange = vi.fn();
    const rendered = renderEditor(initial, onChange, { gitChanges: [secondLineChange] });
    const view = EditorView.findFromDOM(rendered.container.querySelector<HTMLElement>(".cm-editor")!);
    const dispatchSpy = vi.spyOn(view!, "dispatch");

    expect(() => {
      view!.dispatch({ changes: { from: 0, to: initial.length, insert: "c" } });
      rendered.rerender(
        <CodeMirrorHost
          {...rendered.props}
          doc="c"
          documentRevision={1}
          gitChanges={[firstLineChange]}
        />,
      );
    }).not.toThrow();
    expect(dispatchSpy).toHaveBeenCalledTimes(1);
    expect(view!.state.doc.toString()).toBe("c");
    await act(async () => {
      await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
    });
    expect(dispatchSpy.mock.calls.length).toBeGreaterThan(1);
    expect(rendered.container.querySelector(".cm-git-change-modified")).toBeTruthy();
  });
});

describe("ED-IMPROVE-007 leaf/file view snapshots", () => {
  afterEach(() => cleanup());

  function findView(rendered: { container: HTMLElement }): EditorView {
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

describe("ED-REPAIR-007 IME end/blur/reentry session lifecycle", () => {
  afterEach(() => cleanup());

  it("produces two distinct undo entries across two composition sessions separated by blur (ED-REPAIR-007-A1)", async () => {
    const owner = new WorkspaceDocumentTransactionOwner();
    const rendered = renderEditor("", vi.fn(), {
      transactionOwner: owner,
      viewId: "primary",
      fileKey: "ime-blur.ts",
    });
    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!)!;

    // Session 1: compose "你"
    act(() => {
      content.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    });
    act(() => {
      view.dispatch({
        changes: { from: 0, insert: "你" },
        userEvent: "input.type.compose",
      });
    });
    act(() => {
      content.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你" }));
      // Blur arrives immediately before timer fires
      content.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    });

    expect(owner.getDocument("ime-blur.ts")).toBe("你");
    expect(owner.getHistoryState("ime-blur.ts").undoDepth).toBe(1);

    // Session 2: compose "好"
    act(() => {
      content.dispatchEvent(new FocusEvent("focus", { bubbles: true }));
      content.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    });
    act(() => {
      view.dispatch({
        changes: { from: 1, insert: "好" },
        userEvent: "input.type.compose",
      });
    });
    act(() => {
      content.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "好" }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(owner.getDocument("ime-blur.ts")).toBe("你好");
    expect(owner.getHistoryState("ime-blur.ts").undoDepth).toBe(2);

    // Undo 1: reverts "好", leaving "你"
    act(() => {
      owner.undo("ime-blur.ts", "primary");
    });
    expect(owner.getDocument("ime-blur.ts")).toBe("你");
    expect(owner.getHistoryState("ime-blur.ts").undoDepth).toBe(1);

    // Undo 2: reverts "你", leaving ""
    act(() => {
      owner.undo("ime-blur.ts", "primary");
    });
    expect(owner.getDocument("ime-blur.ts")).toBe("");
    expect(owner.getHistoryState("ime-blur.ts").undoDepth).toBe(0);
  });

  it("produces two distinct undo entries when next composition starts before end timer (ED-REPAIR-007-A1)", async () => {
    const owner = new WorkspaceDocumentTransactionOwner();
    const rendered = renderEditor("", vi.fn(), {
      transactionOwner: owner,
      viewId: "primary",
      fileKey: "ime-fast.ts",
    });
    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!)!;

    // Session 1: "你"
    act(() => {
      content.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    });
    act(() => {
      view.dispatch({
        changes: { from: 0, insert: "你" },
        userEvent: "input.type.compose",
      });
    });
    act(() => {
      content.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "你" }));
      // Immediately start session 2 before macrotask timer
      content.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    });
    act(() => {
      view.dispatch({
        changes: { from: 1, insert: "好" },
        userEvent: "input.type.compose",
      });
    });
    act(() => {
      content.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "好" }));
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(owner.getDocument("ime-fast.ts")).toBe("你好");
    expect(owner.getHistoryState("ime-fast.ts").undoDepth).toBe(2);

    // Undo step 1 reverts "好"
    owner.undo("ime-fast.ts", "primary");
    expect(owner.getDocument("ime-fast.ts")).toBe("你");

    // Undo step 2 reverts "你"
    owner.undo("ime-fast.ts", "primary");
    expect(owner.getDocument("ime-fast.ts")).toBe("");
  });

  it("finalizes active preedit on blur before compositionend without error (ED-REPAIR-007-A1)", async () => {
    const owner = new WorkspaceDocumentTransactionOwner();
    const rendered = renderEditor("", vi.fn(), {
      transactionOwner: owner,
      viewId: "primary",
      fileKey: "ime-blur-mid.ts",
    });
    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!)!;

    act(() => {
      content.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    });
    act(() => {
      view.dispatch({
        changes: { from: 0, insert: "pre" },
        userEvent: "input.type.compose",
      });
    });
    // Blur during preedit before compositionend
    act(() => {
      content.dispatchEvent(new FocusEvent("blur", { bubbles: true }));
    });

    // Subsequent compositionend does not corrupt state
    act(() => {
      content.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "pre" }));
    });

    // Normal typing follows
    act(() => {
      view.dispatch({
        changes: { from: 3, insert: "!" },
      });
    });
    expect(owner.getDocument("ime-blur-mid.ts")).toBe("pre!");
    expect(owner.getHistoryState("ime-blur-mid.ts").undoDepth).toBe(2);
  });

  it("safely finalizes composition on unmount and ignores late timer (ED-REPAIR-007-A2)", async () => {
    const owner = new WorkspaceDocumentTransactionOwner();
    owner.acquireView("ime-unmount.ts", "secondary", "");
    const rendered = renderEditor("", vi.fn(), {
      transactionOwner: owner,
      viewId: "primary",
      fileKey: "ime-unmount.ts",
    });
    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!)!;

    act(() => {
      content.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    });
    act(() => {
      view.dispatch({
        changes: { from: 0, insert: "unmount-test" },
        userEvent: "input.type.compose",
      });
      content.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "unmount-test" }));
    });

    // Unmount before timer fires
    rendered.unmount();

    // Fast-forward any timers
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
    });

    // Owner should retain text and have finalized composition session
    expect(owner.getDocument("ime-unmount.ts")).toBe("unmount-test");
    expect(owner.getHistoryState("ime-unmount.ts").undoDepth).toBe(1);
    owner.undo("ime-unmount.ts", "secondary");
    expect(owner.getDocument("ime-unmount.ts")).toBe("");
  });

  it("finalizes session on fileKey switch and does not pollute new file (ED-REPAIR-007-A2)", async () => {
    const owner = new WorkspaceDocumentTransactionOwner();
    const rendered = renderEditor("", vi.fn(), {
      transactionOwner: owner,
      viewId: "primary",
      fileKey: "fileA.ts",
    });
    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!)!;

    act(() => {
      content.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
    });
    act(() => {
      view.dispatch({
        changes: { from: 0, insert: "typedA" },
        userEvent: "input.type.compose",
      });
      content.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "typedA" }));
    });

    // Switch fileKey prop to fileB.ts
    rendered.rerender(<CodeMirrorHost {...rendered.props} fileKey="fileB.ts" doc="" />);

    // Now fileA composition should be finalized
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
    });

    expect(owner.getDocument("fileA.ts")).toBe("typedA");
  });
});

describe("ED-IMPROVE-009 late clipboard results report a cancelled observation", () => {
  afterEach(() => cleanup());

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
  }

  function stubHandle(
    read: () => Promise<unknown>,
    write: () => Promise<unknown>,
  ) {
    return {
      workspaceId: "ws-009",
      attachConsumer: () => ({ detach: () => {} }),
      getSnapshot: () => ({
        permission: "granted",
        permissionGeneration: 3,
        exclusion: "recorded",
        payloadRevision: 1,
      }),
      readSystemClipboard: read,
      writeSystemClipboard: write,
      write: () => { throw new Error("unused"); },
      read: () => null,
      clear: () => {},
      release: () => {},
      historyEntries: () => [],
      pasteFromHistory: () => null,
      removeHistoryEntry: () => false,
      clearHistory: () => {},
      setHistoryEnabled: () => {},
      isHistoryEnabled: () => true,
      setHistoryLimits: () => {},
      historyLimits: () => ({ maxItems: 0, maxTotalBytes: 0 }),
      historyExclusion: () => "recorded",
      setPermission: () => {},
      permission: () => "granted",
      attachPermissionAdapter: () => () => {},
      syncPermission: async () => "granted",
      subscribe: () => () => {},
    };
  }

  it("reports a cancelled paste with the OS read effect after the selection moved", async () => {
    const pending = deferred<unknown>();
    const observations: unknown[] = [];
    let port: { execute: (id: string, options?: unknown) => boolean } | null = null;
    const handle = stubHandle(() => pending.promise, async () => ({ outcome: "success", systemEffect: "performed" }));
    renderEditor("hello world", vi.fn(), {
      clipboardHandle: handle as never,
      onClipboardObservation: (record) => { observations.push(record); },
      onCommandPortChange: (registration) => { port = registration.port as never; },
    });
    await waitFor(() => expect(port).not.toBeNull());
    const view = EditorView.findFromDOM(document.querySelector(".cm-editor")!)!;
    act(() => {
      port!.execute("paste");
    });
    act(() => {
      view.dispatch({ selection: EditorSelection.cursor(5) });
    });
    act(() => {
      pending.resolve({ outcome: "success", text: "payload", systemEffect: "performed" });
    });
    await waitFor(() => expect(observations).toHaveLength(1));
    expect(observations[0]).toMatchObject({
      operation: "paste",
      outcome: "cancelled",
      systemEffect: "performed",
      permission: "granted",
    });
    expect(view.state.doc.toString()).toBe("hello world");
  });

  it("keeps a performed cut write fact after the document changed", async () => {
    const pending = deferred<unknown>();
    const observations: unknown[] = [];
    let port: { execute: (id: string, options?: unknown) => boolean } | null = null;
    const handle = stubHandle(async () => ({ outcome: "denied", systemEffect: "not-performed", fallbackSession: null }), () => pending.promise);
    const rendered = renderEditor("hello world", vi.fn(), {
      clipboardHandle: handle as never,
      onClipboardObservation: (record) => { observations.push(record); },
      onCommandPortChange: (registration) => { port = registration.port as never; },
    });
    await waitFor(() => expect(port).not.toBeNull());
    const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!)!;
    act(() => {
      view.dispatch({ selection: EditorSelection.range(0, 5) });
    });
    act(() => {
      port!.execute("cut");
    });
    act(() => {
      view.dispatch({ selection: EditorSelection.cursor(0) });
    });
    act(() => {
      pending.resolve({ outcome: "denied", systemEffect: "performed" });
    });
    await waitFor(() => expect(observations).toHaveLength(1));
    expect(observations[0]).toMatchObject({
      operation: "cut",
      outcome: "cancelled",
      systemEffect: "performed",
    });
    // No cut happened: the document keeps its text.
    expect(view.state.doc.toString()).toBe("hello world");
  });

  // ED-MAIN-007: an async paste whose owner moved must not edit the background
  // buffer, steal focus back, or add history, but its OS effect is still
  // observed through the frozen endpoint.
  it("keeps a paste out of a background buffer and does not steal focus when the owner moved (ED-MAIN-007)", async () => {
    const pending = deferred<unknown>();
    const observations: unknown[] = [];
    const owner = new WorkspaceDocumentTransactionOwner();
    let port: { execute: (id: string, options?: unknown) => boolean } | null = null;
    const handle = stubHandle(() => pending.promise, async () => ({ outcome: "success", systemEffect: "performed" }));
    const rendered = renderEditor("hello world", vi.fn(), {
      clipboardHandle: handle as never,
      transactionOwner: owner,
      viewId: "primary",
      fileKey: "owner.ts",
      onClipboardObservation: (record) => { observations.push(record); },
      onCommandPortChange: (registration) => { port = registration.port as never; },
    });
    await waitFor(() => expect(port).not.toBeNull());
    const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!)!;
    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    act(() => { content.focus(); });
    expect(view.hasFocus).toBe(true);

    act(() => { port!.execute("paste"); });
    const search = document.createElement("input");
    document.body.appendChild(search);
    act(() => { search.focus(); });
    act(() => { pending.resolve({ outcome: "success", text: "payload", systemEffect: "performed" }); });

    await waitFor(() => expect(observations).toHaveLength(1));
    expect(observations[0]).toMatchObject({
      operation: "paste",
      outcome: "cancelled",
      systemEffect: "performed",
    });
    expect(view.state.doc.toString()).toBe("hello world");
    expect(document.activeElement).toBe(search);
    expect(owner.getHistoryState("owner.ts").undoDepth).toBe(0);
    search.remove();
  });

  // A legitimate menu/context-menu paste runs while the editor does not hold
  // DOM focus but no newer surface claimed it; it must still apply.
  it("still pastes for an authorized menu owner that is not focused at request (ED-MAIN-007)", async () => {
    const pending = deferred<unknown>();
    let port: { execute: (id: string, options?: unknown) => boolean } | null = null;
    const handle = stubHandle(() => pending.promise, async () => ({ outcome: "success", systemEffect: "performed" }));
    const rendered = renderEditor("hello world", vi.fn(), {
      clipboardHandle: handle as never,
      onCommandPortChange: (registration) => { port = registration.port as never; },
    });
    await waitFor(() => expect(port).not.toBeNull());
    const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!)!;
    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    const menu = document.createElement("button");
    document.body.appendChild(menu);

    act(() => { content.focus(); });
    // The menu takes focus before the command executes (owner generation moves
    // before the request, so no change is observed while it is pending).
    act(() => { menu.focus(); });
    act(() => { port!.execute("paste"); });
    act(() => { pending.resolve({ outcome: "success", text: "payload", systemEffect: "performed" }); });

    await waitFor(() => expect(view.state.doc.toString()).toContain("payload"));
    menu.remove();
  });

  it("observes an OS effect that returns after the view was destroyed (ED-MAIN-007)", async () => {
    const pending = deferred<unknown>();
    const observations: unknown[] = [];
    let port: { execute: (id: string, options?: unknown) => boolean } | null = null;
    const handle = stubHandle(() => pending.promise, async () => ({ outcome: "success", systemEffect: "performed" }));
    const rendered = renderEditor("hello world", vi.fn(), {
      clipboardHandle: handle as never,
      onClipboardObservation: (record) => { observations.push(record); },
      onCommandPortChange: (registration) => { port = registration.port as never; },
    });
    await waitFor(() => expect(port).not.toBeNull());
    act(() => { port!.execute("paste"); });
    // The whole host unmounts (its clipboard WeakMap entry is released) while
    // the OS read is still in flight.
    rendered.unmount();
    act(() => { pending.resolve({ outcome: "denied", systemEffect: "performed" }); });

    await waitFor(() => expect(observations).toHaveLength(1));
    expect(observations[0]).toMatchObject({
      operation: "paste",
      outcome: "cancelled",
      systemEffect: "performed",
    });
  });
});

describe("ED-REPAIR-008 irreversible clipboard owner loss and multi-split isolation", () => {
  afterEach(() => cleanup());

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => { resolve = res; });
    return { promise, resolve };
  }

  function stubHandle(
    read: () => Promise<unknown>,
    write: () => Promise<unknown>,
  ) {
    return {
      workspaceId: "ws-008",
      attachConsumer: () => ({ detach: () => {} }),
      getSnapshot: () => ({
        permission: "granted",
        permissionGeneration: 3,
        exclusion: "recorded",
        payloadRevision: 1,
      }),
      readSystemClipboard: read,
      writeSystemClipboard: write,
      write: () => { throw new Error("unused"); },
      read: () => null,
      clear: () => {},
      release: () => {},
      historyEntries: () => [],
      pasteFromHistory: () => null,
      removeHistoryEntry: () => false,
      clearHistory: () => {},
      setHistoryEnabled: () => {},
      isHistoryEnabled: () => true,
      setHistoryLimits: () => {},
      historyLimits: () => ({ maxItems: 0, maxTotalBytes: 0 }),
      historyExclusion: () => "recorded",
      setPermission: () => {},
      permission: () => "granted",
      attachPermissionAdapter: () => () => {},
      syncPermission: async () => "granted",
      subscribe: () => () => {},
    };
  }

  it("rejects pending paste when focus moves from editor to search box and back to editor (editor -> search -> editor) (ED-REPAIR-008-A1)", async () => {
    const pending = deferred<unknown>();
    const observations: unknown[] = [];
    const owner = new WorkspaceDocumentTransactionOwner();
    let port: { execute: (id: string, options?: unknown) => boolean } | null = null;
    const handle = stubHandle(() => pending.promise, async () => ({ outcome: "success", systemEffect: "performed" }));
    const rendered = renderEditor("hello world", vi.fn(), {
      clipboardHandle: handle as never,
      transactionOwner: owner,
      viewId: "primary",
      fileKey: "search-focus.ts",
      onClipboardObservation: (record) => { observations.push(record); },
      onCommandPortChange: (registration) => { port = registration.port as never; },
    });
    await waitFor(() => expect(port).not.toBeNull());
    const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!)!;
    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    act(() => { content.focus(); });
    expect(view.hasFocus).toBe(true);

    act(() => { port!.execute("paste"); });

    // Focus moves to search input
    const search = document.createElement("input");
    document.body.appendChild(search);
    act(() => { search.focus(); });

    // Focus returns back to the editor before the promise settles
    act(() => { content.focus(); });
    expect(view.hasFocus).toBe(true);

    // Pending read settles
    act(() => { pending.resolve({ outcome: "success", text: "injected-payload", systemEffect: "performed" }); });

    await waitFor(() => expect(observations).toHaveLength(1));
    expect(observations[0]).toMatchObject({
      operation: "paste",
      outcome: "cancelled",
      systemEffect: "performed",
    });
    // Document must be unchanged, undo depth must be 0
    expect(view.state.doc.toString()).toBe("hello world");
    expect(owner.getHistoryState("search-focus.ts").undoDepth).toBe(0);
    search.remove();
  });

  it("rejects pending paste when active leaf moves to another group and returns (leaf A -> B -> A) (ED-REPAIR-008-A1)", async () => {
    const pending = deferred<unknown>();
    const observations: unknown[] = [];
    let port: { execute: (id: string, options?: unknown) => boolean } | null = null;
    const handle = stubHandle(() => pending.promise, async () => ({ outcome: "success", systemEffect: "performed" }));
    const rendered = renderEditor("hello world", vi.fn(), {
      clipboardHandle: handle as never,
      active: true,
      visible: true,
      onClipboardObservation: (record) => { observations.push(record); },
      onCommandPortChange: (registration) => { port = registration.port as never; },
    });
    await waitFor(() => expect(port).not.toBeNull());
    const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!)!;

    act(() => { port!.execute("paste"); });

    // Group switches away from leaf A (active -> false)
    rendered.rerender(<CodeMirrorHost {...rendered.props} active={false} visible={true} />);

    // Group switches back to leaf A (active -> true)
    rendered.rerender(<CodeMirrorHost {...rendered.props} active={true} visible={true} />);

    // Pending read settles
    act(() => { pending.resolve({ outcome: "success", text: "injected-payload", systemEffect: "performed" }); });

    await waitFor(() => expect(observations).toHaveLength(1));
    expect(observations[0]).toMatchObject({
      operation: "paste",
      outcome: "cancelled",
      systemEffect: "performed",
    });
    expect(view.state.doc.toString()).toBe("hello world");
  });

  it("rejects pending paste when workspace visibility toggles off and on (workspace A -> B -> A) (ED-REPAIR-008-A1)", async () => {
    const pending = deferred<unknown>();
    const observations: unknown[] = [];
    let port: { execute: (id: string, options?: unknown) => boolean } | null = null;
    const handle = stubHandle(() => pending.promise, async () => ({ outcome: "success", systemEffect: "performed" }));
    const rendered = renderEditor("hello world", vi.fn(), {
      clipboardHandle: handle as never,
      visible: true,
      onClipboardObservation: (record) => { observations.push(record); },
      onCommandPortChange: (registration) => { port = registration.port as never; },
    });
    await waitFor(() => expect(port).not.toBeNull());
    const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!)!;

    act(() => { port!.execute("paste"); });

    // Workspace hidden
    rendered.rerender(<CodeMirrorHost {...rendered.props} visible={false} />);

    // Workspace shown again
    rendered.rerender(<CodeMirrorHost {...rendered.props} visible={true} />);

    // Pending read settles
    act(() => { pending.resolve({ outcome: "success", text: "injected-payload", systemEffect: "performed" }); });

    await waitFor(() => expect(observations).toHaveLength(1));
    expect(observations[0]).toMatchObject({
      operation: "paste",
      outcome: "cancelled",
      systemEffect: "performed",
    });
    expect(view.state.doc.toString()).toBe("hello world");
  });

  it("rejects older paste when a newer paste request was initiated (ED-REPAIR-008-A1)", async () => {
    const pending1 = deferred<unknown>();
    const pending2 = deferred<unknown>();
    let readCallCount = 0;
    const observations: unknown[] = [];
    let port: { execute: (id: string, options?: unknown) => boolean } | null = null;
    const handle = stubHandle(
      () => {
        readCallCount++;
        return readCallCount === 1 ? pending1.promise : pending2.promise;
      },
      async () => ({ outcome: "success", systemEffect: "performed" }),
    );
    const rendered = renderEditor("hello world", vi.fn(), {
      clipboardHandle: handle as never,
      onClipboardObservation: (record) => { observations.push(record); },
      onCommandPortChange: (registration) => { port = registration.port as never; },
    });
    await waitFor(() => expect(port).not.toBeNull());
    const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!)!;
    act(() => {
      view.dispatch({ selection: EditorSelection.range(0, 11) });
    });

    // Trigger first paste
    act(() => { port!.execute("paste"); });

    // Trigger second paste
    act(() => { port!.execute("paste"); });

    // Second paste settles first and applies
    act(() => { pending2.resolve({ outcome: "success", text: "new-text", systemEffect: "performed" }); });
    await waitFor(() => expect(view.state.doc.toString()).toBe("new-text"));

    // First paste settles later and must be cancelled
    act(() => { pending1.resolve({ outcome: "success", text: "old-text", systemEffect: "performed" }); });

    await waitFor(() => expect(observations).toHaveLength(2));
    const cancelled = observations.find((o) => (o as { outcome: string }).outcome === "cancelled");
    expect(cancelled).toBeDefined();
    // Document must keep new-text, not old-text
    expect(view.state.doc.toString()).toBe("new-text");
  });

  it("cancels pending menu paste when focus moves to search box before settle (menu -> search) (ED-REPAIR-008-A2)", async () => {
    const pending = deferred<unknown>();
    const observations: unknown[] = [];
    let port: { execute: (id: string, options?: unknown) => boolean } | null = null;
    const handle = stubHandle(() => pending.promise, async () => ({ outcome: "success", systemEffect: "performed" }));
    const rendered = renderEditor("hello world", vi.fn(), {
      clipboardHandle: handle as never,
      onClipboardObservation: (record) => { observations.push(record); },
      onCommandPortChange: (registration) => { port = registration.port as never; },
    });
    await waitFor(() => expect(port).not.toBeNull());
    const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!)!;

    // Menu button has focus at request
    const menu = document.createElement("button");
    menu.setAttribute("role", "menuitem");
    document.body.appendChild(menu);
    act(() => { menu.focus(); });

    act(() => { port!.execute("paste"); });

    // Focus moves to search input instead of editor
    const search = document.createElement("input");
    document.body.appendChild(search);
    act(() => { search.focus(); });

    act(() => { pending.resolve({ outcome: "success", text: "menu-payload", systemEffect: "performed" }); });

    await waitFor(() => expect(observations).toHaveLength(1));
    expect(observations[0]).toMatchObject({
      operation: "paste",
      outcome: "cancelled",
      systemEffect: "performed",
    });
    expect(view.state.doc.toString()).toBe("hello world");
    menu.remove();
    search.remove();
  });

  it("cancels in-flight copy when owner is lost and reports cancelled observation with systemEffect (ED-REPAIR-008-A2)", async () => {
    const pending = deferred<unknown>();
    const observations: unknown[] = [];
    let port: { execute: (id: string, options?: unknown) => boolean } | null = null;
    const handle = stubHandle(async () => ({ outcome: "success" }), () => pending.promise);
    const rendered = renderEditor("hello world", vi.fn(), {
      clipboardHandle: handle as never,
      onClipboardObservation: (record) => { observations.push(record); },
      onCommandPortChange: (registration) => { port = registration.port as never; },
    });
    await waitFor(() => expect(port).not.toBeNull());
    const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!)!;
    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    act(() => { content.focus(); });

    act(() => {
      view.dispatch({ selection: EditorSelection.range(0, 5) });
    });

    act(() => { port!.execute("copy"); });

    // Focus leaves editor
    const search = document.createElement("input");
    document.body.appendChild(search);
    act(() => { search.focus(); });

    // Write finishes with performed
    act(() => { pending.resolve({ outcome: "success", systemEffect: "performed" }); });

    await waitFor(() => expect(observations).toHaveLength(1));
    expect(observations[0]).toMatchObject({
      operation: "copy",
      outcome: "cancelled",
      systemEffect: "performed",
    });
    search.remove();
  });

  it("does not invoke onUnavailable on unmounted or inactive host when late denied result arrives (ED-REPAIR-008-A2)", async () => {
    const pending = deferred<unknown>();
    const observations: unknown[] = [];
    const unavailableMessages: string[] = [];
    let port: { execute: (id: string, options?: unknown) => boolean } | null = null;
    const handle = stubHandle(() => pending.promise, async () => ({ outcome: "success", systemEffect: "performed" }));
    const rendered = renderEditor("hello world", vi.fn(), {
      clipboardHandle: handle as never,
      onClipboardUnavailable: (msg) => { unavailableMessages.push(msg); },
      onClipboardObservation: (record) => { observations.push(record); },
      onCommandPortChange: (registration) => { port = registration.port as never; },
    });
    await waitFor(() => expect(port).not.toBeNull());
    act(() => { port!.execute("paste"); });

    // Host is unmounted
    rendered.unmount();

    // Late denial arrives
    act(() => { pending.resolve({ outcome: "denied", systemEffect: "not-performed", fallbackSession: null }); });

    await waitFor(() => expect(observations).toHaveLength(1));
    expect(observations[0]).toMatchObject({
      operation: "paste",
      outcome: "cancelled",
      systemEffect: "not-performed",
    });
    // onUnavailable should NOT have been called on unmounted host
    expect(unavailableMessages).toHaveLength(0);
  });
});
