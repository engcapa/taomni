import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { EditorView } from "@codemirror/view";
import { undo } from "@codemirror/commands";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewerDocument } from "../../../lib/viewer";
import { useDocumentStore } from "../../../stores/documentStore";
import { MarkdownEditor } from "./MarkdownEditor";
// @ts-expect-error Node builtin is confined to unit tests, not the DOM application.
import { readFileSync } from "node:fs";

const themeCss = readFileSync("src/styles/theme.css", "utf8") as string;
const viewerCss = readFileSync("src/components/viewer/viewer.css", "utf8") as string;
const markdownCss = readFileSync("src/components/viewer/markdown/markdown.css", "utf8") as string;

vi.mock("../viewerLabels", () => ({ useViewerLabels: () => (_zh: string, en: string) => en }));
vi.mock("./markdownExport", () => ({ exportMarkdown: vi.fn() }));
vi.mock("../../../lib/explorer/openExplorer", () => ({ openExplorer: vi.fn() }));

const sampleDoc = [
  "# About",
  "",
  "<!-- Main description -->",
  "",
  "Mermaid is a diagramming tool.",
  "",
  "> Doc-Rot is a Catch-22 that Mermaid helps to solve.",
  "",
  "## Details",
  "",
  "Plain paragraph text.",
].join("\n");

function fixture(content = sampleDoc): ViewerDocument {
  return {
    key: "/docs/about.md",
    path: "/docs/about.md",
    kind: "markdown",
    content,
    savedContent: content,
    savedHash: "hash",
    encoding: "UTF-8",
    bom: false,
    eol: "LF",
    savedEncoding: "UTF-8",
    savedBom: false,
    savedEol: "LF",
    originalLineEndings: [],
    dirty: false,
    mtime: 0,
    size: content.length,
    readOnly: false,
    loading: false,
    saving: false,
    large: false,
    truncated: false,
    revision: 0,
    chunkOffset: 0,
    nextOffset: 0,
    eof: true,
  };
}

function Harness() {
  const doc = useDocumentStore((state) => state.documents["/docs/about.md"]);
  return (
    <div className="fv">
      <MarkdownEditor document={doc} onError={vi.fn()} />
    </div>
  );
}

function resolveColorVar(el: Element, value: string): string {
  const style = getComputedStyle(el);
  let current = value.trim();
  for (let depth = 0; depth < 6; depth++) {
    const match = /^var\(\s*(--[^,\s)]+)(?:\s*,\s*(.+))?\)$/.exec(current);
    if (!match) return current.replace(/\s+/g, "");
    const resolved = style.getPropertyValue(match[1]).trim();
    current = resolved || (match[2] ?? "").trim();
  }
  return current.replace(/\s+/g, "");
}

function readSelectionBg(focused: boolean): string {
  const cmEditor = screen.getByTestId("viewer-editor").querySelector<HTMLElement>(".cm-editor")!;
  const layer = cmEditor.querySelector<HTMLElement>(".cm-selectionLayer")!;
  expect(layer).not.toBeNull();
  const marker = document.createElement("div");
  marker.className = "cm-selectionBackground";
  layer.append(marker);
  cmEditor.classList.toggle("cm-focused", focused);
  try {
    return resolveColorVar(marker, getComputedStyle(marker).backgroundColor);
  } finally {
    marker.remove();
  }
}

let styleEl: HTMLStyleElement;
beforeEach(() => {
  vi.clearAllMocks();
  document.documentElement.removeAttribute("data-app-theme");
  styleEl = document.createElement("style");
  styleEl.textContent = `${themeCss}\n${viewerCss}\n${markdownCss}`;
  document.head.append(styleEl);
  useDocumentStore.setState({ documents: { "/docs/about.md": fixture() } });
});
afterEach(() => {
  cleanup();
  styleEl.remove();
  document.documentElement.removeAttribute("data-app-theme");
  useDocumentStore.setState({ documents: {} });
});

describe("MarkdownEditor edit-mode selection contrast and formatting interactions", () => {
  it("uses readable dark selection tokens in Source, Split, and Live Edit modes while preserving Live browse", () => {
    document.documentElement.setAttribute("data-app-theme", "dark");
    render(<Harness />);

    // Live browse mode uses native selection (no CodeMirror drawSelection layer)
    expect(screen.getByTestId("markdown-editor")).toHaveAttribute("data-editing", "false");
    expect(screen.getByTestId("viewer-editor").querySelector(".cm-selectionLayer")).toBeNull();

    // Live edit mode uses dark preview selection tokens (never CM #d7d4f0 / #d9d9d9)
    fireEvent.click(screen.getByTestId("markdown-live-edit"));
    expect(screen.getByTestId("markdown-editor")).toHaveAttribute("data-editing", "true");
    expect(readSelectionBg(true)).toBe("rgba(92,143,214,0.4)");
    expect(readSelectionBg(false)).toBe("rgba(92,143,214,0.22)");

    // Active line in Live edit becomes transparent while a range is selected
    const view = EditorView.findFromDOM(screen.getByTestId("viewer-editor").querySelector<HTMLElement>(".cm-editor")!)!;
    const from = sampleDoc.indexOf("Mermaid is");
    const to = sampleDoc.indexOf("solve.") + "solve.".length;
    act(() => view.dispatch({ selection: { anchor: from, head: to } }));
    expect(screen.getByTestId("viewer-editor")).toHaveClass("fv-selection-active");
    const currentLine = view.contentDOM.querySelector<HTMLElement>(".fv-md-current-line");
    expect(currentLine).not.toBeNull();
    expect(getComputedStyle(currentLine!).backgroundColor).toBe("rgba(0, 0, 0, 0)");

    // Source mode & Split mode under dark app theme keep readable dark selection
    for (const mode of ["source", "split"] as const) {
      fireEvent.click(screen.getByTestId(`markdown-mode-${mode}`));
      expect(readSelectionBg(true)).toBe("rgba(92,143,214,0.4)");
      expect(readSelectionBg(false)).toBe("rgba(92,143,214,0.22)");
    }

    // Returning to Live restores browse mode without dirtying the document
    fireEvent.click(screen.getByTestId("markdown-mode-live"));
    expect(screen.getByTestId("markdown-editor")).toHaveAttribute("data-editing", "false");
    expect(screen.getByTestId("viewer-editor").querySelector(".cm-selectionLayer")).toBeNull();
    expect(useDocumentStore.getState().documents["/docs/about.md"].dirty).toBe(false);
  });

  it("adapts Live Edit selection tokens to local PreviewAppearance overrides independent of the app theme", () => {
    document.documentElement.setAttribute("data-app-theme", "dark");
    render(<Harness />);
    fireEvent.click(screen.getByTestId("markdown-live-edit"));

    // Dark app + Light local preview -> light selection tokens so dark text on white canvas stays crisp
    fireEvent.click(screen.getByTestId("markdown-preview-appearance"));
    fireEvent.click(screen.getByRole("option", { name: "Light" }));
    expect(document.querySelector(".fv-md-live-pane")).toHaveAttribute("data-preview-theme", "light");
    expect(readSelectionBg(true)).toBe("rgba(37,99,235,0.26)");
    expect(readSelectionBg(false)).toBe("rgba(37,99,235,0.14)");

    // Dark app + Dark local preview -> dark selection tokens
    fireEvent.click(screen.getByTestId("markdown-preview-appearance"));
    fireEvent.click(screen.getByRole("option", { name: "Dark" }));
    expect(document.querySelector(".fv-md-live-pane")).toHaveAttribute("data-preview-theme", "dark");
    expect(readSelectionBg(true)).toBe("rgba(92,143,214,0.4)");
    expect(readSelectionBg(false)).toBe("rgba(92,143,214,0.22)");
  });

  it("applies and toggles formatting toolbar commands on selected text and reflects updates in Split preview", async () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("markdown-mode-split"));
    const view = EditorView.findFromDOM(screen.getByTestId("viewer-editor").querySelector<HTMLElement>(".cm-editor")!)!;
    const selectWord = (word: string) => {
      const start = view.state.doc.toString().indexOf(word);
      expect(start).toBeGreaterThanOrEqual(0);
      act(() => view.dispatch({ selection: { anchor: start, head: start + word.length } }));
    };

    // Bold + Italic nests to ***Plain***, then toggling Italic and Bold restores plain text
    selectWord("Plain");
    fireEvent.click(screen.getByTestId("markdown-format-bold"));
    expect(view.state.doc.toString()).toContain("**Plain** paragraph text.");
    await waitFor(() => expect(screen.getByTestId("markdown-preview").querySelector("strong")?.textContent).toBe("Plain"));
    fireEvent.click(screen.getByTestId("markdown-format-italic"));
    expect(view.state.doc.toString()).toContain("***Plain*** paragraph text.");
    fireEvent.click(screen.getByTestId("markdown-format-italic"));
    expect(view.state.doc.toString()).toContain("**Plain** paragraph text.");
    fireEvent.click(screen.getByTestId("markdown-format-bold"));
    expect(view.state.doc.toString()).toContain("Plain paragraph text.");

    // Italic, strikethrough, inline code
    selectWord("paragraph");
    fireEvent.click(screen.getByTestId("markdown-format-italic"));
    expect(view.state.doc.toString()).toContain("*paragraph*");
    fireEvent.click(screen.getByTestId("markdown-format-strike"));
    expect(view.state.doc.toString()).toContain("*~~paragraph~~*");

    selectWord("text");
    fireEvent.click(screen.getByTestId("markdown-format-code"));
    expect(view.state.doc.toString()).toContain("`text`");

    // Heading dropdown changes heading level cleanly
    const detailsPos = view.state.doc.toString().indexOf("## Details");
    act(() => view.dispatch({ selection: { anchor: detailsPos + 3 } }));
    fireEvent.click(screen.getByTestId("markdown-heading"));
    fireEvent.click(screen.getByRole("option", { name: "Heading 3" }));
    expect(view.state.doc.toString()).toContain("### Details");
    await waitFor(() => expect(screen.getByTestId("markdown-preview").querySelector("h3")?.textContent).toBe("Details"));

    // Bullet list & quote toggles
    const lineStart = view.state.doc.toString().indexOf("Plain");
    act(() => view.dispatch({ selection: { anchor: lineStart, head: lineStart + 5 } }));
    fireEvent.click(screen.getByTestId("markdown-format-bullet"));
    expect(view.state.doc.toString()).toContain("- Plain");
    fireEvent.click(screen.getByTestId("markdown-format-bullet"));
    expect(view.state.doc.toString()).not.toContain("- Plain");
    fireEvent.click(screen.getByTestId("markdown-format-quote"));
    expect(view.state.doc.toString()).toContain("> Plain");
  });

  it("opens slash insert menu on empty line in Live edit mode, inserts block cleanly, and toggles outline & focus", () => {
    render(<Harness />);
    fireEvent.click(screen.getByTestId("markdown-live-edit"));
    const view = EditorView.findFromDOM(screen.getByTestId("viewer-editor").querySelector<HTMLElement>(".cm-editor")!)!;

    // Type "/" on a trailing empty line
    const eof = view.state.doc.length;
    act(() => view.dispatch({ changes: { from: eof, insert: "\n/" }, selection: { anchor: eof + 2 } }));
    const menu = screen.getByTestId("markdown-insert-menu");
    expect(menu).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: "Table" }));
    expect(screen.queryByTestId("markdown-insert-menu")).not.toBeInTheDocument();
    expect(view.state.doc.toString()).toContain("| Column 1 | Column 2 |");
    expect(view.state.doc.toString()).not.toMatch(/\n\/\n/);

    // Undo restores document before slash insert
    act(() => { expect(undo(view)).toBe(true); });
    expect(view.state.doc.toString()).not.toContain("| Column 1 | Column 2 |");

    // Outline toggle & focus mode toggle
    expect(screen.getByTestId("markdown-outline")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("markdown-outline-toggle"));
    expect(screen.queryByTestId("markdown-outline")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("markdown-outline-toggle"));
    expect(screen.getByTestId("markdown-outline")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("markdown-focus"));
    expect(screen.getByTestId("markdown-editor")).toHaveClass("fv-md-focus");
    fireEvent.click(screen.getByTestId("markdown-focus"));
    expect(screen.getByTestId("markdown-editor")).not.toHaveClass("fv-md-focus");
  });
});
