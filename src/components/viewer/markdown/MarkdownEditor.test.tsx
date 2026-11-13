import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewerDocument } from "../../../lib/viewer";
import { useDocumentStore } from "../../../stores/documentStore";
import { MarkdownEditor } from "./MarkdownEditor";
import { exportMarkdown } from "./markdownExport";

vi.mock("../viewerLabels", () => ({ useViewerLabels: () => (_zh: string, en: string) => en }));
vi.mock("./markdownExport", () => ({ exportMarkdown: vi.fn() }));
vi.mock("../../../lib/explorer/openExplorer", () => ({ openExplorer: vi.fn() }));
const source = "# Title\n\nA **bold** line\n\n## Details\n\n| A | B |\n| --- | --- |\n| c | d |\n";
function fixture(): ViewerDocument {
  return { key: "/docs/a.md", path: "/docs/a.md", kind: "markdown", content: source, savedContent: source, savedHash: "hash",
    encoding: "UTF-8", bom: false, eol: "LF", savedEncoding: "UTF-8", savedBom: false, savedEol: "LF", originalLineEndings: [], dirty: false,
    mtime: 0, size: source.length, readOnly: false, loading: false, saving: false, large: false, truncated: false, revision: 0, chunkOffset: 0, nextOffset: 0, eof: true };
}
function Harness() {
  const document = useDocumentStore((state) => state.documents["/docs/a.md"]);
  return <MarkdownEditor document={document} onError={vi.fn()} />;
}
beforeEach(() => { vi.clearAllMocks(); useDocumentStore.setState({ documents: { "/docs/a.md": fixture() } }); });
afterEach(() => { cleanup(); useDocumentStore.setState({ documents: {} }); });

describe("MarkdownEditor real host lifecycle", () => {
  it("keeps one source/history across live/source/split/focus switches, with outline navigation", async () => {
    render(<Harness />);
    const dom = screen.getByTestId("markdown-editor").querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(dom)!;
    expect(screen.getByTestId("markdown-outline")).toHaveTextContent("Details");
    expect(dom.querySelector("strong")?.textContent).toBe("bold");
    act(() => { view.dispatch({ changes: { from: 0, to: 7, insert: "# Changed" } }); });
    expect(useDocumentStore.getState().documents["/docs/a.md"].dirty).toBe(true);
    fireEvent.click(screen.getByTestId("markdown-mode-source"));
    expect(screen.getByTestId("markdown-source")).toBeInTheDocument();
    expect(EditorView.findFromDOM(dom)).toBe(view);
    fireEvent.click(screen.getByTestId("markdown-mode-split"));
    await waitFor(() => expect(screen.getByTestId("markdown-preview").querySelector("h1")?.textContent).toBe("Changed"));
    expect(EditorView.findFromDOM(dom)).toBe(view);
    fireEvent.click(screen.getByTestId("markdown-mode-live"));
    fireEvent.click(screen.getByTestId("markdown-focus"));
    expect(screen.getByTestId("markdown-editor")).toHaveClass("fv-md-focus");
    expect(view.state.doc.toString()).toContain("# Changed");
    expect(screen.queryByText(/Simulate|模拟/)).toBeNull();
  });
  it("exports actual unsaved content and distinguishes completion, cancellation and errors", async () => {
    vi.mocked(exportMarkdown).mockResolvedValue({ status: "saved", path: "/exports/a.html" });
    render(<Harness />);
    fireEvent.click(screen.getByTestId("markdown-export"));
    fireEvent.click(screen.getByTestId("markdown-export-html"));
    await waitFor(() => expect(screen.getByTestId("markdown-export-status")).toHaveAttribute("data-export-state", "saved"));
    expect(exportMarkdown).toHaveBeenCalledWith("html", source, "/docs/a.md", expect.any(Object));
    expect(screen.getByTestId("markdown-export-status")).toHaveAttribute("data-export-path", "/exports/a.html");
    vi.mocked(exportMarkdown).mockResolvedValue({ status: "cancelled" });
    fireEvent.click(screen.getByTestId("markdown-export")); fireEvent.click(screen.getByTestId("markdown-export-html"));
    await waitFor(() => expect(screen.getByTestId("markdown-export-status")).toHaveAttribute("data-export-state", "cancelled"));
  });
  it("uses actual PDF page settings and calls the print/PDF route without claiming a saved file", async () => {
    vi.mocked(exportMarkdown).mockResolvedValue({ status: "print-opened" });
    render(<Harness />);
    fireEvent.click(screen.getByTestId("markdown-export")); fireEvent.click(screen.getByTestId("markdown-export-pdf"));
    expect(screen.getByTestId("markdown-export-settings")).toHaveTextContent("A4");
    fireEvent.change(screen.getByLabelText("Paper"), { target: { value: "Letter" } });
    fireEvent.click(screen.getByTestId("markdown-export-confirm"));
    await waitFor(() => expect(exportMarkdown).toHaveBeenCalledWith("pdf", source, "/docs/a.md", expect.objectContaining({ paper: "Letter" })));
    expect(screen.getByTestId("markdown-export-status")).toHaveAttribute("data-export-state", "print-opened");
    expect(screen.getByTestId("markdown-export-status")).not.toHaveAttribute("data-export-path");
  });
});
