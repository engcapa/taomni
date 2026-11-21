import { beforeEach, describe, expect, it } from "vitest";
import { useAppStore } from "../../../stores/appStore";
import { useDocumentStore } from "../../../stores/documentStore";
import { useExplorerStore } from "../../../stores/explorerStore";
import { useNotepadStore } from "../../../stores/notepadStore";
import { createDefaultWorkspace, useWorkspacePlatformStore } from "../../../stores/workspacePlatformStore";
import { viewerTabHost } from "./viewerTabHost";

describe("viewerTabHost adapter (V-46)", () => {
  beforeEach(() => {
    localStorage.clear();
    useDocumentStore.setState({ documents: {}, closeRequest: undefined, draftError: undefined });
    useNotepadStore.setState({ docs: {} });
    useExplorerStore.setState({ tabs: [], activeTabId: null });
    useAppStore.setState({ tabs: [], activeTabId: null });
    const ws = createDefaultWorkspace();
    useWorkspacePlatformStore.setState({ workspaces: [ws], activeWorkspaceId: ws.id });
  });

  it("opens untitled docs, lists open docs across hosts, pins left, and rekeys on Save As", () => {
    const id1 = viewerTabHost.openUntitled({ host: "explorer" }, "");
    const id2 = viewerTabHost.openUntitled({ host: "explorer" }, "world");
    expect(id1).toMatch(/^untitled:/);
    expect(id2).toMatch(/^untitled:/);

    const open = viewerTabHost.listOpenDocs({ host: "explorer" });
    expect(open).toHaveLength(2);
    expect(open[0].untitled).toBe(true);

    // Pinning second tab moves it left ahead of first unpinned tab
    viewerTabHost.pinDoc(id2, true);
    const afterPin = viewerTabHost.listOpenDocs({ host: "explorer" });
    expect(afterPin[0].docKey).toBe(id2);
    expect(afterPin[0].pinned).toBe(true);

    // closeMany with keepPinned preserves pinned id2
    viewerTabHost.closeMany([id1, id2], { keepPinned: true, host: "explorer" });
    const remaining = viewerTabHost.listOpenDocs({ host: "explorer" });
    expect(remaining.map((r) => r.docKey)).toEqual([id2]);

    // Rekey on Save As updates Explorer tab path and title cleanly
    viewerTabHost.rekeyDoc(id2, "/preview/saved-note.txt", "saved-note.txt");
    const rekeyed = viewerTabHost.listOpenDocs({ host: "explorer" });
    expect(rekeyed[0]).toMatchObject({ path: "/preview/saved-note.txt", title: "saved-note.txt", untitled: false });
  });

  it("activates and closes workspace file-viewer tabs", () => {
    const ws = useWorkspacePlatformStore.getState().workspaces[0];
    useWorkspacePlatformStore.getState().openViewerTab(ws.id, {
      path: "/preview/ws-doc.txt",
      kind: "text",
      mode: "notepad",
      title: "ws-doc.txt",
    });
    expect(viewerTabHost.activateDoc("/preview/ws-doc.txt", { host: "workspace", workspaceId: ws.id })).toBe(true);
    expect(viewerTabHost.getActiveDoc({ host: "workspace", workspaceId: ws.id })?.path).toBe("/preview/ws-doc.txt");
    expect(viewerTabHost.closeDoc("/preview/ws-doc.txt", { host: "workspace", workspaceId: ws.id })).toBe(true);
    expect(viewerTabHost.listOpenDocs({ host: "workspace", workspaceId: ws.id })).toHaveLength(0);
  });
});
