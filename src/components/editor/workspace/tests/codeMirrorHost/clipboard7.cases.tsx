import { startCompletion } from "@codemirror/autocomplete";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { CodeMirrorHost } from "../../CodeMirrorHost";
import { renderEditor } from "./harness";

export function registerCodeMirrorHostClipboard7Cases() {

  it("opens the themed find panel and navigates matches", async () => {
    const { content } = renderEditor("alpha beta alpha");

    fireEvent.keyDown(content, { key: "f", code: "KeyF", ctrlKey: true });

    const search = await screen.findByRole("searchbox", { name: "Find" });
    fireEvent.input(search, { target: { value: "alpha" } });
    expect(screen.getByText("1 / 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(screen.getByText("2 / 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
    expect(screen.getByText("1 / 2")).toBeInTheDocument();

    // Native type=search clear — no custom × button.
    fireEvent.input(search, { target: { value: "" } });
    expect(search).toHaveValue("");
    expect(screen.getByText("0 results")).toBeInTheDocument();
  });

  it("applies case, whole-word, and regular-expression search options", async () => {
    const { content } = renderEditor("Alpha alpha alphabet ALPHA");
    fireEvent.keyDown(content, { key: "f", code: "KeyF", ctrlKey: true });

    const search = await screen.findByRole("searchbox", { name: "Find" });
    fireEvent.input(search, { target: { value: "alpha" } });
    expect(screen.getByText("1 / 4")).toBeInTheDocument();

    const wholeWord = screen.getByRole("button", { name: "Match whole word" });
    fireEvent.click(wholeWord);
    expect(wholeWord).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("1 / 3")).toBeInTheDocument();

    const matchCase = screen.getByRole("button", { name: "Match case" });
    fireEvent.click(matchCase);
    expect(matchCase).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByText("1 / 1")).toBeInTheDocument();

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
    fireEvent.click(screen.getByRole("button", { name: "Show replace" }));
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
    expect(screen.getByText("0 results")).toBeInTheDocument();
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

  it("opens replacement mode with Ctrl+R, keeps focus in Find and closes with Escape", async () => {
    const { content } = renderEditor("alpha");
    fireEvent.keyDown(content, { key: "r", code: "KeyR", ctrlKey: true });

    // ED-PARITY-012 DEC-012-05: IDEA keeps the caret in the Find field.
    const replace = await screen.findByRole("textbox", { name: "Replace" });
    const find = screen.getByRole("searchbox", { name: "Find" });
    expect(replace).toBeVisible();
    await waitFor(() => expect(find).toHaveFocus());
    fireEvent.keyDown(find, { key: "Tab" });
    expect(replace).toHaveFocus();
    fireEvent.keyDown(replace, { key: "Tab", shiftKey: true });
    expect(find).toHaveFocus();
    fireEvent.keyDown(find, { key: "Escape" });
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

  it("publishes the final typing viewport after idle without updating workspace UI for every key", async () => {
    vi.useFakeTimers();
    try {
      const onViewportChange = vi.fn();
      const rendered = renderEditor("class Example {}", vi.fn(), { onViewportChange });
      const view = EditorView.findFromDOM(rendered.container.querySelector(".cm-editor")!)!;
      await act(async () => { await vi.advanceTimersByTimeAsync(150); });
      onViewportChange.mockClear();
      for (const character of "abc") {
        act(() => view.dispatch({
          changes: { from: view.state.doc.length, insert: character },
          userEvent: "input.type",
        }));
        await act(async () => { await vi.advanceTimersByTimeAsync(40); });
      }
      expect(rendered.onChange).toHaveBeenCalledTimes(3);
      expect(view.state.doc.toString()).toBe("class Example {}abc");
      expect(onViewportChange).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(150); });
      expect(onViewportChange).toHaveBeenCalledTimes(1);
      expect(onViewportChange).toHaveBeenLastCalledWith({
        start: { line: 0, character: 0 },
        end: { line: 0, character: 19 },
      });
      act(() => view.dispatch({ changes: { from: 19, insert: "d" } }));
      rendered.unmount();
      onViewportChange.mockClear();
      await act(async () => { await vi.advanceTimersByTimeAsync(200); });
      expect(onViewportChange).not.toHaveBeenCalled();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
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
}
