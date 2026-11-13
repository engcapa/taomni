import { act, cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EditorView } from "@codemirror/view";
import { EditorSurface } from "./EditorSurface";
import { useDocumentStore } from "../../stores/documentStore";
import { viewerReadText, viewerStat } from "../../lib/viewer";
vi.mock("../../lib/viewer", async (original) => ({ ...await original<typeof import("../../lib/viewer")>(), viewerStat: vi.fn(), viewerReadText: vi.fn() }));
const path = "/note.txt";
beforeEach(async () => {
  localStorage.clear(); useDocumentStore.setState({ documents: {} });
  vi.mocked(viewerStat).mockResolvedValue({ path, size: 3, mtime: 1, mime: "text/plain", isFile: true });
  vi.mocked(viewerReadText).mockResolvedValue({ path, content: "old", hash: "h", encoding: "UTF-8", bom: false, eol: "LF", mtime: 1, size: 3, truncated: false });
  await useDocumentStore.getState().open(path);
});
afterEach(cleanup);
describe("lightweight shared CodeMirror surface", () => {
  it("keeps one mounted view and sends only local changes into the shared store", async () => {
    let view: EditorView | null = null;
    const current = () => useDocumentStore.getState().documents[path];
    const screen = render(<div className="fv"><EditorSurface document={current()} onView={(value) => { view = value; }} /></div>);
    await waitFor(() => expect(view).not.toBeNull());
    const original = view;
    act(() => { view!.dispatch({ changes: { from: 0, to: 3, insert: "mine" } }); });
    expect(current().content).toBe("mine"); expect(current().dirty).toBe(true);
    screen.rerender(<div className="fv"><EditorSurface document={{ ...current(), content: "shared" }} onView={(value) => { view = value; }} /></div>);
    expect(view).toBe(original); expect(view!.state.doc.toString()).toBe("shared");
    expect(current().content).toBe("mine");
  });
  it("makes remote and large documents non-editable", async () => {
    const current = useDocumentStore.getState().documents[path];
    const screen = render(<div className="fv"><EditorSurface document={{ ...current, readOnly: true }} /></div>);
    await waitFor(() => expect(screen.getByTestId("viewer-editor-content")).toHaveAttribute("contenteditable", "false"));
  });
});
