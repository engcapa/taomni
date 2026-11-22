import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewerDocument } from "../../../lib/viewer";
import { useDocumentStore } from "../../../stores/documentStore";
import { resetNotepadPreferences } from "../../../stores/notepadPreferences";
import { useNotepadStore } from "../../../stores/notepadStore";
import { NotepadEditor } from "../NotepadEditor";
import { NotepadMenuBar } from "../NotepadMenuBar";
import { CharPanel } from "../panels/CharPanel";
import { DocumentListPanel } from "../panels/DocumentListPanel";
import { useExplorerStore } from "../../../stores/explorerStore";

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
    // Shared save contract: enabled only for a dirty, writable document.
    expect(screen.getByTestId("viewer-save")).toBeDisabled();
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

  it("enables the shared save control only when the document is dirty and writable", () => {
    const doc = makeDoc();
    useDocumentStore.setState({ documents: { [doc.key]: doc } });
    const mounted = render(<NotepadEditor document={doc} onError={vi.fn()} onCursorChange={vi.fn()} />);
    expect(screen.getByTestId("viewer-save")).toBeDisabled();
    mounted.rerender(<NotepadEditor document={{ ...doc, dirty: true }} onError={vi.fn()} onCursorChange={vi.fn()} />);
    expect(screen.getByTestId("viewer-save")).toBeEnabled();
    mounted.rerender(<NotepadEditor document={{ ...doc, dirty: true, readOnly: true }} onError={vi.fn()} onCursorChange={vi.fn()} />);
    expect(screen.getByTestId("viewer-save")).toBeDisabled();
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
    expect(screen.getByTestId("notepad-large-force-edit")).toBeEnabled();
    expect(screen.getByTestId("viewer-chunk-prev")).toBeDisabled();
    expect(screen.getByTestId("viewer-chunk-next")).toBeEnabled();
    // Large-file chunk previews are read-only, so the shared save control stays disabled.
    expect(screen.getByTestId("viewer-save")).toBeDisabled();
  });

  it("replays saved macro steps instead of live buffer and shows View-mode Exit pill in focus mode", async () => {
    const doc = makeDoc({ content: "hello" });
    useDocumentStore.setState({ documents: { [doc.key]: doc } });
    useNotepadStore.setState((s) => ({
      ...s,
      macro: {
        ...s.macro,
        loaded: true,
        buffer: [{ type: "insertText", text: "WRONG" }],
        saved: [{ name: "SayHi", steps: [{ type: "insertText", text: "HI!" }] }],
      },
    }));

    render(<NotepadEditor document={doc} onError={vi.fn()} onCursorChange={vi.fn()} />);

    // Saved macro click runs saved macro's steps ("HI!"), not buffer ("WRONG").
    fireEvent.click(screen.getByTestId("notepad-menu-macro"));
    fireEvent.click(screen.getByTestId("notepad-menu-macro-SayHi"));
    expect(useDocumentStore.getState().documents[doc.key].content).toContain("HI!");
    expect(useDocumentStore.getState().documents[doc.key].content).not.toContain("WRONG");

    // Distraction-free sets focus mode and shows floating Exit button
    fireEvent.click(screen.getByTestId("notepad-menu-view"));
    fireEvent.click(screen.getByTestId("notepad-menu-item-view.distractionFree"));
    expect(useNotepadStore.getState().viewMode).toBe("focus");
    const exitBtn = screen.getByTestId("notepad-exit-view-mode");
    fireEvent.click(exitBtn);
    expect(useNotepadStore.getState().viewMode).toBe("");
  });

  it("allows Save As / Save Copy / Reload / Print in read-only menu bar, fires single CharPanel insert, and updates DocumentListPanel reactively", () => {
    const onCmd = vi.fn();
    render(
      <NotepadMenuBar
        dirty={true}
        readOnly={true}
        recordingMacro={false}
        hasRecordedBuffer={false}
        recentFiles={[]}
        savedMacros={[]}
        documents={[]}
        checks={{}}
        capabilities={{ pinTabs: false }}
        onCommand={onCmd}
        onOpenRecent={vi.fn()}
        onOpenAllRecent={vi.fn()}
        onClearRecent={vi.fn()}
        onOpenSavedMacro={vi.fn()}
        onValidateMacros={vi.fn()}
        onActivateDocument={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("notepad-menu-file"));
    expect(screen.getByTestId("notepad-menu-item-file.save")).toBeDisabled();
    expect(screen.getByTestId("notepad-menu-item-file.saveAs")).not.toBeDisabled();
    expect(screen.getByTestId("notepad-menu-item-file.saveCopy")).not.toBeDisabled();
    expect(screen.getByTestId("notepad-menu-item-file.reload")).not.toBeDisabled();
    expect(screen.getByTestId("notepad-menu-item-file.print")).not.toBeDisabled();
    expect(screen.getByTestId("notepad-menu-item-file.printNow")).not.toBeDisabled();

    fireEvent.click(screen.getByTestId("notepad-menu-window"));
    expect(screen.queryByTestId("notepad-menu-item-window.togglePinTab")).toBeNull();

    // CharPanel doubleClick does not insert duplicates (single click only)
    const onInsert = vi.fn();
    render(<CharPanel onInsertChar={onInsert} />);
    const row65 = screen.getByTestId("notepad-char-row-65");
    fireEvent.dblClick(row65);
    expect(onInsert).not.toHaveBeenCalled();
    fireEvent.click(row65);
    expect(onInsert).toHaveBeenCalledTimes(1);

    // DocumentListPanel reactively updates when explorer tabs change
    useExplorerStore.setState({
      tabs: [{ id: "t1", type: "file-viewer", title: "a.txt", closable: true, fileViewer: { path: "/a.txt", kind: "text", mode: "notepad" } }],
      activeTabId: "t1",
    });
    render(<DocumentListPanel activeDocKey="/a.txt" onSelectDoc={vi.fn()} onCloseDoc={vi.fn()} />);
    expect(screen.getByTestId("notepad-doc-list-item-a.txt")).toBeInTheDocument();
    act(() => {
      useExplorerStore.setState({ tabs: [], activeTabId: null });
    });
    expect(screen.queryByTestId("notepad-doc-list-item-a.txt")).toBeNull();
  });
});
