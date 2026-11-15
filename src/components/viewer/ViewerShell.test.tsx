import { StrictMode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ViewerShell } from "./ViewerShell";
import { ViewerCloseDialog } from "./ViewerDialogs";
import { useDocumentStore } from "../../stores/documentStore";
import { useAppStore } from "../../stores/appStore";
import { viewerReadText, viewerStat, viewerWriteText } from "../../lib/viewer";
vi.mock("../../lib/viewer", async (original) => ({ ...await original<typeof import("../../lib/viewer")>(), viewerStat: vi.fn(), viewerReadText: vi.fn(), viewerWriteText: vi.fn() }));
const path = "/viewer.txt";
const viewer = { path, kind: "text" as const };
beforeEach(() => {
  vi.clearAllMocks(); localStorage.clear(); useDocumentStore.setState({ documents: {}, closeRequest: undefined });
  vi.mocked(viewerStat).mockResolvedValue({ path, size: 4, mtime: 1, mime: "text/plain", isFile: true });
  vi.mocked(viewerReadText).mockResolvedValue({ path, content: "disk", hash: "hash", encoding: "UTF-8", bom: false, eol: "LF", mtime: 1, size: 4, truncated: false });
  vi.mocked(viewerWriteText).mockResolvedValue({ hash: "saved", size: 5, mtime: 2 });
  useAppStore.setState({ tabs: [{ id: "viewer", type: "file-viewer", fileViewer: viewer, title: "viewer.txt", closable: true }], activeTabId: "viewer" });
});
afterEach(async () => { cleanup(); await Promise.resolve(); });
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
    fireEvent.click(screen.getByTestId("viewer-close-cancel"));
    expect(useAppStore.getState().tabs).toHaveLength(1); expect(useDocumentStore.getState().documents[path].dirty).toBe(true);
    act(() => useAppStore.getState().removeTab("viewer"));
    fireEvent.click(screen.getByTestId("viewer-close-discard"));
    expect(useAppStore.getState().tabs).toHaveLength(0); expect(useDocumentStore.getState().documents[path].dirty).toBe(false);
  });
});
