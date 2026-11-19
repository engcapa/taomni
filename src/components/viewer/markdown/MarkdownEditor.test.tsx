import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { undo, redo } from "@codemirror/commands";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewerDocument } from "../../../lib/viewer";
import { viewerReadBytes, viewerSavePastedImage } from "../../../lib/viewer";
import { readClipboardImageFiles, readNativeClipboardImagePath } from "../../../lib/clipboard";
import { useDocumentStore } from "../../../stores/documentStore";
import { MarkdownEditor } from "./MarkdownEditor";
import { exportMarkdown } from "./markdownExport";
// @ts-expect-error Node builtin is confined to unit tests, not the DOM application.
import { readFileSync } from "node:fs";
const markdownStyles = readFileSync("src/components/viewer/markdown/markdown.css", "utf8") as string;

vi.mock("../viewerLabels", () => ({ useViewerLabels: () => (_zh: string, en: string) => en }));
vi.mock("./markdownExport", () => ({ exportMarkdown: vi.fn() }));
vi.mock("../../../lib/explorer/openExplorer", () => ({ openExplorer: vi.fn() }));
vi.mock("../../../lib/clipboard", async (original) => ({
  ...await original<typeof import("../../../lib/clipboard")>(),
  readNativeClipboardImagePath: vi.fn(async () => null),
  readClipboardImageFiles: vi.fn(async () => []),
}));
vi.mock("../../../lib/viewer", async (original) => ({
  ...await original<typeof import("../../../lib/viewer")>(),
  viewerReadBytes: vi.fn(),
  viewerSavePastedImage: vi.fn(),
}));
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
let style: HTMLStyleElement;
beforeEach(() => {
  vi.clearAllMocks();
  style = document.createElement("style");
  style.textContent = markdownStyles;
  document.head.append(style);
  useDocumentStore.setState({ documents: { "/docs/a.md": fixture() } });
});
afterEach(() => { cleanup(); style.remove(); useDocumentStore.setState({ documents: {} }); });

describe("MarkdownEditor real host lifecycle", () => {
  it("shares terminal-style zoom across modes and leaves the editor history intact", () => {
    render(<Harness />);
    const content = screen.getByTestId("viewer-editor").querySelector<HTMLElement>(".cm-content")!;
    fireEvent.keyDown(content, { key: "=", ctrlKey: true });
    expect(screen.getByTestId("markdown-live")).toHaveAttribute("data-zoom", "110");
    expect(fireEvent.wheel(content, { deltaY: -100, ctrlKey: true })).toBe(false);
    expect(screen.getByTestId("markdown-live")).toHaveAttribute("data-zoom", "120");
    fireEvent.wheel(content, { deltaY: 100 });
    fireEvent.click(screen.getByTestId("markdown-mode-source"));
    expect(screen.getByTestId("markdown-source")).toHaveAttribute("data-zoom", "120");
    fireEvent.keyDown(content, { key: "-", ctrlKey: true });
    fireEvent.keyDown(content, { key: "0", ctrlKey: true, isComposing: true });
    expect(screen.getByTestId("markdown-source")).toHaveAttribute("data-zoom", "110");
    fireEvent.click(screen.getByTestId("markdown-mode-split"));
    fireEvent.keyDown(content, { key: "0", ctrlKey: true });
    expect(screen.getByTestId("markdown-split")).toHaveAttribute("data-zoom", "100");
    expect(useDocumentStore.getState().documents["/docs/a.md"].content).toBe(source);
  });

  it("keeps the shared find panel across modes and permits replacement only in the editing surface", () => {
    render(<Harness />);
    fireEvent.keyDown(screen.getByTestId("markdown-live"), { key: "f", ctrlKey: true });
    const panel = screen.getByTestId("code-workspace-editor-search");
    const find = screen.getByRole("searchbox", { name: "Find" });
    fireEvent.input(find, { target: { value: "Details" } });
    fireEvent.click(screen.getByRole("button", { name: "Show replace" }));
    expect(screen.getByRole("button", { name: "Replace all matches" })).toBeDisabled();
    fireEvent.input(screen.getByLabelText("Replace", { selector: "input" }), { target: { value: "Outline" } });
    expect(useDocumentStore.getState().documents["/docs/a.md"].content).toContain("## Details");

    fireEvent.click(screen.getByTestId("markdown-mode-split"));
    expect(screen.getByTestId("code-workspace-editor-search")).toBe(panel);
    expect(find).toHaveValue("Details");
    fireEvent.click(screen.getByRole("button", { name: "Replace all matches" }));
    expect(useDocumentStore.getState().documents["/docs/a.md"].content).toContain("## Outline");

    fireEvent.click(screen.getByTestId("markdown-mode-live"));
    expect(screen.getByRole("button", { name: "Replace all matches" })).toBeDisabled();
    fireEvent.keyDown(find, { key: "Escape" });
    expect(screen.queryByTestId("code-workspace-editor-search")).not.toBeInTheDocument();
  });

  it("keeps exactly one import/export control while actual editor selections and modes change", () => {
    render(<Harness />);
    const importDrawio = screen.getByRole("button", { name: "Import draw.io" });
    const insertImage = screen.getByRole("button", { name: "Insert image" });
    expect(screen.getByRole("toolbar", { name: "Markdown formatting" })).toContainElement(importDrawio);
    expect(insertImage.nextElementSibling).toBe(importDrawio);
    expect(importDrawio).toBeDisabled();
    fireEvent.click(screen.getByTestId("markdown-live-edit"));
    expect(importDrawio).toBeEnabled();
    const view = EditorView.findFromDOM(screen.getByTestId("viewer-editor").querySelector<HTMLElement>(".cm-editor")!)!;
    for (const mode of ["live", "source", "split", "live"] as const) {
      fireEvent.click(screen.getByTestId(`markdown-mode-${mode}`));
      for (const anchor of [source.indexOf("Details"), 0, source.indexOf("bold"), source.length, 3]) {
        act(() => view.dispatch({ selection: { anchor, head: Math.min(source.length, anchor + 3) } }));
        expect(screen.getAllByTestId("markdown-import-drawio")).toEqual([importDrawio]);
        expect(screen.getAllByTestId("markdown-export")).toHaveLength(1);
      }
    }
    expect(view.state.doc.toString()).toBe(source);
    expect(useDocumentStore.getState().documents["/docs/a.md"].dirty).toBe(false);
    fireEvent.click(screen.getByTestId("markdown-export"));
    expect(screen.getByTestId("markdown-export-menu")).toBeInTheDocument();
  });
  it("keeps the export menu above diagram actions when the shared viewer styles load last", () => {
    const viewerStyles = document.createElement("style");
    viewerStyles.textContent = readFileSync("src/components/viewer/viewer.css", "utf8")
      + readFileSync("src/components/viewer/markdown/diagram.css", "utf8");
    const diagramTools = document.createElement("div");
    diagramTools.className = "fv fv-md-diagram-tools";
    document.head.append(viewerStyles);
    document.body.append(diagramTools);
    try {
      render(<Harness />);
      fireEvent.click(screen.getByTestId("markdown-export"));
      const menu = screen.getByTestId("markdown-export-menu");
      expect(Number(getComputedStyle(menu).zIndex)).toBeGreaterThan(Number(getComputedStyle(diagramTools).zIndex));
    } finally {
      viewerStyles.remove();
      diagramTools.remove();
    }
  });
  it("keeps one source/history across live/source/split/focus switches, with outline navigation", async () => {
    render(<Harness />);
    const dom = screen.getByTestId("markdown-editor").querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(dom)!;
    expect(screen.getByTestId("markdown-outline")).toHaveTextContent("Details");
    expect(dom.querySelector("strong")?.textContent).toBe("bold");
    expect(view.state.readOnly).toBe(true);
    fireEvent.click(screen.getByTestId("markdown-live-edit"));
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
  it("keeps compact view-only whitespace, subtle heading syntax and editable blank/EOF history", () => {
    render(<Harness />);
    const dom = screen.getByTestId("markdown-editor").querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(dom)!;
    fireEvent.click(screen.getByTestId("markdown-live-edit"));
    const marker = dom.querySelector<HTMLElement>(".fv-md-source-marker")!;
    expect(marker.textContent).toBe("# ");
    expect(getComputedStyle(marker).fontSize).toBe("0.8em");
    expect(getComputedStyle(marker).fontWeight).toBe("400");
    const rendered = dom.querySelector<HTMLElement>(".fv-md-rendered-block")!;
    expect(getComputedStyle(rendered).whiteSpace).toBe("normal");
    const blank = source.indexOf("\n\n##") + 1;
    act(() => view.dispatch({ selection: { anchor: blank } }));
    expect(dom.querySelector(".fv-md-current-line")).not.toBeNull();
    act(() => view.dispatch({ changes: { from: blank, insert: "typed" }, selection: { anchor: blank + 5 } }));
    expect(view.state.doc.toString()).toBe(source.slice(0, blank) + "typed" + source.slice(blank));
    act(() => { expect(undo(view)).toBe(true); });
    expect(view.state.doc.toString()).toBe(source);
    act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }));
    expect(dom.querySelector(".fv-md-current-line")).not.toBeNull();
    act(() => view.dispatch({ changes: { from: view.state.doc.length, insert: "end" } }));
    expect(view.state.doc.toString()).toBe(source + "end");
    act(() => { expect(undo(view)).toBe(true); });
    expect(view.state.doc.toString()).toBe(source);
  });
  it("preserves clipboard conversion Undo/Redo through the mounted shared store", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("markdown-mode-source"));
    const dom = screen.getByTestId("markdown-editor").querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(dom)!;
    act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }));
    const event = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(event, "clipboardData", { value: { items: [], getData: (type: string) => type === "text/plain" ? "Name\tValue\r\nAlpha\t1" : "" } });
    act(() => { view.contentDOM.dispatchEvent(event); });
    expect(view.state.doc.toString()).toContain("| Alpha | 1 |");
    act(() => { expect(undo(view)).toBe(true); });
    expect(view.state.doc.toString()).toContain("Name\tValue\nAlpha\t1");
    act(() => { expect(redo(view)).toBe(true); });
    expect(view.state.doc.toString()).toContain("| Alpha | 1 |");
    expect(useDocumentStore.getState().documents["/docs/a.md"].content).toBe(view.state.doc.toString());
  });
  it("starts Live in browse mode, gates all writes and restores browse after mode changes", () => {
    render(<Harness />);
    const dom = screen.getByTestId("markdown-editor").querySelector<HTMLElement>(".cm-editor")!;
    const view = EditorView.findFromDOM(dom)!;
    expect(view.state.readOnly).toBe(true);
    act(() => view.dispatch({ changes: { from: 0, insert: "blocked" } }));
    expect(view.state.doc.toString()).toBe(source);
    expect(useDocumentStore.getState().documents["/docs/a.md"].dirty).toBe(false);
    expect(screen.getByTestId("markdown-format-bold")).toBeDisabled();
    fireEvent.click(screen.getByTestId("markdown-live-edit"));
    expect(view.state.readOnly).toBe(false);
    expect(useDocumentStore.getState().documents["/docs/a.md"].dirty).toBe(false);
    act(() => view.dispatch({ changes: { from: 0, insert: "allowed\n" } }));
    fireEvent.click(screen.getByTestId("markdown-mode-source"));
    expect(view.state.readOnly).toBe(false);
    fireEvent.click(screen.getByTestId("markdown-mode-live"));
    expect(view.state.readOnly).toBe(true);
    expect(view.state.doc.toString()).toContain("allowed");
    fireEvent.click(screen.getByTestId("markdown-live-edit"));
    act(() => { expect(undo(view)).toBe(true); });
    expect(view.state.doc.toString()).toBe(source);
  });
  it("keeps hard read-only sources protected and local preview appearance independent from the app", async () => {
    useDocumentStore.setState({ documents: { "/docs/a.md": { ...fixture(), readOnly: true } } });
    render(<Harness />);
    expect(screen.getByTestId("markdown-live-edit")).toBeDisabled();
    const sourceTheme = document.documentElement.dataset.appTheme;
    fireEvent.click(screen.getByTestId("markdown-preview-appearance"));
    fireEvent.click(screen.getByRole("option", { name: "Dark" }));
    expect(document.querySelector(".fv-md-live-pane")).toHaveAttribute("data-preview-theme", "dark");
    expect(document.documentElement.dataset.appTheme).toBe(sourceTheme);
    fireEvent.click(screen.getByTestId("markdown-mode-split"));
    expect(screen.getByTestId("markdown-preview")).toHaveAttribute("data-preview-theme", "dark");
    const separator = screen.getByTestId("markdown-split-resize");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    expect(separator).toHaveAttribute("aria-valuenow", "55");
    const view = EditorView.findFromDOM(screen.getByTestId("viewer-editor").querySelector<HTMLElement>(".cm-editor")!)!;
    expect(view.state.readOnly).toBe(true);
    expect(useDocumentStore.getState().documents["/docs/a.md"].dirty).toBe(false);
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
  it("uses actual PDF page settings and reports the independently saved PDF", async () => {
    vi.mocked(exportMarkdown).mockResolvedValue({ status: "saved", path: "/exports/a.pdf" });
    render(<Harness />);
    fireEvent.click(screen.getByTestId("markdown-export")); fireEvent.click(screen.getByTestId("markdown-export-pdf"));
    expect(screen.getByTestId("markdown-export-settings")).toHaveTextContent("A4");
    fireEvent.click(screen.getByRole("combobox", { name: "Paper" }));
    fireEvent.click(screen.getByRole("option", { name: "Letter" }));
    fireEvent.click(screen.getByTestId("markdown-export-confirm"));
    await waitFor(() => expect(exportMarkdown).toHaveBeenCalledWith("pdf", source, "/docs/a.md", expect.objectContaining({ paper: "Letter" })));
    expect(screen.getByTestId("markdown-export-status")).toHaveAttribute("data-export-state", "saved");
    expect(screen.getByTestId("markdown-export-status")).toHaveAttribute("data-export-path", "/exports/a.pdf");
  });

  it("opens the export menu outside the toolbar clipping surface and restores focus on Escape", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("markdown-export"));
    const menu = screen.getByTestId("markdown-export-menu");
    expect(menu.closest(".fv-md-toolbar")).toBeNull();
    expect(screen.getByTestId("markdown-export-html")).toHaveFocus();
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(screen.queryByTestId("markdown-export-menu")).toBeNull();
    expect(screen.getByTestId("markdown-export")).toHaveFocus();
  });

  it("keeps Mermaid split preview width >= 340px and clamps doc padding on narrow panes", () => {
    expect(markdownStyles).toContain(".fv-md-doc{max-width:800px;margin:0 auto;padding:30px clamp(16px,4.5%,44px) 120px;");
    expect(markdownStyles).toContain(".fv-md-mermaid svg{width:max(100%,340px);height:auto;margin:auto}");
  });

  it("falls back to native clipboard image bytes on WebKitGTK X11 paste without ClipboardItem files", async () => {
    vi.mocked(readNativeClipboardImagePath).mockResolvedValue("/tmp/x11-clip.png");
    vi.mocked(viewerReadBytes).mockResolvedValue({ bytes: [137, 80, 78, 71], mime: "image/png", size: 4 });
    vi.mocked(viewerSavePastedImage).mockResolvedValue({
      path: "/docs/assets/pasted.png",
      relativePath: "assets/pasted.png",
    });
    const tauriWindow = window as unknown as { __TAURI_INTERNALS__?: unknown };
    const prevTauri = tauriWindow.__TAURI_INTERNALS__;
    tauriWindow.__TAURI_INTERNALS__ = {};
    try {
      render(<Harness />);
      fireEvent.click(screen.getByTestId("markdown-mode-source"));
      const dom = screen.getByTestId("markdown-editor").querySelector<HTMLElement>(".cm-editor")!;
      const view = EditorView.findFromDOM(dom)!;
      act(() => view.dispatch({ selection: { anchor: view.state.doc.length } }));

      const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(pasteEvent, "clipboardData", {
        value: { items: [], getData: () => "" },
      });
      act(() => {
        view.contentDOM.dispatchEvent(pasteEvent);
      });

      await waitFor(() => expect(view.state.doc.toString()).toContain("![image](assets/pasted.png)"));
      expect(readNativeClipboardImagePath).toHaveBeenCalledTimes(1);
      expect(viewerReadBytes).toHaveBeenCalledWith("/tmp/x11-clip.png", expect.any(Number));
      expect(readClipboardImageFiles).not.toHaveBeenCalled();
    } finally {
      if (prevTauri === undefined) delete tauriWindow.__TAURI_INTERNALS__;
      else tauriWindow.__TAURI_INTERNALS__ = prevTauri;
    }
  });
});
