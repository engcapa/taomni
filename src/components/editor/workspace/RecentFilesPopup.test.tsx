import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RecentFilesPopup, type RecentFileEntry } from "./RecentFilesPopup";

function entry(path: string, open = false): RecentFileEntry {
  const title = path.split("/").pop() ?? path;
  return {
    key: `root:app:${path}`,
    ref: { kind: "root", rootId: "app", path },
    title,
    subtitle: `app / ${path}`,
    open,
  };
}

const entries = [
  entry("src/current.ts", true),
  entry("src/previous.ts", true),
  entry("docs/closed.md"),
];

describe("RecentFilesPopup", () => {
  afterEach(() => cleanup());

  it("lists files most-recent-first and preselects the previous file", () => {
    const onPick = vi.fn();
    render(
      <RecentFilesPopup open entries={entries} onClose={vi.fn()} onPick={onPick} />,
    );

    const rows = screen.getAllByRole("button");
    expect(rows[0]).toHaveTextContent("current.ts");
    expect(rows[1]).toHaveTextContent("previous.ts");
    expect(rows[1]).toHaveAttribute("data-selected", "true");

    fireEvent.keyDown(screen.getByLabelText("Recent files"), { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(entries[1]);
  });

  it("advances the selection when the advance nonce bumps", () => {
    const onPick = vi.fn();
    const { rerender } = render(
      <RecentFilesPopup open entries={entries} advanceNonce={0} onClose={vi.fn()} onPick={onPick} />,
    );
    rerender(
      <RecentFilesPopup open entries={entries} advanceNonce={1} onClose={vi.fn()} onPick={onPick} />,
    );

    fireEvent.keyDown(screen.getByLabelText("Recent files"), { key: "Enter" });
    expect(onPick).toHaveBeenCalledWith(entries[2]);
  });

  it("filters with fuzzy matching and marks files that are still open", () => {
    render(<RecentFilesPopup open entries={entries} onClose={vi.fn()} onPick={vi.fn()} />);

    expect(screen.getAllByLabelText("Open in editor")).toHaveLength(2);

    fireEvent.change(screen.getByLabelText("Recent files"), { target: { value: "closed" } });
    expect(screen.getByText("closed.md")).toBeInTheDocument();
    expect(screen.queryByText("previous.ts")).not.toBeInTheDocument();
  });

  it("explains the empty states", () => {
    render(<RecentFilesPopup open entries={[]} onClose={vi.fn()} onPick={vi.fn()} />);
    expect(screen.getByText("No recent files yet")).toBeInTheDocument();
  });

  it("renders custom placeholder and label in changed-only mode", () => {
    render(<RecentFilesPopup open entries={[]} changedOnly onClose={vi.fn()} onPick={vi.fn()} />);
    expect(screen.getByLabelText("Recently changed files")).toBeInTheDocument();
    expect(screen.getByText("No recently changed files")).toBeInTheDocument();
  });
});

describe("ED-PARITY-014: Recent Files switcher", () => {
  afterEach(() => cleanup());

  it("shows tool windows beside the files, Show edited only and the selected path", () => {
    const onToggle = vi.fn();
    const onActivate = vi.fn();
    const onRecentLocations = vi.fn();
    render(
      <RecentFilesPopup
        open
        entries={entries}
        onClose={vi.fn()}
        onPick={vi.fn()}
        onToggleChangedOnly={onToggle}
        toolWindows={[{ id: "project", label: "Project", shortcut: "Alt+1" }]}
        onActivateToolWindow={onActivate}
        onOpenRecentLocations={onRecentLocations}
      />,
    );
    fireEvent.click(screen.getByTestId("code-workspace-recent-files-tool-window-project"));
    expect(onActivate).toHaveBeenCalledWith("project");
    fireEvent.click(screen.getByTestId("code-workspace-recent-files-recent-locations"));
    expect(onRecentLocations).toHaveBeenCalledTimes(1);
    const editedOnly = screen.getByTestId("code-workspace-recent-files-edited-only");
    expect(editedOnly).not.toBeChecked();
    fireEvent.click(editedOnly);
    expect(onToggle).toHaveBeenCalledTimes(1);
    // The previous file is preselected; its full path is in the footer.
    expect(screen.getByTestId("code-workspace-recent-files-path")).toHaveTextContent("app / src/previous.ts");
  });
});
