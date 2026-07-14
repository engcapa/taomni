import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { CodeMirrorHost } from "./CodeMirrorHost";

function renderEditor(
  doc: string,
  onChange = vi.fn(),
  overrides: Partial<ComponentProps<typeof CodeMirrorHost>> = {},
) {
  const result = render(
    <CodeMirrorHost
      path="src/example.ts"
      doc={doc}
      visible
      diagnostics={[]}
      reveal={null}
      onChange={onChange}
      onSave={vi.fn()}
      onHover={vi.fn(async () => null)}
      onDefinition={vi.fn(async () => false)}
      onReferences={vi.fn(async () => undefined)}
      {...overrides}
    />,
  );
  const content = result.container.querySelector<HTMLElement>(".cm-content");
  expect(content).not.toBeNull();
  return { ...result, content: content!, onChange };
}

describe("CodeMirrorHost search", () => {
  afterEach(() => cleanup());

  it("opens the themed find panel and navigates matches", async () => {
    const { content } = renderEditor("alpha beta alpha");

    fireEvent.keyDown(content, { key: "f", code: "KeyF", ctrlKey: true });

    const search = await screen.findByRole("textbox", { name: "Find" });
    fireEvent.input(search, { target: { value: "alpha" } });
    expect(screen.getByText("2 matches")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Next match" }));
    expect(screen.getByText("1 / 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
    expect(screen.getByText("2 / 2")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Clear find" }));
    expect(search).toHaveValue("");
    expect(screen.getByText("0 matches")).toBeInTheDocument();
  });

  it("applies case, whole-word, and regular-expression search options", async () => {
    const { content } = renderEditor("Alpha alpha alphabet ALPHA");
    fireEvent.keyDown(content, { key: "f", code: "KeyF", ctrlKey: true });

    const search = await screen.findByRole("textbox", { name: "Find" });
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

    fireEvent.input(await screen.findByRole("textbox", { name: "Find" }), {
      target: { value: "alpha" },
    });
    fireEvent.input(screen.getByRole("textbox", { name: "Replace" }), {
      target: { value: "omega" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Replace all matches" }));

    await waitFor(() => {
      expect(onChange).toHaveBeenLastCalledWith("omega beta omega");
    });
    expect(screen.getByText("0 matches")).toBeInTheDocument();
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
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith("one\none\ntwo"));

    fireEvent.keyDown(content, { key: "y", code: "KeyY", ctrlKey: true });
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith("one\ntwo"));
  });

  it("moves selected lines with Alt+Shift+Arrow", async () => {
    const onChange = vi.fn();
    const { content } = renderEditor("one\ntwo", onChange);

    fireEvent.keyDown(content, { key: "ArrowDown", code: "ArrowDown", altKey: true, shiftKey: true });
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith("two\none"));
  });

  it("toggles line comments with Ctrl+Slash", async () => {
    const onChange = vi.fn();
    const { content } = renderEditor("const value = 1;", onChange);
    await waitFor(() => expect(content).toHaveAttribute("data-language", "typescript"));

    fireEvent.keyDown(content, { key: "/", code: "Slash", ctrlKey: true });
    await waitFor(() => expect(onChange).toHaveBeenLastCalledWith("// const value = 1;"));
  });

  it("opens go to line with Ctrl+G", async () => {
    const { content } = renderEditor("one\ntwo");
    fireEvent.keyDown(content, { key: "g", code: "KeyG", ctrlKey: true });
    expect(await screen.findByRole("textbox", { name: /Go to line/ })).toBeInTheDocument();
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
});
