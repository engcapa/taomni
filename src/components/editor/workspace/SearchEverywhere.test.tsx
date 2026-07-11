import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SearchEverywhere, type GoToFileItem } from "./SearchEverywhere";

const items: GoToFileItem[] = [
  { rootId: "root-1", rootName: "app", path: "src/components/editor/CodeWorkspaceTab.tsx" },
  { rootId: "root-1", rootName: "app", path: "src/lib/editor/workspace.ts" },
  { rootId: "root-2", rootName: "tools", path: "scripts/deploy.sh" },
];

function renderPopup(overrides: Partial<Parameters<typeof SearchEverywhere>[0]> = {}) {
  const onOpenFile = vi.fn();
  const onClose = vi.fn();
  render(
    <SearchEverywhere
      open
      items={items}
      loading={false}
      onClose={onClose}
      onOpenFile={onOpenFile}
      {...overrides}
    />,
  );
  return { onOpenFile, onClose };
}

describe("SearchEverywhere", () => {
  afterEach(() => cleanup());

  it("renders nothing while closed", () => {
    renderPopup({ open: false });
    expect(screen.queryByTestId("code-workspace-search-everywhere")).not.toBeInTheDocument();
  });

  it("filters files with camelCase abbreviations and opens the selection", () => {
    const { onOpenFile } = renderPopup();
    const input = screen.getByLabelText("Go to file");

    fireEvent.change(input, { target: { value: "cwt" } });
    expect(screen.getByText("CodeWorkspaceTab.tsx")).toBeInTheDocument();
    expect(screen.queryByText("deploy.sh")).not.toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter" });
    expect(onOpenFile).toHaveBeenCalledWith(items[0]);
  });

  it("moves the selection with arrow keys before opening", () => {
    const { onOpenFile } = renderPopup();
    const input = screen.getByLabelText("Go to file");

    fireEvent.change(input, { target: { value: "editor" } });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    const opened = onOpenFile.mock.calls[0][0] as GoToFileItem;
    const shown = screen.getAllByRole("button").map((button) => button.textContent);
    expect(shown.some((text) => text?.includes(opened.path.split("/").pop() ?? ""))).toBe(true);
    expect(onOpenFile).toHaveBeenCalledTimes(1);
  });

  it("closes on Escape and on backdrop clicks", () => {
    const { onClose } = renderPopup();
    fireEvent.keyDown(screen.getByLabelText("Go to file"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.mouseDown(screen.getByTestId("code-workspace-search-everywhere"));
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("reports the index size and truncation", () => {
    renderPopup({ truncated: true });
    expect(screen.getByText(/file index truncated · 3 files/)).toBeInTheDocument();
  });

  it("shows an indexing hint while loading with no results", () => {
    renderPopup({ items: [], loading: true });
    expect(screen.getByText("Indexing workspace files...")).toBeInTheDocument();
  });
});
