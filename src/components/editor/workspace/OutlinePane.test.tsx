import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LspDocumentSymbol } from "../../../lib/editor/lsp";
import { isProbablyPublicSymbol, OutlinePane, outlineRows } from "./OutlinePane";

function symbol(name: string, kind: number, line: number, depth: number): LspDocumentSymbol {
  return {
    name,
    detail: null,
    kind,
    range: { start: { line, character: 0 }, end: { line: line + 5, character: 0 } },
    selectionRange: { start: { line, character: 0 }, end: { line, character: name.length } },
    depth,
  };
}

const symbols = [
  symbol("Widget", 5, 0, 0),
  symbol("render", 6, 2, 1),
  symbol("_secret", 8, 4, 1),
  symbol("alpha", 12, 10, 0),
];

describe("OutlinePane", () => {
  afterEach(cleanup);

  it("builds hierarchy rows, filters descendants, and supports sibling sorting", () => {
    expect(outlineRows(symbols, {
      query: "render",
      sort: "position",
      publicOnly: false,
      collapsed: new Set(),
    }).map((row) => [row.symbol.name, row.depth])).toEqual([
      ["Widget", 0],
      ["render", 1],
    ]);
    expect(outlineRows(symbols, {
      query: "",
      sort: "name",
      publicOnly: false,
      collapsed: new Set(),
    }).map((row) => row.symbol.name)).toEqual(["alpha", "Widget", "_secret", "render"]);
  });

  it("marks the approximate public filter and highlights the cursor symbol", () => {
    expect(isProbablyPublicSymbol(symbols[0])).toBe(true);
    expect(isProbablyPublicSymbol(symbols[2])).toBe(false);
    const onPick = vi.fn();
    render(
      <OutlinePane
        symbols={symbols}
        position={{ line: 3, character: 0 }}
        loading={false}
        onPick={onPick}
      />,
    );
    const tree = screen.getByRole("tree", { name: "Outline" });
    expect(within(tree).getByRole("treeitem", { current: "location" })).toHaveTextContent("render");
    fireEvent.click(screen.getByText("Public only ≈"));
    expect(screen.queryByText("_secret")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("render"));
    expect(onPick).toHaveBeenCalledWith(symbols[1]);
  });

  it("collapses and expands symbol children", () => {
    render(
      <OutlinePane symbols={symbols} position={{ line: 0, character: 0 }} loading={false} onPick={() => {}} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Collapse Widget" }));
    expect(screen.queryByText("render")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Expand Widget" }));
    expect(screen.getByText("render")).toBeInTheDocument();
  });

  it("clears the outline filter when the search value is emptied", () => {
    render(
      <OutlinePane symbols={symbols} position={{ line: 0, character: 0 }} loading={false} onPick={() => {}} />,
    );
    const input = screen.getByRole("searchbox", { name: "Filter outline" });
    fireEvent.change(input, { target: { value: "render" } });
    expect(screen.queryByText("alpha")).not.toBeInTheDocument();
    fireEvent.change(input, { target: { value: "" } });
    expect(input).toHaveValue("");
    expect(screen.getByText("alpha")).toBeInTheDocument();
  });
});
