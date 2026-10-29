import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ComponentProps } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspacePopupsHost } from "./WorkspacePopupsHost";
import { createWorkspaceSemanticIndexSnapshot } from "./workspaceSemanticIndex";

afterEach(cleanup);

function props(): ComponentProps<typeof WorkspacePopupsHost> {
  return {
    searchEverywhereOpen: false, searchEverywhereMode: "files",
    goToFileItems: [], goToFileLoading: false, goToFileTruncated: false,
    actionSnapshots: [], symbolsAvailable: false,
    semanticIndex: createWorkspaceSemanticIndexSnapshot(),
    fetchWorkspaceSymbols: vi.fn(), onCloseSearchEverywhere: vi.fn(),
    onOpenFileItem: vi.fn(), onOpenSymbol: vi.fn(), onRunCommand: vi.fn(), onSearchText: vi.fn(),
    recentFilesOpen: false, recentEntries: [], recentAdvanceNonce: 0,
    onCloseRecent: vi.fn(), onPickRecent: vi.fn(),
    structureOpen: false, structureFileTitle: null, structureSymbols: [],
    structureLoading: false, structureUnavailable: null,
    onCloseStructure: vi.fn(), onPickStructure: vi.fn(),
    quickDocOpen: false, quickDocContent: null,
    onCloseQuickDoc: vi.fn(), onPinQuickDoc: vi.fn(),
    locationPeek: null, onCloseLocationPeek: vi.fn(), onOpenLocation: vi.fn(),
  };
}

describe("workspace popup background updates", () => {
  it("reopens Search Everywhere with current files, mode and handlers", async () => {
    const initial = props();
    const { rerender } = render(<WorkspacePopupsHost {...initial} />);
    const item = { rootId: "root", rootName: "repo", path: "latest.txt" };
    const pick = vi.fn();
    const updated = { ...initial, goToFileItems: [item], onOpenFileItem: pick };
    rerender(<WorkspacePopupsHost {...updated} />);
    rerender(<WorkspacePopupsHost {...updated} searchEverywhereOpen />);
    expect(screen.getByLabelText("Go to file")).toBeInTheDocument();
    fireEvent.click(await screen.findByText("latest.txt"));
    expect(pick).toHaveBeenCalledWith(item);
    expect(initial.onOpenFileItem).not.toHaveBeenCalled();

    rerender(<WorkspacePopupsHost {...updated} />);
    expect(screen.queryByTestId("code-workspace-search-everywhere")).toBeNull();
    rerender(<WorkspacePopupsHost {...updated} searchEverywhereMode="actions" />);
    rerender(<WorkspacePopupsHost {...updated} searchEverywhereMode="actions" searchEverywhereOpen />);
    expect(screen.getByLabelText("Search actions")).toBeInTheDocument();
  });

  it("closes documentation, restores focus, and reopens with current content", async () => {
    const initial = props();
    const view = (overrides: Partial<ComponentProps<typeof WorkspacePopupsHost>>) => (
      <><button data-testid="editor-opener">Editor</button><WorkspacePopupsHost {...initial} {...overrides} /></>
    );
    const { rerender } = render(view({}));
    const opener = screen.getByTestId("editor-opener");
    opener.focus();
    const content = { title: "first", body: "first documentation", source: "test" };
    rerender(view({ quickDocOpen: true, quickDocContent: content }));
    screen.getByTestId("code-workspace-quick-doc").focus();
    rerender(view({}));
    await waitFor(() => expect(opener).toHaveFocus());

    const latest = { title: "latest", body: "current documentation", source: "test" };
    const pin = vi.fn();
    rerender(view({ quickDocContent: latest, onPinQuickDoc: pin }));
    rerender(view({ quickDocOpen: true, quickDocContent: latest, onPinQuickDoc: pin }));
    expect(screen.getByText("current documentation")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("code-workspace-quick-doc-pin"));
    expect(pin).toHaveBeenCalledWith(latest);
    expect(initial.onPinQuickDoc).not.toHaveBeenCalled();
  });
});
