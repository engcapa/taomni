import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewerDocument } from "../../../lib/viewer";
import { documentPathKey } from "../../../lib/openFile/pathIdentity";
import { useDocumentStore } from "../../../stores/documentStore";
import { resetNotepadPreferences } from "../../../stores/notepadPreferences";
import { useNotepadStore } from "../../../stores/notepadStore";
import { NotepadEditor } from "../NotepadEditor";

function makeDoc(overrides: Partial<ViewerDocument> = {}): ViewerDocument {
  return {
    key: "/preview/demo.txt",
    path: "/preview/demo.txt",
    kind: "text",
    content: "alpha\nbeta",
    savedContent: "alpha\nbeta",
    savedHash: "h1",
    encoding: "UTF-8",
    savedEncoding: "UTF-8",
    bom: false,
    savedBom: false,
    eol: "LF",
    savedEol: "LF",
    originalLineEndings: ["\n"],
    dirty: false,
    mtime: 1,
    size: 10,
    readOnly: false,
    loading: false,
    saving: false,
    large: false,
    truncated: false,
    revision: 1,
    chunkOffset: 0,
    nextOffset: 0,
    eof: true,
    ...overrides,
  };
}

function renderEditor(overrides: Partial<ViewerDocument> = {}) {
  const doc = makeDoc(overrides);
  useDocumentStore.setState({ documents: { [doc.key]: doc } });
  render(<NotepadEditor document={doc} onError={vi.fn()} onCursorChange={vi.fn()} />);
  return doc;
}

function openEditorContextMenu(): HTMLElement {
  const host = screen.getByTestId("viewer-editor");
  fireEvent.contextMenu(host, { clientX: 120, clientY: 80, button: 2 });
  return screen.getByTestId("context-menu");
}

const EXPECTED_CONTEXT_ROWS = [
  "notepad-context-undo",
  "notepad-context-redo",
  "notepad-context-cut",
  "notepad-context-copy",
  "notepad-context-paste",
  "notepad-context-paste-special",
  "notepad-context-delete",
  "notepad-context-select-all",
  "notepad-context-duplicate-line",
  "notepad-context-delete-line",
  "notepad-context-move-line-up",
  "notepad-context-move-line-down",
  "notepad-context-find",
  "notepad-context-find-next",
  "notepad-context-replace",
  "notepad-context-go-to",
  "notepad-context-toggle-bookmark",
  "notepad-context-copy-path",
  "notepad-context-save",
  "notepad-context-save-as",
];

beforeEach(() => {
  localStorage.clear();
  resetNotepadPreferences();
  useDocumentStore.setState({ documents: {}, closeRequest: undefined, draftError: undefined });
  useNotepadStore.setState({ docs: {}, results: [], resultsTitle: "", compare: null });
});

afterEach(() => {
  cleanup();
});

describe("Notepad editor context menu (U3)", () => {
  it("replaces the WebView menu with the app context menu on right click", () => {
    renderEditor();
    const host = screen.getByTestId("viewer-editor");
    // fireEvent returns false when preventDefault() was called on the native event.
    expect(fireEvent.contextMenu(host, { clientX: 120, clientY: 80, button: 2 })).toBe(false);

    const menu = screen.getByTestId("context-menu");
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(EXPECTED_CONTEXT_ROWS.length);
    const rows = Array.from(menu.querySelectorAll<HTMLElement>('[data-testid^="notepad-context-"]'));
    expect(rows.map((row) => row.dataset.testid)).toEqual(EXPECTED_CONTEXT_ROWS);
    // Shortcuts come from the shared keymap catalog and stay visible.
    expect(within(menu).getByTestId("notepad-context-undo").textContent).toContain("Ctrl+Z");
    expect(within(menu).getByTestId("notepad-context-find").textContent).toContain("Ctrl+F");
    // Opens at the cursor coordinates (position is clamped into the viewport).
    expect(menu).toHaveStyle({ position: "fixed" });
  });

  it("executes the clicked item through the command registry and closes", async () => {
    const doc = renderEditor();
    const menu = openEditorContextMenu();
    fireEvent.click(within(menu).getByTestId("notepad-context-find"));
    expect(useNotepadStore.getState().docs[documentPathKey(doc.path)]?.find.open).toBe(true);
    expect(screen.queryByTestId("context-menu")).toBeNull();
  });

  it("keeps showing the menu in read-only mode with write rows disabled", () => {
    renderEditor({ readOnly: true });
    const menu = openEditorContextMenu();
    for (const readOnlyBlocked of [
      "notepad-context-undo",
      "notepad-context-redo",
      "notepad-context-cut",
      "notepad-context-paste",
      "notepad-context-paste-special",
      "notepad-context-delete",
      "notepad-context-duplicate-line",
      "notepad-context-delete-line",
      "notepad-context-move-line-up",
      "notepad-context-move-line-down",
      "notepad-context-save",
    ]) {
      expect(within(menu).getByTestId(readOnlyBlocked)).toBeDisabled();
    }
    for (const readOnlyAllowed of [
      "notepad-context-copy",
      "notepad-context-select-all",
      "notepad-context-find",
      "notepad-context-find-next",
      "notepad-context-replace",
      "notepad-context-go-to",
      "notepad-context-toggle-bookmark",
      "notepad-context-copy-path",
      "notepad-context-save-as",
    ]) {
      expect(within(menu).getByTestId(readOnlyAllowed)).toBeEnabled();
    }
  });

  it("closes on Escape and on an outside mousedown", () => {
    renderEditor();
    openEditorContextMenu();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByTestId("context-menu")).toBeNull();

    openEditorContextMenu();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId("context-menu")).toBeNull();
  });

  it("closes when clicking one of its own rows and does not leak an outside-close", () => {
    renderEditor();
    const menu = openEditorContextMenu();
    fireEvent.mouseDown(within(menu).getByTestId("notepad-context-copy-path"));
    // A mousedown inside the menu keeps it open until the click action runs.
    expect(screen.getByTestId("context-menu")).toBeInTheDocument();
    fireEvent.click(within(menu).getByTestId("notepad-context-copy-path"));
    expect(screen.queryByTestId("context-menu")).toBeNull();
  });
});
