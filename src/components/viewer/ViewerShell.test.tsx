import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ViewerShell } from "./ViewerShell";
import { ViewerCloseDialog } from "./ViewerDialogs";
import { useDocumentStore } from "../../stores/documentStore";
import { useAppStore } from "../../stores/appStore";
import { guardViewerClose, trackModuleDocumentDraft } from "../../lib/openFile/closeGuard";
import { viewerReadText, viewerStat, viewerWriteText } from "../../lib/viewer";
vi.mock("../../lib/viewer", async (original) => ({ ...await original<typeof import("../../lib/viewer")>(), viewerStat: vi.fn(), viewerReadText: vi.fn(), viewerWriteText: vi.fn() }));
const backups = vi.hoisted(() => new Map<string, { entry: { id: string; docId: string; path: string | null; name: string; encoding: string; bom: boolean; eol: string; savedHash: string; updatedAt: number; size: number }; content: string }[]>());
vi.mock("../../lib/notepad/ipc", () => {
  let sequence = 0;
  return {
    notepadBackupWrite: vi.fn(async (args: { docId: string; path: string | null; name: string; content: string; encoding: string; bom: boolean; eol: string; savedHash: string }) => {
      const entry = {
        id: `${args.docId}__${++sequence}`, docId: args.docId, path: args.path, name: args.name,
        encoding: args.encoding, bom: args.bom, eol: args.eol, savedHash: args.savedHash,
        updatedAt: Math.floor(Date.now() / 1000), size: args.content.length,
      };
      backups.set(args.docId, [...(backups.get(args.docId) ?? []), { entry, content: args.content }].slice(-9));
      return entry;
    }),
    notepadBackupList: vi.fn(async () => [...backups.values()].flat().map((item) => item.entry)),
    notepadBackupRead: vi.fn(async (id: string) => {
      for (const list of backups.values()) {
        const found = list.find((item) => item.entry.id === id);
        if (found) return found;
      }
      throw new Error(`not_found: ${id}`);
    }),
    notepadBackupPrune: vi.fn(async (docId: string) => { backups.delete(docId); }),
  };
});
import { notepadBackupWrite } from "../../lib/notepad/ipc";
const path = "/viewer.txt";
const viewer = { path, kind: "text" as const };
const addViewerTab = () => useAppStore.setState({ tabs: [{ id: "viewer", type: "file-viewer", fileViewer: viewer, title: "viewer.txt", closable: true }], activeTabId: "viewer" });
const withDraftStorageUnavailable = () => {
  const originalSetItem = Storage.prototype.setItem;
  return vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key: string, value: string) {
    if (key === "taomni.viewer.drafts.v1") throw new DOMException("Quota exceeded", "QuotaExceededError");
    Reflect.apply(originalSetItem, this, [key, value]);
  });
};
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); useDocumentStore.setState({ documents: {}, moduleDrafts: {}, closeRequest: undefined });
  backups.clear();
  vi.mocked(viewerStat).mockResolvedValue({ path, size: 4, mtime: 1, mime: "text/plain", isFile: true });
  vi.mocked(viewerReadText).mockResolvedValue({ path, content: "disk", hash: "hash", encoding: "UTF-8", bom: false, eol: "LF", mtime: 1, size: 4, truncated: false });
  vi.mocked(viewerWriteText).mockResolvedValue({ hash: "saved", size: 5, mtime: 2 });
  addViewerTab();
});
afterEach(async () => { cleanup(); await Promise.resolve(); vi.restoreAllMocks(); });
describe("shared viewer lifecycle and close guard", () => {
  it("survives StrictMode replay and preserves document while another host remains", async () => {
    const mounted = render(<StrictMode><ViewerShell viewer={viewer} /><ViewerShell viewer={viewer} active={false} /></StrictMode>);
    await waitFor(() => expect(screen.getAllByTestId("viewer-editor")).toHaveLength(2));
    act(() => useDocumentStore.getState().edit(path, "draft"));
    mounted.rerender(<StrictMode><ViewerShell viewer={viewer} /></StrictMode>);
    await act(async () => { await Promise.resolve(); });
    expect(useDocumentStore.getState().documents[path].content).toBe("draft");
    mounted.unmount(); await Promise.resolve();
    expect(useDocumentStore.getState().documents[path]).toBeUndefined();
    expect(localStorage.getItem("taomni.viewer.drafts.v1")).toContain("draft");
  });
  it("offers save/discard/cancel and does not close a dirty tab before the choice", async () => {
    // Workspace canvas hides the Sessions host; the shared close dialog must
    // portal out of that ancestor so a workspace dirty close remains visible.
    render(<><ViewerShell viewer={viewer} /><div style={{ display: "none" }}><ViewerCloseDialog /></div></>);
    await screen.findByTestId("viewer-editor");
    act(() => { useDocumentStore.getState().edit(path, "draft"); useAppStore.getState().removeTab("viewer"); });
    expect(screen.getByTestId("viewer-close-dialog")).toBeVisible(); expect(useAppStore.getState().tabs).toHaveLength(1);
    const cancel = screen.getByTestId("viewer-close-cancel");
    expect(cancel).toHaveFocus();
    fireEvent.keyDown(cancel, { key: "Escape", isComposing: true });
    expect(screen.getByTestId("viewer-close-dialog")).toBeVisible();
    fireEvent.keyDown(cancel, { key: "Escape" });
    expect(useAppStore.getState().tabs).toHaveLength(1); expect(useDocumentStore.getState().documents[path].dirty).toBe(true);
    act(() => useAppStore.getState().removeTab("viewer"));
    fireEvent.click(screen.getByTestId("viewer-close-discard"));
    expect(useAppStore.getState().tabs).toHaveLength(0); expect(useDocumentStore.getState().documents[path].dirty).toBe(false);
  });
  it("keeps the module close prompt open when saving a copy is cancelled and allows a retry", async () => {
    const modulePath = "/document.pdf";
    const save = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const proceed = vi.fn();
    trackModuleDocumentDraft({ path: modulePath, save, discard: vi.fn() });
    guardViewerClose([modulePath], proceed);

    render(<ViewerCloseDialog />);
    expect(screen.queryByTestId("viewer-close-keep-draft")).toBeNull();
    const saveButton = screen.getByTestId("viewer-close-save");
    fireEvent.click(saveButton);
    await waitFor(() => expect(saveButton).toBeEnabled());
    expect(screen.getByTestId("viewer-close-dialog")).toBeVisible();
    expect(proceed).not.toHaveBeenCalled();

    fireEvent.click(saveButton);
    await waitFor(() => expect(screen.queryByTestId("viewer-close-dialog")).toBeNull());
    expect(save).toHaveBeenCalledTimes(2);
    expect(proceed).toHaveBeenCalledOnce();
  });
  it("keeps a recovery draft while closing without writing the host file", async () => {
    render(<><ViewerShell viewer={viewer} /><ViewerCloseDialog /></>);
    await screen.findByTestId("viewer-editor");
    act(() => { useDocumentStore.getState().edit(path, "draft"); useAppStore.getState().removeTab("viewer"); });
    fireEvent.click(screen.getByTestId("viewer-close-keep-draft"));
    await act(async () => { await Promise.resolve(); });
    expect(useAppStore.getState().tabs).toHaveLength(0);
    expect(localStorage.getItem("taomni.viewer.drafts.v1")).toContain("draft");
    expect(viewerWriteText).not.toHaveBeenCalled();
  });
  it("restores a kept small draft when the tab is reopened", async () => {
    const first = render(<><ViewerShell viewer={viewer} /><ViewerCloseDialog /></>);
    await screen.findByTestId("viewer-editor");
    act(() => { useDocumentStore.getState().edit(path, "reopen draft"); useAppStore.getState().removeTab("viewer"); });
    fireEvent.click(screen.getByTestId("viewer-close-keep-draft"));
    await waitFor(() => expect(screen.queryByTestId("viewer-close-dialog")).toBeNull());
    first.unmount();
    await act(async () => { await Promise.resolve(); });
    expect(useDocumentStore.getState().documents[path]).toBeUndefined();
    addViewerTab();
    render(<><ViewerShell viewer={viewer} /><ViewerCloseDialog /></>);
    await screen.findByTestId("viewer-editor");
    await waitFor(() => expect(useDocumentStore.getState().documents[path].content).toBe("reopen draft"));
    expect(useDocumentStore.getState().documents[path].restored).toBe(true);
    expect(screen.getByTestId("viewer-draft-restored")).toBeVisible();
  });
  it("falls back to a native Notepad snapshot when localStorage rejects the keep-draft write", async () => {
    render(<><ViewerShell viewer={viewer} /><ViewerCloseDialog /></>);
    await screen.findByTestId("viewer-editor");
    const setItem = withDraftStorageUnavailable();
    try {
      act(() => { useDocumentStore.getState().edit(path, "native fallback draft"); useAppStore.getState().removeTab("viewer"); });
      fireEvent.click(screen.getByTestId("viewer-close-keep-draft"));
      await waitFor(() => expect(screen.queryByTestId("viewer-close-dialog")).toBeNull());
    } finally {
      setItem.mockRestore();
    }
    expect(notepadBackupWrite).toHaveBeenCalledWith(expect.objectContaining({ docId: path, content: "native fallback draft" }));
    expect(useAppStore.getState().tabs).toHaveLength(0);
    expect(viewerWriteText).not.toHaveBeenCalled();
  });
  it("keeps the close dialog open with an actionable error when the draft cannot persist", async () => {
    render(<><ViewerShell viewer={viewer} /><ViewerCloseDialog /></>);
    await screen.findByTestId("viewer-editor");
    const setItem = withDraftStorageUnavailable();
    const write = vi.mocked(notepadBackupWrite);
    const originalWrite = write.getMockImplementation()!;
    write.mockRejectedValue(new Error("io: disk full"));
    try {
      act(() => { useDocumentStore.getState().edit(path, "unsavable draft"); useAppStore.getState().removeTab("viewer"); });
      fireEvent.click(screen.getByTestId("viewer-close-keep-draft"));
      await waitFor(() => expect(screen.getByTestId("viewer-close-error")).toBeVisible());
    } finally {
      write.mockImplementation(originalWrite);
      setItem.mockRestore();
    }
    expect(screen.getByTestId("viewer-close-error").textContent).toMatch(/disk full/);
    expect(screen.getByTestId("viewer-close-dialog")).toBeVisible();
    expect(useAppStore.getState().tabs).toHaveLength(1);
    expect(useDocumentStore.getState().documents[path].dirty).toBe(true);
  });
});
