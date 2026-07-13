import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LspDocumentStatus } from "../../../lib/editor/lsp";
import type { CodeWorkspaceRootInfo } from "../../../types";
import type { LspFileState, OpenFileState } from "./codeWorkspaceModel";
import { useWorkspaceLspSession } from "./useWorkspaceLspSession";

const lspMocks = vi.hoisted(() => ({
  lspDetectServers: vi.fn(),
  lspOpenDocument: vi.fn(),
  lspChangeDocument: vi.fn(),
  lspSaveDocument: vi.fn(),
  lspCloseDocument: vi.fn(),
  lspStopWorkspace: vi.fn(),
  lspGetDiagnostics: vi.fn(),
}));

vi.mock("../../../lib/editor/lsp", () => lspMocks);

const roots: CodeWorkspaceRootInfo[] = [{
  id: "root-1",
  name: "repo",
  path: "/repo",
  kind: "folder",
}];

const status: LspDocumentStatus = {
  path: "/repo/src/main.ts",
  uri: "file:///repo/src/main.ts",
  presetId: "typescript",
  languageId: "typescript",
  displayName: "TypeScript",
  available: true,
  active: true,
  selectedCommandId: "typescript-language-server",
  selectedCommand: "typescript-language-server",
  installHint: null,
  error: null,
};

const incrementalStatus: LspDocumentStatus = {
  ...status,
  capabilities: {
    textDocumentSyncKind: 2,
    completion: false,
    signatureHelp: false,
    hover: false,
    definition: false,
    typeDefinition: false,
    implementation: false,
    references: false,
    documentSymbol: false,
    workspaceSymbol: false,
    rename: false,
    formatting: false,
    rangeFormatting: false,
    codeAction: false,
    documentHighlight: false,
    callHierarchy: false,
    typeHierarchy: false,
    inlayHint: false,
    selectionRange: false,
    semanticTokens: false,
    completionTriggerCharacters: [],
    signatureTriggerCharacters: [],
  },
};

const file: OpenFileState = {
  key: "root:root-1:src/main.ts",
  ref: { kind: "root", rootId: "root-1", path: "src/main.ts" },
  title: "main.ts",
  subtitle: "repo / src/main.ts",
  path: "src/main.ts",
  languagePath: "src/main.ts",
  text: "const value = 1;",
  savedText: "const value = 1;",
  eol: "LF",
  size: 16,
  mtime: 1,
  hash: "hash",
  loading: false,
  saving: false,
  dirty: false,
  error: null,
};

describe("useWorkspaceLspSession", () => {
  beforeEach(() => {
    window.localStorage.clear();
    lspMocks.lspDetectServers.mockReset().mockResolvedValue([]);
    lspMocks.lspOpenDocument.mockReset().mockResolvedValue(status);
    lspMocks.lspChangeDocument.mockReset().mockResolvedValue(status);
    lspMocks.lspSaveDocument.mockReset().mockResolvedValue(status);
    lspMocks.lspCloseDocument.mockReset().mockResolvedValue(status);
    lspMocks.lspStopWorkspace.mockReset().mockResolvedValue(0);
    lspMocks.lspGetDiagnostics.mockReset().mockResolvedValue({ status, diagnostics: [] });
  });

  it("owns descriptor creation and the open/save/close document lifecycle", async () => {
    const openFilesRef = { current: { [file.key]: file } };
    let lspFiles: Record<string, LspFileState> = {};
    const updateLspFiles = vi.fn((updater: Record<string, LspFileState> | ((current: Record<string, LspFileState>) => Record<string, LspFileState>)) => {
      lspFiles = typeof updater === "function" ? updater(lspFiles) : updater;
    });
    const { result } = renderHook(() => useWorkspaceLspSession({
      workspaceInstanceId: "workspace-1",
      roots,
      openFilesRef,
      updateLspFiles,
      onError: vi.fn(),
    }));

    await waitFor(() => expect(lspMocks.lspDetectServers).toHaveBeenCalledOnce());
    expect(result.current.descriptorForFile(file)).toMatchObject({
      workspaceId: "workspace-1",
      rootPath: "/repo",
      filePath: "src/main.ts",
    });

    await act(async () => result.current.syncDocument(file, "open"));
    expect(lspMocks.lspOpenDocument).toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: "/repo" }),
      file.text,
      1,
    );
    expect(lspFiles[file.key]?.syncedText).toBe(file.text);

    await act(async () => result.current.saveDocument(file, "const value = 2;"));
    expect(lspMocks.lspSaveDocument).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "src/main.ts" }),
      "const value = 2;",
      1,
    );

    act(() => result.current.closeDocument(file));
    expect(lspMocks.lspCloseDocument).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace-1" }),
    );
  });

  it("does not commit an async response after its buffer was closed", async () => {
    let resolveOpen!: (value: LspDocumentStatus) => void;
    lspMocks.lspOpenDocument.mockImplementation(() => new Promise<LspDocumentStatus>((resolve) => {
      resolveOpen = resolve;
    }));
    const openFilesRef: { current: Record<string, OpenFileState> } = {
      current: { [file.key]: file },
    };
    let lspFiles: Record<string, LspFileState> = {};
    const updateLspFiles = vi.fn((updater: Record<string, LspFileState> | ((current: Record<string, LspFileState>) => Record<string, LspFileState>)) => {
      lspFiles = typeof updater === "function" ? updater(lspFiles) : updater;
    });
    const { result } = renderHook(() => useWorkspaceLspSession({
      workspaceInstanceId: "workspace-1",
      roots,
      openFilesRef,
      updateLspFiles,
      onError: vi.fn(),
    }));

    let pending: Promise<void>;
    act(() => {
      pending = result.current.syncDocument(file, "open");
    });
    expect(lspFiles[file.key]?.syncing).toBe(true);
    openFilesRef.current = {};
    resolveOpen(status);
    await act(async () => pending);
    expect(lspFiles[file.key]?.syncedText).toBeNull();
    expect(lspMocks.lspCloseDocument).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "src/main.ts" }),
    );
  });

  it("stops every backend LSP session when the workspace unmounts", () => {
    const { unmount } = renderHook(() => useWorkspaceLspSession({
      workspaceInstanceId: "workspace-stop",
      roots,
      openFilesRef: { current: {} },
      updateLspFiles: vi.fn(),
      onError: vi.fn(),
    }));

    unmount();
    expect(lspMocks.lspStopWorkspace).toHaveBeenCalledOnce();
    expect(lspMocks.lspStopWorkspace).toHaveBeenCalledWith("workspace-stop");
  });

  it("coalesces edits during open and follows with only the latest buffer", async () => {
    let resolveOpen!: (value: LspDocumentStatus) => void;
    lspMocks.lspOpenDocument.mockImplementation(() => new Promise<LspDocumentStatus>((resolve) => {
      resolveOpen = resolve;
    }));
    const edited = { ...file, text: "const value = 2;", dirty: true };
    const latest = { ...file, text: "const value = 3;", dirty: true };
    const openFilesRef: { current: Record<string, OpenFileState> } = {
      current: { [file.key]: file },
    };
    let lspFiles: Record<string, LspFileState> = {};
    const updateLspFiles = vi.fn((updater: Record<string, LspFileState> | ((current: Record<string, LspFileState>) => Record<string, LspFileState>)) => {
      lspFiles = typeof updater === "function" ? updater(lspFiles) : updater;
    });
    const { result } = renderHook(() => useWorkspaceLspSession({
      workspaceInstanceId: "workspace-1",
      roots,
      openFilesRef,
      updateLspFiles,
      onError: vi.fn(),
    }));

    let initialSync!: Promise<void>;
    act(() => {
      initialSync = result.current.syncDocument(file, "open");
    });
    await waitFor(() => expect(lspMocks.lspOpenDocument).toHaveBeenCalledOnce());
    await act(async () => {
      openFilesRef.current[file.key] = edited;
      await result.current.syncDocument(edited, "open");
      openFilesRef.current[file.key] = latest;
      await result.current.syncDocument(latest, "open");
    });
    expect(lspMocks.lspOpenDocument).toHaveBeenCalledOnce();
    expect(lspMocks.lspChangeDocument).not.toHaveBeenCalled();

    await act(async () => {
      resolveOpen(incrementalStatus);
      await initialSync;
    });
    expect(lspMocks.lspChangeDocument).toHaveBeenCalledOnce();
    expect(lspMocks.lspChangeDocument).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "src/main.ts" }),
      null,
      2,
      {
        range: {
          start: { line: 0, character: 14 },
          end: { line: 0, character: 15 },
        },
        rangeLength: 1,
        text: "3",
      },
    );
    expect(lspFiles[file.key]?.syncedText).toBe(latest.text);
    expect(lspFiles[file.key]?.syncing).toBe(false);
  });

  it("retries with full text if an incremental-only change cannot be delivered", async () => {
    lspMocks.lspOpenDocument.mockResolvedValue(incrementalStatus);
    lspMocks.lspChangeDocument
      .mockRejectedValueOnce(new Error("full document text required"))
      .mockResolvedValueOnce(incrementalStatus);
    const edited = { ...file, text: "const value = 2;", dirty: true };
    const openFilesRef: { current: Record<string, OpenFileState> } = {
      current: { [file.key]: file },
    };
    let lspFiles: Record<string, LspFileState> = {};
    const updateLspFiles = vi.fn((updater: Record<string, LspFileState> | ((current: Record<string, LspFileState>) => Record<string, LspFileState>)) => {
      lspFiles = typeof updater === "function" ? updater(lspFiles) : updater;
    });
    const { result } = renderHook(() => useWorkspaceLspSession({
      workspaceInstanceId: "workspace-1",
      roots,
      openFilesRef,
      updateLspFiles,
      onError: vi.fn(),
    }));

    await act(async () => result.current.syncDocument(file, "open"));
    openFilesRef.current[file.key] = edited;
    await act(async () => result.current.syncDocument(edited, "change"));

    expect(lspMocks.lspChangeDocument).toHaveBeenCalledTimes(2);
    expect(lspMocks.lspChangeDocument.mock.calls[0]?.[1]).toBeNull();
    expect(lspMocks.lspChangeDocument.mock.calls[1]?.[1]).toBe(edited.text);
    expect(lspFiles[file.key]?.syncedText).toBe(edited.text);
  });
});
