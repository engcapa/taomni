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

const file: OpenFileState = {
  key: "root:root-1:src/main.ts",
  ref: { kind: "root", rootId: "root-1", path: "src/main.ts" },
  title: "main.ts",
  subtitle: "repo / src/main.ts",
  path: "src/main.ts",
  languagePath: "src/main.ts",
  text: "const value = 1;",
  savedText: "const value = 1;",
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
  });
});
