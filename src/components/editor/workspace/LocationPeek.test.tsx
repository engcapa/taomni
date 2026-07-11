import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { LocationPeek } from "./LocationPeek";
import type { LspLocation } from "../../../lib/editor/lsp";

const locations: LspLocation[] = [
  {
    uri: "file:///repo/a.ts",
    path: "/repo/a.ts",
    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 4 } },
  },
  {
    uri: "file:///repo/b.ts",
    path: "/repo/b.ts",
    range: { start: { line: 5, character: 2 }, end: { line: 5, character: 8 } },
  },
];

describe("LocationPeek", () => {
  it("opens a selected location with Enter and closes with Escape", () => {
    const onOpen = vi.fn();
    const onClose = vi.fn();
    render(
      <LocationPeek
        open
        state={{ title: "Implementations", locations }}
        onOpen={onOpen}
        onClose={onClose}
      />,
    );
    expect(screen.getByTestId("code-workspace-location-peek")).toHaveTextContent("Implementations");
    expect(screen.getByText("2 results")).toBeInTheDocument();
    fireEvent.keyDown(window, { key: "ArrowDown" });
    fireEvent.keyDown(window, { key: "Enter" });
    expect(onOpen).toHaveBeenCalledWith(locations[1]);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
