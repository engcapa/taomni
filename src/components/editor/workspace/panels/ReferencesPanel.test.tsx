import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { LspLocation } from "../../../../lib/editor/lsp";
import { ReferencesPanel } from "./ReferencesPanel";

const location: LspLocation = {
  uri: "file:///C:/repo/src/example.ts",
  path: "C:\\repo\\src\\example.ts",
  range: {
    start: { line: 4, character: 2 },
    end: { line: 4, character: 9 },
  },
};

describe("ReferencesPanel", () => {
  afterEach(() => cleanup());

  it("shows workspace-relative locations and opens the selected reference", () => {
    const onOpenLocation = vi.fn();
    render(
      <ReferencesPanel
        roots={[{ id: "root", name: "repo", path: "C:\\repo", kind: "folder" }]}
        result={{ loading: false, origin: "example.ts:1:1", locations: [location], error: null }}
        onOpenLocation={onOpenLocation}
      />,
    );

    const result = screen.getByRole("button", { name: /repo\/src\/example.ts/ });
    expect(result).toHaveTextContent("5:3");
    fireEvent.click(result);
    expect(onOpenLocation).toHaveBeenCalledWith(location);
  });

  it("renders empty and loading states explicitly", () => {
    const { rerender } = render(
      <ReferencesPanel
        roots={[]}
        result={{ loading: false, origin: null, locations: [], error: null }}
        onOpenLocation={vi.fn()}
      />,
    );
    expect(screen.getByText("No references")).toBeInTheDocument();

    rerender(
      <ReferencesPanel
        roots={[]}
        result={{ loading: true, origin: null, locations: [], error: null }}
        onOpenLocation={vi.fn()}
      />,
    );
    expect(screen.getByText("Finding references...")).toBeInTheDocument();
  });
});
