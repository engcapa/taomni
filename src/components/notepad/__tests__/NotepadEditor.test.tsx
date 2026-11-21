import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewerDocument } from "../../../lib/viewer";
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

describe("NotepadEditor UI workbench", () => {
  beforeEach(() => {
    localStorage.clear();
    resetNotepadPreferences();
    useDocumentStore.setState({ documents: {}, closeRequest: undefined, draftError: undefined });
    useNotepadStore.setState({ docs: {}, results: [], resultsTitle: "", compare: null });
  });

  afterEach(() => {
    cleanup();
  });

  it("renders the 9 DEC-16 menus, toolbar save button, CM6 pane, and status bar", () => {
    const doc = makeDoc();
    useDocumentStore.setState({ documents: { [doc.key]: doc } });
    const onError = vi.fn();
    const onCursorChange = vi.fn();

    render(
      <NotepadEditor
        document={doc}
        onError={onError}
        onCursorChange={onCursorChange}
      />,
    );

    // Menu bar has strictly the 9 expected menus and no Language/Plugins/Run menus
    const menuButtons = Array.from(screen.getByTestId("notepad-menubar").querySelectorAll("button"));
    expect(menuButtons).toHaveLength(9);
    expect(screen.queryByTestId("notepad-menu-language")).toBeNull();
    expect(screen.queryByTestId("notepad-menu-plugins")).toBeNull();

    // Primary editor testid & save button state preserved for QA contracts
    expect(screen.getByTestId("viewer-editor")).toBeInTheDocument();
    expect(screen.getByTestId("viewer-save")).toBeEnabled();
    expect(screen.getByTestId("viewer-cursor").textContent).toMatch(/1/);

    // Clicking INS/OVR toggles overwrite mode indicator
    const ovr = screen.getByTestId("notepad-status-ovr");
    expect(ovr.textContent).toBe("INS");
    fireEvent.click(ovr);
    expect(screen.getByTestId("notepad-status-ovr").textContent).toBe("OVR");

    // Clicking Find toolbar button opens Find bar
    fireEvent.click(screen.getByTestId("notepad-tool-find"));
    expect(screen.getByTestId("notepad-find-bar")).toBeInTheDocument();
  });

  it("renders large-file chunk preview banner with prev/next buttons when large=true", () => {
    const doc = makeDoc({ large: true, truncated: true, readOnly: true, size: 8 * 1024 * 1024, chunkOffset: 0, nextOffset: 256 * 1024, eof: false });
    useDocumentStore.setState({ documents: { [doc.key]: doc } });

    render(
      <NotepadEditor
        document={doc}
        onError={vi.fn()}
        onCursorChange={vi.fn()}
      />,
    );

    expect(screen.getByTestId("viewer-large-file")).toBeInTheDocument();
    expect(screen.getByTestId("viewer-chunk-prev")).toBeDisabled();
    expect(screen.getByTestId("viewer-chunk-next")).toBeEnabled();
    expect(screen.getByTestId("viewer-save")).toBeEnabled();
  });
});
