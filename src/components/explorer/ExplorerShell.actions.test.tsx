import { installShellHarness, mountShell, row, rows, selection, native, filesystem, file, TAB } from "./tests/explorerShellHarness";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { getExplorerClipboard } from "./explorerClipboard";
import { useSftpStore } from "../../stores/sftpStore";

installShellHarness();

describe("Explorer mounted context and command workflows", () => {
  it("routes folder new-tab/terminal and current-directory toolbar actions with scope", async () => {
    const { props } = await mountShell({ workspaceId: "workspace-one" });
    fireEvent.contextMenu(row("folder"), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByTestId("explorer-context-newtab"));
    expect(native.openExplorer).toHaveBeenCalledWith("/fixture/folder", { workspaceId: "workspace-one", forceNew: true });
    fireEvent.contextMenu(row("folder"), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByTestId("explorer-context-terminal"));
    expect(props.onOpenTerminal).toHaveBeenCalledWith("/fixture/folder");
    fireEvent.click(screen.getByTestId("explorer-cmd-newtab"));
    expect(native.openExplorer).toHaveBeenLastCalledWith("/fixture", { workspaceId: "workspace-one", forceNew: true });
    fireEvent.click(screen.getByTestId("explorer-cmd-terminal"));
    expect(props.onOpenTerminal).toHaveBeenLastCalledWith("/fixture");
    fireEvent.contextMenu(row("alpha.txt"), { clientX: 10, clientY: 10 });
    expect(screen.queryByTestId("explorer-context-newtab")).toBeNull();
    fireEvent.click(screen.getByTestId("explorer-context-open"));
    expect(native.openFile).toHaveBeenCalledWith({ path: "/fixture/alpha.txt" }, { context: "explorer", workspaceId: "workspace-one", alternate: false });
  });

  it("right-click preserves multi-selection, disables multi-rename and copies only effective targets", async () => {
    await mountShell();
    fireEvent.click(row("alpha.txt")); fireEvent.click(row("beta.md"), { ctrlKey: true });
    fireEvent.contextMenu(row("alpha.txt"), { clientX: 10, clientY: 10 });
    expect(selection()).toEqual(["/fixture/alpha.txt", "/fixture/beta.md"]);
    expect(screen.getByTestId("explorer-context-rename")).toBeDisabled();
    fireEvent.click(screen.getByTestId("explorer-context-copy"));
    await waitFor(() => expect(native.explorerWriteClipboardFiles).toHaveBeenCalledWith(["/fixture/alpha.txt", "/fixture/beta.md"], false));
    fireEvent.contextMenu(row("gamma.csv"), { clientX: 10, clientY: 10 });
    expect(selection()).toEqual(["/fixture/gamma.csv"]);
    fireEvent.click(screen.getByTestId("explorer-context-copy-path"));
    expect(native.writeText).toHaveBeenCalledWith("/fixture/gamma.csv");
  });

  it("shows a permission failure and retries rename from the context menu without losing edit state", async () => {
    await mountShell();
    native.localRenameEntry.mockRejectedValueOnce(new Error("Permission denied"));
    fireEvent.contextMenu(row("alpha.txt"));
    fireEvent.click(screen.getByTestId("explorer-context-rename"));
    const input = await screen.findByTestId("explorer-rename-input");
    fireEvent.change(input, { target: { value: "changed.txt" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByTestId("explorer-toast")).toHaveTextContent("Permission denied");
    expect(input).toHaveFocus();
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(rows()).toContain("changed.txt"));
    expect(selection()).toEqual(["/fixture/changed.txt"]);
  });

  it("creates conflict-free names and selects the new row for inline rename", async () => {
    filesystem.get("/fixture")!.push(file("New folder", { fileType: "dir", size: 0 }));
    await mountShell();
    fireEvent.click(screen.getByTestId("explorer-cmd-new"));
    fireEvent.click(screen.getByTestId("explorer-new-folder"));
    const input = await screen.findByTestId("explorer-rename-input") as HTMLInputElement;
    expect(native.localCreateEntry).toHaveBeenCalledWith("/fixture", "New folder (2)", true);
    expect(input.value).toBe("New folder (2)");
    expect(input.selectionStart).toBe(0); expect(input.selectionEnd).toBe("New folder (2)".length);
    expect(selection()).toEqual(["/fixture/New folder (2)"]);
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.contextMenu(screen.getByTestId("explorer-file-list"));
    fireEvent.click(screen.getByTestId("explorer-context-new-file"));
    expect(await screen.findByTestId("explorer-rename-input")).toHaveValue("New text document.txt");
    expect(native.localCreateEntry).toHaveBeenLastCalledWith("/fixture", "New text document.txt", false);
  });

  it("cuts selected files, dims rows and clears cut state only for successful paste items", async () => {
    const { list } = await mountShell();
    fireEvent.click(row("alpha.txt")); fireEvent.click(row("beta.md"), { ctrlKey: true });
    fireEvent.keyDown(list, { key: "x", ctrlKey: true });
    await waitFor(() => expect(row("alpha.txt")).toHaveClass("cut"));
    native.readFilesResult.mockResolvedValue({ ok: true, paths: ["/fixture/alpha.txt", "/fixture/beta.md"] });
    native.localMoveEntries.mockResolvedValue({ done: [{ from: "/fixture/alpha.txt", to: "/destination/alpha.txt" }], failed: [{ path: "/fixture/beta.md", code: "permission_denied", message: "Permission denied" }] });
    fireEvent.click(screen.getByTestId("explorer-cmd-paste"));
    await waitFor(() => expect(screen.getByTestId("explorer-toast")).toHaveTextContent("Permission denied"));
    expect(getExplorerClipboard()).toEqual({ paths: ["/fixture/beta.md"], cut: true });
    expect(row("alpha.txt")).not.toHaveClass("cut"); expect(row("beta.md")).toHaveClass("cut");
    expect(native.localMoveEntries).toHaveBeenCalledWith(["/fixture/alpha.txt", "/fixture/beta.md"], "/fixture", expect.any(String));
    expect(native.localCopyEntries).not.toHaveBeenCalled();
  });

  it("does not paste stale application files after system clipboard ownership changes", async () => {
    const { list } = await mountShell();
    fireEvent.click(row("alpha.txt")); fireEvent.keyDown(list, { key: "x", ctrlKey: true });
    await waitFor(() => expect(getExplorerClipboard()?.cut).toBe(true));
    native.readFilesResult.mockResolvedValue({ ok: true, paths: ["/external/foreign.txt"] });
    fireEvent.keyDown(list, { key: "v", ctrlKey: true });
    await waitFor(() => expect(native.localCopyEntries).toHaveBeenCalledWith(["/external/foreign.txt"], "/fixture", expect.any(String)));
    expect(native.localMoveEntries).not.toHaveBeenCalled(); expect(getExplorerClipboard()).toBeNull();
  });

  it("moves ordinary Delete to Trash and exposes a real restore action", async () => {
    native.localTrashEntries.mockImplementation(async (paths: string[]) => {
      filesystem.set("/fixture", filesystem.get("/fixture")!.filter((entry) => !paths.includes(entry.path)));
      return { trashed: [{ id: "trash-alpha", originalPath: "/fixture/alpha.txt" }], failed: [] };
    });
    native.localTrashRestore.mockImplementation(async () => {
      filesystem.get("/fixture")!.push(file("alpha.txt", { size: 20 }));
      return { done: [{ from: "trash-alpha", to: "/fixture/alpha.txt" }], failed: [] };
    });
    const { list } = await mountShell();
    fireEvent.click(row("alpha.txt")); fireEvent.keyDown(list, { key: "Delete" });
    await waitFor(() => expect(rows()).not.toContain("alpha.txt"));
    expect(native.sftpRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("explorer-undo"));
    await waitFor(() => expect(rows()).toContain("alpha.txt"));
    expect(native.localTrashRestore).toHaveBeenCalledWith([{ id: "trash-alpha", originalPath: "/fixture/alpha.txt" }]);
  });

  it("requires explicit confirmation for Shift+Delete and for unavailable Trash", async () => {
    const { list } = await mountShell();
    fireEvent.click(row("alpha.txt")); fireEvent.keyDown(list, { key: "Delete", shiftKey: true });
    expect(screen.getByTestId("explorer-delete-dialog")).toHaveTextContent("cannot be undone");
    expect(native.sftpRemove).not.toHaveBeenCalled(); expect(native.localTrashEntries).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("explorer-delete-cancel"));
    native.localTrashEntries.mockResolvedValue({ trashed: [], failed: [{ path: "/fixture/alpha.txt", code: "trash_unavailable", message: "No trash service" }] });
    fireEvent.keyDown(list, { key: "Delete" });
    expect(await screen.findByTestId("explorer-trash-unavailable")).toHaveTextContent("No trash service");
    expect(native.sftpRemove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("explorer-delete-confirm"));
    await waitFor(() => expect(native.sftpRemove).toHaveBeenCalledWith(TAB, "/fixture/alpha.txt", "local", true));
  });

  it("opens Properties and closes with Escape without dispatching a selected file open", async () => {
    const { list } = await mountShell();
    fireEvent.click(row("alpha.txt")); fireEvent.contextMenu(row("alpha.txt"));
    fireEvent.click(screen.getByTestId("explorer-context-properties"));
    const dialog = screen.getByTestId("explorer-properties-dialog");
    expect(await screen.findByTestId("explorer-properties-size")).toHaveTextContent("10 B");
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByTestId("explorer-properties-dialog")).toBeNull();
    expect(native.sftpOpenPath).not.toHaveBeenCalled();
    fireEvent.keyDown(list, { key: "Enter" });
    expect(native.openFile).toHaveBeenCalledWith({ path: "/fixture/alpha.txt" }, { context: "explorer", workspaceId: undefined, alternate: false });
  });

  it("opens nested directories by double-click using the same sftpStore pane", async () => {
    await mountShell();
    fireEvent.doubleClick(row("folder"));
    await waitFor(() => expect(rows()).toEqual(["child.txt"]));
    expect(useSftpStore.getState().sessions[TAB].local.path).toBe("/fixture/folder");
    expect(screen.getByTestId("explorer-tab")).toHaveAttribute("data-path", "/fixture/folder");
    expect(native.sftpOpenPath).not.toHaveBeenCalled();
  });
});
