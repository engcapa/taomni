import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LspDocumentSymbol } from "../../../lib/editor/lsp";
import { StructurePopup, symbolKindBadge } from "./StructurePopup";

function symbol(
  name: string,
  kind: number,
  depth: number,
  line: number,
  detail: string | null = null,
): LspDocumentSymbol {
  return {
    name,
    detail,
    kind,
    depth,
    range: { start: { line, character: 0 }, end: { line: line + 3, character: 1 } },
    selectionRange: { start: { line, character: 4 }, end: { line, character: 4 + name.length } },
  };
}

const symbols = [
  symbol("OpenFileState", 11, 0, 4),
  symbol("path", 7, 1, 5, "string"),
  symbol("openFile", 12, 0, 14),
];

describe("StructurePopup", () => {
  afterEach(() => cleanup());

  it("lists symbols in document order and jumps to the selection", () => {
    const onPick = vi.fn();
    render(
      <StructurePopup
        open
        fileTitle="CodeWorkspaceTab.tsx"
        symbols={symbols}
        loading={false}
        onClose={vi.fn()}
        onPick={onPick}
      />,
    );

    const rows = screen.getAllByRole("button");
    expect(rows[0]).toHaveTextContent("OpenFileState");
    expect(rows[1]).toHaveTextContent("path");
    expect(rows[1]).toHaveTextContent("string");
    expect(rows[2]).toHaveTextContent("openFile");

    const input = screen.getByLabelText("File structure");
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(symbols[1]);
  });

  it("filters symbols by fuzzy name match", () => {
    render(
      <StructurePopup
        open
        fileTitle="CodeWorkspaceTab.tsx"
        symbols={symbols}
        loading={false}
        onClose={vi.fn()}
        onPick={vi.fn()}
      />,
    );

    fireEvent.change(screen.getByLabelText("File structure"), { target: { value: "path" } });
    expect(screen.getByText("path")).toBeInTheDocument();
    expect(screen.queryByText("OpenFileState")).not.toBeInTheDocument();
    expect(screen.queryByText("openFile")).not.toBeInTheDocument();
  });

  it("explains why the list is empty when the server is unavailable", () => {
    render(
      <StructurePopup
        open
        fileTitle="a.ts"
        symbols={[]}
        loading={false}
        unavailableReason="Language server is not running for this file"
        onClose={vi.fn()}
        onPick={vi.fn()}
      />,
    );
    expect(screen.getByText("Language server is not running for this file")).toBeInTheDocument();
  });
});

describe("symbolKindBadge", () => {
  it("maps common LSP symbol kinds to badges", () => {
    expect(symbolKindBadge(5).label).toBe("C");
    expect(symbolKindBadge(11).label).toBe("I");
    expect(symbolKindBadge(12).label).toBe("ƒ");
    expect(symbolKindBadge(999).label).toBe("•");
  });
});
