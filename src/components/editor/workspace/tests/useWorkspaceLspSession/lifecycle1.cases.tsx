import { emit } from "@tauri-apps/api/event";
import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { LspDiagnostic, LspDocumentStatus } from "../../../../../lib/editor/lsp";
import type { LspFileState, OpenFileState } from "../../codeWorkspaceModel";
import { LSP_DIAGNOSTICS_REFRESH_EVENT, useWorkspaceLspSession } from "../../useWorkspaceLspSession";
import { file, lspMocks, roots, status } from "./harness";

export function registeruseWorkspaceLspSessionLifecycle1Cases() {

  it("auto-configures discovered Java bundles without persisting machine paths", async () => {
    const onError = vi.fn();
    lspMocks.lspDiscoverJavaBundles.mockResolvedValue([
      {
        id: "javaDebug",
        path: "/extensions/java-debug.jar",
        version: "0.53.2",
        source: "vscode: java-debug",
      },
      {
        id: "javaTest",
        path: "/extensions/java-test.jar",
        version: "0.43.1",
        source: "vscode: java-test",
      },
    ]);

    renderHook(() => useWorkspaceLspSession({
      workspaceInstanceId: "workspace-auto-java-bundles",
      roots,
      openFilesRef: { current: {} },
      updateLspFiles: vi.fn(),
      onError,
    }));

    await waitFor(() => expect(lspMocks.lspDetectServers).toHaveBeenCalledOnce());
    expect(lspMocks.lspSetJavaBundles).toHaveBeenCalledWith({
      javaDebugPath: "/extensions/java-debug.jar",
      javaTestPath: "/extensions/java-test.jar",
    });
    expect(window.localStorage.getItem("taomni.codeWorkspace.lspJavaBundles.v1")).toBeNull();
  });

  it("preserves explicit Java bundle paths and fills only missing entries", async () => {
    const onError = vi.fn();
    window.localStorage.setItem("taomni.codeWorkspace.lspJavaBundles.v1", JSON.stringify({
      javaDebugPath: "/configured/java-debug.jar",
      javaTestPath: "",
    }));
    lspMocks.lspDiscoverJavaBundles.mockResolvedValue([
      {
        id: "javaDebug",
        path: "/discovered/java-debug.jar",
        version: "0.53.2",
        source: "vscode: java-debug",
      },
      {
        id: "javaTest",
        path: "/discovered/java-test.jar",
        version: "0.43.1",
        source: "vscode: java-test",
      },
    ]);

    renderHook(() => useWorkspaceLspSession({
      workspaceInstanceId: "workspace-partial-java-bundles",
      roots,
      openFilesRef: { current: {} },
      updateLspFiles: vi.fn(),
      onError,
    }));

    await waitFor(() => expect(lspMocks.lspDetectServers).toHaveBeenCalledOnce());
    expect(lspMocks.lspSetJavaBundles).toHaveBeenCalledWith({
      javaDebugPath: "/configured/java-debug.jar",
      javaTestPath: "/discovered/java-test.jar",
    });
  });

  it("continues server detection when Java bundle discovery is unavailable", async () => {
    lspMocks.lspDiscoverJavaBundles.mockRejectedValue(new Error("native discovery unavailable"));
    const onError = vi.fn();

    renderHook(() => useWorkspaceLspSession({
      workspaceInstanceId: "workspace-no-java-bundle-discovery",
      roots,
      openFilesRef: { current: {} },
      updateLspFiles: vi.fn(),
      onError,
    }));

    await waitFor(() => expect(lspMocks.lspDetectServers).toHaveBeenCalledOnce());
    expect(lspMocks.lspSetJavaBundles).toHaveBeenCalledWith({
      javaDebugPath: "",
      javaTestPath: "",
    });
    expect(onError).not.toHaveBeenCalled();
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

    await waitFor(() => expect(lspMocks.lspDetectServers).toHaveBeenCalled());
    expect(result.current.descriptorForFile(file)).toMatchObject({
      workspaceId: "workspace-1",
      rootPath: "/repo",
      filePath: "src/main.ts",
      javaHome: null,
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
      2,
    );

    act(() => result.current.closeDocument(file));
    expect(lspMocks.lspCloseDocument).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "workspace-1" }),
    );
  });

  it("keeps document identity retryable when awaited didClose fails", async () => {
    const openFilesRef = { current: { [file.key]: file } };
    const { result } = renderHook(() => useWorkspaceLspSession({
      workspaceInstanceId: "workspace-close-recovery",
      roots,
      openFilesRef,
      updateLspFiles: vi.fn(),
      onError: vi.fn(),
    }));

    await act(async () => result.current.syncDocument(file, "open"));
    expect(result.current.documentVersion(file.key)).toBe(1);

    lspMocks.lspCloseDocument.mockRejectedValueOnce(new Error("didClose transport failed"));
    await expect(result.current.closeDocumentAndWait(file)).rejects.toThrow("didClose transport failed");
    expect(result.current.documentVersion(file.key)).toBe(1);

    await result.current.closeDocumentAndWait(file);
    expect(lspMocks.lspCloseDocument).toHaveBeenCalledTimes(2);
    expect(result.current.documentVersion(file.key)).toBeNull();
  });

  it("refreshes active open-file diagnostics when the server invalidates pull results", async () => {
    const openFilesRef = { current: { [file.key]: file } };
    const { result, unmount } = renderHook(() => useWorkspaceLspSession({
      workspaceInstanceId: "workspace-1",
      roots,
      openFilesRef,
      updateLspFiles: vi.fn(),
      onError: vi.fn(),
    }));

    await act(async () => result.current.syncDocument(file, "open"));
    lspMocks.lspGetDiagnostics.mockClear();
    await act(async () => {
      await emit(LSP_DIAGNOSTICS_REFRESH_EVENT, { workspaceId: "workspace-other" });
      await emit(LSP_DIAGNOSTICS_REFRESH_EVENT, { workspaceId: "workspace-1" });
    });

    await waitFor(() => expect(lspMocks.lspGetDiagnostics).toHaveBeenCalledOnce());
    expect(lspMocks.lspGetDiagnostics).toHaveBeenCalledWith(expect.objectContaining({
      workspaceId: "workspace-1",
      filePath: "src/main.ts",
    }));
    unmount();
  });

  it("publishes semantic readiness when the provider refreshes after indexing", async () => {
    const initializing = { ...status, presetId: "jdtls", semanticReady: false };
    const ready = { ...initializing, semanticReady: true };
    lspMocks.lspOpenDocument.mockResolvedValue(initializing);
    lspMocks.lspGetDiagnostics.mockResolvedValue({ status: ready, diagnostics: [] });
    const openFilesRef = { current: { [file.key]: file } };
    let lspFiles: Record<string, LspFileState> = {};
    const updateLspFiles = vi.fn((updater: Record<string, LspFileState> | ((current: Record<string, LspFileState>) => Record<string, LspFileState>)) => {
      lspFiles = typeof updater === "function" ? updater(lspFiles) : updater;
    });
    const { result, unmount } = renderHook(() => useWorkspaceLspSession({
      workspaceInstanceId: "workspace-semantic-ready",
      roots,
      openFilesRef,
      updateLspFiles,
      onError: vi.fn(),
    }));

    await act(async () => result.current.syncDocument(file, "open"));
    expect(lspFiles[file.key]?.status?.semanticReady).toBe(false);
    await act(async () => {
      await emit(LSP_DIAGNOSTICS_REFRESH_EVENT, { workspaceId: "workspace-semantic-ready" });
    });

    await waitFor(() => expect(lspFiles[file.key]?.status?.semanticReady).toBe(true));
    unmount();
  });

  it("ED-PERF-002-A1: skips server detection while hidden and refreshes when shown", async () => {
    const onError = vi.fn();
    const { result, rerender } = renderHook(
      ({ visible }) => useWorkspaceLspSession({
        workspaceInstanceId: "workspace-hidden-detection",
        roots,
        openFilesRef: { current: {} },
        updateLspFiles: vi.fn(),
        onError,
        visible,
      }),
      { initialProps: { visible: false } },
    );

    await act(async () => Promise.resolve());
    expect(lspMocks.lspSetJavaHome).not.toHaveBeenCalled();
    expect(lspMocks.lspDetectServers).not.toHaveBeenCalled();
    expect(result.current.serverStatuses).toEqual([]);

    rerender({ visible: true });
    await waitFor(() => expect(lspMocks.lspDetectServers).toHaveBeenCalledOnce());
    expect(lspMocks.lspDetectServers).toHaveBeenCalledWith({ javaHome: null, forceRefresh: true });
    expect(result.current.serverStatuses).toEqual([]);
  });

  it("ED-PERF-002-A3: drops a slow detection result after the workspace is hidden", async () => {
    let resolveJavaHome!: () => void;
    lspMocks.lspSetJavaHome.mockImplementationOnce(() => new Promise<void>((resolve) => {
      resolveJavaHome = resolve;
    }));
    const onError = vi.fn();
    const { result, rerender } = renderHook(
      ({ visible }) => useWorkspaceLspSession({
        workspaceInstanceId: "workspace-hidden-slow-detection",
        roots,
        openFilesRef: { current: {} },
        updateLspFiles: vi.fn(),
        onError,
        visible,
      }),
      { initialProps: { visible: true } },
    );

    await waitFor(() => expect(lspMocks.lspSetJavaHome).toHaveBeenCalledOnce());
    rerender({ visible: false });
    resolveJavaHome();
    await act(async () => Promise.resolve());
    expect(lspMocks.lspDetectServers).not.toHaveBeenCalled();
    expect(result.current.serverStatuses).toEqual([]);

    rerender({ visible: true });
    await waitFor(() => expect(lspMocks.lspDetectServers).toHaveBeenCalledOnce());
    expect(lspMocks.lspDetectServers).toHaveBeenCalledWith({ javaHome: null, forceRefresh: true });
  });

  it("records the file revision and provider session scope for diagnostics", async () => {
    const diagnostic: LspDiagnostic = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
      severity: 1,
      message: "Type error",
      source: "ts",
      code: "2322",
    };
    lspMocks.lspGetDiagnostics.mockResolvedValue({ status, diagnostics: [diagnostic] });
    const openFilesRef = { current: { [file.key]: file } };
    let lspFiles: Record<string, LspFileState> = {};
    const updateLspFiles = vi.fn((updater: Record<string, LspFileState> | ((current: Record<string, LspFileState>) => Record<string, LspFileState>)) => {
      lspFiles = typeof updater === "function" ? updater(lspFiles) : updater;
    });
    const { result, unmount } = renderHook(() => useWorkspaceLspSession({
      workspaceInstanceId: "workspace-diagnostic-scope",
      roots,
      openFilesRef,
      updateLspFiles,
      onError: vi.fn(),
    }));

    await act(async () => result.current.syncDocument(file, "open"));
    await act(async () => {
      await emit(LSP_DIAGNOSTICS_REFRESH_EVENT, { workspaceId: "workspace-diagnostic-scope" });
    });

    await waitFor(() => expect(lspFiles[file.key]?.diagnostics).toHaveLength(1));
    expect(lspFiles[file.key]?.diagnosticScope).toEqual({
      fileKey: file.key,
      revision: 0,
      providerId: "typescript",
      providerGeneration: 0,
      uri: "file:///repo/src/main.ts",
    });
    unmount();
  });

  it("drops a diagnostics response when the buffer revision changes while it is pending", async () => {
    let resolveDiagnostics!: (value: { status: LspDocumentStatus; diagnostics: LspDiagnostic[]; }) => void;
    lspMocks.lspGetDiagnostics.mockImplementation(() => new Promise((resolve) => {
      resolveDiagnostics = resolve;
    }));
    const openFilesRef: { current: Record<string, OpenFileState>; } = {
      current: { [file.key]: file },
    };
    let lspFiles: Record<string, LspFileState> = {};
    const updateLspFiles = vi.fn((updater: Record<string, LspFileState> | ((current: Record<string, LspFileState>) => Record<string, LspFileState>)) => {
      lspFiles = typeof updater === "function" ? updater(lspFiles) : updater;
    });
    const { result, unmount } = renderHook(() => useWorkspaceLspSession({
      workspaceInstanceId: "workspace-diagnostic-revision",
      roots,
      openFilesRef,
      updateLspFiles,
      onError: vi.fn(),
    }));

    await act(async () => result.current.syncDocument(file, "open"));
    await act(async () => {
      await emit(LSP_DIAGNOSTICS_REFRESH_EVENT, { workspaceId: "workspace-diagnostic-revision" });
    });
    await waitFor(() => expect(lspMocks.lspGetDiagnostics).toHaveBeenCalled());

    openFilesRef.current[file.key] = { ...file, text: "const value = 2;", documentRevision: 1 };
    resolveDiagnostics({
      status,
      diagnostics: [{
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        severity: 1,
        message: "Stale error",
        source: "ts",
        code: "2322",
      }],
    });
    await act(async () => Promise.resolve());

    expect(lspFiles[file.key]?.diagnostics).toEqual([]);
    expect(lspFiles[file.key]?.diagnosticScope).toBeNull();
    unmount();
  });

  it("routes library sources through the origin project session and never syncs them", async () => {
    const libraryFile: OpenFileState = {
      ...file,
      key: "loose:loose-jdt-string",
      ref: { kind: "loose", id: "loose-jdt-string", path: "jdt://contents/java.base/java.lang/String.class?=x" },
      title: "String.java",
      subtitle: "java.lang · java.base · String.java",
      path: "jdt://contents/java.base/java.lang/String.class?=x",
      languagePath: "String.java",
      library: {
        uri: "jdt://contents/java.base/java.lang/String.class?=x",
        container: "java.lang · java.base",
        originRootPath: "/repo",
        originFilePath: "src/Main.java",
      },
    };
    const openFilesRef = { current: { [libraryFile.key]: libraryFile } };
    const { result } = renderHook(() => useWorkspaceLspSession({
      workspaceInstanceId: "workspace-1",
      roots,
      openFilesRef,
      updateLspFiles: vi.fn(),
      onError: vi.fn(),
    }));

    await waitFor(() => expect(lspMocks.lspDetectServers).toHaveBeenCalled());
    // Requests must ride the origin project's session but target the class URI.
    expect(result.current.descriptorForFile(libraryFile)).toMatchObject({
      rootPath: "/repo",
      filePath: "src/Main.java",
      documentUri: "jdt://contents/java.base/java.lang/String.class?=x",
    });

    await act(async () => result.current.syncDocument(libraryFile, "open"));
    await act(async () => result.current.saveDocument(libraryFile, "text"));
    act(() => result.current.closeDocument(libraryFile));
    expect(lspMocks.lspOpenDocument).not.toHaveBeenCalled();
    expect(lspMocks.lspSaveDocument).not.toHaveBeenCalled();
    expect(lspMocks.lspCloseDocument).not.toHaveBeenCalled();
  });

  it("does not commit an async response after its buffer was closed", async () => {
    let resolveOpen!: (value: LspDocumentStatus) => void;
    lspMocks.lspOpenDocument.mockImplementation(() => new Promise<LspDocumentStatus>((resolve) => {
      resolveOpen = resolve;
    }));
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

  it("advances the error generation when the same provider failure recurs", async () => {
    lspMocks.lspOpenDocument.mockRejectedValue(new Error("server unavailable"));
    const openFilesRef = { current: { [file.key]: file } };
    let lspFiles: Record<string, LspFileState> = {};
    const updateLspFiles = vi.fn((updater: Record<string, LspFileState> | ((current: Record<string, LspFileState>) => Record<string, LspFileState>)) => {
      lspFiles = typeof updater === "function" ? updater(lspFiles) : updater;
    });
    const { result } = renderHook(() => useWorkspaceLspSession({
      workspaceInstanceId: "workspace-error-generation",
      roots,
      openFilesRef,
      updateLspFiles,
      onError: vi.fn(),
    }));

    await act(async () => result.current.syncDocument(file, "open"));
    expect(lspFiles[file.key]?.errorGeneration).toBe(1);

    await act(async () => result.current.syncDocument(file, "open"));
    expect(lspFiles[file.key]?.errorGeneration).toBe(2);
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
}
