import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { LspDocumentSymbol } from "../../../lib/editor/lsp";
import { Breadcrumbs, collapsedBreadcrumbItems, symbolChainAtPosition } from "./Breadcrumbs";

const symbols: LspDocumentSymbol[] = [
  {
    name: "App",
    detail: null,
    kind: 5,
    depth: 0,
    range: { start: { line: 0, character: 0 }, end: { line: 20, character: 0 } },
    selectionRange: { start: { line: 0, character: 6 }, end: { line: 0, character: 9 } },
  },
  {
    name: "render",
    detail: null,
    kind: 6,
    depth: 1,
    range: { start: { line: 5, character: 2 }, end: { line: 10, character: 3 } },
    selectionRange: { start: { line: 5, character: 2 }, end: { line: 5, character: 8 } },
  },
];

describe("Breadcrumbs", () => {
  it("collapses intermediate path and symbol segments for narrow editor panes", () => {
    const segments = [
      { label: "repo", path: "", kind: "root" as const },
      { label: "src", path: "src", kind: "directory" as const },
      { label: "main", path: "src/main", kind: "directory" as const },
      { label: "java", path: "src/main/java", kind: "directory" as const },
      { label: "App.java", path: "src/main/java/App.java", kind: "file" as const },
    ];

    expect(collapsedBreadcrumbItems(segments, symbols).map((item) => {
      if (item.type === "collapsed") return "…";
      return item.type === "symbol" ? item.value.name : item.value.label;
    })).toEqual(["repo", "…", "java", "App.java", "…", "render"]);
  });

  it("derives the nested symbol chain at the cursor", () => {
    expect(symbolChainAtPosition(symbols, { line: 7, character: 1 }).map((item) => item.name))
      .toEqual(["App", "render"]);
    expect(symbolChainAtPosition(symbols, { line: 15, character: 1 }).map((item) => item.name))
      .toEqual(["App"]);
  });

  it("renders path and symbol segments and routes clicks", () => {
    const onPathClick = vi.fn();
    const onSymbolClick = vi.fn();
    render(
      <Breadcrumbs
        pathSegments={[
          { label: "repo", path: "", kind: "root" },
          { label: "src", path: "src", kind: "directory" },
          { label: "App.tsx", path: "src/App.tsx", kind: "file" },
        ]}
        symbols={symbols}
        position={{ line: 7, character: 1 }}
        onPathClick={onPathClick}
        onSymbolClick={onSymbolClick}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /src/ }));
    expect(onPathClick).toHaveBeenCalledWith(expect.objectContaining({ path: "src" }));
    fireEvent.click(screen.getByRole("button", { name: /render/ }));
    expect(onSymbolClick).toHaveBeenCalledWith(expect.objectContaining({ name: "render" }));
  });
});
