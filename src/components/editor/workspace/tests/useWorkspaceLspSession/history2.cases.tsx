import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { LspDocumentStatus } from "../../../../../lib/editor/lsp";
import { SDK_REGISTRY_CHANGED_EVENT } from "../../../../../lib/editor/sdk";
import type { LspFileState, OpenFileState } from "../../codeWorkspaceModel";
import { useWorkspaceLspSession } from "../../useWorkspaceLspSession";
import { file, incrementalStatus, lspMocks, roots, status } from "./harness";

export function registeruseWorkspaceLspSessionHistory2Cases() {

  it("restarts the workspace LSP session when SDK bindings change", async () => {
    const updateLspFiles = vi.fn();
    const onRestart = vi.fn();
    renderHook(() => useWorkspaceLspSession({
      workspaceInstanceId: "workspace-sdk-change",
      roots,
      openFilesRef: { current: {} },
      updateLspFiles,
      onError: vi.fn(),
      onRestart,
    }));

    await waitFor(() => expect(lspMocks.lspDetectServers).toHaveBeenCalled());
    lspMocks.lspStopWorkspace.mockClear();
    window.dispatchEvent(new Event(SDK_REGISTRY_CHANGED_EVENT));

    await waitFor(() => expect(lspMocks.lspStopWorkspace).toHaveBeenCalledWith(
      "workspace-sdk-change",
      true,
    ));
    expect(updateLspFiles).toHaveBeenCalled();
    expect(onRestart).toHaveBeenCalledOnce();
  });

  it("coalesces edits during open and follows with only the latest buffer", async () => {
    let resolveOpen!: (value: LspDocumentStatus) => void;
    lspMocks.lspOpenDocument.mockImplementation(() => new Promise<LspDocumentStatus>((resolve) => {
      resolveOpen = resolve;
    }));
    const edited = { ...file, text: "const value = 2;", dirty: true };
    const latest = { ...file, text: "const value = 3;", dirty: true };
    const openFilesRef: { current: Record<string, OpenFileState>; } = {
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
    const openFilesRef: { current: Record<string, OpenFileState>; } = {
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

  it("does not flip syncing on active didChange so the status pill does not spin per key", async () => {
    let resolveChange!: (value: LspDocumentStatus) => void;
    lspMocks.lspOpenDocument.mockResolvedValue(status);
    lspMocks.lspChangeDocument.mockImplementation(() => new Promise<LspDocumentStatus>((resolve) => {
      resolveChange = resolve;
    }));
    const edited = { ...file, text: "const value = 2;", dirty: true };
    const openFilesRef: { current: Record<string, OpenFileState>; } = {
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
    expect(lspFiles[file.key]?.syncing).toBe(false);
    const publishesAfterOpen = updateLspFiles.mock.calls.length;

    openFilesRef.current[file.key] = edited;
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.syncDocument(edited, "change");
    });
    // Busy flag stays false while an already-active document is syncing.
    expect(lspFiles[file.key]?.syncing).toBe(false);
    expect(result.current.isDocumentSynced(file.key, edited.text)).toBe(false);

    await act(async () => {
      resolveChange(status);
      await pending;
    });
    expect(lspFiles[file.key]?.syncing).toBe(false);
    expect(lspFiles[file.key]?.syncedText).toBe(edited.text);
    expect(result.current.isDocumentSynced(file.key, edited.text)).toBe(true);
    // At least one publish for the drained change (syncedText).
    expect(updateLspFiles.mock.calls.length).toBeGreaterThan(publishesAfterOpen);
  });

  it("skips intermediate store publishes while a typing burst is still queued", async () => {
    let resolveFirstChange!: (value: LspDocumentStatus) => void;
    lspMocks.lspOpenDocument.mockResolvedValue(status);
    lspMocks.lspChangeDocument
      .mockImplementationOnce(() => new Promise<LspDocumentStatus>((resolve) => {
        resolveFirstChange = resolve;
      }))
      .mockResolvedValue(status);
    const first = { ...file, text: "const value = 2;", dirty: true };
    const second = { ...file, text: "const value = 3;", dirty: true };
    const openFilesRef: { current: Record<string, OpenFileState>; } = {
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
    const publishesAfterOpen = updateLspFiles.mock.calls.length;

    openFilesRef.current[file.key] = first;
    let firstSync!: Promise<void>;
    act(() => {
      firstSync = result.current.syncDocument(first, "change");
    });
    openFilesRef.current[file.key] = second;
    await act(async () => {
      await result.current.syncDocument(second, "change");
    });

    // First change still in flight with a pending follow-up — no mid-burst
    // publish beyond the open lifecycle.
    const midBurstPublishes = updateLspFiles.mock.calls.length - publishesAfterOpen;
    expect(midBurstPublishes).toBe(0);
    expect(lspFiles[file.key]?.syncedText).toBe(file.text);

    await act(async () => {
      resolveFirstChange(status);
      await firstSync;
    });
    expect(lspMocks.lspChangeDocument).toHaveBeenCalledTimes(2);
    expect(lspFiles[file.key]?.syncedText).toBe(second.text);
    expect(lspFiles[file.key]?.syncing).toBe(false);
    expect(result.current.isDocumentSynced(file.key, second.text)).toBe(true);
  });

  it("clears syncedTextRef on saveDocument to force re-sync before subsequent feature queries", async () => {
    const openFilesRef = { current: { [file.key]: file } };
    const { result } = renderHook(() => useWorkspaceLspSession({
      workspaceInstanceId: "workspace-save-resync",
      roots,
      openFilesRef,
      updateLspFiles: vi.fn(),
      onError: vi.fn(),
    }));

    await act(async () => result.current.syncDocument(file, "open"));
    expect(result.current.isDocumentSynced(file.key, file.text)).toBe(true);
    const changesBeforeSave = lspMocks.lspChangeDocument.mock.calls.length;

    // Save document with the same text: didSave is followed by a recovery
    // didChange inside the save path (provider empty-completion workaround).
    await act(async () => result.current.saveDocument(file, file.text));
    expect(lspMocks.lspSaveDocument).toHaveBeenCalled();
    expect(lspMocks.lspChangeDocument.mock.calls.length).toBeGreaterThan(changesBeforeSave);
    // The recovery sync re-marks the buffer as synced, so the next completion
    // query takes the fast already-synced path instead of an extra round trip.
    expect(result.current.isDocumentSynced(file.key, file.text)).toBe(true);
  });

  it("skips didSave and the recovery change for jdtls buffers", async () => {
    const javaFile: OpenFileState = {
      ...file,
      key: "root:root-1:src/main/java/com/example/App.java",
      ref: { kind: "root", rootId: "root-1", path: "src/main/java/com/example/App.java" },
      title: "App.java",
      subtitle: "repo / src/main/java/com/example/App.java",
      path: "src/main/java/com/example/App.java",
      languagePath: "src/main/java/com/example/App.java",
      text: "class App {}",
      savedText: "class App {}",
    };
    const openFilesRef = { current: { [javaFile.key]: javaFile } };
    const { result } = renderHook(() => useWorkspaceLspSession({
      workspaceInstanceId: "workspace-java-save-skip",
      roots,
      openFilesRef,
      updateLspFiles: vi.fn(),
      onError: vi.fn(),
    }));

    await act(async () => result.current.syncDocument(javaFile, "open"));
    const changesBeforeSave = lspMocks.lspChangeDocument.mock.calls.length;

    await act(async () => result.current.saveDocument(javaFile, javaFile.text));
    // Eclipse JDT LS returns degraded completions after didSave and can answer
    // the first post-save query from the pre-edit document. The save flow's
    // workspace/didChangeWatchedFiles notification owns the provider rebuild,
    // so didSave must never be sent and no recovery didChange is needed.
    expect(lspMocks.lspSaveDocument).not.toHaveBeenCalled();
    expect(lspMocks.lspChangeDocument.mock.calls.length).toBe(changesBeforeSave);
    expect(result.current.isDocumentSynced(javaFile.key, javaFile.text)).toBe(true);
  });
}
