import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ViewerDocument } from "../../../lib/viewer";
import { useDocumentStore } from "../../../stores/documentStore";
import { useExplorerStore } from "../../../stores/explorerStore";
import { resetNotepadPreferences, setNotepadPreferences, useNotepadPreferences } from "../../../stores/notepadPreferences";
import { createDefaultDocState, useNotepadStore } from "../../../stores/notepadStore";
import { useNotepadActions } from "../useNotepadActions";

const mocks = vi.hoisted(() => ({
  getHomeDir: vi.fn(async (): Promise<string | null> => "/preview"),
  viewerSaveAs: vi.fn(async ({ path }: { path: string }) => ({
    path,
    hash: "saved-hash",
    size: 5,
    mtime: 1,
  })),
}));

// Browser preview home is the local VFS root; native builds return the real
// `$HOME` from the `get_home_dir` command.
vi.mock("../../../lib/ipc/files", async (original) => {
  const actual = await original<typeof import("../../../lib/ipc/files")>();
  return { ...actual, getHomeDir: mocks.getHomeDir };
});

vi.mock("../../../lib/notepad/ipc", async (original) => {
  const actual = await original<typeof import("../../../lib/notepad/ipc")>();
  return { ...actual, viewerSaveAs: mocks.viewerSaveAs };
});

function makeDoc(overrides: Partial<ViewerDocument> = {}): ViewerDocument {
  return {
    key: "/tmp/demo.txt",
    path: "/tmp/demo.txt",
    kind: "text",
    content: "hello",
    savedContent: "hello",
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
    size: 5,
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

function renderActions(document: ViewerDocument, docState = createDefaultDocState(document.key, "新建 1")) {
  const setLifecycleModal = vi.fn();
  const hook = renderHook(() =>
    useNotepadActions({
      docKey: document.key,
      document,
      docState,
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
  return { ...hook, setLifecycleModal };
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  resetNotepadPreferences();
  mocks.getHomeDir.mockResolvedValue("/preview");
  useDocumentStore.setState({ documents: {}, closeRequest: undefined, draftError: undefined });
  useNotepadStore.setState({ docs: {}, viewMode: "" });
  useExplorerStore.setState({ tabs: [], activeTabId: null });
});

describe("Notepad Save As default directory (U2)", () => {
  it("opens an untitled Save As at $HOME with an absolute default path", async () => {
    const doc = makeDoc({ key: "untitled:save-default-1", path: "untitled:save-default-1" });
    useDocumentStore.setState({ documents: { [doc.key]: doc } });
    const { result, setLifecycleModal } = renderActions(doc);

    await act(async () => {
      await result.current.performSave();
    });

    expect(mocks.getHomeDir).toHaveBeenCalled();
    expect(setLifecycleModal).toHaveBeenCalledTimes(1);
    expect(setLifecycleModal).toHaveBeenCalledWith({
      kind: "saveAs",
      defaultPath: "/preview/新建 1.txt",
      initialPath: "/preview/新建 1.txt",
      defaultDir: "/preview",
    });
  });

  it("prefers the remembered last save directory over $HOME", async () => {
    setNotepadPreferences({ lastSaveDir: "/data/notes" });
    const doc = makeDoc({ key: "untitled:save-default-2", path: "untitled:save-default-2" });
    useDocumentStore.setState({ documents: { [doc.key]: doc } });
    const { result, setLifecycleModal } = renderActions(doc);

    await act(async () => {
      await result.current.performSave();
    });

    expect(setLifecycleModal).toHaveBeenCalledWith(expect.objectContaining({
      kind: "saveAs",
      defaultPath: "/data/notes/新建 1.txt",
      initialPath: "/data/notes/新建 1.txt",
      defaultDir: "/data/notes",
    }));
  });

  it("keeps the current path prefilled for an already-saved document's Save As", async () => {
    const doc = makeDoc();
    useDocumentStore.setState({ documents: { [doc.key]: doc } });
    const { result, setLifecycleModal } = renderActions(doc, createDefaultDocState(doc.key, "demo.txt"));

    await act(async () => {
      await result.current.registry.execute("file.saveAs");
    });

    expect(setLifecycleModal).toHaveBeenCalledWith({
      kind: "saveAs",
      defaultPath: "/tmp/demo.txt",
      initialPath: "/tmp/demo.txt",
      defaultDir: "/tmp",
    });
  });

  it("records the directory of a successful save for the next untitled Save As", async () => {
    expect(useNotepadPreferences.getState().lastSaveDir).toBe("");
    const doc = makeDoc({ key: "untitled:save-default-3", path: "untitled:save-default-3" });
    useDocumentStore.setState({ documents: { [doc.key]: doc } });
    const { result } = renderActions(doc);

    await act(async () => {
      await result.current.handleSaveAs("/exports/out.txt", false, true);
    });

    expect(mocks.viewerSaveAs).toHaveBeenCalledWith(expect.objectContaining({ path: "/exports/out.txt" }));
    expect(useNotepadPreferences.getState().lastSaveDir).toBe("/exports");
  });
});
