import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExplorerTabPane } from "./ExplorerTabPane";
import { useAppStore } from "../../stores/appStore";
import { useSftpStore } from "../../stores/sftpStore";
import { freshSession } from "../../stores/sftp/listing";
import { DEFAULT_WORKSPACE_ID, useWorkspacePlatformStore } from "../../stores/workspacePlatformStore";

vi.mock("./ExplorerShell", () => ({ ExplorerShell: ({ initialPath, onOpenTerminal }: { initialPath: string; onOpenTerminal?: (path: string) => void }) =>
  <button data-testid="shell" data-startup={initialPath} onClick={() => onOpenTerminal?.("/terminal")}>Explorer</button> }));

const originalRefreshPane = useSftpStore.getState().refreshPane;

beforeEach(() => {
  localStorage.clear();
  useSftpStore.setState({ sessions: {}, refreshPane: originalRefreshPane });
  useWorkspacePlatformStore.getState().reloadFromStorage();
  useAppStore.setState({ tabs: [{ id: "file", type: "file-browser", title: "Saved session", closable: true,
    sessionId: "saved", fileBrowser: { initialPath: "/initial" } }] });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function commitPath(id: string, path: string, loading = false, error: string | null = null) {
  const session = freshSession(id);
  session.local.path = path;
  session.local.loading = loading;
  session.local.error = error;
  act(() => useSftpStore.setState({ sessions: { [id]: session } }));
}

describe("Explorer tab metadata bridge", () => {
  it("updates title and persisted path without reattaching or losing the saved session", () => {
    const { rerender } = render(<ExplorerTabPane tabId="file" initialPath="/initial" />);
    commitPath("file", "/new/current");
    expect(useAppStore.getState().tabs[0]).toMatchObject({ title: "current", sessionId: "saved", fileBrowser: { initialPath: "/new/current", explorer: true } });
    rerender(<ExplorerTabPane tabId="file" initialPath="/new/current" />);
    expect(screen.getByTestId("shell")).toHaveAttribute("data-startup", "/initial");
  });

  it("does not persist failed/loading speculative paths", () => {
    render(<ExplorerTabPane tabId="file" initialPath="/initial" />);
    commitPath("file", "/loading", true);
    commitPath("file", "/failed", false, "permission denied");
    expect(useAppStore.getState().tabs[0].fileBrowser?.initialPath).toBe("/initial");
  });

  it("refreshes once when an inactive tab becomes active without duplicating the initial attach read", () => {
    commitPath("file", "/initial");
    const refresh = vi.spyOn(useSftpStore.getState(), "refreshPane").mockResolvedValue();
    const { rerender } = render(<ExplorerTabPane tabId="file" initialPath="/initial" active={false} />);
    expect(refresh).not.toHaveBeenCalled();
    rerender(<ExplorerTabPane tabId="file" initialPath="/initial" active />);
    expect(refresh).toHaveBeenCalledExactlyOnceWith("file", "local");
    rerender(<ExplorerTabPane tabId="file" initialPath="/initial" active />);
    commitPath("file", "/refreshed");
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("does not refresh on initial active mount or compete with a pending navigation", () => {
    commitPath("file", "/initial");
    const refresh = vi.spyOn(useSftpStore.getState(), "refreshPane").mockResolvedValue();
    const { rerender } = render(<ExplorerTabPane tabId="file" initialPath="/initial" active />);
    expect(refresh).not.toHaveBeenCalled();
    rerender(<ExplorerTabPane tabId="file" initialPath="/initial" active={false} />);
    commitPath("file", "/loading", true);
    rerender(<ExplorerTabPane tabId="file" initialPath="/initial" active />);
    commitPath("file", "/loading");
    expect(refresh).not.toHaveBeenCalled();
  });

  it("updates workspace current paths without touching main tabs", () => {
    const tab = useWorkspacePlatformStore.getState().addExplorerTab(DEFAULT_WORKSPACE_ID, "/initial");
    render(<ExplorerTabPane tabId={tab.id} initialPath="/initial" workspaceId={DEFAULT_WORKSPACE_ID} />);
    commitPath(tab.id, "/workspace/new");
    expect(useWorkspacePlatformStore.getState().getWorkspace()?.openTabs[0]).toMatchObject({ title: "new", explorerPath: "/workspace/new" });
    expect(useAppStore.getState().tabs[0].fileBrowser?.initialPath).toBe("/initial");
  });
});
