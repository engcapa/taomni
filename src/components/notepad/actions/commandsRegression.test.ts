import { renderHook, act } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { viewerSetReadonlyAttr } from "../../../lib/notepad/ipc";
import * as sessionMgr from "../../../lib/notepad/persistence/sessionManager";
import { NOTEPAD_COMMAND_BY_ID } from "../../../lib/notepad/commands/catalog";
import type { ViewerDocument } from "../../../lib/viewer";
import { useDocumentStore } from "../../../stores/documentStore";
import { useExplorerStore } from "../../../stores/explorerStore";
import { resetNotepadPreferences, setNotepadPreferences } from "../../../stores/notepadPreferences";
import { createDefaultDocState, useNotepadStore } from "../../../stores/notepadStore";
import { useNotepadActions } from "../useNotepadActions";
import { changedLineIndexes } from "./extraCommands";

vi.mock("../../../lib/notepad/ipc", async (original) => {
  const actual = await original<typeof import("../../../lib/notepad/ipc")>();
  return {
    ...actual,
    viewerSetReadonlyAttr: vi.fn(async () => true),
  };
});

function makeDoc(overrides: Partial<ViewerDocument> = {}): ViewerDocument {
  return {
    key: "/tmp/demo.txt",
    path: "/tmp/demo.txt",
    kind: "text",
    content: "zeta\nalpha\nmid",
    savedContent: "zeta\nalpha\nmid",
    savedHash: "h1",
    encoding: "UTF-8",
    savedEncoding: "UTF-8",
    bom: false,
    savedBom: false,
    eol: "LF",
    savedEol: "LF",
    originalLineEndings: ["\n", "\n"],
    dirty: false,
    mtime: 1,
    size: 14,
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

function makeFakeView(text: string, selFrom = 0, selTo = selFrom) {
  let content = text;
  let selection = { from: selFrom, to: selTo, anchor: selFrom, head: selTo, empty: selFrom === selTo };
  const dispatched: unknown[] = [];
  const fakeDoc = {
    get length() { return content.length; },
    get lines() { return content.split("\n").length; },
    toString: () => content,
    lineAt(pos: number) {
      const prefix = content.slice(0, pos);
      const ln = prefix.split("\n").length;
      const from = prefix.lastIndexOf("\n") + 1;
      const nextNl = content.indexOf("\n", from);
      const to = nextNl === -1 ? content.length : nextNl;
      return { number: ln, from, to, text: content.slice(from, to) };
    },
    line(n: number) {
      const parts = content.split("\n");
      let from = 0;
      for (let i = 0; i < n - 1 && i < parts.length; i += 1) from += parts[i].length + 1;
      const t = parts[n - 1] ?? "";
      return { number: n, from, to: from + t.length, text: t };
    },
  };
  return {
    view: {
      state: {
        get doc() { return fakeDoc; },
        get selection() { return { main: selection }; },
        sliceDoc: (a: number, b: number) => content.slice(a, b),
      },
      scrollDOM: { scrollTop: 42, scrollLeft: 0 },
      dispatch: vi.fn((tr: { changes?: { from: number; to: number; insert?: string }; selection?: { anchor: number; head?: number } }) => {
        dispatched.push(tr);
        if (tr.changes) {
          content = content.slice(0, tr.changes.from) + (tr.changes.insert ?? "") + content.slice(tr.changes.to);
        }
        if (tr.selection) {
          const a = tr.selection.anchor;
          const h = tr.selection.head ?? a;
          selection = { from: Math.min(a, h), to: Math.max(a, h), anchor: a, head: h, empty: a === h };
        }
      }),
      focus: vi.fn(),
    } as never,
    getContent: () => content,
    dispatched,
  };
}

describe("Notepad actions & command regressions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    resetNotepadPreferences();
    useDocumentStore.setState({ documents: {}, closeRequest: undefined, draftError: undefined });
    useNotepadStore.setState({ docs: {}, viewMode: "" });
    useExplorerStore.setState({ tabs: [], activeTabId: null });
  });

  it("keeps Change History shortcut free of Alt+Shift+ArrowUp/Down column-selection keys", () => {
    expect(NOTEPAD_COMMAND_BY_ID.get("search.nextChange")?.defaultShortcut).toBe("Alt+F5");
    expect(NOTEPAD_COMMAND_BY_ID.get("search.prevChange")?.defaultShortcut).toBe("Alt+Shift+F5");
  });

  it("separates editor read-only toggle from disk attribute toggle and clears change history", async () => {
    const doc = makeDoc({ content: "edited", savedContent: "zeta\nalpha\nmid" });
    useDocumentStore.setState({ documents: { [doc.key]: doc } });
    const setLifecycleModal = vi.fn();
    const { result } = renderHook(() =>
      useNotepadActions({
        zoom: vi.fn(),
        docKey: doc.key,
        document: doc,
        docState: createDefaultDocState(doc.key),
        hostCtx: { host: "explorer" },
        backupMgr: { createSaveBackupCopy: vi.fn(), pruneDoc: vi.fn() } as never,
        effectiveReadOnly: false,
        getActiveView: () => null,
        onError: vi.fn(),
        setFindStatus: vi.fn(),
        setSearchingFiles: vi.fn(),
        setLifecycleModal,
        setEditModal: vi.fn(),
        setPickerModal: vi.fn(),
        setEncodingOpen: vi.fn(),
        setToolboxKind: vi.fn(),
        setMacroModal: vi.fn(),
        setPrintOpen: vi.fn(),
        setSessionModal: vi.fn(),
        setPrefsOpen: vi.fn(),
        setMapperOpen: vi.fn(),
        setAboutOpen: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.registry.execute("file.toggleReadonly");
    });
    expect(viewerSetReadonlyAttr).not.toHaveBeenCalled();
    expect(useDocumentStore.getState().documents[doc.key].readOnly).toBe(true);

    await act(async () => {
      await result.current.registry.execute("file.toggleReadonlyAttr");
    });
    expect(viewerSetReadonlyAttr).toHaveBeenCalledWith(doc.path, false);
    expect(useDocumentStore.getState().documents[doc.key].readOnly).toBe(false);

    // Clear Change History stores content baseline and increments reset nonce
    await act(async () => {
      await result.current.registry.execute("search.clearChangeHistory");
    });
    const st = useNotepadStore.getState().docs[doc.key];
    expect(st.changeHistoryBaseline).toEqual(["edited"]);
    expect(st.changeHistoryResetNonce).toBe(1);
    expect(changedLineIndexes(doc.content, st.changeHistoryBaseline!.join("\n"))).toEqual([]);
  });

  it("supports volatile selection find without mutating find.query and prompts before whole-doc sort", async () => {
    const doc = makeDoc({ content: "foo bar\nfoo baz" });
    useDocumentStore.setState({ documents: { [doc.key]: doc } });
    const fake = makeFakeView(doc.content, 0, 3); // selects "foo"
    useNotepadStore.getState().patchFind(doc.key, { query: "original" });
    const docState = useNotepadStore.getState().docs[doc.key];
    const setLifecycleModal = vi.fn();

    const { result } = renderHook(() =>
      useNotepadActions({
        zoom: vi.fn(),
        docKey: doc.key,
        document: doc,
        docState,
        hostCtx: { host: "explorer" },
        backupMgr: { createSaveBackupCopy: vi.fn(), pruneDoc: vi.fn() } as never,
        effectiveReadOnly: false,
        getActiveView: () => fake.view,
        onError: vi.fn(),
        setFindStatus: vi.fn(),
        setSearchingFiles: vi.fn(),
        setLifecycleModal,
        setEditModal: vi.fn(),
        setPickerModal: vi.fn(),
        setEncodingOpen: vi.fn(),
        setToolboxKind: vi.fn(),
        setMacroModal: vi.fn(),
        setPrintOpen: vi.fn(),
        setSessionModal: vi.fn(),
        setPrefsOpen: vi.fn(),
        setMapperOpen: vi.fn(),
        setAboutOpen: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.registry.execute("search.selectAndFindVolatile");
    });
    expect((fake.view as unknown as { state: { selection: { main: { from: number; to: number } } } }).state.selection.main).toMatchObject({ from: 8, to: 11 });
    expect(useNotepadStore.getState().docs[doc.key]?.find.query ?? docState.find.query).toBe("original");

    // Empty selection sort prompts when askWholeDocLineOp is enabled
    const doc2 = makeDoc({ content: "b\na" });
    useDocumentStore.setState({ documents: { [doc.key]: doc2 } });
    const emptyFake = makeFakeView("b\na", 0, 0);
    const { result: res2 } = renderHook(() =>
      useNotepadActions({
        zoom: vi.fn(),
        docKey: doc.key,
        document: doc2,
        docState: createDefaultDocState(doc.key),
        hostCtx: { host: "explorer" },
        backupMgr: { createSaveBackupCopy: vi.fn(), pruneDoc: vi.fn() } as never,
        effectiveReadOnly: false,
        getActiveView: () => emptyFake.view,
        onError: vi.fn(),
        setFindStatus: vi.fn(),
        setSearchingFiles: vi.fn(),
        setLifecycleModal,
        setEditModal: vi.fn(),
        setPickerModal: vi.fn(),
        setEncodingOpen: vi.fn(),
        setToolboxKind: vi.fn(),
        setMacroModal: vi.fn(),
        setPrintOpen: vi.fn(),
        setSessionModal: vi.fn(),
        setPrefsOpen: vi.fn(),
        setMapperOpen: vi.fn(),
        setAboutOpen: vi.fn(),
      }),
    );
    await act(async () => {
      await res2.current.registry.execute("edit.sortAsc");
    });
    expect(setLifecycleModal).toHaveBeenCalledWith(expect.objectContaining({ kind: "wholeDocConfirm" }));

    setNotepadPreferences({ askWholeDocLineOp: false });
    await act(async () => {
      await res2.current.registry.execute("edit.sortAsc");
    });
    expect(emptyFake.getContent()).toBe("a\nb");
  });

  it("saves real cursor/scroll in session and restores untitled bookmarks, encoding, eol, and readOnly on new key", async () => {
    const untitledKey = "untitled:orig-1";
    const doc = makeDoc({
      key: untitledKey,
      path: untitledKey,
      content: "line one\nline two\nline three",
      encoding: "GBK",
      eol: "CRLF",
      readOnly: true,
    });
    useDocumentStore.setState({ documents: { [untitledKey]: doc } });
    useExplorerStore.setState({
      tabs: [{ id: "tab-1", type: "file-viewer", title: "Draft.txt", closable: true, pinned: true, fileViewer: { path: untitledKey, kind: "text", mode: "notepad", untitled: true, title: "Draft.txt" } }],
      activeTabId: "tab-1",
    });
    useNotepadStore.getState().ensureDoc(untitledKey, "Draft.txt");
    useNotepadStore.getState().setBookmarks(untitledKey, [2]);
    useNotepadStore.getState().patchDoc(untitledKey, { split: true });
    const fake = makeFakeView(doc.content, 11, 11); // line 2, col 3

    let savedTabs: sessionMgr.SessionTabEntry[] = [];
    vi.spyOn(sessionMgr, "saveSessionToDisk").mockImplementation(async (tabs) => {
      savedTabs = tabs;
      return "/tmp/sess.json";
    });
    vi.spyOn(sessionMgr, "loadSessionFromDisk").mockImplementation(async () => ({
      version: 1,
      savedAt: 1,
      activeDocKey: savedTabs[0].docKey,
      tabs: savedTabs,
    }));

    const { result } = renderHook(() =>
      useNotepadActions({
        zoom: vi.fn(),
        docKey: untitledKey,
        document: doc,
        docState: useNotepadStore.getState().docs[untitledKey],
        hostCtx: { host: "explorer" },
        backupMgr: { createSaveBackupCopy: vi.fn(), pruneDoc: vi.fn() } as never,
        effectiveReadOnly: false,
        getActiveView: () => fake.view,
        onError: vi.fn(),
        setFindStatus: vi.fn(),
        setSearchingFiles: vi.fn(),
        setLifecycleModal: vi.fn(),
        setEditModal: vi.fn(),
        setPickerModal: vi.fn(),
        setEncodingOpen: vi.fn(),
        setToolboxKind: vi.fn(),
        setMacroModal: vi.fn(),
        setPrintOpen: vi.fn(),
        setSessionModal: vi.fn(),
        setPrefsOpen: vi.fn(),
        setMapperOpen: vi.fn(),
        setAboutOpen: vi.fn(),
      }),
    );

    await act(async () => {
      await result.current.sessionAndMacroHelpers.saveSession();
    });
    expect(savedTabs).toHaveLength(1);
    expect(savedTabs[0]).toMatchObject({
      cursorLine: 2,
      cursorCol: 3,
      scrollTop: 42,
      encoding: "GBK",
      eol: "CRLF",
      pinned: true,
      readOnly: true,
      split: true,
      bookmarks: [2],
    });

    // Clear state and load session back (simulates fresh restart)
    useDocumentStore.setState({ documents: {} });
    useExplorerStore.setState({ tabs: [], activeTabId: null });
    useNotepadStore.setState({ docs: {} });

    await act(async () => {
      await result.current.sessionAndMacroHelpers.loadSession();
    });
    const newTabs = useExplorerStore.getState().tabs;
    expect(newTabs).toHaveLength(1);
    const restoredKey = newTabs[0].fileViewer!.path;
    expect(useNotepadStore.getState().docs[restoredKey].bookmarks).toEqual([2]);
    expect(useNotepadStore.getState().docs[restoredKey].split).toBe(true);
    expect(useNotepadStore.getState().docs[restoredKey].paneSelections[0]).toEqual({ from: 11, to: 11 });
    expect(useNotepadStore.getState().docs[restoredKey].paneScrolls[0].top).toBe(42);
    expect(useDocumentStore.getState().documents[restoredKey]).toMatchObject({
      encoding: "GBK",
      eol: "CRLF",
      readOnly: true,
    });
    expect(newTabs[0].pinned).toBe(true);
  });
});
