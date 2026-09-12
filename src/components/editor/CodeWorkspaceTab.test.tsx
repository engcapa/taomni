import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import mermaid from "mermaid";
import { StrictMode, useCallback, useRef, useState, type ComponentProps } from "react";
import { useAppStore } from "../../stores/appStore";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../stores/codeWorkspaceStore";
import { useCodeWorkspaceStatusStore } from "../../stores/codeWorkspaceStatusStore";
import { DEFAULT_CODE_VIEW_PROFILE, saveCodeViewProfile } from "../../lib/codeViewProfile";
import {
  editorAppearanceProfileStorageKey,
  writeEditorAppearanceProfile,
} from "./workspace/editorAppearanceProfile";
import type { CodeWorkspaceTabInfo } from "../../types";
import type {
  LspCapabilitySummary,
  LspDocumentHighlight,
  LspDocumentStatus,
  LspServerStatus,
} from "../../lib/editor/lsp";
import type { ProjectDescriptorDiscoveryState } from "../../hooks/useProjectDescriptorDiscovery";
import type { StructuredTestResults, WorkspaceEntry, WorkspaceFile, WorkspaceWriteAck } from "../../lib/editor/workspace";
import type { LocalHistoryEntry } from "../../lib/localHistory";
import { CodeWorkspaceTab, debugCurrentLineForFile, extractContextSnippet } from "./CodeWorkspaceTab";
import { emit } from "@tauri-apps/api/event";
import { WORKSPACE_RECOVERY_STORAGE_PREFIX, hasBlockingDiskEffectResolution, listDiskEffectLedgerEntries, resolveDiskEffectLedgerEntry } from "./workspace/workspaceRecovery";
import type { WorkspaceCommandRegistration } from "./workspace/workspaceCommands";
import { confirmAppDialog, promptAppDialog } from "../../lib/appDialogs";
import {
  getRefactorRecoveryJournalV2,
  recordRefactorRecoveryJournalV2,
} from "./workspace/refactorPlan";
import { sha256Hex } from "./workspace/projectAnalysisModel";
import { textIdentityFromString } from "./workspace/workspaceLayoutPersistence";
import { workspaceActionRegistry } from "./workspace/workspaceActionRegistry";
import {
  WorkspaceLocationController,
} from "./workspace/navigationHistoryModel";
import {
  clearGitSnapshotCache,
  clearGitSnapshotInFlight,
} from "./workspace/useWorkspaceGitSnapshots";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { globalEditorConfigResolver } from "./workspace/editorConfigResolver";
import { acquireClipboardStore, resetWorkspaceClipboardStores } from "./workspace/workspaceClipboardSession";
import * as workspaceSearchModule from "../../lib/editor/workspaceSearch";

const workspaceMocks = vi.hoisted(() => ({
  workspaceListDir: vi.fn(),
  workspaceCompactChain: vi.fn(),
  workspaceListFilesRecursive: vi.fn(),
  workspaceDetectGitRoots: vi.fn(),
  workspaceDetectTasks: vi.fn(),
  workspaceExecutionModel: vi.fn(),
  workspaceJavaRunTargets: vi.fn(),
  workspaceJavaRunTarget: vi.fn(),
  workspaceTaskTree: vi.fn(),
  workspaceTestResults: vi.fn(),
  workspaceDependencyTree: vi.fn(),
  workspaceReadFile: vi.fn(),
  workspaceReadLooseFile: vi.fn(),
  workspaceReadFileWithEncoding: vi.fn(),
  workspaceReadLooseFileWithEncoding: vi.fn(),
  workspaceWriteFile: vi.fn(),
  workspaceWriteLooseFile: vi.fn(),
  workspaceWriteFileEncoded: vi.fn(),
  workspaceWriteLooseFileEncoded: vi.fn(),
  workspaceCreateFile: vi.fn(),
  workspaceCreateDir: vi.fn(),
  workspaceDeletePath: vi.fn(),
  workspaceRenamePath: vi.fn(),
  workspaceApplyResourceOperation: vi.fn(),
}));

const saveCommitObservations = vi.hoisted(() => ({
  results: [] as unknown[],
}));

vi.mock("./workspace/workspaceStyleController", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./workspace/workspaceStyleController")>();
  return {
    ...actual,
    createWorkspaceStyleController: (
      ...args: Parameters<typeof actual.createWorkspaceStyleController>
    ) => {
      const controller = actual.createWorkspaceStyleController(...args);
      const executeSaveTransaction = controller.executeSaveTransaction.bind(controller);
      controller.executeSaveTransaction = async (
        ...transactionArgs: Parameters<typeof executeSaveTransaction>
      ) => {
        const result = await executeSaveTransaction(...transactionArgs);
        saveCommitObservations.results.push(result);
        return result;
      };
      return controller;
    },
  };
});

const lspMocks = vi.hoisted(() => ({
  // This mock replaces the whole lsp module, so every value export
  // CodeWorkspaceTab imports must exist here. Keep the renderer-wide sequence
  // monotonic like the real module: handlers call it before the IPC request.
  nextLspRequestSequence: (() => {
    let seq = 0;
    return vi.fn(() => {
      seq += 1;
      return seq;
    });
  })(),
  lspDetectServers: vi.fn(),
  lspSetJavaHome: vi.fn(),
  lspSetJavaVmargs: vi.fn(),
  lspSetJavaSettings: vi.fn(),
  lspSetJavaBundles: vi.fn(),
  lspOpenDocument: vi.fn(),
  lspChangeDocument: vi.fn(),
  lspSaveDocument: vi.fn(),
  lspCloseDocument: vi.fn(),
  lspStopWorkspace: vi.fn(),
  lspGetDiagnostics: vi.fn(),
  lspHover: vi.fn(),
  lspDefinition: vi.fn(),
  lspDeclaration: vi.fn(),
  lspTypeDefinition: vi.fn(),
  lspImplementation: vi.fn(),
  lspPrepareRename: vi.fn(),
  lspRename: vi.fn(),
  lspReadUriContents: vi.fn(),
  lspDownloadSources: vi.fn(),
  lspReloadProject: vi.fn(),
  lspJavaModules: vi.fn(),
  lspWorkspaceDiagnostics: vi.fn(),
  lspBuildWorkspace: vi.fn(),
  javaTestDiscover: vi.fn(),
  lspReferences: vi.fn(),
  lspPrepareCallHierarchy: vi.fn(),
  lspCallHierarchyIncoming: vi.fn(),
  lspCallHierarchyOutgoing: vi.fn(),
  lspPrepareTypeHierarchy: vi.fn(),
  lspTypeHierarchySupertypes: vi.fn(),
  lspTypeHierarchySubtypes: vi.fn(),
  lspDocumentSymbols: vi.fn(),
  lspDocumentHighlights: vi.fn(),
  lspInlayHints: vi.fn(),
  lspSemanticTokens: vi.fn(),
  lspSelectionRanges: vi.fn(),
  lspCompletion: vi.fn(),
  lspCompletionResolve: vi.fn(),
  lspSignatureHelp: vi.fn(),
  lspFormatting: vi.fn(),
  lspRangeFormatting: vi.fn(),
  lspCodeActions: vi.fn(),
  lspCodeActionResolve: vi.fn(),
  lspWorkspaceSymbols: vi.fn(),
  lspWorkspaceSymbolResolve: vi.fn(),
  lspExecuteCommand: vi.fn(),
  lspResolveWorkspaceEdit: vi.fn(),
  lspResolveShowMessageRequest: vi.fn(),
  lspCancelWorkDoneProgress: vi.fn(),
  lspWorkspaceDidFileOperation: vi.fn(),
  lspWorkspaceDidChangeWatchedFiles: vi.fn(),
  lspStartWorkspaceWatcher: vi.fn(),
  lspStopWorkspaceWatcher: vi.fn(),
  lspWorkspaceWillFileOperation: vi.fn(),
}));

const ipcMocks = vi.hoisted(() => ({
  selectFilePath: vi.fn(),
  selectFolderPath: vi.fn(),
}));

const dapMocks = vi.hoisted(() => ({
  dapStartSession: vi.fn(),
  dapSendRequest: vi.fn(),
  dapSend: vi.fn(),
  dapTerminate: vi.fn(),
  listenDapEvents: vi.fn(),
  dapResolveJavaMainClasses: vi.fn(),
}));

vi.mock("../../lib/editor/dap", () => dapMocks);

/**
 * Whether the component sees the desktop runtime. Defaults to false (the value
 * every other test in this file has always run with); the Java debug test opts
 * in, since the Debug button is disabled outside the Tauri webview.
 */
const runtimeState = vi.hoisted(() => ({
  tauri: false,
  platform: "linux" as "linux" | "macos" | "windows" | "unknown",
}));

vi.mock("../../lib/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/runtime")>()),
  isTauriRuntime: () => runtimeState.tauri,
  getAppPlatform: () => runtimeState.platform,
}));

const clipboardMocks = vi.hoisted(() => {
  let inMemoryClipboard = "";
  return {
    probeClipboardCapabilities: vi.fn(async () => null),
    readText: vi.fn(async () => inMemoryClipboard),
    readNativeTextResult: vi.fn(async () => ({ ok: true, text: inMemoryClipboard })),
    readTextResult: vi.fn(async () => ({ ok: true, text: inMemoryClipboard })),
    writeText: vi.fn(async (text: string) => {
      inMemoryClipboard = text;
    }),
  };
});

const settingsNavigationMocks = vi.hoisted(() => ({
  openSettingsSection: vi.fn(),
}));

const projectFactsMock = vi.hoisted(() => {
  const state = {
    status: "idle" as "idle" | "loading" | "ready" | "degraded" | "untrusted" | "failed",
    reason: null as string | null,
    generation: 0,
    isStale: false,
  };
  const refresh = vi.fn(async () => undefined);
  return {
    state,
    refresh,
    useProjectFacts: vi.fn((workspaceRoot: string, _options?: unknown) => ({
      workspaceRoot,
      ...state,
      fingerprint: null,
      structure: null,
      provenance: null,
      abortController: null,
      refresh,
      invalidate: vi.fn(),
    })),
  };
});

vi.mock("../../hooks/useProjectFacts", () => ({
  useProjectFacts: projectFactsMock.useProjectFacts,
}));

const descriptorDiscoveryMock = vi.hoisted(() => {
  const refresh = vi.fn(async () => undefined);
  const state: ProjectDescriptorDiscoveryState = {
    status: "idle",
    discovery: null,
    reason: null,
    refresh,
  };
  return {
    state,
    refresh,
    useProjectDescriptorDiscovery: vi.fn(() => state),
  };
});

vi.mock("../../hooks/useProjectDescriptorDiscovery", () => ({
  useProjectDescriptorDiscovery: descriptorDiscoveryMock.useProjectDescriptorDiscovery,
}));

vi.mock("../../lib/clipboard", () => clipboardMocks);

vi.mock("../../lib/settingsNavigation", () => settingsNavigationMocks);

// CodeWorkspaceTab is rendered in isolation (without the app-level dialog
// provider). Auto-confirm preview-only WorkspaceEdits so those tests can
// continue to assert the resource operation lifecycle itself.
vi.mock("../../lib/appDialogs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../lib/appDialogs")>()),
  confirmAppDialog: vi.fn(async () => true),
  promptAppDialog: vi.fn(async () => null),
}));

const gitMocks = vi.hoisted(() => ({
  gitSnapshot: vi.fn(),
  gitIgnorePath: vi.fn(),
  gitBlobPair: vi.fn(),
  gitBlameLines: vi.fn(),
  gitChangeLabel: vi.fn((change: { conflict?: boolean; status: string }) => (
    change.conflict ? "Conflicted" : change.status[0]?.toUpperCase() + change.status.slice(1)
  )),
}));

vi.mock("../../lib/editor/workspace", () => {
  // W0 §8.20.1: the production tree IPC returns the WorkspaceTreeLoadResult
  // union. Test fixtures keep writing raw arrays/chain objects; these
  // delegates convert them (and rejections) exactly like the real decoder.
  const wrapResult = (value: unknown): unknown => {
    if (value && typeof value === "object" && "state" in (value as Record<string, unknown>)) return value;
    if (Array.isArray(value)) return { state: "ready", entries: value, truncated: false };
    if (value && typeof value === "object" && "path" in (value as Record<string, unknown>)
      && "entries" in (value as Record<string, unknown>)) {
      return { state: "ready", entries: (value as { entries: unknown[] }).entries, truncated: false };
    }
    return { state: "failed", message: "malformed fixture payload" };
  };
  const wrap = async (fn: () => unknown): Promise<unknown> => {
    try {
      return wrapResult(await fn());
    } catch (error) {
      return { state: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  };
  return {
    ...workspaceMocks,
    parseWorkspaceWriteError: (error: unknown) => {
      if (error && typeof error === "object" && "kind" in error && "message" in error) {
        return error;
      }
      return {
        kind: "io",
        message: error instanceof Error ? error.message : String(error),
      };
    },
    workspaceListDir: (...args: unknown[]) => wrap(() => workspaceMocks.workspaceListDir(...args)),
    workspaceCompactChain: (...args: unknown[]) => wrap(() => workspaceMocks.workspaceCompactChain(...args)),
    workspaceListFilesRecursive: (...args: unknown[]) => wrap(() => workspaceMocks.workspaceListFilesRecursive(...args)),
  };
});

vi.mock("../../lib/editor/lsp", () => lspMocks);

vi.mock("@tauri-apps/api/event", () => import("../../stubs/tauri-event"));

vi.mock("../../lib/ipc", () => ipcMocks);

vi.mock("../../lib/git", () => gitMocks);

const localHistoryMocks = vi.hoisted(() => ({
  historySnapshot: vi.fn<() => Promise<LocalHistoryEntry | null>>(async () => null),
  historyList: vi.fn<() => Promise<LocalHistoryEntry[]>>(async () => []),
  historyRead: vi.fn(async () => ""),
  formatLocalHistoryTime: vi.fn(() => "just now"),
  historyRevert: vi.fn(async () => null),
  historyPurge: vi.fn(async () => null),
}));

vi.mock("../../lib/localHistory", () => localHistoryMocks);

const chatMocks = vi.hoisted(() => ({
  attachToComposer: vi.fn(async () => undefined),
  explainSelection: vi.fn(async () => undefined),
  sendPromptToTabChat: vi.fn(async () => undefined),
}));

vi.mock("../../stores/chatStore", () => ({
  useChatStore: (selector: (state: typeof chatMocks) => unknown) => selector(chatMocks),
}));

vi.mock("../git/diffLanguage", () => ({
  languageForPath: vi.fn(async () => null),
}));

vi.mock("../terminal/TerminalPanel", () => ({
  TerminalPanel: ({
    tabId,
    initialCwd,
    onTaskExit,
  }: {
    tabId?: string;
    initialCwd?: string;
    onTaskExit?: (exitCode: number) => void;
  }) => (
    <div data-testid="mock-workspace-terminal" data-tab-id={tabId} data-initial-cwd={initialCwd}>
      <button
        type="button"
        data-testid="mock-workspace-terminal-task-exit"
        onClick={() => onTaskExit?.(0)}
      >
        task-exit
      </button>
    </div>
  ),
}));

function file(
  path: string,
  text: string,
  overrides: Partial<WorkspaceFile> = {},
): WorkspaceFile {
  return {
    path,
    text,
    size: text.length,
    mtime: 1_788_888_888,
    hash: `hash-${path}`,
    ...overrides,
  };
}

/** Native write ack (§8.18.1): the decoded file plus the written byte identity. */
function writeAck(
  written: WorkspaceFile,
  overrides: Partial<Omit<WorkspaceWriteAck, "file">> = {},
): WorkspaceWriteAck {
  return {
    file: written,
    writtenHash: written.hash,
    writtenByteLength: written.size,
    atomicReplaceUsed: true,
    ...overrides,
  };
}

function entry(
  name: string,
  path: string,
  fileType: WorkspaceEntry["fileType"] = "file",
): WorkspaceEntry {
  return {
    name,
    path,
    fileType,
    size: fileType === "file" ? 42 : 0,
    mtime: 1_788_888_888,
    isHidden: false,
  };
}

function csharpStatus(overrides: Partial<LspServerStatus> = {}): LspServerStatus {
  return {
    presetId: "csharp",
    displayName: "C#",
    documentLanguageIds: ["csharp"],
    available: false,
    active: false,
    selectedCommandId: "csharp-ls",
    selectedCommand: "csharp-ls",
    installHint: "dotnet tool install -g csharp-ls",
    error: null,
    commands: [
      {
        id: "csharp-ls",
        label: "csharp-ls",
        command: "csharp-ls",
        args: [],
        installHint: "dotnet tool install -g csharp-ls",
        fallback: false,
        available: false,
      },
      {
        id: "omnisharp",
        label: "OmniSharp",
        command: "omnisharp",
        args: ["--languageserver"],
        installHint: "Install OmniSharp and ensure `omnisharp` is on PATH",
        fallback: true,
        available: false,
      },
    ],
    ...overrides,
  };
}

function defaultCapabilities(overrides: Partial<LspCapabilitySummary> = {}): LspCapabilitySummary {
  return {
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
    inlayHint: false,
    selectionRange: false,
    callHierarchy: false,
    typeHierarchy: false,
    semanticTokens: false,
    completionTriggerCharacters: [],
    signatureTriggerCharacters: [],
    ...overrides,
  };
}

function documentStatus(overrides: Partial<LspDocumentStatus> = {}): LspDocumentStatus {
  return {
    path: "/repo/app/src/Program.cs",
    uri: "file:///repo/app/src/Program.cs",
    presetId: "csharp",
    languageId: "csharp",
    displayName: "C#",
    available: false,
    active: false,
    selectedCommandId: "csharp-ls",
    selectedCommand: "csharp-ls",
    installHint: "dotnet tool install -g csharp-ls",
    error: null,
    capabilities: defaultCapabilities(overrides.capabilities ?? undefined),
    ...overrides,
  };
}

function renderWorkspace(
  workspace: CodeWorkspaceTabInfo,
  props: Partial<ComponentProps<typeof CodeWorkspaceTab>> = {},
  options: { strict?: boolean } = {},
) {
  const element = <CodeWorkspaceTab tabId="tab-code" workspace={workspace} visible {...props} />;
  // `strict` reproduces how the app actually mounts (src/main.tsx wraps the tree
  // in React.StrictMode): mount → effect cleanups → effects again. Anything that
  // latches state in an effect cleanup behaves differently there.
  return render(options.strict ? <StrictMode>{element}</StrictMode> : element);
}

describe("extractContextSnippet", () => {
  it("extracts the first line and its following context at offset zero", () => {
    expect(extractContextSnippet("first\nsecond\nthird", 0, 0)).toEqual({
      lineText: "first",
      contextSnippet: "first\nsecond",
    });
  });

  it("preserves an empty first line when the caret is on the second line", () => {
    expect(extractContextSnippet("\nsecond\nthird", 1, 1)).toEqual({
      lineText: "second",
      contextSnippet: "\nsecond\nthird",
    });
  });

  it("returns only the adjacent three-line window for a middle line", () => {
    const text = "zero\none\ntwo\nthree\nfour";
    expect(extractContextSnippet(text, 2, text.indexOf("two"))).toEqual({
      lineText: "two",
      contextSnippet: "one\ntwo\nthree",
    });
  });

  it("extracts the final line and its predecessor at end of file", () => {
    const text = "zero\none\ntwo";
    expect(extractContextSnippet(text, 2, text.length)).toEqual({
      lineText: "two",
      contextSnippet: "one\ntwo",
    });
  });
});

describe("debugCurrentLineForFile", () => {
  it("matches a stopped source frame by source name when path is omitted", () => {
    expect(debugCurrentLineForFile(
      null,
      [{ id: 7, path: null, line: 17, sourceName: "PersisG2Application.java" }],
      7,
      "/repo/persis-g2-server/src/main/java/com/deepzero/ads/persis/PersisG2Application.java",
      true,
    )).toBe(17);
  });

  it("prefers an exact source path and rejects a different source name", () => {
    expect(debugCurrentLineForFile(
      { path: "/repo/src/App.java", line: 9 },
      [{ id: 1, path: null, line: 17, sourceName: "Other.java" }],
      1,
      "/repo/src/App.java",
      true,
    )).toBe(9);
    expect(debugCurrentLineForFile(
      null,
      [{ id: 1, path: null, line: 17, sourceName: "Other.java" }],
      1,
      "/repo/src/App.java",
      true,
    )).toBeNull();
  });
});

describe("CodeWorkspaceTab", () => {
  beforeEach(() => {
    window.localStorage.clear();
    workspaceActionRegistry.clear();
    globalEditorConfigResolver.clearAll();
    clearGitSnapshotCache();
    clearGitSnapshotInFlight();
    vi.mocked(confirmAppDialog).mockReset().mockResolvedValue(true);
    vi.mocked(promptAppDialog).mockReset().mockResolvedValue(null);
    useAppStore.setState({
      statusMessage: "Ready",
      codeWorkspaceByTab: {},
    });
    useCodeWorkspaceStore.setState({ byInstanceId: {} });
    saveCommitObservations.results.length = 0;
    projectFactsMock.state.status = "idle";
    projectFactsMock.state.reason = null;
    projectFactsMock.state.generation = 0;
    projectFactsMock.state.isStale = false;
    projectFactsMock.refresh.mockReset().mockResolvedValue(undefined);
    projectFactsMock.useProjectFacts.mockClear();
    descriptorDiscoveryMock.state.status = "idle";
    descriptorDiscoveryMock.state.discovery = null;
    descriptorDiscoveryMock.state.reason = null;
    descriptorDiscoveryMock.refresh.mockReset().mockResolvedValue(undefined);
    descriptorDiscoveryMock.useProjectDescriptorDiscovery.mockClear();
    localHistoryMocks.historySnapshot.mockReset().mockResolvedValue(null);
    localHistoryMocks.historyList.mockReset().mockResolvedValue([]);
    localHistoryMocks.historyRead.mockReset().mockResolvedValue("");
    localHistoryMocks.formatLocalHistoryTime.mockReset().mockReturnValue("just now");
    workspaceMocks.workspaceListDir.mockReset();
    workspaceMocks.workspaceCompactChain.mockReset();
    workspaceMocks.workspaceListFilesRecursive.mockReset();
    workspaceMocks.workspaceDetectGitRoots.mockReset();
    workspaceMocks.workspaceDetectTasks.mockReset();
    workspaceMocks.workspaceJavaRunTargets.mockReset().mockResolvedValue([]);
    workspaceMocks.workspaceExecutionModel.mockReset().mockResolvedValue({
      projects: [],
      buildTargets: [],
      runConfigurations: [],
      debugConfigurations: [],
      tools: [],
    });
    workspaceMocks.workspaceJavaRunTarget.mockReset();
    workspaceMocks.workspaceTaskTree.mockReset().mockResolvedValue([]);
    workspaceMocks.workspaceTestResults.mockReset().mockResolvedValue({
      schema: "taomni.codeWorkspace.testResults",
      version: 1,
      source: "junit-xml",
      generatedAt: 1,
      results: [],
      summary: { total: 0, passed: 0, failed: 0, skipped: 0, errors: 0, durationMs: 0 },
      diagnostics: [],
    } satisfies StructuredTestResults);
    workspaceMocks.workspaceDependencyTree.mockReset().mockResolvedValue([]);
    workspaceMocks.workspaceReadFile.mockReset();
    workspaceMocks.workspaceReadLooseFile.mockReset();
    workspaceMocks.workspaceReadFileWithEncoding.mockReset();
    workspaceMocks.workspaceReadLooseFileWithEncoding.mockReset();
    workspaceMocks.workspaceWriteFile.mockReset();
    workspaceMocks.workspaceWriteLooseFile.mockReset();
    workspaceMocks.workspaceWriteFileEncoded.mockReset();
    workspaceMocks.workspaceWriteLooseFileEncoded.mockReset();
    workspaceMocks.workspaceCreateFile.mockReset();
    workspaceMocks.workspaceCreateDir.mockReset();
    workspaceMocks.workspaceDeletePath.mockReset();
    workspaceMocks.workspaceRenamePath.mockReset();
    workspaceMocks.workspaceApplyResourceOperation.mockReset();
    lspMocks.lspDetectServers.mockReset();
    lspMocks.lspSetJavaHome.mockReset().mockResolvedValue(undefined);
    lspMocks.lspSetJavaVmargs.mockReset().mockResolvedValue("-Xms1024m -Xmx1024m");
    lspMocks.lspSetJavaSettings.mockReset().mockResolvedValue(0);
    lspMocks.lspSetJavaBundles.mockReset().mockResolvedValue(undefined);
    lspMocks.lspOpenDocument.mockReset();
    lspMocks.lspChangeDocument.mockReset();
    lspMocks.lspSaveDocument.mockReset();
    lspMocks.lspCloseDocument.mockReset();
    lspMocks.lspStopWorkspace.mockReset().mockResolvedValue(0);
    lspMocks.lspGetDiagnostics.mockReset();
    lspMocks.lspWorkspaceDiagnostics.mockReset().mockResolvedValue([]);
    lspMocks.lspBuildWorkspace.mockReset().mockResolvedValue("succeed");
    runtimeState.tauri = false;
    dapMocks.dapStartSession.mockReset();
    dapMocks.dapSendRequest.mockReset().mockResolvedValue({});
    dapMocks.dapSend.mockReset().mockResolvedValue(undefined);
    dapMocks.dapTerminate.mockReset().mockResolvedValue(undefined);
    dapMocks.listenDapEvents.mockReset().mockResolvedValue(() => {});
    dapMocks.dapResolveJavaMainClasses.mockReset();
    lspMocks.lspHover.mockReset();
    lspMocks.lspDefinition.mockReset();
    lspMocks.lspDeclaration.mockReset();
    lspMocks.lspTypeDefinition.mockReset();
    lspMocks.lspImplementation.mockReset();
    lspMocks.lspPrepareRename.mockReset();
    lspMocks.lspRename.mockReset();
    lspMocks.lspReadUriContents.mockReset();
    lspMocks.lspDownloadSources.mockReset();
    lspMocks.lspReferences.mockReset();
    lspMocks.lspPrepareCallHierarchy.mockReset();
    lspMocks.lspCallHierarchyIncoming.mockReset();
    lspMocks.lspCallHierarchyOutgoing.mockReset();
    lspMocks.lspPrepareTypeHierarchy.mockReset();
    lspMocks.lspTypeHierarchySupertypes.mockReset();
    lspMocks.lspTypeHierarchySubtypes.mockReset();
    lspMocks.lspDocumentSymbols.mockReset();
    lspMocks.lspDocumentHighlights.mockReset();
    lspMocks.lspInlayHints.mockReset();
    lspMocks.lspSemanticTokens.mockReset();
    lspMocks.lspSelectionRanges.mockReset();
    lspMocks.lspExecuteCommand.mockReset().mockResolvedValue(null);
    lspMocks.lspResolveWorkspaceEdit.mockReset().mockResolvedValue(undefined);
    lspMocks.lspResolveShowMessageRequest.mockReset().mockResolvedValue(undefined);
    lspMocks.lspCancelWorkDoneProgress.mockReset().mockResolvedValue(false);
    lspMocks.lspWorkspaceDidChangeWatchedFiles.mockReset().mockResolvedValue(0);
    lspMocks.lspStartWorkspaceWatcher.mockReset().mockResolvedValue(undefined);
    lspMocks.lspStopWorkspaceWatcher.mockReset().mockResolvedValue(undefined);
    lspMocks.lspWorkspaceDidFileOperation.mockReset().mockResolvedValue(1);
    lspMocks.lspWorkspaceWillFileOperation.mockReset().mockResolvedValue(1);
    lspMocks.lspDocumentSymbols.mockResolvedValue({ status: documentStatus(), symbols: [] });
    lspMocks.lspDocumentHighlights.mockResolvedValue({ status: documentStatus(), highlights: [] });
    lspMocks.lspInlayHints.mockResolvedValue({ status: documentStatus(), hints: [] });
    lspMocks.lspSemanticTokens.mockResolvedValue({ status: documentStatus(), tokens: [] });
    lspMocks.lspSelectionRanges.mockResolvedValue({ status: documentStatus(), ranges: [] });
    lspMocks.lspCompletion.mockReset();
    lspMocks.lspCompletion.mockResolvedValue({ status: documentStatus(), isIncomplete: false, items: [] });
    lspMocks.lspCompletionResolve.mockReset();
    lspMocks.lspCompletionResolve.mockResolvedValue(null);
    lspMocks.lspSignatureHelp.mockReset();
    lspMocks.lspSignatureHelp.mockResolvedValue({
      status: documentStatus(),
      signatures: [],
      activeSignature: 0,
      activeParameter: 0,
    });
    lspMocks.lspFormatting.mockReset();
    lspMocks.lspFormatting.mockResolvedValue({ status: documentStatus(), edits: [] });
    lspMocks.lspRangeFormatting.mockReset();
    lspMocks.lspRangeFormatting.mockResolvedValue({ status: documentStatus(), edits: [] });
    lspMocks.lspCodeActions.mockReset();
    lspMocks.lspCodeActions.mockResolvedValue({ status: documentStatus(), actions: [] });
    lspMocks.lspCodeActionResolve.mockReset();
    lspMocks.lspCodeActionResolve.mockImplementation(async (_descriptor: unknown, raw: unknown) => ({
      status: documentStatus({ available: true, active: true }),
      action: raw,
    }));
    lspMocks.lspWorkspaceSymbols.mockReset();
    lspMocks.lspWorkspaceSymbols.mockResolvedValue({
      status: documentStatus(),
      symbols: [],
      sessionCount: 0,
      providerCount: 0,
      skippedProviderCount: 0,
      failedProviderCount: 0,
      complete: false,
      truncated: false,
      diagnostics: [],
    });
    lspMocks.lspWorkspaceSymbolResolve.mockReset();
    lspMocks.lspPrepareCallHierarchy.mockResolvedValue({ status: documentStatus(), items: [] });
    lspMocks.lspCallHierarchyIncoming.mockResolvedValue({ status: documentStatus(), entries: [] });
    lspMocks.lspCallHierarchyOutgoing.mockResolvedValue({ status: documentStatus(), entries: [] });
    lspMocks.lspPrepareTypeHierarchy.mockResolvedValue({ status: documentStatus(), items: [] });
    lspMocks.lspTypeHierarchySupertypes.mockResolvedValue({ status: documentStatus(), items: [] });
    lspMocks.lspTypeHierarchySubtypes.mockResolvedValue({ status: documentStatus(), items: [] });
    ipcMocks.selectFilePath.mockReset();
    ipcMocks.selectFolderPath.mockReset();
    gitMocks.gitSnapshot.mockReset();
    gitMocks.gitIgnorePath.mockReset();
    gitMocks.gitBlobPair.mockReset();
    gitMocks.gitBlameLines.mockReset();
    gitMocks.gitChangeLabel.mockClear();
    vi.mocked(mermaid.initialize).mockClear();
    vi.mocked(mermaid.render).mockClear();
    lspMocks.lspDetectServers.mockResolvedValue([]);
    lspMocks.lspOpenDocument.mockResolvedValue(documentStatus());
    lspMocks.lspChangeDocument.mockResolvedValue(documentStatus({ active: true, available: true }));
    lspMocks.lspSaveDocument.mockResolvedValue(documentStatus({ active: true, available: true }));
    lspMocks.lspCloseDocument.mockResolvedValue(documentStatus());
    lspMocks.lspPrepareRename.mockResolvedValue({
      status: documentStatus(),
      allowed: false,
      range: null,
      placeholder: null,
      message: null,
    });
    lspMocks.lspRename.mockResolvedValue({
      status: documentStatus(),
      edit: { documentEdits: [], operations: [] },
    });
    lspMocks.lspGetDiagnostics.mockImplementation(async (descriptor: {
      workspaceId: string;
      rootPath: string | null;
      filePath: string;
      documentUri?: string | null;
    }) => {
      const normalizedFilePath = descriptor.filePath.replace(/\\/g, "/");
      const absolutePath = descriptor.rootPath && !normalizedFilePath.startsWith("/")
        ? `${descriptor.rootPath.replace(/\/$/, "")}/${normalizedFilePath}`
        : normalizedFilePath;
      let openResultIndex = -1;
      for (let index = lspMocks.lspOpenDocument.mock.calls.length - 1; index >= 0; index -= 1) {
        const openedDescriptor = lspMocks.lspOpenDocument.mock.calls[index]?.[0] as typeof descriptor | undefined;
        if (
          openedDescriptor?.workspaceId === descriptor.workspaceId
          && openedDescriptor.rootPath === descriptor.rootPath
          && openedDescriptor.filePath === descriptor.filePath
          && openedDescriptor.documentUri === descriptor.documentUri
        ) {
          openResultIndex = index;
          break;
        }
      }
      const openResult = openResultIndex >= 0
        ? lspMocks.lspOpenDocument.mock.results[openResultIndex]
        : undefined;
      const openedStatus = openResult?.type === "return"
        ? await openResult.value as LspDocumentStatus | undefined
        : undefined;
      return {
        status: openedStatus ?? documentStatus({
          path: absolutePath,
          uri: descriptor.documentUri ?? `file://${absolutePath.startsWith("/") ? "" : "/"}${absolutePath}`,
        }),
        diagnostics: [],
      };
    });
    workspaceMocks.workspaceListDir.mockResolvedValue([]);
    workspaceMocks.workspaceCompactChain.mockResolvedValue({ path: "", entries: [] });
    workspaceMocks.workspaceListFilesRecursive.mockResolvedValue([]);
    workspaceMocks.workspaceDetectGitRoots.mockResolvedValue([]);
    workspaceMocks.workspaceDetectTasks.mockResolvedValue([]);
    gitMocks.gitSnapshot.mockResolvedValue({
      repoRoot: "/repo/app",
      currentBranch: "main",
      headOid: null,
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      changes: [],
      remotes: [],
      branches: [],
      stashes: [],
      tags: [],
      settings: {
        userName: null,
        userEmail: null,
        httpProxy: null,
        httpsProxy: null,
        pullRebase: null,
        pushDefault: null,
        coreAutocrlf: null,
        coreFilemode: null,
        commitGpgsign: null,
      },
    });
    gitMocks.gitIgnorePath.mockResolvedValue({
      rule: "/README.md",
      gitignorePath: "/repo/app/.gitignore",
      added: true,
    });
    gitMocks.gitBlobPair.mockResolvedValue({
      path: "src/main.ts",
      oldPath: null,
      oldText: "",
      newText: null,
      oldExists: true,
      newExists: false,
      binary: false,
      image: false,
      oldImageB64: null,
      newImageB64: null,
      oversize: false,
      oldSize: 0,
      newSize: 0,
    });
    gitMocks.gitBlameLines.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    workspaceActionRegistry.clear();
    globalEditorConfigResolver.clearAll();
    clearGitSnapshotCache();
    clearGitSnapshotInFlight();
  });

  it("mounts project facts for the workspace root and routes status refresh to the store", async () => {
    projectFactsMock.state.status = "loading";
    projectFactsMock.state.reason = "Loading project build facts...";
    projectFactsMock.state.generation = 4;
    descriptorDiscoveryMock.state.status = "descriptor-only";
    descriptorDiscoveryMock.state.discovery = {
      status: "descriptor-only",
      generation: 1,
      descriptors: [{
        path: "/repo/app/pom.xml",
        buildSystem: "maven",
        name: "app",
        root: "/repo/app",
        rawContentSha256: "descriptor-hash",
        inferredExcludedRoots: ["/repo/app/target"],
      }],
      excludedRoots: ["/repo/app/target"],
      diagnostics: [],
    };

    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-project-facts",
      workspaceInstanceId: "instance-project-facts",
      name: "Project Facts",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
    };

    renderWorkspace(workspace);

    expect(await screen.findByTestId("project-facts-status-badge")).toHaveTextContent("Maven Discovered");
    expect(await screen.findByTestId("project-facts-status-badge")).toHaveTextContent("Loading Facts");
    expect(projectFactsMock.useProjectFacts).toHaveBeenCalledWith(
      "/repo/app",
      expect.objectContaining({ autoFetch: true }),
    );
    expect(descriptorDiscoveryMock.useProjectDescriptorDiscovery).toHaveBeenCalledWith(
      "/repo/app",
      { autoRefresh: true },
    );

    fireEvent.click(screen.getByTestId("project-facts-refresh-btn"));
    expect(projectFactsMock.refresh).toHaveBeenCalledTimes(1);
    expect(descriptorDiscoveryMock.refresh).toHaveBeenCalledTimes(1);
  });

  it("keeps the analysis panel mounted when an imported baseline is invalid", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "",
      workspaceId: "ws-invalid-baseline",
      workspaceInstanceId: "instance-invalid-baseline",
      name: "Invalid Baseline",
      roots: [],
      looseFiles: [],
    };
    clipboardMocks.readText.mockResolvedValueOnce("not json");

    renderWorkspace(workspace);

    fireEvent.click(screen.getByTestId("code-workspace-bottom-tab-analysis"));
    expect(await screen.findByTestId("code-workspace-analysis-panel")).toBeVisible();
    fireEvent.click(screen.getByTestId("analysis-baseline-import"));

    await waitFor(() => expect(useAppStore.getState().statusMessage).toBe(
      "Inspection baseline is not valid JSON",
    ));
    expect(screen.getByTestId("analysis-inspection-suppressions")).toBeVisible();
    expect(screen.getByTestId("code-workspace-tab")).toBeVisible();
  });

  it("keeps command registration stable across unrelated parent rerenders", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "",
      workspaceId: "ws-registration",
      workspaceInstanceId: "instance-registration",
      name: "Registration Workspace",
      roots: [],
      looseFiles: [],
    };
    const onCommandsChange = vi.fn();
    const rendered = renderWorkspace(workspace, { onCommandsChange });

    await waitFor(() => {
      expect(onCommandsChange).toHaveBeenCalledWith(
        "tab-code",
        expect.objectContaining({
          items: expect.any(Array),
          snapshot: expect.any(Array),
          executeAction: expect.any(Function),
          execute: expect.any(Function),
        }),
      );
    });

    onCommandsChange.mockClear();
    rendered.rerender(
      <CodeWorkspaceTab
        tabId="tab-code"
        workspace={workspace}
        visible
        onCommandsChange={onCommandsChange}
      />,
    );
    expect(onCommandsChange).not.toHaveBeenCalled();

    rendered.unmount();
    expect(onCommandsChange).toHaveBeenCalledTimes(1);
    expect(onCommandsChange).toHaveBeenCalledWith("tab-code", null);
  });

  it("persists editor intelligence settings per workspace and reloads defaults after rebinding", async () => {
    const first: CodeWorkspaceTabInfo = {
      repoRoot: "",
      workspaceId: "ws-intelligence-settings-a",
      workspaceInstanceId: "instance-intelligence-settings-a",
      name: "Intelligence Settings A",
      roots: [],
      looseFiles: [],
    };
    const second: CodeWorkspaceTabInfo = {
      ...first,
      workspaceId: "ws-intelligence-settings-b",
      workspaceInstanceId: "instance-intelligence-settings-b",
      name: "Intelligence Settings B",
    };
    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });
    const rendered = renderWorkspace(first, { onCommandsChange });
    await screen.findByText("Code · Intelligence Settings A");
    await waitFor(() => expect(
      registrationRef.current?.items.some((item) => item.id === "workspace.intelligenceSettings"),
    ).toBe(true));

    act(() => {
      expect(registrationRef.current?.execute("workspace.intelligenceSettings")).toBe(true);
    });
    await screen.findByTestId("workspace-intelligence-settings-dialog");
    fireEvent.click(screen.getByTestId("workspace-quick-doc-hover-enabled"));
    fireEvent.change(screen.getByTestId("workspace-quick-doc-hover-delay"), {
      target: { value: "825" },
    });
    fireEvent.change(screen.getByTestId("workspace-quick-doc-default-target"), {
      target: { value: "tool-window" },
    });
    fireEvent.click(screen.getByTestId("workspace-parameter-info-auto-popup"));
    fireEvent.change(screen.getByTestId("workspace-parameter-info-delay"), {
      target: { value: "275" },
    });
    fireEvent.click(screen.getByTestId("workspace-intelligence-settings-apply"));

    expect(JSON.parse(
      window.localStorage.getItem(
        "taomni.codeWorkspace.intelligence.v1.instance-intelligence-settings-a",
      ) ?? "null",
    )).toEqual(expect.objectContaining({
      quickDoc: {
        showOnHover: false,
        hoverDelayMs: 825,
        defaultTarget: "tool-window",
      },
      parameterInfo: {
        autoPopup: false,
        delayMs: 275,
        showFullSignatures: false,
      },
    }));
    expect(window.localStorage.getItem(
      "taomni.codeWorkspace.intelligence.v1.instance-intelligence-settings-b",
    )).toBeNull();

    rendered.rerender(
      <CodeWorkspaceTab
        tabId="tab-code"
        workspace={second}
        visible
        onCommandsChange={onCommandsChange}
      />,
    );
    await screen.findByText("Code · Intelligence Settings B");
    await waitFor(() => expect(
      registrationRef.current?.items.some((item) => item.id === "workspace.intelligenceSettings"),
    ).toBe(true));
    act(() => {
      expect(registrationRef.current?.execute("workspace.intelligenceSettings")).toBe(true);
    });

    await screen.findByTestId("workspace-intelligence-settings-dialog");
    expect(screen.getByTestId("workspace-quick-doc-hover-enabled")).toBeChecked();
    expect(screen.getByTestId("workspace-quick-doc-hover-delay")).toHaveValue(300);
    expect(screen.getByTestId("workspace-quick-doc-default-target")).toHaveValue("popup");
    expect(screen.getByTestId("workspace-parameter-info-auto-popup")).toBeChecked();
    expect(screen.getByTestId("workspace-parameter-info-delay")).toHaveValue(0);
  });

  it("settles when the parent stores command registrations in state", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "",
      workspaceId: "ws-registration-feedback",
      workspaceInstanceId: "instance-registration-feedback",
      name: "Registration Feedback Workspace",
      roots: [],
      looseFiles: [],
    };
    let parentRenderCount = 0;

    function RegistrationHost() {
      const renderCount = useRef(0);
      renderCount.current += 1;
      parentRenderCount = Math.max(parentRenderCount, renderCount.current);
      if (renderCount.current > 20) {
        throw new Error("Command registration feedback did not settle");
      }

      const [, setRegistrations] = useState<Record<string, unknown>>({});
      const handleCommandsChange = useCallback<
        NonNullable<ComponentProps<typeof CodeWorkspaceTab>["onCommandsChange"]>
      >((tabId, registration) => {
        setRegistrations((current) => {
          if (registration) {
            return current[tabId] === registration
              ? current
              : { ...current, [tabId]: registration };
          }
          if (!(tabId in current)) return current;
          const next = { ...current };
          delete next[tabId];
          return next;
        });
      }, []);

      return (
        <CodeWorkspaceTab
          tabId="tab-code-feedback"
          workspace={workspace}
          visible
          onCommandsChange={handleCommandsChange}
        />
      );
    }

    render(<RegistrationHost />);

    expect(await screen.findByText("Code · Registration Feedback Workspace")).toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
    });
    expect(parentRenderCount).toBeGreaterThan(1);
    expect(parentRenderCount).toBeLessThan(20);
  });

  it("leaves navigation-bar keyboard state to the mounted breadcrumb surface", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-navigation-bar-keyboard",
      workspaceInstanceId: "instance-navigation-bar-keyboard",
      name: "Navigation Bar Keyboard",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([
      entry("src", "src", "dir"),
      entry("README.md", "README.md"),
    ]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "const value = 1;"));

    const rendered = renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();

    fireEvent.keyDown(content!, { key: "Home", code: "Home", altKey: true });
    const nav = await screen.findByTestId("code-workspace-breadcrumbs");
    await waitFor(() => expect(document.activeElement).toBe(nav));

    fireEvent.keyDown(nav, { key: "Home", code: "Home" });
    expect(nav).toHaveAttribute("aria-activedescendant", "code-workspace-breadcrumb-segment-0");
    fireEvent.keyDown(nav, { key: "Enter", code: "Enter" });

    const popup = await screen.findByTestId("code-workspace-breadcrumb-popup");
    expect(popup).toHaveAttribute("role", "listbox");
    const filter = within(popup).getByRole("combobox");
    fireEvent.keyDown(filter, { key: "Escape", code: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("code-workspace-breadcrumb-popup")).toBeNull());
    expect(document.activeElement).toBe(nav);
  });

  it("opens a multi-root workspace without embedding Language Servers in the tree", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-multi",
      workspaceInstanceId: "instance-multi",
      name: "Multi Repo",
      roots: [
        { id: "app", name: "app", path: "/repo/app", kind: "git" },
        { id: "lib", name: "lib", path: "/repo/lib", kind: "folder" },
      ],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Program.cs" },
    };
    workspaceMocks.workspaceListDir.mockImplementation(async (rootPath: string) => (
      rootPath === "/repo/app"
        ? [entry("src", "src", "dir")]
        : [entry("README.md", "README.md")]
    ));
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/Program.cs", "class Program {}"));
    lspMocks.lspDetectServers.mockResolvedValue([csharpStatus()]);
    lspMocks.lspOpenDocument.mockResolvedValue(documentStatus());

    renderWorkspace(workspace);

    expect(await screen.findByText("Code · Multi Repo")).toBeInTheDocument();
    expect(screen.getByText("2 roots")).toBeInTheDocument();
    expect(screen.getAllByText("app").length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("lib").length).toBeGreaterThanOrEqual(1);
    // Language Servers UI moved to Settings — tree should stay free of it.
    expect(screen.queryByText("Language Servers")).toBeNull();
    expect(screen.queryByText("dotnet tool install -g csharp-ls")).toBeNull();

    await waitFor(() => {
      expect(lspMocks.lspOpenDocument).toHaveBeenCalledWith(
        {
          workspaceId: "instance-multi",
          rootPath: "/repo/app",
          filePath: "src/Program.cs",
          documentUri: null,
          serverCommandId: null,
          customServerCommand: null,
          javaHome: null,
        },
        "class Program {}",
        1,
      );
    });
  });

  it("offers a settings link when opening a file without an active language server", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-lsp-settings",
      name: "LSP Settings",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Program.cs" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/Program.cs", "class Program {}"));
    lspMocks.lspDetectServers.mockResolvedValue([csharpStatus()]);
    lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({ error: "csharp-ls failed to start" }));

    renderWorkspace(workspace);

    await screen.findByTitle("app / src/Program.cs");
    await waitFor(() => expect(lspMocks.lspOpenDocument).toHaveBeenCalled(), { timeout: 3_000 });

    const banner = await screen.findByTestId("code-workspace-banner-lsp-error:root:app:src/Program.cs:csharp");
    expect(banner).toHaveTextContent("Language Server Degraded");
    expect(banner).toHaveTextContent("csharp-ls failed to start");
    fireEvent.click(screen.getByTestId("banner-action-open-settings"));
    expect(settingsNavigationMocks.openSettingsSection).toHaveBeenCalledTimes(1);
    expect(settingsNavigationMocks.openSettingsSection).toHaveBeenCalledWith("language-servers", {
      presetId: "csharp",
    });

    const link = await screen.findByTestId("code-workspace-lsp-open-settings");
    expect(link).toBeInTheDocument();
    fireEvent.click(link);
    expect(settingsNavigationMocks.openSettingsSection).toHaveBeenCalledWith("language-servers", {
      presetId: "csharp",
    });
  });

  it("renders Mermaid diagrams in markdown preview with SVG and PNG export controls", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "",
      workspaceId: "ws-md",
      name: "Editor Workspace",
      roots: [],
      looseFiles: [{ id: "readme", name: "README.md", path: "/tmp/README.md" }],
      initialFile: { kind: "loose", id: "readme", path: "/tmp/README.md" },
    };
    workspaceMocks.workspaceReadLooseFile.mockResolvedValue(file(
      "/tmp/README.md",
      [
        "# Diagram",
        "",
        "```mermaid",
        "graph TD",
        "  A-->B",
        "```",
      ].join("\n"),
    ));

    renderWorkspace(workspace);

    await waitFor(() => expect(screen.getAllByText("README.md").length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "Preview" }));

    await waitFor(() => {
      const preview = screen.getByTestId("code-workspace-markdown-preview");
      expect(within(preview).getByText("Diagram")).toBeInTheDocument();
      expect(within(preview).getByText("Mermaid 1")).toBeInTheDocument();
      expect(within(preview).getByRole("button", { name: "SVG" })).toBeInTheDocument();
      expect(within(preview).getByRole("button", { name: "PNG" })).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(mermaid.render).toHaveBeenCalledWith(
        expect.stringContaining("taomni-mermaid-"),
        expect.stringContaining("graph TD"),
      );
    });
  });

  it("keeps file tree zoom separate from editor zoom", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-appearance",
      name: "Appearance",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "export const answer = 42;"));

    renderWorkspace(workspace);

    expect(await screen.findByText("Code · Appearance")).toBeInTheDocument();

    // The tree's font size must be bound to the zoom variable (not just row
    // height), so zooming the left pane actually resizes its text.
    expect(screen.getByTestId("code-workspace-tree").style.fontSize).toBe(
      "var(--taomni-code-tree-font-size)",
    );

    fireEvent.click(screen.getByTestId("code-workspace-tree-zoom-in"));
    expect(window.localStorage.getItem("taomni.codeWorkspace.treeFontSize.v1")).toBe("13");
    expect(screen.getByTestId("code-workspace-tree-pane").style.getPropertyValue("--taomni-code-tree-font-size")).toBe("13px");
    expect(window.localStorage.getItem("taomni.codeViewProfile.v1")).toBeNull();

    const appearanceKey = editorAppearanceProfileStorageKey("ws-appearance");
    fireEvent.click(screen.getByTestId("code-workspace-zoom-in"));
    let saved = JSON.parse(window.localStorage.getItem(appearanceKey) ?? "{}");
    expect(saved.profile.fontSizePx).toBe(14);
    expect(document.documentElement.style.getPropertyValue("--taomni-code-font-size")).toBe("");
    expect(window.localStorage.getItem("taomni.codeViewProfile.v1")).toBeNull();
    expect(window.localStorage.getItem("taomni.codeWorkspace.treeFontSize.v1")).toBe("13");

    fireEvent.wheel(screen.getByTestId("code-workspace-tree-pane"), { ctrlKey: true, deltaY: -100 });
    expect(window.localStorage.getItem("taomni.codeWorkspace.treeFontSize.v1")).toBe("14");
    saved = JSON.parse(window.localStorage.getItem(appearanceKey) ?? "{}");
    expect(saved.profile.fontSizePx).toBe(14);

    fireEvent.wheel(screen.getByTestId("code-workspace-editor-pane"), { ctrlKey: true, deltaY: -100 });
    saved = JSON.parse(window.localStorage.getItem(appearanceKey) ?? "{}");
    expect(saved.profile.fontSizePx).toBe(15);
    expect(window.localStorage.getItem("taomni.codeWorkspace.treeFontSize.v1")).toBe("14");

    fireEvent.click(screen.getByTestId("code-workspace-zoom-out"));
    saved = JSON.parse(window.localStorage.getItem(appearanceKey) ?? "{}");
    expect(saved.profile.fontSizePx).toBe(14);

    fireEvent.click(screen.getByTestId("code-workspace-tree-zoom-out"));
    expect(window.localStorage.getItem("taomni.codeWorkspace.treeFontSize.v1")).toBe("13");
  });

  it("persists and renders the flat file view with language src groups only", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-flat",
      name: "Flat",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: null,
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
    workspaceMocks.workspaceListFilesRecursive.mockResolvedValue([
      entry("README.md", "README.md"),
      entry("App.tsx", "src/App.tsx"),
      entry("lib.rs", "src-tauri/src/lib.rs"),
      entry("guide.md", "docs/guide.md"),
      entry("foo.rs", "target/debug/foo.rs"),
    ]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/App.tsx", "export function App() {}"));

    renderWorkspace(workspace);

    expect(await screen.findByText("Code · Flat")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("code-workspace-view-flat"));

    expect(window.localStorage.getItem("taomni.codeWorkspace.treeViewMode.v1")).toBe("flat");
    expect(await screen.findByText("src")).toBeInTheDocument();
    expect(await screen.findByText("src-tauri/src")).toBeInTheDocument();
    expect(screen.queryByText("README.md")).not.toBeInTheDocument();
    expect(screen.queryByText("guide.md")).not.toBeInTheDocument();
    expect(screen.queryByText("(root)")).not.toBeInTheDocument();
    expect(screen.getAllByTestId("code-workspace-flat-file")).toHaveLength(2);
    expect(screen.getByText("App.tsx")).toBeInTheDocument();
    expect(screen.getByText("lib.rs")).toBeInTheDocument();

    fireEvent.click(screen.getByText("App.tsx"));
    await waitFor(() => {
      expect(workspaceMocks.workspaceReadFile).toHaveBeenCalledWith("/repo/app", "src/App.tsx");
    });
  });

  it("opens successive tree files as permanent tabs without closing the previous one", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-tabs",
      workspaceInstanceId: "instance-tabs",
      name: "Tabs",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: null,
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([
      entry("main.ts", "src/main.ts"),
      entry("util.ts", "src/util.ts"),
    ]);
    workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => (
      file(path, path === "src/main.ts" ? "export const main = 1;" : "export const util = 2;")
    ));

    renderWorkspace(workspace);
    expect(await screen.findByText("Code · Tabs")).toBeInTheDocument();

    const rows = await screen.findAllByTestId("code-workspace-tree-file");
    fireEvent.click(rows[0]);
    await waitFor(() => {
      expect(workspaceMocks.workspaceReadFile).toHaveBeenCalledWith("/repo/app", "src/main.ts");
    });
    fireEvent.click(rows[1]);
    await waitFor(() => {
      expect(workspaceMocks.workspaceReadFile).toHaveBeenCalledWith("/repo/app", "src/util.ts");
    });

    await waitFor(() => {
      const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-tabs");
      expect(ui.editorGroups.primary.openOrder).toEqual([
        "root:app:src/main.ts",
        "root:app:src/util.ts",
      ]);
      expect(ui.editorGroups.primary.activeKey).toBe("root:app:src/util.ts");
      expect(ui.editorGroups.primary.previewKey).toBeNull();
    });
    expect(screen.getByTitle("app / src/main.ts")).toBeInTheDocument();
    expect(screen.getByTitle("app / src/util.ts")).toBeInTheDocument();
  });

  it("renders compact directory chains and expands the endpoint", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-compact",
      name: "Compact",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: null,
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
    workspaceMocks.workspaceCompactChain.mockResolvedValue({
      path: "src/main/java/com/example",
      entries: [entry("UserService.java", "src/main/java/com/example/UserService.java")],
    });
    workspaceMocks.workspaceReadFile.mockResolvedValue(file(
      "src/main/java/com/example/UserService.java",
      "class UserService {}",
    ));

    renderWorkspace(workspace);

    expect(await screen.findByText("Code · Compact")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("code-workspace-view-compact"));

    const compactDir = await screen.findByText("src/main/java/com/example");
    fireEvent.click(compactDir);
    expect(await screen.findByText("UserService.java")).toBeInTheDocument();

    fireEvent.click(screen.getByText("UserService.java"));
    await waitFor(() => {
      expect(workspaceMocks.workspaceReadFile).toHaveBeenCalledWith(
        "/repo/app",
        "src/main/java/com/example/UserService.java",
      );
    });
  });

  it("detects git roots, decorates file changes, and opens the Git tab from the toolbar", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-git",
      name: "Git",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/App.tsx" },
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("App.tsx", "src/App.tsx")]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/App.tsx", "export function App() {}"));
    workspaceMocks.workspaceDetectGitRoots.mockResolvedValue([
      {
        id: "app",
        name: "app",
        path: "/repo/app",
        repoRoot: "/repo/app",
        rootIds: ["app"],
      },
    ]);
    gitMocks.gitSnapshot.mockResolvedValue({
      repoRoot: "/repo/app",
      currentBranch: "main",
      headOid: null,
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      changes: [
        {
          path: "src/App.tsx",
          oldPath: null,
          status: "modified",
          staged: false,
          unstaged: true,
          conflict: false,
        },
      ],
      remotes: [],
      branches: [],
      stashes: [],
      tags: [],
      settings: {
        userName: null,
        userEmail: null,
        httpProxy: null,
        httpsProxy: null,
        pullRebase: null,
        pushDefault: null,
        coreAutocrlf: null,
        coreFilemode: null,
        commitGpgsign: null,
      },
    });

    const onOpenGitManager = vi.fn();
    renderWorkspace(workspace, { onOpenGitManager });

    expect(await screen.findByText("Code · Git")).toBeInTheDocument();
    await waitFor(() => {
      expect(workspaceMocks.workspaceDetectGitRoots).toHaveBeenCalledWith([
        { id: "app", name: "app", path: "/repo/app" },
      ]);
      expect(gitMocks.gitSnapshot).toHaveBeenCalledWith("/repo/app");
    });
    expect(await screen.findByTestId("code-workspace-git-status")).toHaveTextContent("M");
    expect(screen.queryByTestId("code-workspace-git-manager-open")).not.toBeInTheDocument();
    expect(screen.queryByTestId("workspace-git-container")).not.toBeInTheDocument();

    await waitFor(() => expect(screen.getByTestId("code-workspace-git-panel-toggle")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("code-workspace-git-panel-toggle"));

    expect(onOpenGitManager).toHaveBeenCalledWith({
      workspaceName: "Git",
      workspaceInstanceId: "ws-git",
      workspaceId: "ws-git",
      roots: [
        {
          id: "app",
          name: "app",
          path: "/repo/app",
          repoRoot: "/repo/app",
          rootIds: ["app"],
        },
      ],
      activeRepoRoot: "/repo/app",
    });
  });

  it("shows Git gutter diffs and opt-in inline blame for the active line", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-git-editor",
      workspaceInstanceId: "instance-git-editor",
      name: "Git Editor",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "const value = 1;"));
    workspaceMocks.workspaceDetectGitRoots.mockResolvedValue([{
      id: "app",
      name: "app",
      path: "/repo/app",
      repoRoot: "/repo/app",
      rootIds: ["app"],
    }]);
    gitMocks.gitSnapshot.mockResolvedValue({
      repoRoot: "/repo/app",
      currentBranch: "main",
      headOid: "0123456789abcdef",
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      changes: [],
      remotes: [],
      branches: [],
      stashes: [],
      tags: [],
      settings: {
        userName: null,
        userEmail: null,
        httpProxy: null,
        httpsProxy: null,
        pullRebase: null,
        pushDefault: null,
        coreAutocrlf: null,
        coreFilemode: null,
        commitGpgsign: null,
      },
    });
    gitMocks.gitBlobPair.mockResolvedValue({
      path: "src/main.ts",
      oldPath: null,
      oldText: "const previous = 1;",
      newText: null,
      oldExists: true,
      newExists: false,
      binary: false,
      image: false,
      oldImageB64: null,
      newImageB64: null,
      oversize: false,
      oldSize: 19,
      newSize: 0,
    });
    gitMocks.gitBlameLines.mockResolvedValue([{
      line: 1,
      commit: "0123456789abcdef",
      author: "Ada",
      authorMail: "ada@example.test",
      authorTime: Math.floor(Date.now() / 1000) - 3_600,
      summary: "feat: seed main",
    }]);

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(gitMocks.gitBlobPair).toHaveBeenCalledWith(
      "/repo/app",
      "src/main.ts",
      "HEAD",
      "",
    ));
    const marker = await screen.findByLabelText("modified Git change · show diff", {}, { timeout: 5_000 });
    fireEvent.mouseDown(marker);
    expect(screen.getByTestId("code-workspace-git-diff-peek")).toHaveTextContent("previous");
    expect(screen.getByTestId("code-workspace-git-diff-peek")).toHaveTextContent("value");

    const blameToggle = screen.getByTestId("code-workspace-inline-blame-toggle");
    expect(blameToggle).not.toBeDisabled();
    fireEvent.click(blameToggle);
    await waitFor(() => expect(gitMocks.gitBlameLines).toHaveBeenCalledWith("/repo/app", "src/main.ts", 1, 1));
    expect(await screen.findByText(/Ada, .* · feat: seed main/)).toBeInTheDocument();
  });

  it("selects the child repository that owns the active file inside a plain workspace root", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/workspace",
      workspaceId: "ws-child-git",
      name: "Child Repos",
      roots: [{ id: "workspace", name: "workspace", path: "/workspace", kind: "folder" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "workspace", path: "service/src/api.ts" },
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("api.ts", "service/src/api.ts")]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("service/src/api.ts", "export const api = true;"));
    workspaceMocks.workspaceDetectGitRoots.mockResolvedValue([
      {
        id: "workspace:/workspace/app",
        name: "app",
        path: "/workspace",
        repoRoot: "/workspace/app",
        rootIds: ["workspace"],
      },
      {
        id: "workspace:/workspace/service",
        name: "service",
        path: "/workspace",
        repoRoot: "/workspace/service",
        rootIds: ["workspace"],
      },
    ]);
    gitMocks.gitSnapshot.mockImplementation(async (repoRoot: string) => ({
      repoRoot,
      currentBranch: "main",
      headOid: null,
      detached: false,
      upstream: null,
      ahead: 0,
      behind: 0,
      changes: repoRoot === "/workspace/service"
        ? [
          {
            path: "src/api.ts",
            oldPath: null,
            status: "modified",
            staged: false,
            unstaged: true,
            conflict: false,
          },
        ]
        : [
          {
            path: "src/App.tsx",
            oldPath: null,
            status: "modified",
            staged: false,
            unstaged: true,
            conflict: false,
          },
        ],
      remotes: [],
      branches: [],
      stashes: [],
      tags: [],
      settings: {
        userName: null,
        userEmail: null,
        httpProxy: null,
        httpsProxy: null,
        pullRebase: null,
        pushDefault: null,
        coreAutocrlf: null,
        coreFilemode: null,
        commitGpgsign: null,
      },
    }));

    const onOpenGitManager = vi.fn();
    renderWorkspace(workspace, { onOpenGitManager });

    expect(await screen.findByText("Code · Child Repos")).toBeInTheDocument();
    await waitFor(() => expect(gitMocks.gitSnapshot).toHaveBeenCalledWith("/workspace/service"));
    expect(await screen.findByTestId("code-workspace-git-status")).toHaveTextContent("M");

    await waitFor(() => expect(screen.getByTestId("code-workspace-git-panel-toggle")).not.toBeDisabled());
    fireEvent.click(screen.getByTestId("code-workspace-git-panel-toggle"));

    expect(onOpenGitManager).toHaveBeenCalledWith({
      workspaceName: "Child Repos",
      workspaceInstanceId: "ws-child-git",
      workspaceId: "ws-child-git",
      roots: [
        {
          id: "workspace:/workspace/app",
          name: "app",
          path: "/workspace",
          repoRoot: "/workspace/app",
          rootIds: ["workspace"],
        },
        {
          id: "workspace:/workspace/service",
          name: "service",
          path: "/workspace",
          repoRoot: "/workspace/service",
          rootIds: ["workspace"],
        },
      ],
      activeRepoRoot: "/workspace/service",
    });
  });

  it("keeps workspace editor appearance isolated from the global code-view profile", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-theme-follow",
      name: "Theme",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "export const answer = 42;"));
    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });

    renderWorkspace(workspace, { onCommandsChange });

    expect(await screen.findByText("Code · Theme")).toBeInTheDocument();
    // The workspace no longer owns a theme selector; theme is set in Settings.
    expect(screen.queryByTestId("code-workspace-theme-select")).toBeNull();

    // Global Code View changes no longer mutate the Code Workspace editor.
    act(() => {
      saveCodeViewProfile({ ...DEFAULT_CODE_VIEW_PROFILE, theme: "kanagawa-wave" });
    });
    expect(document.documentElement.style.getPropertyValue("--taomni-code-bg")).toBe("");

    writeEditorAppearanceProfile("ws-theme-follow", {
      fontFamily: DEFAULT_CODE_VIEW_PROFILE.fontFamily,
      fontSizePx: 13,
      lineHeight: 1.5,
      ligatures: true,
      colorSchemeId: "dracula",
      highContrast: false,
      zoomScope: "all-editors",
      highlighting: "all-problems",
      softWrap: { patterns: [], useOriginalIndent: true, additionalIndent: 0, showMarkers: false },
      virtualSpace: { afterLineEnd: false, atFileBottom: false },
      breadcrumbs: { visible: true, placement: "top", languages: ["*"] },
      clipboard: { historyEnabled: true, historyMaxItems: 30, historyMaxTotalBytes: 1024 * 1024 },
    });
    await waitFor(() => expect(
      registrationRef.current?.items.some((item) => item.id === "workspace.editorAppearanceSettings"),
    ).toBe(true));
    act(() => {
      expect(registrationRef.current?.execute("workspace.editorAppearanceSettings")).toBe(true);
    });
    expect(await screen.findByTestId("workspace-editor-appearance-settings-dialog")).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("workspace-editor-appearance-color-scheme-id"), {
      target: { value: "dracula" },
    });
    fireEvent.click(screen.getByTestId("workspace-editor-appearance-apply"));
    await waitFor(() => {
      expect(document.querySelector(".cm-content")).toHaveAttribute(
        "data-editor-color-scheme",
        "dracula",
      );
    });
  });

  it("mirrors active files, loose files, and diagnostics into agent workspace context", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-context",
      name: "Context",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Program.cs" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/Program.cs", "class Program {}"));
    lspMocks.lspDetectServers.mockResolvedValue([csharpStatus({ available: true, active: true })]);
    lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({
      active: true,
      available: true,
      selectedCommand: "csharp-ls",
      installHint: null,
    }));
    lspMocks.lspGetDiagnostics.mockResolvedValue({
      status: documentStatus({
        active: true,
        available: true,
        selectedCommand: "csharp-ls",
        installHint: null,
      }),
      diagnostics: [
        {
          range: {
            start: { line: 0, character: 6 },
            end: { line: 0, character: 13 },
          },
          severity: 1,
          code: "CS1001",
          source: "csharp-ls",
          message: "Identifier expected",
        },
      ],
    });

    renderWorkspace(workspace);

    await screen.findByTitle("app / src/Program.cs");
    await waitFor(() => expect(lspMocks.lspOpenDocument).toHaveBeenCalled(), { timeout: 3_000 });
    await waitFor(() => expect(lspMocks.lspGetDiagnostics).toHaveBeenCalled(), { timeout: 3_000 });
    await waitFor(() => {
      const context = useAppStore.getState().codeWorkspaceByTab["tab-code"];
      expect(context).toMatchObject({
        repoRoot: "/repo/app",
        activePath: "src/Program.cs",
        openPaths: ["src/Program.cs"],
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        activeFile: {
          kind: "root",
          rootId: "app",
          rootName: "app",
          rootPath: "/repo/app",
          path: "src/Program.cs",
        },
        lsp: {
          activeStatus: {
            displayName: "C#",
            languageId: "csharp",
            active: true,
            available: true,
            selectedCommand: "csharp-ls",
          },
          diagnostics: [
            {
              file: {
                kind: "root",
                rootId: "app",
                rootName: "app",
                rootPath: "/repo/app",
                path: "src/Program.cs",
              },
              errorCount: 1,
              warningCount: 0,
              infoCount: 0,
              messages: ["Identifier expected"],
            },
          ],
        },
      });
    });

    fireEvent.click(screen.getByRole("tab", { name: /Problems/ }));
    expect(await screen.findByText("Identifier expected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Show error diagnostics" })).toHaveTextContent("1");
  });

  it("tracks navigation history and reopens recent files from Ctrl+E", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-nav",
      workspaceInstanceId: "instance-nav",
      name: "Nav",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([
      entry("a.ts", "a.ts"),
      entry("b.ts", "b.ts"),
    ]);
    workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) =>
      file(path, `// ${path}`));

    renderWorkspace(workspace);

    const treeFiles = await screen.findAllByTestId("code-workspace-tree-file");
    fireEvent.click(treeFiles[0]);
    await screen.findByTitle("app / a.ts");
    fireEvent.click(treeFiles[1]);
    await screen.findByTitle("app / b.ts");
    await waitFor(() =>
      expect(screen.getByTitle("app / b.ts").closest("div")).toHaveAttribute("data-active"));

    fireEvent.click(screen.getByTestId("code-workspace-nav-back"));
    await waitFor(() =>
      expect(screen.getByTitle("app / a.ts").closest("div")).toHaveAttribute("data-active"));
    expect(screen.getByTestId("code-workspace-nav-back")).toBeDisabled();

    fireEvent.click(screen.getByTestId("code-workspace-nav-forward"));
    await waitFor(() =>
      expect(screen.getByTitle("app / b.ts").closest("div")).toHaveAttribute("data-active"));
    expect(screen.getByTestId("code-workspace-nav-forward")).toBeDisabled();

    // Ctrl+E preselects the previously active file; Enter flips back to it.
    fireEvent.keyDown(window, { key: "e", ctrlKey: true });
    const popup = await screen.findByTestId("code-workspace-recent-files");
    expect(within(popup).getAllByRole("button")[0]).toHaveTextContent("b.ts");
    fireEvent.keyDown(screen.getByLabelText("Recent files"), { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByTitle("app / a.ts").closest("div")).toHaveAttribute("data-active"));
    expect(screen.queryByTestId("code-workspace-recent-files")).not.toBeInTheDocument();
  });

  it("resolves URI-only workspace symbols before opening their source range", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-symbol-resolve",
      workspaceInstanceId: "instance-symbol-resolve",
      name: "Symbol Resolve",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const capabilities = {
      completion: false,
      signatureHelp: false,
      hover: false,
      definition: false,
      typeDefinition: false,
      implementation: false,
      references: false,
      documentSymbol: false,
      workspaceSymbol: true,
      workspaceSymbolResolve: true,
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
    };
    const activeStatus = documentStatus({ available: true, active: true, capabilities });
    const lifecycle: string[] = [];
    workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => {
      if (path === "src/target.ts") lifecycle.push("read-target");
      return file(path, path === "src/target.ts" ? "\n".repeat(8) + "class DeferredType {}" : "const main = true;");
    });
    lspMocks.lspOpenDocument.mockResolvedValue(activeStatus);
    lspMocks.lspChangeDocument.mockResolvedValue(activeStatus);
    lspMocks.lspGetDiagnostics.mockResolvedValue({ status: activeStatus, diagnostics: [] });
    lspMocks.lspWorkspaceSymbols.mockResolvedValue({
      status: activeStatus,
      symbols: [{
        name: "DeferredType",
        kind: 5,
        containerName: "editor",
        uri: "file:///repo/app/src/target.ts",
        path: "/repo/app/src/target.ts",
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
        selectionRange: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
        resolved: false,
        resolveToken: "0123456789abcdef0123456789abcdef:0",
      }, {
        name: "BrokenType",
        kind: 5,
        containerName: "editor",
        uri: "file:///repo/app/src/broken.ts",
        path: "/repo/app/src/broken.ts",
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
        selectionRange: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 0 },
        },
        resolved: false,
        resolveToken: null,
      }],
      sessionCount: 1,
      providerCount: 1,
      skippedProviderCount: 0,
      failedProviderCount: 0,
      complete: true,
      truncated: false,
      diagnostics: [],
    });
    lspMocks.lspWorkspaceSymbolResolve.mockImplementation(async () => {
      lifecycle.push("resolve");
      return {
        name: "DeferredType",
        kind: 5,
        containerName: "editor",
        uri: "file:///repo/app/src/target.ts",
        path: "/repo/app/src/target.ts",
        range: {
          start: { line: 8, character: 0 },
          end: { line: 8, character: 21 },
        },
        selectionRange: {
          start: { line: 8, character: 6 },
          end: { line: 8, character: 18 },
        },
        resolved: true,
        resolveToken: null,
      };
    });
    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      registrationRef.current = next;
    });

    renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => {
      expect(registrationRef.current?.items.find((item) => item.id === "workspace.goToSymbol")?.enabled)
        .toBe(true);
    });
    act(() => {
      expect(registrationRef.current?.execute("workspace.goToSymbol")).toBe(true);
    });
    const input = await screen.findByLabelText("Go to symbol");
    fireEvent.change(input, { target: { value: "Deferred" } });
    expect(await screen.findByText("DeferredType")).toBeInTheDocument();
    expect(screen.queryByText("editor · /repo/app/src/target.ts:1")).not.toBeInTheDocument();

    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(lspMocks.lspWorkspaceSymbolResolve).toHaveBeenCalledWith(
      "instance-symbol-resolve",
      "0123456789abcdef0123456789abcdef:0",
    ));
    expect(await screen.findByTitle("app / src/target.ts")).toBeInTheDocument();
    expect(lifecycle).toEqual(["resolve", "read-target"]);
    expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-symbol-resolve",
    ).splitOrientation).toBe("vertical");

    act(() => {
      expect(registrationRef.current?.execute("workspace.goToSymbol")).toBe(true);
    });
    const brokenInput = await screen.findByLabelText("Go to symbol");
    fireEvent.change(brokenInput, { target: { value: "Broken" } });
    expect(await screen.findByText("BrokenType")).toBeInTheDocument();
    fireEvent.keyDown(brokenInput, { key: "Enter" });
    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
      "did not provide a source location",
    ));
    expect(lspMocks.lspWorkspaceSymbolResolve).toHaveBeenCalledTimes(1);
    expect(screen.queryByTitle("app / src/broken.ts")).not.toBeInTheDocument();
  });

  it("opens the file structure popup with Ctrl+F12 and jumps to a symbol", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-structure",
      workspaceInstanceId: "instance-structure",
      name: "Structure",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "a.ts" },
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("a.ts", "a.ts")]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("a.ts", "const x = 1;"));
    lspMocks.lspDocumentSymbols.mockResolvedValue({
      status: documentStatus({ active: true, available: true }),
      symbols: [
        {
          name: "openFile",
          detail: "(path: string) => Promise<void>",
          kind: 12,
          depth: 0,
          range: { start: { line: 13, character: 0 }, end: { line: 16, character: 1 } },
          selectionRange: { start: { line: 13, character: 8 }, end: { line: 13, character: 16 } },
        },
      ],
    });

    renderWorkspace(workspace);
    await screen.findByTitle("app / a.ts");
    // The tab strip renders while the file is still loading; wait for the
    // loaded file header (size text) before invoking the structure popup.
    await screen.findByText("12 B");

    fireEvent.keyDown(window, { key: "F12", ctrlKey: true });
    const popup = await screen.findByTestId("code-workspace-structure-popup");
    expect(await within(popup).findByText("openFile")).toBeInTheDocument();
    expect(lspMocks.lspDocumentSymbols).toHaveBeenCalled();

    fireEvent.keyDown(screen.getByLabelText("File structure"), { key: "Enter" });
    expect(screen.queryByTestId("code-workspace-structure-popup")).not.toBeInTheDocument();
  });

  it("opens the persistent Outline pane and follows document symbols", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-outline",
      workspaceInstanceId: "instance-outline",
      name: "Outline",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const capabilities = {
      completion: false,
      signatureHelp: false,
      hover: false,
      definition: false,
      typeDefinition: false,
      implementation: false,
      references: false,
      documentSymbol: true,
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
    };
    const status = documentStatus({ available: true, active: true, capabilities });
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "function render() {}"));
    lspMocks.lspOpenDocument.mockResolvedValue(status);
    lspMocks.lspChangeDocument.mockResolvedValue(status);
    lspMocks.lspGetDiagnostics.mockResolvedValue({ status, diagnostics: [] });
    lspMocks.lspDocumentSymbols.mockResolvedValue({
      status,
      symbols: [{
        name: "render",
        detail: "() => void",
        kind: 12,
        depth: 0,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 20 } },
        selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 15 } },
      }],
    });

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(lspMocks.lspDocumentSymbols).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("code-workspace-right-pane-toggle"));

    expect(screen.getByRole("tab", { name: "Outline", selected: true })).toBeInTheDocument();
    const outline = await screen.findByTestId("code-workspace-outline-pane");
    expect(outline).toHaveTextContent("render");
    fireEvent.click(within(outline).getByText("render"));
  });

  it("opens quick documentation with Ctrl+Q, navigates to its exact source, and pins it", async () => {
    const { EditorView } = await import("@codemirror/view");
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-qdoc",
      workspaceInstanceId: "instance-qdoc",
      name: "QuickDoc",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "openFile(path)"));
    const status = documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      available: true,
      active: true,
    });
    lspMocks.lspOpenDocument.mockResolvedValue(status);
    lspMocks.lspHover.mockResolvedValue({
      status,
      contents: "**Opens** a workspace file.",
      range: {
        start: { line: 0, character: 9 },
        end: { line: 0, character: 13 },
      },
    });

    const rendered = renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(lspMocks.lspOpenDocument).toHaveBeenCalled());
    const editorContent = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(editorContent).not.toBeNull();
    const view = EditorView.findFromDOM(editorContent!);
    expect(view).not.toBeNull();

    fireEvent.keyDown(window, { key: "q", ctrlKey: true });
    const popup = await screen.findByTestId("code-workspace-quick-doc");
    expect(popup).toHaveTextContent("Opens");
    expect(lspMocks.lspHover).toHaveBeenCalled();

    fireEvent.click(within(popup).getByRole("button", { name: "Source" }));
    await waitFor(() => expect(view!.state.selection.main.head).toBe(9));

    fireEvent.keyDown(window, { key: "q", ctrlKey: true });
    await screen.findByTestId("code-workspace-quick-doc");
    fireEvent.click(screen.getByTestId("code-workspace-quick-doc-pin"));
    expect(screen.queryByTestId("code-workspace-quick-doc")).not.toBeInTheDocument();
    expect(screen.getByTestId("code-workspace-right-pane")).toBeInTheDocument();
    expect(screen.getByTestId("code-workspace-documentation-pane")).toHaveTextContent("Opens");
  });

  it("routes explicit QuickDoc to the unlocked Documentation pane when configured", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-qdoc-tool-window",
      workspaceInstanceId: "instance-qdoc-tool-window",
      name: "QuickDoc tool window",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    window.localStorage.setItem(
      "taomni.codeWorkspace.intelligence.v1.instance-qdoc-tool-window",
      JSON.stringify({ quickDoc: { defaultTarget: "tool-window" } }),
    );
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "openFile(path)"));
    const status = documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      available: true,
      active: true,
    });
    lspMocks.lspOpenDocument.mockResolvedValue(status);
    lspMocks.lspHover.mockResolvedValue({
      status,
      contents: "**Opens** a workspace file.",
      range: {
        start: { line: 0, character: 0 },
        end: { line: 0, character: 8 },
      },
    });

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(lspMocks.lspOpenDocument).toHaveBeenCalled());
    fireEvent.keyDown(window, { key: "q", ctrlKey: true });

    const pane = await screen.findByTestId("code-workspace-documentation-pane");
    expect(pane).toHaveTextContent("Opens");
    expect(screen.getByRole("tab", { name: "Documentation", selected: true })).toBeInTheDocument();
    expect(screen.queryByTestId("code-workspace-quick-doc")).not.toBeInTheDocument();
    expect(within(pane).queryByLabelText("Pinned")).not.toBeInTheDocument();
    expect(within(pane).queryByRole("button", { name: "Unpin documentation" })).not.toBeInTheDocument();
  });

  it("requests code actions on Alt+Enter and applies workspace edits", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-actions",
      workspaceInstanceId: "instance-actions",
      name: "Actions",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "x=1"));
    workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
      _rootPath: string,
      path: string,
      text: string,
    ) => writeAck(file(path, text, { hash: `hash-${text}` })));
    lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({
      path: "/repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities: {
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
        codeAction: true,
        documentHighlight: false,
        callHierarchy: false,
        typeHierarchy: false,
        inlayHint: false,
        selectionRange: false,
      semanticTokens: false,
        completionTriggerCharacters: [],
        signatureTriggerCharacters: [],
      },
    }));
    lspMocks.lspCodeActions.mockResolvedValue({
      status: documentStatus({ available: true, active: true }),
      actions: [{
        title: "Insert space",
        kind: "quickfix",
        isPreferred: true,
        edit: null,
        command: null,
        commandArguments: null,
        raw: {
          title: "Insert space",
          kind: "quickfix",
          data: { fixId: "space" },
        },
      }],
    });
    lspMocks.lspCodeActionResolve.mockResolvedValue({
      status: documentStatus({ available: true, active: true }),
      action: {
        title: "Insert space",
        kind: "quickfix",
        isPreferred: true,
        edit: {
          documentEdits: [{
            uri: "file:///repo/app/src/main.ts",
            path: "/repo/app/src/main.ts",
            edits: [{
              range: {
                start: { line: 0, character: 1 },
                end: { line: 0, character: 1 },
              },
              newText: " ",
            }],
          }],
        },
        command: null,
        commandArguments: null,
        raw: { title: "Insert space", data: { fixId: "space" } },
      },
    });

    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });
    renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    await waitFor(() => expect(lspMocks.lspCodeActions).toHaveBeenCalled());
    fireEvent.click(await screen.findByRole("button", { name: "Insert space" }));
    await waitFor(() => expect(lspMocks.lspCodeActionResolve).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ data: { fixId: "space" } }),
    ));
    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-actions",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("x =1"));
    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("undo transaction"));

    // ED-AUDIT-008: with editor focus the journal action yields the stroke to
    // the shared document undo (which claims the journal), so the journal
    // action itself stays disabled in the snapshot even though the transaction
    // is undoable; a non-editor stroke (window target) still reaches it.
    await waitFor(() => expect(
      registrationRef.current?.items.find((item) => item.id === "workspace.undoWorkspaceEdit")?.enabled,
    ).toBe(false));
    await act(async () => {
      fireEvent.keyDown(window, { key: "z", ctrlKey: true });
    });
    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-actions",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("x=1"));

    await act(async () => {
      fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
    });
    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-actions",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("x =1"));
  });

  // ED-AUDIT-008 A1/A3: after an intention apply, Ctrl+Z on the editor
  // surface must run the journal undo — one history unit with its verified
  // restore — instead of colliding with the document ledger, and a follow-up
  // Ctrl+Z must not re-apply the change the journal just undid.
  it("undoes an applied code action through the journal with Ctrl+Z on the editor surface", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-actions-undo",
      workspaceInstanceId: "instance-actions-undo",
      name: "Actions",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "x=1"));
    workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
      _rootPath: string,
      path: string,
      text: string,
    ) => writeAck(file(path, text, { hash: `hash-${text}` })));
    lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({
      path: "/repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities: {
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
        codeAction: true,
        documentHighlight: false,
        callHierarchy: false,
        typeHierarchy: false,
        inlayHint: false,
        selectionRange: false,
        semanticTokens: false,
        completionTriggerCharacters: [],
        signatureTriggerCharacters: [],
      },
    }));
    lspMocks.lspCodeActions.mockResolvedValue({
      status: documentStatus({ available: true, active: true }),
      actions: [{
        title: "Insert space",
        kind: "quickfix",
        isPreferred: true,
        edit: null,
        command: null,
        commandArguments: null,
        raw: {
          title: "Insert space",
          kind: "quickfix",
          data: { fixId: "space" },
        },
      }],
    });
    lspMocks.lspCodeActionResolve.mockResolvedValue({
      status: documentStatus({ available: true, active: true }),
      action: {
        title: "Insert space",
        kind: "quickfix",
        isPreferred: true,
        edit: {
          documentEdits: [{
            uri: "file:///repo/app/src/main.ts",
            path: "/repo/app/src/main.ts",
            edits: [{
              range: {
                start: { line: 0, character: 1 },
                end: { line: 0, character: 1 },
              },
              newText: " ",
            }],
          }],
        },
        command: null,
        commandArguments: null,
        raw: { title: "Insert space", data: { fixId: "space" } },
      },
    });

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "Insert space" }));
    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-actions-undo",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("x =1"));
    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("undo transaction"));

    const pane = screen.getAllByTestId("code-workspace-editor-pane")[0]!;
    fireEvent.keyDown(pane, { key: "z", ctrlKey: true });
    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-actions-undo",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("x=1"));
    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Undid Insert space"));

    // The journal owns the reverted transaction; the superseded document
    // ledger entry is stale, so a second Ctrl+Z must be a no-op instead of
    // re-applying the undone change.
    fireEvent.keyDown(pane, { key: "z", ctrlKey: true });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-actions-undo",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("x=1");
  });

  // ED-AUDIT-008 A2: a provider command that fails AFTER the WorkspaceEdit
  // landed must not be reported as a zero-effect success — the already-written
  // text is automatically recovered and the status message names both the
  // failure and the performed recovery, and the failed run registers no
  // undoable history entry.
  it("recovers the applied edit and reports an accurate failure when the provider command throws", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-actions-cmdfail",
      workspaceInstanceId: "instance-actions-cmdfail",
      name: "Actions",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "x=1"));
    workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
      _rootPath: string,
      path: string,
      text: string,
    ) => writeAck(file(path, text, { hash: `hash-${text}` })));
    lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({
      path: "/repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities: {
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
        codeAction: true,
        documentHighlight: false,
        callHierarchy: false,
        typeHierarchy: false,
        inlayHint: false,
        selectionRange: false,
        semanticTokens: false,
        completionTriggerCharacters: [],
        signatureTriggerCharacters: [],
      },
    }));
    lspMocks.lspCodeActions.mockResolvedValue({
      status: documentStatus({ available: true, active: true }),
      actions: [{
        title: "Insert space then sync",
        kind: "quickfix",
        isPreferred: true,
        edit: null,
        command: null,
        commandArguments: null,
        raw: { title: "Insert space then sync", data: { fixId: "space-sync" } },
      }],
    });
    lspMocks.lspCodeActionResolve.mockResolvedValue({
      status: documentStatus({ available: true, active: true }),
      action: {
        title: "Insert space then sync",
        kind: "quickfix",
        isPreferred: true,
        edit: {
          documentEdits: [{
            uri: "file:///repo/app/src/main.ts",
            path: "/repo/app/src/main.ts",
            edits: [{
              range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
              newText: " ",
            }],
          }],
        },
        command: "java.project.refresh",
        commandArguments: [],
        raw: { title: "Insert space then sync", data: { fixId: "space-sync" } },
      },
    });
    lspMocks.lspExecuteCommand.mockRejectedValue(
      new Error("LSP command execution timed out on language server"),
    );

    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });
    renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "Insert space then sync" }));

    // The edit lands first...
    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-actions-cmdfail",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("x =1"));
    // ...then the command failure is recovered: the text is restored and the
    // message names the failure plus the performed recovery (never a
    // zero-effect wording that would mask the mutation).
    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Code action failed:"));
    expect(useAppStore.getState().statusMessage).toContain("Provider command execution failed");
    expect(useAppStore.getState().statusMessage).toContain("recovery ca-rec-");
    expect(useAppStore.getState().statusMessage).toContain("performed");
    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-actions-cmdfail",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("x=1"));
    await waitFor(() => expect(
      registrationRef.current?.items.find((item) => item.id === "workspace.undoWorkspaceEdit")?.enabled,
    ).not.toBe(true));
  });

  // ED-AUDIT-008 A2: a resolve that returns null keeps the file untouched and
  // shows the retryable resolve-failure result instead of a generic error.
  it("reports a retryable resolve failure with zero effect when resolve returns null", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-actions-resolvefail",
      workspaceInstanceId: "instance-actions-resolvefail",
      name: "Actions",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "x=1"));
    lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({
      path: "/repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities: {
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
        codeAction: true,
        documentHighlight: false,
        callHierarchy: false,
        typeHierarchy: false,
        inlayHint: false,
        selectionRange: false,
        semanticTokens: false,
        completionTriggerCharacters: [],
        signatureTriggerCharacters: [],
      },
    }));
    lspMocks.lspCodeActions.mockResolvedValue({
      status: documentStatus({ available: true, active: true }),
      actions: [{
        title: "Vanishing fix",
        kind: "quickfix",
        isPreferred: true,
        edit: null,
        command: null,
        commandArguments: null,
        raw: { title: "Vanishing fix", data: { fixId: "vanish" } },
      }],
    });
    lspMocks.lspCodeActionResolve.mockResolvedValue({
      status: documentStatus({ available: true, active: true }),
      action: null,
    });

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "Vanishing fix" }));

    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Code action resolve failed:"));
    expect(useAppStore.getState().statusMessage).toContain("Provider returned null on resolve");
    expect(useAppStore.getState().statusMessage).toContain("you can retry");
    // Zero effect: the buffer text is untouched by the failed resolve.
    expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-actions-resolvefail",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("x=1");
  });

  // ED-AUDIT-008 A1 regression: jdtls keeps reporting work-done progress while
  // the candidates are requested and applied, so the semantic snapshot is
  // still "building" with an active provider at both gates. Background
  // provider progress must not stale a revision-pinned response — pre-fix the
  // strict build gate blocked the menu ("Refactor actions became stale…") or
  // aborted the apply ("Semantic result became stale before changes were
  // applied") on roughly half of the native runs. The workspace revision is
  // unchanged throughout, so the menu must open and the apply must land.
  it("opens the intention menu and applies the quick fix while provider work-done progress is active", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-actions-progress",
      workspaceInstanceId: "instance-actions-progress",
      name: "Actions",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "x=1"));
    workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
      _rootPath: string,
      path: string,
      text: string,
    ) => writeAck(file(path, text, { hash: `hash-${text}` })));
    lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({
      path: "/repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities: {
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
        codeAction: true,
        documentHighlight: false,
        callHierarchy: false,
        typeHierarchy: false,
        inlayHint: false,
        selectionRange: false,
        semanticTokens: false,
        completionTriggerCharacters: [],
        signatureTriggerCharacters: [],
      },
    }));
    const insertSpaceAction = {
      title: "Insert space",
      kind: "quickfix",
      isPreferred: true,
      edit: {
        documentEdits: [{
          uri: "file:///repo/app/src/main.ts",
          path: "/repo/app/src/main.ts",
          edits: [{
            range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
            newText: " ",
          }],
        }],
      },
      command: null,
      commandArguments: null,
      raw: { title: "Insert space" },
    };
    lspMocks.lspCodeActions.mockResolvedValue({
      status: documentStatus({ available: true, active: true }),
      actions: [insertSpaceAction],
    });
    lspMocks.lspCodeActionResolve.mockResolvedValue({
      status: documentStatus({ available: true, active: true }),
      action: insertSpaceAction,
    });

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

    // jdtls begins a long-running task (Maven import); after the 150ms
    // progress flush the semantic snapshot stays "building" with an active
    // provider for the rest of the scenario.
    await act(async () => {
      await emit("lsp://work-done-progress", {
        workspaceId: "instance-actions-progress",
        presetId: "app",
        serverLabel: "jdt.ls",
        rootUri: "file:///repo/app",
        token: "qa008-progress",
        kind: "begin",
        title: "Building",
        message: null,
        percentage: null,
        cancellable: false,
      });
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 250)));

    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "Insert space" }));

    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Applied code action"));
    expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-actions-progress",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("x =1");
    // ED-AUDIT-008: the commit must reach the VISIBLE editor, not only the
    // store. The import quick fix is a pure insertion; its replaceDocument
    // delta used to be rejected by the owner's deleted-equality guard, the
    // sync effect swallowed the store change, and the native editor kept the
    // pre-apply text while the disk already held the import.
    await waitFor(() => {
      const content = document.querySelector<HTMLElement>(".cm-content");
      expect(content?.textContent).toContain("x =1");
    });
  });

  it("cancels a multi-file code-action preview with zero edits and zero history", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-actions-cancel",
      workspaceInstanceId: "instance-actions-cancel",
      name: "Actions cancel",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceListDir.mockImplementation(async (_root: string, path: string) => (
      path === "src"
        ? [entry("main.ts", "src/main.ts"), entry("other.ts", "src/other.ts")]
        : [entry("src", "src", "dir")]
    ));
    workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => (
      path === "src/other.ts" ? file(path, "y=2") : file(path, "x=1")
    ));
    const status = documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities: defaultCapabilities({ codeAction: true }),
    });
    lspMocks.lspOpenDocument.mockResolvedValue(status);
    lspMocks.lspCodeActions.mockResolvedValue({
      status,
      actions: [{
        title: "Update two files",
        kind: "quickfix",
        isPreferred: true,
        edit: {
          documentEdits: [
            {
              uri: "file:///repo/app/src/main.ts",
              path: "/repo/app/src/main.ts",
              edits: [{
                range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
                newText: " ",
              }],
            },
            {
              uri: "file:///repo/app/src/other.ts",
              path: "/repo/app/src/other.ts",
              edits: [{
                range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
                newText: " ",
              }],
            },
          ],
        },
        command: null,
        commandArguments: null,
        raw: { title: "Update two files", kind: "quickfix" },
      }],
    });
    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });

    renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "Update two files" }));
    const preview = await screen.findByTestId("refactoring-preview-dialog");
    expect(within(preview).getByText("/repo/app/src/main.ts")).toBeInTheDocument();
    expect(within(preview).getByText("/repo/app/src/other.ts")).toBeInTheDocument();
    fireEvent.click(within(preview).getByTestId("refactoring-preview-cancel"));

    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Code action cancelled"));
    expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-actions-cancel",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("x=1");
    expect(workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
    expect(
      registrationRef.current?.items.find((item) => item.id === "workspace.undoWorkspaceEdit")?.enabled,
    ).toBe(false);
  });

  it("keeps a failed Alt+Enter resolve visible and retries the frozen candidate", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-action-retry",
      workspaceInstanceId: "instance-action-retry",
      name: "Action retry",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const status = documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities: defaultCapabilities({ codeAction: true }),
    });
    const deferredAction = {
      title: "Insert retry space",
      kind: "quickfix",
      isPreferred: true,
      edit: null,
      command: null,
      commandArguments: null,
      raw: { title: "Insert retry space", kind: "quickfix", data: { fixId: "retry-space" } },
    };
    const resolvedAction = {
      ...deferredAction,
      edit: {
        documentEdits: [{
          uri: "file:///repo/app/src/main.ts",
          path: "/repo/app/src/main.ts",
          edits: [{
            range: {
              start: { line: 0, character: 1 },
              end: { line: 0, character: 1 },
            },
            newText: " ",
          }],
        }],
      },
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "x=1"));
    workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
      _rootPath: string,
      path: string,
      text: string,
    ) => writeAck(file(path, text, { hash: `hash-${text}` })));
    lspMocks.lspOpenDocument.mockResolvedValue(status);
    lspMocks.lspCodeActions.mockResolvedValue({ status, actions: [deferredAction] });
    lspMocks.lspCodeActionResolve
      .mockRejectedValueOnce(new Error("resolve transport unavailable"))
      .mockResolvedValueOnce({ status, action: resolvedAction });

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "Insert retry space" }));

    const retry = await screen.findByRole("button", {
      name: /Retry Insert retry space.*resolve transport unavailable/i,
    });
    expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-action-retry",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("x=1");
    expect(lspMocks.lspCodeActionResolve).toHaveBeenCalledTimes(1);

    fireEvent.click(retry);
    await waitFor(() => expect(lspMocks.lspCodeActionResolve).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-action-retry",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("x =1"));
  });

  it("shares frozen candidate identity between Alt+Enter and the gutter lightbulb", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-action-entries",
      workspaceInstanceId: "instance-action-entries",
      name: "Action entries",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const status = documentStatus({
      path: "/repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities: defaultCapabilities({ codeAction: true }),
    });
    const diagnostic = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      severity: 2,
      code: "shared-entry",
      source: "typescript",
      message: "Shared entry diagnostic",
    };
    const action = {
      title: "Use shared candidate",
      kind: "quickfix",
      isPreferred: true,
      edit: { documentEdits: [] },
      command: null,
      commandArguments: null,
      raw: { title: "Use shared candidate", kind: "quickfix" },
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "x"));
    lspMocks.lspOpenDocument.mockResolvedValue(status);
    lspMocks.lspGetDiagnostics.mockResolvedValue({ status, diagnostics: [diagnostic] });
    lspMocks.lspCodeActions.mockResolvedValue({ status, actions: [action] });

    const rendered = renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(lspMocks.lspGetDiagnostics).toHaveBeenCalled());
    await waitFor(() => expect(rendered.container.querySelector(
      '[data-testid="code-workspace-lightbulb"]',
    )).toBeTruthy());

    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).toBeTruthy();
    fireEvent.keyDown(content!, { key: "Enter", altKey: true });
    await waitFor(() => expect(lspMocks.lspCodeActions).toHaveBeenCalledTimes(1));
    const keyboardCandidate = await screen.findByRole("button", { name: "Use shared candidate" });
    const keyboardCandidateId = keyboardCandidate.getAttribute("data-testid");
    expect(keyboardCandidateId).toMatch(/^code-workspace-intention-intention\.provider\./);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Use shared candidate" })).not.toBeInTheDocument());

    const bulb = rendered.container.querySelector('[data-testid="code-workspace-lightbulb"]');
    expect(bulb).toBeTruthy();
    fireEvent.mouseDown(bulb!);
    const gutterCandidate = await screen.findByRole("button", { name: "Use shared candidate" });
    expect(gutterCandidate.getAttribute("data-testid")).toBe(keyboardCandidateId);
    expect(lspMocks.lspCodeActions).toHaveBeenCalledTimes(2);
  });

  it("keeps Problems and editor context-menu code actions on the frozen target", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-action-frozen-target",
      workspaceInstanceId: "instance-action-frozen-target",
      name: "Action frozen target",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const diagnostic = {
      range: { start: { line: 1, character: 0 }, end: { line: 1, character: 6 } },
      severity: 2,
      code: "shared-problem-entry",
      source: "typescript",
      message: "Target file diagnostic",
    };
    const action = {
      title: "Use target-file candidate",
      kind: "quickfix",
      isPreferred: true,
      edit: { documentEdits: [] },
      command: null,
      commandArguments: null,
      raw: { title: "Use target-file candidate", kind: "quickfix" },
    };
    const statusFor = (filePath: string) => documentStatus({
      path: filePath,
      uri: `file://${filePath}`,
      presetId: "typescript-javascript",
      languageId: "typescript",
      displayName: "TypeScript / JavaScript",
      available: true,
      active: true,
      capabilities: defaultCapabilities({ codeAction: true }),
    });
    window.localStorage.setItem("taomni.codeWorkspace.layout.v1.instance-action-frozen-target", JSON.stringify({
      version: 1,
      splitOrientation: "vertical",
      activeEditorGroupId: "primary",
      editorGroups: {
        primary: {
          openOrder: ["root:app:src/main.ts"],
          activeKey: "root:app:src/main.ts",
          previewKey: null,
          pinnedKeys: [],
        },
        secondary: {
          openOrder: ["root:app:src/util.ts"],
          activeKey: "root:app:src/util.ts",
          previewKey: null,
          pinnedKeys: [],
        },
      },
    }));
    workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => (
      file(path, path === "src/util.ts" ? "first\ntarget" : "main")
    ));
    lspMocks.lspOpenDocument.mockImplementation(async (descriptor: { filePath: string }) => (
      statusFor(descriptor.filePath)
    ));
    lspMocks.lspGetDiagnostics.mockImplementation(async (descriptor: { filePath: string }) => ({
      status: statusFor(descriptor.filePath),
      diagnostics: descriptor.filePath.endsWith("src/main.ts") ? [diagnostic] : [],
    }));
    lspMocks.lspCodeActions.mockImplementation(async (descriptor: { filePath: string }) => ({
      status: statusFor(descriptor.filePath),
      actions: [action],
    }));

    const rendered = renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await screen.findByTitle("app / src/util.ts");
    const panes = screen.getAllByTestId("code-workspace-editor-pane");
    const primaryPane = panes.find((pane) => pane.getAttribute("data-editor-group-id") === "primary");
    const secondaryPane = panes.find((pane) => (
      pane.getAttribute("data-editor-group-id") === "secondary"
    ));
    fireEvent.mouseDown(primaryPane!);
    await waitFor(() => expect(lspMocks.lspOpenDocument).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "src/main.ts" }),
      "main",
      expect.any(Number),
    ));
    await waitFor(() => expect(lspMocks.lspGetDiagnostics).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "src/main.ts" }),
    ));
    fireEvent.click(screen.getByTestId("code-workspace-bottom-tab-problems"));
    const problem = await screen.findByRole("button", { name: /Target file diagnostic/ });
    fireEvent.contextMenu(problem, { clientX: 12, clientY: 18 });
    fireEvent.click(screen.getByRole("button", { name: "Quick Fix" }));
    const problemCandidate = await screen.findByRole("button", { name: "Use target-file candidate" });
    const problemCandidateId = problemCandidate.getAttribute("data-testid");
    expect(problemCandidateId).toMatch(/^code-workspace-intention-intention\.provider\./);
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Use target-file candidate" })).not.toBeInTheDocument());

    const secondaryContent = secondaryPane?.querySelector<HTMLElement>(".cm-content");
    expect(secondaryContent).not.toBeNull();
    const secondaryView = EditorView.findFromDOM(secondaryContent!);
    expect(secondaryView).not.toBeNull();
    act(() => {
      secondaryView!.dispatch({ selection: { anchor: secondaryView!.state.doc.toString().indexOf("target") } });
    });
    vi.spyOn(secondaryView!, "posAtCoords").mockReturnValue(null);
    fireEvent.contextMenu(secondaryContent!, { clientX: 24, clientY: 36, button: 2 });
    fireEvent.click(await screen.findByTestId("editor-context-code-actions"));
    const contextCandidate = await screen.findByRole("button", { name: "Use target-file candidate" });

    expect(contextCandidate.getAttribute("data-testid")).toBe(problemCandidateId);
    expect(lspMocks.lspCodeActions).toHaveBeenCalledTimes(2);
    expect(lspMocks.lspCodeActions).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ filePath: "src/main.ts" }),
      diagnostic.range,
      [expect.objectContaining({ code: diagnostic.code, message: diagnostic.message })],
      undefined,
    );
    expect(lspMocks.lspCodeActions).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ filePath: "src/util.ts" }),
      {
        start: { line: 1, character: 0 },
        end: { line: 1, character: 0 },
      },
      [],
      undefined,
    );
    expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-action-frozen-target",
    ).activeEditorGroupId).toBe("primary");
    expect(rendered.container).toBeInTheDocument();
  });

  it("uses the canonical plan-only result for organize imports on save", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-action-save-plan",
      workspaceInstanceId: "instance-action-save-plan",
      name: "Action save plan",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const initialText = "import { b } from \"./b\";\nimport { a } from \"./a\";\nvalue();\n";
    const dirtyText = `${initialText}// dirty\n`;
    const organizedText = "import { a } from \"./a\";\nimport { b } from \"./b\";\nvalue();\n// dirty\n";
    const status = documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      presetId: "typescript-javascript",
      languageId: "typescript",
      displayName: "TypeScript / JavaScript",
      available: true,
      active: true,
      capabilities: defaultCapabilities({ codeAction: true }),
    });
    window.localStorage.setItem("taomni.codeWorkspace.codeStyle.schemes.v1", JSON.stringify({
      schemes: [{
        schemaVersion: 3,
        id: "save-actions",
        name: "Save actions",
        languageId: "ts",
        basedOn: null,
        values: {},
        saveActions: { format: false, organizeImports: true, rearrange: false, cleanup: false },
        exclusions: { patterns: [], formatterMarkers: true },
      }],
      activeByLanguage: { ts: "save-actions" },
    }));
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", initialText));
    lspMocks.lspOpenDocument.mockResolvedValue(status);
    lspMocks.lspChangeDocument.mockResolvedValue(status);
    lspMocks.lspSaveDocument.mockResolvedValue(status);
    lspMocks.lspGetDiagnostics.mockResolvedValue({ status, diagnostics: [] });
    lspMocks.lspCodeActions.mockResolvedValue({
      status,
      actions: [{
        title: "Organize Imports",
        kind: "source.organizeImports",
        isPreferred: true,
        edit: {
          documentEdits: [{
            uri: "file:///repo/app/src/main.ts",
            path: "/repo/app/src/main.ts",
            edits: [{
              range: { start: { line: 0, character: 0 }, end: { line: 2, character: 0 } },
              newText: "import { a } from \"./a\";\nimport { b } from \"./b\";\n",
            }],
          }],
        },
        command: null,
        commandArguments: null,
        raw: null,
      }],
    });
    let releaseWrite!: (ack: WorkspaceWriteAck) => void;
    workspaceMocks.workspaceWriteFileEncoded.mockImplementation(() => new Promise((resolve) => {
      releaseWrite = resolve;
    }));

    const rendered = renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    const view = EditorView.findFromDOM(content!);
    expect(view).not.toBeNull();
    act(() => {
      view!.dispatch({ changes: { from: view!.state.doc.length, insert: "// dirty\n" } });
    });
    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-action-save-plan",
    ).openFiles["root:app:src/main.ts"]?.text).toBe(dirtyText));

    fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
    await waitFor(() => expect(lspMocks.lspCodeActions).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "src/main.ts" }),
      expect.anything(),
      [],
      ["source.organizeImports"],
    ));
    await waitFor(() => expect(workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledWith(
      "/repo/app",
      "src/main.ts",
      organizedText,
      "hash-src/main.ts",
      "UTF-8",
      false,
    ));
    expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-action-save-plan",
    ).openFiles["root:app:src/main.ts"]?.text).toBe(dirtyText);
    expect(lspMocks.lspExecuteCommand).not.toHaveBeenCalled();

    await act(async () => {
      releaseWrite(writeAck(file("src/main.ts", organizedText, { hash: "hash-organized" })));
      await Promise.resolve();
    });
    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-action-save-plan",
    ).openFiles["root:app:src/main.ts"]?.dirty).toBe(false));

    lspMocks.lspCodeActions.mockRejectedValueOnce(new Error("provider transport failed"));
    const currentContent = rendered.container.querySelector<HTMLElement>(".cm-content");
    const currentView = currentContent ? EditorView.findFromDOM(currentContent) : null;
    expect(currentView).not.toBeNull();
    act(() => {
      currentView!.dispatch({
        changes: { from: currentView!.state.doc.length, insert: "// second save\n" },
      });
    });
    const secondText = `${dirtyText}// second save\n`;
    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-action-save-plan",
    ).openFiles["root:app:src/main.ts"]?.text).toBe(secondText));

    fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
    await waitFor(() => expect(workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(2));
    expect(workspaceMocks.workspaceWriteFileEncoded).toHaveBeenLastCalledWith(
      "/repo/app",
      "src/main.ts",
      secondText,
      "hash-organized",
      "UTF-8",
      false,
    );
    expect(lspMocks.lspExecuteCommand).not.toHaveBeenCalled();

    await act(async () => {
      releaseWrite(writeAck(file("src/main.ts", secondText, { hash: "hash-second-save" })));
      await Promise.resolve();
    });
    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
      "save action issue: Organize imports: Code action request failed: provider transport failed",
    ));
  });

  it("supersedes an older intention request when another entry opens", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-action-supersede",
      workspaceInstanceId: "instance-action-supersede",
      name: "Action supersede",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const status = documentStatus({
      path: "/repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities: defaultCapabilities({ codeAction: true }),
    });
    const diagnostic = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      severity: 2,
      code: "supersede-entry",
      source: "typescript",
      message: "Supersede entry diagnostic",
    };
    const olderAction = {
      title: "Older candidate",
      kind: "quickfix",
      isPreferred: false,
      edit: { documentEdits: [] },
      command: null,
      commandArguments: null,
      raw: { title: "Older candidate" },
    };
    const newerAction = { ...olderAction, title: "Newer candidate", raw: { title: "Newer candidate" } };
    let releaseOlder!: (value: { status: LspDocumentStatus; actions: typeof olderAction[] }) => void;
    lspMocks.lspCodeActions
      .mockImplementationOnce(() => new Promise((resolve) => {
        releaseOlder = resolve;
      }))
      .mockResolvedValueOnce({ status, actions: [newerAction] });
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "x"));
    lspMocks.lspOpenDocument.mockResolvedValue(status);
    lspMocks.lspGetDiagnostics.mockResolvedValue({ status, diagnostics: [diagnostic] });

    const rendered = renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(lspMocks.lspGetDiagnostics).toHaveBeenCalled());
    await waitFor(() => expect(rendered.container.querySelector(
      '[data-testid="code-workspace-lightbulb"]',
    )).toBeTruthy());

    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    await waitFor(() => expect(lspMocks.lspCodeActions).toHaveBeenCalledTimes(1));
    fireEvent.mouseDown(rendered.container.querySelector('[data-testid="code-workspace-lightbulb"]')!);
    expect(await screen.findByRole(
      "button",
      { name: "Newer candidate" },
      { timeout: 5_000 },
    )).toBeInTheDocument();

    await act(async () => {
      releaseOlder({ status, actions: [olderAction] });
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Newer candidate" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Older candidate" })).not.toBeInTheDocument();
    expect(useAppStore.getState().statusMessage).not.toContain("No code actions");
  });

  it("discards a resolved action when a newer intention session owns the menu", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-action-resolve-owner",
      workspaceInstanceId: "instance-action-resolve-owner",
      name: "Action resolve owner",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const status = documentStatus({
      path: "/repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities: defaultCapabilities({ codeAction: true }),
    });
    const diagnostic = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      severity: 2,
      code: "resolve-owner",
      source: "typescript",
      message: "Resolve owner diagnostic",
    };
    const oldAction = {
      title: "Deferred old fix",
      kind: "quickfix",
      isPreferred: true,
      edit: null,
      command: null,
      commandArguments: null,
      raw: { title: "Deferred old fix", data: { fixId: "old" } },
    };
    const newAction = {
      title: "Current fix",
      kind: "quickfix",
      isPreferred: true,
      edit: { documentEdits: [] },
      command: null,
      commandArguments: null,
      raw: { title: "Current fix" },
    };
    const resolvedOldAction = {
      ...oldAction,
      edit: {
        documentEdits: [{
          uri: "file:///repo/app/src/main.ts",
          path: "/repo/app/src/main.ts",
          edits: [{
            range: { start: { line: 0, character: 1 }, end: { line: 0, character: 1 } },
            newText: " ",
          }],
        }],
      },
    };
    let releaseResolve!: (value: { status: LspDocumentStatus; action: typeof resolvedOldAction }) => void;
    lspMocks.lspCodeActions
      .mockResolvedValueOnce({ status, actions: [oldAction] })
      .mockResolvedValueOnce({ status, actions: [newAction] });
    lspMocks.lspCodeActionResolve.mockImplementationOnce(() => new Promise((resolve) => {
      releaseResolve = resolve;
    }));
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "x=1"));
    lspMocks.lspOpenDocument.mockResolvedValue(status);
    lspMocks.lspGetDiagnostics.mockResolvedValue({ status, diagnostics: [diagnostic] });

    const rendered = renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(lspMocks.lspGetDiagnostics).toHaveBeenCalled());
    await waitFor(() => expect(rendered.container.querySelector(
      '[data-testid="code-workspace-lightbulb"]',
    )).toBeTruthy());

    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    await waitFor(() => expect(lspMocks.lspCodeActions).toHaveBeenCalledTimes(1));
    fireEvent.click(await screen.findByRole(
      "button",
      { name: "Deferred old fix" },
      { timeout: 5_000 },
    ));
    await waitFor(() => expect(lspMocks.lspCodeActionResolve).toHaveBeenCalledTimes(1));
    fireEvent.mouseDown(rendered.container.querySelector('[data-testid="code-workspace-lightbulb"]')!);
    expect(await screen.findByRole("button", { name: "Current fix" })).toBeInTheDocument();

    await act(async () => {
      releaseResolve({ status, action: resolvedOldAction });
      await Promise.resolve();
    });
    expect(screen.getByRole("button", { name: "Current fix" })).toBeInTheDocument();
    expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-action-resolve-owner",
    ).openFiles["root:app:src/main.ts"]?.text).toBe("x=1");
  });

  it("applies provider Java import quick fixes on Alt+Enter and inserts the import statement", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-java-import",
      workspaceInstanceId: "instance-java-import",
      name: "Java Import",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Service.java" },
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file(
      "src/Service.java",
      "class Service { List items; }",
    ));
    const status = documentStatus({
      path: "/repo/app/src/Service.java",
      uri: "file:///repo/app/src/Service.java",
      presetId: "java",
      languageId: "java",
      displayName: "Java",
      available: true,
      active: true,
      capabilities: {
        completion: true,
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
        codeAction: true,
        documentHighlight: false,
        callHierarchy: false,
        typeHierarchy: false,
        inlayHint: false,
        selectionRange: false,
        semanticTokens: false,
        completionTriggerCharacters: [],
        signatureTriggerCharacters: [],
      },
    });
    lspMocks.lspOpenDocument.mockResolvedValue(status);
    lspMocks.lspCodeActions.mockResolvedValue({
      status,
      actions: [{
        title: "Import 'List' (java.util.List)",
        kind: "quickfix",
        isPreferred: true,
        edit: {
          documentEdits: [{
            uri: "file:///repo/app/src/Service.java",
            path: "/repo/app/src/Service.java",
            edits: [{
              range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
              newText: "import java.util.List;\n",
            }],
          }],
        },
        command: null,
        commandArguments: null,
        raw: { title: "Import 'List' (java.util.List)" },
      }],
    });

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/Service.java");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

    // Trigger Alt+Enter
    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    const importOption = await screen.findByRole("button", { name: "Import 'List' (java.util.List)" });
    expect(importOption).toBeInTheDocument();

    fireEvent.click(importOption);

    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-java-import",
    ).openFiles["root:app:src/Service.java"]?.text).toContain("import java.util.List;"));
  });

  it("never generates or suggests Java import quick fixes in TypeScript files", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-ts-no-java-import",
      workspaceInstanceId: "instance-ts-no-java-import",
      name: "TS No Java Import",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/app.ts" },
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file(
      "src/app.ts",
      "const items: List = [];",
    ));
    lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({
      path: "/repo/app/src/app.ts",
      available: true,
      active: true,
      capabilities: defaultCapabilities({
        completion: true,
        codeAction: true,
      }),
    }));
    lspMocks.lspCodeActions.mockResolvedValue({
      status: documentStatus({ available: true, active: true }),
      actions: [],
    });

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/app.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

    // Trigger Alt+Enter on TypeScript file where LSP has no actions
    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    
    // Assert no Java import quick fix is suggested
    expect(screen.queryByRole("button", { name: /import 'List' \(java\.util\.List\)/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /java\.util/i })).not.toBeInTheDocument();
  });

  it("rejects a provider refactor when the editor changes during preview confirmation", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-stale-refactor",
      workspaceInstanceId: "instance-stale-refactor",
      name: "Stale refactor",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const activeStatus = documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities: {
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
        codeAction: true,
        documentHighlight: false,
        callHierarchy: false,
        typeHierarchy: false,
        inlayHint: false,
        selectionRange: false,
        semanticTokens: false,
        completionTriggerCharacters: [],
        signatureTriggerCharacters: [],
      },
    });
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "const value = 1;"));
    lspMocks.lspOpenDocument.mockResolvedValue(activeStatus);
    lspMocks.lspChangeDocument.mockResolvedValue(activeStatus);
    lspMocks.lspCodeActions.mockResolvedValue({
      status: activeStatus,
      actions: [{
        title: "Extract generated helper",
        kind: "refactor.extract",
        isPreferred: true,
        edit: {
          documentEdits: [],
          operations: [{
            kind: "create",
            uri: "file:///repo/app/src/generated.ts",
            path: "/repo/app/src/generated.ts",
            overwrite: false,
            ignoreIfExists: false,
            annotationId: null,
          }],
        },
        command: null,
        commandArguments: null,
        raw: {},
      }],
    });
    let resolvePreview!: (confirmed: boolean) => void;
    vi.mocked(confirmAppDialog).mockImplementationOnce(() => new Promise<boolean>((resolve) => {
      resolvePreview = resolve;
    }));

    const rendered = renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "Extract generated helper" }));
    await waitFor(() => expect(confirmAppDialog).toHaveBeenCalled());

    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
    await act(async () => {
      resolvePreview(true);
      await Promise.resolve();
    });

    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
      "Code action stale: Live document revision changed from 0 to 1",
    ));
    expect(workspaceMocks.workspaceApplyResourceOperation).not.toHaveBeenCalled();
  });

  it("keeps provider diagnostics unchanged when inspection severity affects editor chrome", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-profile-actions",
      workspaceInstanceId: "instance-profile-actions",
      name: "Profile actions",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const providerDiagnostic = {
      range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
      severity: 2,
      code: "unused-value",
      source: "typescript",
      message: "Value is never read",
      data: { providerToken: "original" },
    };
    window.localStorage.setItem(
      "taomni.codeWorkspace.inspectionProfile.v1.instance-profile-actions",
      JSON.stringify({
        version: 1,
        rules: { "typescript:unused-value": { enabled: true, severity: 1 } },
      }),
    );
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "x"));
    const status = documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities: {
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
        codeAction: true,
        documentHighlight: false,
        callHierarchy: false,
        typeHierarchy: false,
        inlayHint: false,
        selectionRange: false,
        semanticTokens: false,
        completionTriggerCharacters: [],
        signatureTriggerCharacters: [],
      },
    });
    lspMocks.lspOpenDocument.mockResolvedValue(status);
    lspMocks.lspGetDiagnostics.mockResolvedValue({ status, diagnostics: [providerDiagnostic] });

    const rendered = renderWorkspace(workspace);
    await waitFor(() => expect(lspMocks.lspGetDiagnostics).toHaveBeenCalled(), { timeout: 3_000 });
    await waitFor(() => expect(rendered.container.querySelector(".cm-lsp-diagnostic-error")).toBeTruthy());
    const bulb = rendered.container.querySelector('[data-testid="code-workspace-lightbulb"]');
    expect(bulb).toBeTruthy();
    fireEvent.mouseDown(bulb!);

    await waitFor(() => expect(lspMocks.lspCodeActions).toHaveBeenCalled());
    expect(lspMocks.lspCodeActions.mock.calls.at(-1)?.[2]).toEqual([
      expect.objectContaining({
        severity: 2,
        code: "unused-value",
        data: { providerToken: "original" },
      }),
    ]);
  });

  it("makes the active editor read-only while a resource WorkspaceEdit is in flight", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-resource-action",
      workspaceInstanceId: "instance-resource-action",
      name: "Resource action",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "const value = 1;"));
    lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({
      path: "/repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities: {
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
        codeAction: true,
        documentHighlight: false,
        callHierarchy: false,
        typeHierarchy: false,
        inlayHint: false,
        selectionRange: false,
        semanticTokens: false,
        completionTriggerCharacters: [],
        signatureTriggerCharacters: [],
      },
    }));
    lspMocks.lspCodeActions.mockResolvedValue({
      status: documentStatus({ available: true, active: true }),
      actions: [{
        title: "Rename file",
        kind: "refactor.rename",
        isPreferred: true,
        edit: {
          documentEdits: [],
          operations: [{
            kind: "rename",
            oldUri: "file:///repo/app/src/main.ts",
            oldPath: "/repo/app/src/main.ts",
            newUri: "file:///repo/app/src/renamed.ts",
            newPath: "/repo/app/src/renamed.ts",
            overwrite: false,
            ignoreIfExists: false,
            annotationId: null,
          }],
        },
        command: null,
        commandArguments: null,
        raw: {},
      }],
    });
    let finishResourceOperation!: (value: { ignored: boolean }) => void;
    workspaceMocks.workspaceApplyResourceOperation.mockReturnValue(new Promise((resolve) => {
      finishResourceOperation = resolve;
    }));

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    fireEvent.keyDown(window, { key: "Enter", altKey: true });
    fireEvent.click(await screen.findByRole("button", { name: "Rename file" }));

    await waitFor(() => expect(confirmAppDialog).toHaveBeenCalled());
    await waitFor(() => expect(workspaceMocks.workspaceApplyResourceOperation).toHaveBeenCalled());
    await waitFor(() => expect(
      screen.getByTestId("code-workspace-editor").querySelector(".cm-content"),
    ).toHaveAttribute("aria-readonly", "true"));

    await act(async () => finishResourceOperation({ ignored: false }));
    await waitFor(() => expect(
      screen.getByTestId("code-workspace-editor").querySelector(".cm-content"),
    ).not.toHaveAttribute("aria-readonly"));
    expect(workspaceMocks.workspaceApplyResourceOperation).toHaveBeenCalledWith("/repo/app", {
      kind: "rename",
      fromPath: "src/main.ts",
      toPath: "src/renamed.ts",
      toRepoRoot: "/repo/app",
      overwrite: false,
      ignoreIfExists: false,
    });
    expect(Object.keys(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-resource-action").openFiles,
    )).toContain("root:app:src/renamed.ts");
  });

  it("formats the active document through LSP when formatting is advertised", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-format",
      workspaceInstanceId: "instance-format",
      name: "Format",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "const x=1"));
    lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      presetId: "typescript-javascript",
      languageId: "typescript",
      displayName: "TypeScript / JavaScript",
      available: true,
      active: true,
      capabilities: {
        completion: true,
        signatureHelp: true,
        hover: true,
        definition: true,
        typeDefinition: false,
        implementation: false,
        references: true,
        documentSymbol: true,
        workspaceSymbol: false,
        rename: false,
        formatting: true,
        rangeFormatting: true,
        codeAction: false,
        documentHighlight: false,
        callHierarchy: false,
        typeHierarchy: false,
        inlayHint: false,
        selectionRange: false,
      semanticTokens: false,
        completionTriggerCharacters: ["."],
        signatureTriggerCharacters: ["(", ","],
      },
    }));
    lspMocks.lspFormatting.mockResolvedValue({
      status: documentStatus({ active: true, available: true }),
      edits: [{
        range: {
          start: { line: 0, character: 7 },
          end: { line: 0, character: 7 },
        },
        newText: " ",
      }],
    });

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await screen.findByText("9 B");
    await waitFor(() => expect(lspMocks.lspOpenDocument).toHaveBeenCalled());
    // Wait until the LSP status is no longer idle so capabilities are in state.
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

    fireEvent.keyDown(window, { key: "l", ctrlKey: true, altKey: true, shiftKey: false, metaKey: false });
    await waitFor(() => expect(lspMocks.lspFormatting).toHaveBeenCalled());
    // Formatting inserts a space into "const x=1" → dirty buffer.
    await waitFor(() => {
      expect(screen.getByText(/unsaved/)).toBeInTheDocument();
    });
    expect(lspMocks.lspFormatting).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "instance-format",
        filePath: "src/main.ts",
      }),
      expect.objectContaining({
        tabSize: 2,
        insertSpaces: true,
      }),
    );
  });

  it("persists the workspace format-on-save switch and saves formatted text", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-format-on-save",
      workspaceInstanceId: "instance-format-on-save",
      name: "Format on save",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const capabilities = {
      completion: false,
      signatureHelp: false,
      hover: true,
      definition: true,
      typeDefinition: false,
      implementation: false,
      references: true,
      documentSymbol: true,
      workspaceSymbol: false,
      rename: false,
      formatting: true,
      rangeFormatting: true,
      codeAction: false,
      documentHighlight: false,
      callHierarchy: false,
      typeHierarchy: false,
      inlayHint: false,
      selectionRange: false,
      semanticTokens: false,
      completionTriggerCharacters: [],
      signatureTriggerCharacters: [],
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "const x=1"));
    lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      presetId: "typescript-javascript",
      languageId: "typescript",
      displayName: "TypeScript / JavaScript",
      available: true,
      active: true,
      capabilities,
    }));
    lspMocks.lspFormatting
      .mockResolvedValueOnce({
        status: documentStatus({ active: true, available: true, capabilities }),
        edits: [{
          range: {
            start: { line: 0, character: 7 },
            end: { line: 0, character: 7 },
          },
          newText: " ",
        }],
      })
      .mockResolvedValueOnce({
        status: documentStatus({ active: true, available: true, capabilities }),
        edits: [{
          range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
          },
          newText: "// formatted\n",
        }],
      });
    workspaceMocks.workspaceWriteFileEncoded.mockResolvedValue(writeAck(file(
      "src/main.ts",
      "// formatted\nconst x =1",
      { hash: "hash-formatted" },
    )));

    // Format-on-save is a workspace intelligence preference (command / Settings path).
    // Pref-seed before mount so save applies formatting without the old tree checkbox.
    window.localStorage.setItem(
      "taomni.codeWorkspace.intelligence.v1.instance-format-on-save",
      JSON.stringify({ formatOnSave: true }),
    );

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

    // Make the buffer dirty through the existing manual formatting path.
    fireEvent.keyDown(window, { key: "l", ctrlKey: true, altKey: true });
    await waitFor(() => expect(lspMocks.lspFormatting).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByText(/unsaved/)).toBeInTheDocument());

    fireEvent.keyDown(window, { key: "s", ctrlKey: true });
    await waitFor(() => expect(workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledWith(
      "/repo/app",
      "src/main.ts",
      "// formatted\nconst x =1",
      "hash-src/main.ts",
      "UTF-8",
      false,
    ));
    expect(lspMocks.lspFormatting).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByText(/unsaved/)).not.toBeInTheDocument());
    expect(lspMocks.lspWorkspaceDidChangeWatchedFiles).toHaveBeenCalledWith(
      "instance-format-on-save",
      [{ path: "/repo/app/src/main.ts", type: 2 }],
    );
  });

  it("queues an external dirty-buffer conflict and applies a merge against the latest disk hash", async () => {
    runtimeState.tauri = true;
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-external-conflict",
      workspaceInstanceId: "instance-external-conflict",
      name: "External conflict",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    let disk = file("src/main.ts", "const value = 1;", { hash: "hash-base" });
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
    workspaceMocks.workspaceReadFile.mockImplementation(async () => disk);

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    const key = "root:app:src/main.ts";
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-external-conflict")
        .openFiles[key]?.text,
    ).toBe("const value = 1;"));

    act(() => {
      useCodeWorkspaceStore.getState().updateOpenFiles(
        "instance-external-conflict",
        (current) => ({
          ...current,
          [key]: {
            ...current[key]!,
            text: "const value = 2;",
            dirty: true,
          },
        }),
      );
    });
    disk = file("src/main.ts", "const value = 3;", { hash: "hash-external" });
    await act(async () => {
      await emit("lsp://external-file-change", {
        workspaceId: "instance-external-conflict",
        path: "/repo/app/src/main.ts",
        type: 2,
      });
    });

    expect(await screen.findByTestId("external-file-conflict-dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Merge" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Merge result" }, { timeout: 5000 }), {
      target: { value: "const value = 4;" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply Merge" }));

    await waitFor(() => {
      const merged = selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-external-conflict",
      ).openFiles[key];
      expect(merged?.text).toBe("const value = 4;");
      expect(merged?.savedText).toBe("const value = 3;");
      expect(merged?.hash).toBe("hash-external");
      expect(merged?.dirty).toBe(true);
    });
    expect(screen.queryByTestId("external-file-conflict-dialog")).not.toBeInTheDocument();
  });

  it("restores a crash snapshot into the live editor without replacing the disk baseline", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-recovery",
      workspaceInstanceId: "instance-recovery",
      name: "Recovery",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "const value = 1;", { hash: "disk-hash" }));
    window.localStorage.setItem(
      `${WORKSPACE_RECOVERY_STORAGE_PREFIX}:instance-recovery`,
      JSON.stringify([{
        workspaceId: "instance-recovery",
        key: "root:app:src/main.ts",
        ref: { kind: "root", rootId: "app", path: "src/main.ts" },
        path: "src/main.ts",
        text: "const value = 2;",
        savedText: "const value = 1;",
        eol: "LF",
        hash: "disk-hash",
        mtime: 1,
        size: 16,
        capturedAt: Date.now(),
      }]),
    );

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.getByTestId("workspace-recovery-dialog")).toBeInTheDocument());
    expect(await screen.findByTestId("workspace-recovery-dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Recover selected" }));
    await waitFor(() => {
      const recovered = selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-recovery",
      ).openFiles["root:app:src/main.ts"];
      expect(recovered?.text).toBe("const value = 2;");
      expect(recovered?.savedText).toBe("const value = 1;");
      expect(recovered?.hash).toBe("disk-hash");
      expect(recovered?.dirty).toBe(true);
    });
    expect(screen.queryByTestId("workspace-recovery-dialog")).not.toBeInTheDocument();
  });

  it("opens call and type hierarchy from capability-gated shortcuts", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-hierarchy",
      workspaceInstanceId: "instance-hierarchy",
      name: "Hierarchy",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const capabilities = {
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
      callHierarchy: true,
      typeHierarchy: true,
      inlayHint: false,
      selectionRange: false,
      semanticTokens: false,
      completionTriggerCharacters: [],
      signatureTriggerCharacters: [],
    };
    const hierarchyItem = {
      name: "main",
      detail: "module",
      kind: 12,
      uri: "file:///repo/app/src/main.ts",
      path: "/repo/app/src/main.ts",
      range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } },
      selectionRange: { start: { line: 0, character: 9 }, end: { line: 0, character: 13 } },
      raw: { name: "main", data: "opaque" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "function main() {}"));
    lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities,
    }));
    lspMocks.lspPrepareCallHierarchy.mockResolvedValue({
      status: documentStatus({ available: true, active: true, capabilities }),
      items: [hierarchyItem],
    });
    lspMocks.lspPrepareTypeHierarchy.mockResolvedValue({
      status: documentStatus({ available: true, active: true, capabilities }),
      items: [{ ...hierarchyItem, name: "Base", raw: { name: "Base" } }],
    });

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
    const editor = screen.getByTestId("code-workspace-editor-pane");

    fireEvent.keyDown(editor, { key: "h", ctrlKey: true, altKey: true });
    await waitFor(() => expect(lspMocks.lspPrepareCallHierarchy).toHaveBeenCalled());
    expect(screen.getByRole("tab", { name: "Call Hierarchy", selected: true })).toBeInTheDocument();
    expect(screen.getByTestId("code-workspace-call-hierarchy-panel")).toHaveTextContent("main");

    fireEvent.keyDown(editor, { key: "h", ctrlKey: true });
    await waitFor(() => expect(lspMocks.lspPrepareTypeHierarchy).toHaveBeenCalled());
    expect(screen.getByRole("tab", { name: "Type Hierarchy", selected: true })).toBeInTheDocument();
    expect(screen.getByTestId("code-workspace-type-hierarchy-panel")).toHaveTextContent("Base");
  });

  it("opens a JDK / dependency class as a read-only library buffer", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-library-goto",
      workspaceInstanceId: "instance-library-goto",
      name: "Library goto",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Main.java" },
    };
    const activeStatus = documentStatus({
      path: "/repo/app/src/Main.java",
      uri: "file:///repo/app/src/Main.java",
      presetId: "java",
      languageId: "java",
      displayName: "Java",
      available: true,
      active: true,
    });
    const classUri = "jdt://contents/java.base/java.lang/String.class?=java.base";
    workspaceMocks.workspaceReadFile.mockResolvedValue(
      file("src/Main.java", "class Main { String value; }"),
    );
    lspMocks.lspOpenDocument.mockResolvedValue(activeStatus);
    lspMocks.lspChangeDocument.mockResolvedValue(activeStatus);
    lspMocks.lspGetDiagnostics.mockResolvedValue({ status: activeStatus, diagnostics: [] });
    // jdtls answers binary targets with a jdt:// URI and no filesystem path.
    lspMocks.lspDefinition.mockResolvedValue({
      status: activeStatus,
      locations: [{
        uri: classUri,
        path: null,
        range: {
          start: { line: 3, character: 13 },
          end: { line: 3, character: 19 },
        },
      }],
    });
    const charSequenceUri = "jdt://contents/java.base/java.lang/CharSequence.class?=java.base";
    lspMocks.lspReadUriContents.mockImplementation(async (_descriptor: unknown, uri: string) => (
      uri === charSequenceUri
        ? {
          status: activeStatus,
          uri,
          path: null,
          title: "CharSequence.java",
          container: "java.lang · java.base",
          languageId: "java",
          text: "package java.lang;\n\npublic interface CharSequence {}\n",
          readOnly: true,
        }
        : {
          status: activeStatus,
          uri,
          path: null,
          title: "String.java",
          container: "java.lang · java.base",
          languageId: "java",
          text: "package java.lang;\n\npublic final class String implements CharSequence {}\n",
          readOnly: true,
        }
    ));

    const rendered = renderWorkspace(workspace);
    await screen.findByTitle("app / src/Main.java");
    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();

    fireEvent.keyDown(content!, { key: "F12" });

    await waitFor(() => expect(lspMocks.lspReadUriContents).toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: "/repo/app", filePath: "src/Main.java" }),
      classUri,
    ));
    const libraryTab = await screen.findByTitle("java.lang · java.base · String.java");
    expect(libraryTab).toBeInTheDocument();
    // Library sources never touch the file system, and never open a server document.
    expect(workspaceMocks.workspaceReadLooseFile).not.toHaveBeenCalled();
    expect(lspMocks.lspOpenDocument).not.toHaveBeenCalledWith(
      expect.objectContaining({ filePath: classUri }),
      expect.anything(),
      expect.anything(),
    );

    await waitFor(() => expect(useAppStore.getState().statusMessage)
      .toBe("Opened java.lang · java.base · String.java (read-only)"));

    // Jumping again from inside the library buffer rides the origin project's
    // session, and a URI reported as a "path" is never read from disk.
    lspMocks.lspDefinition.mockResolvedValue({
      status: activeStatus,
      locations: [{
        uri: charSequenceUri,
        path: charSequenceUri,
        range: {
          start: { line: 2, character: 17 },
          end: { line: 2, character: 29 },
        },
      }],
    });
    fireEvent.keyDown(rendered.container.querySelector<HTMLElement>(".cm-content")!, { key: "F12" });

    await waitFor(() => expect(lspMocks.lspReadUriContents).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: "src/Main.java", documentUri: classUri }),
      charSequenceUri,
    ));
    expect(await screen.findByTitle("java.lang · java.base · CharSequence.java")).toBeInTheDocument();
    expect(workspaceMocks.workspaceReadLooseFile).not.toHaveBeenCalled();
    expect(workspaceMocks.workspaceWriteLooseFile).not.toHaveBeenCalled();
    expect(workspaceMocks.workspaceWriteFile).not.toHaveBeenCalled();
  });

  it("offers Download sources on a decompiled class and swaps in attached source", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-download-sources",
      workspaceInstanceId: "instance-download-sources",
      name: "Download sources",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Main.java" },
    };
    const activeStatus = documentStatus({
      path: "/repo/app/src/Main.java",
      uri: "file:///repo/app/src/Main.java",
      presetId: "java",
      languageId: "java",
      displayName: "Java",
      available: true,
      active: true,
    });
    const classUri = "jdt://contents/guava-33.jar/com.google.common.base/Strings.class?=guava";
    workspaceMocks.workspaceReadFile.mockResolvedValue(
      file("src/Main.java", "class Main { Strings s; }"),
    );
    lspMocks.lspOpenDocument.mockResolvedValue(activeStatus);
    lspMocks.lspChangeDocument.mockResolvedValue(activeStatus);
    lspMocks.lspGetDiagnostics.mockResolvedValue({ status: activeStatus, diagnostics: [] });
    lspMocks.lspDefinition.mockResolvedValue({
      status: activeStatus,
      locations: [{
        uri: classUri,
        path: null,
        range: { start: { line: 0, character: 13 }, end: { line: 0, character: 20 } },
      }],
    });
    // First open returns decompiled bytecode (marked decompiled: true).
    lspMocks.lspReadUriContents.mockResolvedValue({
      status: activeStatus,
      uri: classUri,
      path: null,
      title: "Strings.java",
      container: "com.google.common.base · guava-33.jar",
      languageId: "java",
      text: "// Source code is decompiled…\npublic final class Strings {}\n",
      readOnly: true,
      decompiled: true,
    });
    lspMocks.lspDownloadSources.mockResolvedValue({
      attached: true,
      text: "package com.google.common.base;\n\npublic final class Strings { /* real */ }\n",
      decompiled: false,
      message: null,
    });

    const rendered = renderWorkspace(workspace);
    await screen.findByTitle("app / src/Main.java");
    fireEvent.keyDown(rendered.container.querySelector<HTMLElement>(".cm-content")!, { key: "F12" });

    // Decompiled banner + Download sources button appear for the library buffer.
    const downloadBtn = await screen.findByTestId("code-workspace-download-sources");
    expect(screen.getByTestId("code-workspace-decompiled-banner")).toBeInTheDocument();

    fireEvent.click(downloadBtn);

    await waitFor(() => expect(lspMocks.lspDownloadSources).toHaveBeenCalledWith(
      expect.objectContaining({ rootPath: "/repo/app", filePath: "src/Main.java" }),
      classUri,
    ));
    // Attached source arrives → banner disappears and status reports success.
    await waitFor(() => expect(screen.queryByTestId("code-workspace-decompiled-banner")).toBeNull());
    await waitFor(() => expect(useAppStore.getState().statusMessage)
      .toBe("Attached sources for Strings.java"));
    // Never written back to disk.
    expect(workspaceMocks.workspaceWriteFile).not.toHaveBeenCalled();
    expect(workspaceMocks.workspaceWriteLooseFile).not.toHaveBeenCalled();
  });

  it("keeps the Download sources banner when no sources are published", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-download-none",
      workspaceInstanceId: "instance-download-none",
      name: "Download none",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Main.java" },
    };
    const activeStatus = documentStatus({
      path: "/repo/app/src/Main.java",
      uri: "file:///repo/app/src/Main.java",
      presetId: "java",
      languageId: "java",
      displayName: "Java",
      available: true,
      active: true,
    });
    const classUri = "jdt://contents/legacy.jar/com.legacy/Widget.class?=legacy";
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/Main.java", "class Main { Widget w; }"));
    lspMocks.lspOpenDocument.mockResolvedValue(activeStatus);
    lspMocks.lspChangeDocument.mockResolvedValue(activeStatus);
    lspMocks.lspGetDiagnostics.mockResolvedValue({ status: activeStatus, diagnostics: [] });
    lspMocks.lspDefinition.mockResolvedValue({
      status: activeStatus,
      locations: [{
        uri: classUri,
        path: null,
        range: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } },
      }],
    });
    lspMocks.lspReadUriContents.mockResolvedValue({
      status: activeStatus,
      uri: classUri,
      path: null,
      title: "Widget.java",
      container: "com.legacy · legacy.jar",
      languageId: "java",
      text: "// Source code is decompiled…\npublic class Widget {}\n",
      readOnly: true,
      decompiled: true,
    });
    lspMocks.lspDownloadSources.mockResolvedValue({
      attached: false,
      text: "// Source code is decompiled…\npublic class Widget {}\n",
      decompiled: true,
      message: "No sources published for this artifact (still showing decompiled bytecode).",
    });

    const rendered = renderWorkspace(workspace);
    await screen.findByTitle("app / src/Main.java");
    fireEvent.keyDown(rendered.container.querySelector<HTMLElement>(".cm-content")!, { key: "F12" });

    const downloadBtn = await screen.findByTestId("code-workspace-download-sources");
    fireEvent.click(downloadBtn);

    await waitFor(() => expect(lspMocks.lspDownloadSources).toHaveBeenCalled());
    await waitFor(() => expect(useAppStore.getState().statusMessage)
      .toContain("No sources published"));
    // Still decompiled → banner stays so the user can retry.
    expect(screen.getByTestId("code-workspace-decompiled-banner")).toBeInTheDocument();
  });

  it("requests usage highlights, viewport inlay hints, and semantic selection ranges", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-intelligence",
      workspaceInstanceId: "instance-intelligence",
      name: "Intelligence",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const capabilities = {
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
      documentHighlight: true,
      callHierarchy: false,
      typeHierarchy: false,
      inlayHint: true,
      selectionRange: true,
      semanticTokens: false,
      completionTriggerCharacters: [],
      signatureTriggerCharacters: [],
    };
    const activeStatus = documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities,
    });
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "const value = value;"));
    lspMocks.lspOpenDocument.mockResolvedValue(activeStatus);
    lspMocks.lspChangeDocument.mockResolvedValue(activeStatus);
    lspMocks.lspGetDiagnostics.mockResolvedValue({ status: activeStatus, diagnostics: [] });
    lspMocks.lspDocumentHighlights.mockResolvedValue({
      status: activeStatus,
      highlights: [{
        range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } },
        kind: 2,
      }],
    });
    lspMocks.lspInlayHints.mockResolvedValue({
      status: activeStatus,
      hints: [{
        position: { line: 0, character: 11 },
        label: ": number",
        kind: 1,
        tooltip: null,
        paddingLeft: true,
        paddingRight: false,
      }],
    });
    lspMocks.lspSelectionRanges.mockResolvedValue({
      status: activeStatus,
      ranges: [{
        start: { line: 0, character: 0 },
        end: { line: 0, character: 20 },
      }],
    });

    const rendered = renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(lspMocks.lspDocumentHighlights).toHaveBeenCalled());

    const inlayHintsToggle = screen.getByTestId("code-workspace-inlay-hints-toggle");
    expect(inlayHintsToggle).not.toBeDisabled();
    fireEvent.click(inlayHintsToggle);
    await waitFor(() => expect(inlayHintsToggle).toHaveAttribute("aria-pressed", "true"));
    await waitFor(() => expect(lspMocks.lspInlayHints).toHaveBeenCalled());
    expect(window.localStorage.getItem("taomni.codeWorkspace.intelligence.v1.instance-intelligence"))
      .toContain('"inlayHintsEnabled":true');

    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    fireEvent.keyDown(content!, { key: "w", code: "KeyW", ctrlKey: true });
    await waitFor(() => expect(lspMocks.lspSelectionRanges).toHaveBeenCalled());
  });

  it("does not restore occurrence highlights when a cleared request returns late", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-occurrence-stale-response",
      workspaceInstanceId: "instance-occurrence-stale-response",
      name: "Occurrence stale response",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const capabilities = defaultCapabilities({ documentHighlight: true });
    const status = documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities,
    });
    const highlights: LspDocumentHighlight[] = [
      { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 4 } }, kind: 1 },
      { range: { start: { line: 1, character: 7 }, end: { line: 1, character: 11 } }, kind: 1 },
      { range: { start: { line: 2, character: 6 }, end: { line: 2, character: 10 } }, kind: 1 },
    ];
    const result = { status, highlights };
    const pending: Array<(
      value: { status: LspDocumentStatus; highlights: LspDocumentHighlight[] }
    ) => void> = [];
    workspaceMocks.workspaceReadFile.mockResolvedValue(file(
      "src/main.ts",
      "item\nsecond item\nthird item",
    ));
    lspMocks.lspOpenDocument.mockResolvedValue(status);
    lspMocks.lspChangeDocument.mockResolvedValue(status);
    lspMocks.lspGetDiagnostics.mockResolvedValue({ status, diagnostics: [] });
    lspMocks.lspDocumentHighlights.mockImplementation(() => new Promise((resolve) => {
      pending.push(resolve);
    }));
    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });

    renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(pending.length).toBeGreaterThan(0));

    // Keep the first cursor-driven request unresolved while invoking the
    // explicit command through the same registered production action.
    lspMocks.lspDocumentHighlights.mockClear();
    let executePromise: Promise<unknown> | undefined;
    act(() => {
      executePromise = registrationRef.current?.executeAction("workspace.highlightUsagesInFile");
    });
    await waitFor(() => expect(pending.length).toBeGreaterThan(1));
    const manualResolve = pending[pending.length - 1]!;
    manualResolve(result);
    await act(async () => {
      await executePromise;
    });
    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Occurrence 1 of 3"));
    expect(document.querySelectorAll(".cm-lsp-usage-text")).toHaveLength(3);

    act(() => {
      registrationRef.current?.executeAction("workspace.clearHighlightUsages");
    });
    await waitFor(() => expect(useAppStore.getState().statusMessage).toBe("Occurrence highlights cleared"));
    expect(document.querySelectorAll(".cm-lsp-usage-text")).toHaveLength(0);

    for (const resolve of pending) resolve(result);
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.querySelectorAll(".cm-lsp-usage-text")).toHaveLength(0);
  });

  it("syncs edits before idle intelligence work and ignores an older semantic-token response", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-lsp-scheduler",
      workspaceInstanceId: "instance-lsp-scheduler",
      name: "LSP scheduler",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const capabilities = {
      completion: false,
      signatureHelp: false,
      hover: false,
      definition: false,
      typeDefinition: false,
      implementation: false,
      references: false,
      documentSymbol: true,
      workspaceSymbol: false,
      rename: false,
      formatting: false,
      rangeFormatting: false,
      codeAction: false,
      documentHighlight: true,
      callHierarchy: false,
      typeHierarchy: false,
      inlayHint: false,
      selectionRange: false,
      semanticTokens: true,
      completionTriggerCharacters: [],
      signatureTriggerCharacters: [],
    };
    const status = documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities,
    });
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "const alpha = 1;"));
    lspMocks.lspOpenDocument.mockResolvedValue(status);
    lspMocks.lspChangeDocument.mockResolvedValue(status);
    lspMocks.lspGetDiagnostics.mockResolvedValue({ status, diagnostics: [] });
    lspMocks.lspDocumentHighlights.mockResolvedValue({ status, highlights: [] });
    lspMocks.lspDocumentSymbols.mockResolvedValue({ status, symbols: [] });

    const rendered = renderWorkspace(workspace);
    const fileKey = "root:app:src/main.ts";
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-lsp-scheduler")
        .lspFiles[fileKey]?.syncedText,
    ).toBe("const alpha = 1;"));

    lspMocks.lspChangeDocument.mockClear();
    lspMocks.lspDocumentHighlights.mockClear();
    lspMocks.lspDocumentSymbols.mockClear();
    lspMocks.lspSemanticTokens.mockClear();
    let resolveOldSemantic: ((value: { status: LspDocumentStatus; tokens: unknown[] }) => void) | null = null;
    lspMocks.lspSemanticTokens.mockImplementationOnce(() => new Promise((resolve) => {
      resolveOldSemantic = resolve;
    }));

    act(() => {
      useCodeWorkspaceStore.getState().updateOpenFiles("instance-lsp-scheduler", (current) => ({
        ...current,
        [fileKey]: {
          ...current[fileKey]!,
          text: "const beta = 2;",
          dirty: true,
        },
      }));
    });

    await waitFor(() => expect(lspMocks.lspChangeDocument).toHaveBeenCalledOnce());
    await waitFor(() => expect(lspMocks.lspDocumentHighlights).toHaveBeenCalledOnce());
    await waitFor(() => expect(lspMocks.lspDocumentSymbols).toHaveBeenCalledOnce());
    await waitFor(() => expect(lspMocks.lspSemanticTokens).toHaveBeenCalledOnce());
    const changeOrder = lspMocks.lspChangeDocument.mock.invocationCallOrder[0]!;
    expect(changeOrder).toBeLessThan(lspMocks.lspDocumentHighlights.mock.invocationCallOrder[0]!);
    expect(changeOrder).toBeLessThan(lspMocks.lspDocumentSymbols.mock.invocationCallOrder[0]!);
    expect(changeOrder).toBeLessThan(lspMocks.lspSemanticTokens.mock.invocationCallOrder[0]!);

    act(() => {
      useCodeWorkspaceStore.getState().updateOpenFiles("instance-lsp-scheduler", (current) => ({
        ...current,
        [fileKey]: {
          ...current[fileKey]!,
          text: "const gamma = 3;",
          dirty: true,
        },
      }));
    });
    await waitFor(() => expect(lspMocks.lspChangeDocument).toHaveBeenCalledTimes(2));

    expect(resolveOldSemantic).not.toBeNull();
    await act(async () => {
      resolveOldSemantic!({
        status,
        tokens: [{
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
          tokenType: "function",
          modifiers: [],
        }],
      });
      await Promise.resolve();
    });
    expect(rendered.container.querySelector(".cm-lsp-sem-function")).toBeNull();
  });

  it("coalesces editor text publications until the input burst is idle", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-editor-text-batch",
      workspaceInstanceId: "instance-editor-text-batch",
      name: "Editor text batch",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "one\ntwo"));

    const rendered = renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    const fileKey = "root:app:src/main.ts";
    const getBufferText = () => selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-editor-text-batch",
    ).openFiles[fileKey]?.text;
    const recordUserEdit = vi.spyOn(WorkspaceLocationController.prototype, "recordUserEdit");

    vi.useFakeTimers();
    try {
      fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
      expect(getBufferText()).toBe("one\ntwo");
      expect(recordUserEdit).not.toHaveBeenCalled();

      // EDITOR_TEXT_COMMIT_IDLE_DELAY_MS is 220ms — stay under it first.
      act(() => vi.advanceTimersByTime(219));
      expect(getBufferText()).toBe("one\ntwo");
      expect(recordUserEdit).not.toHaveBeenCalled();

      act(() => vi.advanceTimersByTime(1));
      expect(getBufferText()).toBe("one\none\ntwo");
      expect(recordUserEdit).toHaveBeenCalledOnce();
      expect(recordUserEdit).toHaveBeenLastCalledWith(expect.objectContaining({
        line: 1,
        character: 0,
        lineText: "one",
        contextSnippet: "one\none\ntwo",
      }));
    } finally {
      recordUserEdit.mockRestore();
      vi.useRealTimers();
    }
  });

  it("offers tree context menu actions: copy path and scoped search", async () => {
    clipboardMocks.writeText.mockClear();
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-menu",
      workspaceInstanceId: "instance-menu",
      name: "Menu",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([
      entry("src", "src", "dir"),
      entry("README.md", "README.md"),
    ]);
    workspaceMocks.workspaceDetectGitRoots.mockResolvedValue([{
      id: "git-app",
      name: "app",
      path: "/repo/app",
      repoRoot: "/repo/app",
      rootIds: ["app"],
    }]);

    renderWorkspace(workspace);

    const fileRow = await screen.findByTestId("code-workspace-tree-file");
    fireEvent.contextMenu(fileRow);
    fireEvent.click(await screen.findByRole("button", { name: "Copy Relative Path" }));
    await waitFor(() => expect(clipboardMocks.writeText).toHaveBeenCalledWith("README.md"));

    fireEvent.contextMenu(fileRow);
    fireEvent.click(await screen.findByRole("button", { name: "Copy Path" }));
    await waitFor(() => expect(clipboardMocks.writeText).toHaveBeenCalledWith("/repo/app/README.md"));

    fireEvent.contextMenu(fileRow);
    fireEvent.click(await screen.findByRole("button", { name: "Add to .gitignore" }));
    await waitFor(() => expect(gitMocks.gitIgnorePath).toHaveBeenCalledWith(
      "/repo/app",
      "README.md",
      false,
    ));

    const dirRow = await screen.findByTestId("code-workspace-tree-dir");
    fireEvent.contextMenu(dirRow);
    fireEvent.click(await screen.findByRole("button", { name: "Find in Directory..." }));
    expect(screen.getByRole("tab", { name: /Search/, selected: true })).toBeInTheDocument();
    expect(screen.getByLabelText("Include globs")).toHaveValue("src/**");

    fireEvent.contextMenu(fileRow);
    fireEvent.click(await screen.findByRole("button", { name: "Open in Terminal" }));
    expect(screen.getByRole("tab", { name: /Terminal/, selected: true })).toBeInTheDocument();
    expect(await screen.findByTestId("mock-workspace-terminal")).toHaveAttribute("data-initial-cwd", "/repo/app");
  });

  it("detects workspace tasks and launches them in the integrated terminal", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-run",
      workspaceInstanceId: "instance-run",
      name: "Run",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
    };
    workspaceMocks.workspaceDetectTasks.mockResolvedValue([{
      id: "package.json:test",
      label: "test",
      command: "pnpm run test",
      cwd: "/repo/app",
      source: "package.json",
    }]);

    renderWorkspace(workspace);
    fireEvent.click(await screen.findByRole("tab", { name: /Run/ }));
    fireEvent.click(await screen.findByTitle("pnpm run test — /repo/app"));

    expect(screen.getByRole("tab", { name: /Terminal/, selected: true })).toBeInTheDocument();
    expect(await screen.findByTestId("mock-workspace-terminal")).toHaveAttribute(
      "data-initial-cwd",
      "/repo/app",
    );
  });

  it("resolves and runs the active Java main class from the workspace toolbar", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-java-run",
      workspaceInstanceId: "instance-java-run",
      name: "Java run",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main/java/com/acme/App.java" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file(
      "src/main/java/com/acme/App.java",
      "package com.acme; class App { public static void main(String[] args) {} }",
    ));
    workspaceMocks.workspaceJavaRunTarget.mockResolvedValue({
      id: "java-main:src/main/java/com/acme/App.java",
      label: "com.acme.App",
      mainClass: "com.acme.App",
      filePath: "/repo/app/src/main/java/com/acme/App.java",
      command: "./mvnw -q -Dexec.mainClass='com.acme.App' compile exec:java",
      cwd: "/repo/app",
      buildSystem: "maven",
      modulePath: ".",
    });

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/main/java/com/acme/App.java");
    fireEvent.click(screen.getByTestId("code-workspace-run-target"));

    await waitFor(() => expect(workspaceMocks.workspaceJavaRunTarget).toHaveBeenCalledWith(
      "/repo/app",
      "src/main/java/com/acme/App.java",
      undefined,
    ));
    expect(screen.getByRole("tab", { name: /Terminal/, selected: true })).toBeInTheDocument();
    expect(await screen.findByTestId("mock-workspace-terminal")).toHaveAttribute(
      "data-initial-cwd",
      "/repo/app",
    );
  });

  it("ingests structured test results after the Java test terminal exits", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-java-test-results",
      workspaceInstanceId: "instance-java-test-results",
      name: "Java test results",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/test/java/com/acme/CalcTest.java" },
    };
    const activeStatus = documentStatus({
      path: "/repo/app/src/test/java/com/acme/CalcTest.java",
      uri: "file:///repo/app/src/test/java/com/acme/CalcTest.java",
      presetId: "java",
      languageId: "java",
      displayName: "Java",
      available: true,
      active: true,
    });
    const testItem = {
      name: "fails",
      fullName: "com.acme.CalcTest#fails",
      kind: "method",
      uri: null,
      range: null,
      children: [],
    };
    const report: StructuredTestResults = {
      schema: "taomni.codeWorkspace.testResults",
      version: 1,
      source: "junit-xml",
      generatedAt: 2,
      results: [{
        id: "target/surefire-reports/TEST.xml::com.acme.CalcTest#fails",
        selector: testItem.fullName,
        name: "fails",
        className: "com.acme.CalcTest",
        status: "failed",
        durationMs: 30,
        message: "expected 2",
        details: "stack",
        filePath: "src/test/java/com/acme/CalcTest.java",
        line: 12,
      }],
      summary: { total: 1, passed: 0, failed: 1, skipped: 0, errors: 0, durationMs: 30 },
      diagnostics: [],
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file(
      "src/test/java/com/acme/CalcTest.java",
      "package com.acme; class CalcTest {}",
    ));
    lspMocks.lspOpenDocument.mockResolvedValue(activeStatus);
    lspMocks.lspChangeDocument.mockResolvedValue(activeStatus);
    lspMocks.lspGetDiagnostics.mockResolvedValue({ status: activeStatus, diagnostics: [] });
    workspaceMocks.workspaceTaskTree.mockResolvedValue([{
      source: "Maven",
      tasks: [{
        id: "Maven:test",
        label: "test",
        command: "mvn test",
        cwd: "/repo/app",
        source: "Maven",
      }],
    }]);
    lspMocks.javaTestDiscover.mockResolvedValue([testItem]);
    workspaceMocks.workspaceTestResults.mockResolvedValue(report);

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/test/java/com/acme/CalcTest.java");
    fireEvent.click(screen.getByRole("tab", { name: /Tests/ }));
    const runButton = await screen.findByTestId(`tests-run-${testItem.fullName}`);
    fireEvent.click(runButton);
    await screen.findByTestId("mock-workspace-terminal");
    fireEvent.click(screen.getByTestId("mock-workspace-terminal-task-exit"));

    await waitFor(() => expect(workspaceMocks.workspaceTestResults).toHaveBeenCalledWith(
      "/repo/app",
      expect.any(Number),
    ));
    expect(workspaceMocks.workspaceTestResults.mock.calls[0][1]).toBeLessThanOrEqual(Date.now());
  });

  it("keeps a shared Java debug-only configuration ahead of compatibility discovery", async () => {
    runtimeState.tauri = true;
    const sourcePath = "/repo/app/src/main/java/com/acme/App.java";
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-java-shared-debug",
      workspaceInstanceId: "instance-java-shared-debug",
      name: "Java shared debug",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main/java/com/acme/App.java" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file(
      "src/main/java/com/acme/App.java",
      "package com.acme; class App { public static void main(String[] args) {} }",
    ));
    workspaceMocks.workspaceJavaRunTarget.mockResolvedValue({
      id: "java-main:src/main/java/com/acme/App.java",
      label: "com.acme.App",
      mainClass: "com.acme.App",
      filePath: sourcePath,
      command: "./mvnw compile exec:java",
      cwd: "/repo/app",
      buildSystem: "maven",
      modulePath: ".",
    });
    workspaceMocks.workspaceExecutionModel.mockResolvedValue({
      projects: [{
        id: "project:maven",
        provider: "maven",
        root: "/repo/app",
        manifest: "/repo/app/pom.xml",
        module: "app",
        languages: ["java"],
        toolchain: "maven",
        diagnostics: [],
      }],
      buildTargets: [],
      runConfigurations: [{
        id: "shared-run:remote",
        projectId: "project:maven",
        label: "Remote JVM",
        kind: "debug-only",
        configurationSource: "shared",
        sourceFile: sourcePath,
        preLaunchTargets: [],
        debugConfigurationId: "shared-debug:remote",
        command: {
          executable: "__taomni_debug_only__",
          args: [],
          cwd: "/repo/app",
          env: {},
          display: "Debug only",
          source: "configured",
          error: "This configuration is debug-only; choose Debug to launch it",
        },
      }],
      debugConfigurations: [{
        id: "shared-debug:remote",
        projectId: "project:maven",
        label: "Remote JVM",
        adapterId: "java",
        request: "attach",
        available: true,
        preLaunchTargets: [],
        sourceFile: sourcePath,
        configurationSource: "shared",
        launchConfig: { request: "attach", arguments: { hostName: "127.0.0.1", port: 5005 } },
      }],
      tools: [],
    });
    dapMocks.dapStartSession.mockResolvedValue({
      sessionId: "shared-java-session",
      capabilities: {},
      request: "attach",
      arguments: { hostName: "127.0.0.1", port: 5005 },
    });

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/main/java/com/acme/App.java");
    await waitFor(() => expect(screen.getByTestId("code-workspace-active-run-configuration")).toHaveValue("shared-run:remote"));
    expect(screen.getByTestId("code-workspace-run-target")).toBeDisabled();
    expect(screen.getByTestId("code-workspace-debug-target")).toBeEnabled();

    fireEvent.click(screen.getByTestId("code-workspace-debug-target"));
    await waitFor(() => expect(dapMocks.dapStartSession).toHaveBeenCalledWith(
      "java",
      expect.objectContaining({ request: "attach" }),
    ));
    expect(workspaceMocks.workspaceJavaRunTarget).toHaveBeenCalled();
  });

  it("uses provider capabilities to run and debug an active non-Java target", async () => {
    runtimeState.tauri = true;
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-go-run",
      workspaceInstanceId: "instance-go-run",
      name: "Go run",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "cmd/demo/main.go" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file(
      "cmd/demo/main.go",
      "package main\nfunc main() {}\n",
    ));
    workspaceMocks.workspaceExecutionModel.mockResolvedValue({
      projects: [{
        id: "project:go",
        provider: "go",
        root: "/repo/app",
        manifest: "/repo/app/go.mod",
        module: "app",
        languages: ["go"],
        toolchain: "go",
        diagnostics: [],
      }],
      buildTargets: [],
      runConfigurations: [{
        id: "run:go",
        projectId: "project:go",
        label: "Run ./cmd/demo",
        kind: "main-package",
        sourceFile: "/repo/app/cmd/demo/main.go",
        preLaunchTargets: [],
        debugConfigurationId: "debug:go",
        command: {
          executable: "go",
          args: ["run", "./cmd/demo", "--"],
          cwd: "/repo/app",
          env: {},
          display: "go run ./cmd/demo --",
          source: "path",
        },
      }],
      debugConfigurations: [{
        id: "debug:go",
        projectId: "project:go",
        label: "Debug ./cmd/demo",
        adapterId: "delve",
        request: "launch",
        available: true,
        preLaunchTargets: [],
        sourceFile: "/repo/app/cmd/demo/main.go",
        launchConfig: {
          adapterCommand: "dlv",
          adapterCwd: "/repo/app",
          mode: { kind: "managedTcp", args: ["dap", "--listen=127.0.0.1:${port}"] },
          arguments: { mode: "debug", program: "/repo/app/cmd/demo" },
        },
      }],
      tools: [],
    });
    dapMocks.dapStartSession.mockResolvedValue({
      sessionId: "go-session",
      capabilities: {},
      request: "launch",
      arguments: { mode: "debug", program: "/repo/app/cmd/demo" },
    });

    renderWorkspace(workspace);
    await screen.findByTitle("app / cmd/demo/main.go");
    await waitFor(() => expect(screen.getByTestId("code-workspace-run-target")).toBeEnabled());
    fireEvent.click(screen.getByTestId("code-workspace-run-target"));
    expect(await screen.findByTestId("mock-workspace-terminal")).toHaveAttribute("data-initial-cwd", "/repo/app");

    fireEvent.click(screen.getByTestId("code-workspace-debug-target"));
    await waitFor(() => expect(dapMocks.dapStartSession).toHaveBeenCalledWith(
      "delve",
      expect.objectContaining({ adapterCommand: "dlv", adapterCwd: "/repo/app" }),
    ));
  });

  it("keeps project-level configurations scoped to the active workspace root", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/one",
      workspaceId: "ws-multi-root-config",
      workspaceInstanceId: "instance-multi-root-config",
      name: "Multi-root configurations",
      roots: [
        { id: "one", name: "one", path: "/repo/one", kind: "git" },
        { id: "two", name: "two", path: "/repo/two", kind: "git" },
      ],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "one", path: "src/main.go" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file(
      "src/main.go",
      "package main\nfunc main() {}\n",
    ));
    workspaceMocks.workspaceExecutionModel.mockResolvedValue({
      projects: [
        {
          id: "project:one",
          provider: "go",
          root: "/repo/one",
          manifest: "/repo/one/go.mod",
          module: "one",
          languages: ["go"],
          toolchain: "go",
          diagnostics: [],
        },
        {
          id: "project:two",
          provider: "go",
          root: "/repo/two",
          manifest: "/repo/two/go.mod",
          module: "two",
          languages: ["go"],
          toolchain: "go",
          diagnostics: [],
        },
      ],
      buildTargets: [],
      runConfigurations: [
        {
          id: "shared-run:one",
          projectId: "project:one",
          label: "One project launch",
          kind: "project",
          configurationSource: "shared",
          preLaunchTargets: [],
          command: {
            executable: "go",
            args: ["run", "."],
            cwd: "/repo/one",
            env: {},
            display: "go run .",
            source: "path",
          },
        },
        {
          id: "shared-run:two",
          projectId: "project:two",
          label: "Two project launch",
          kind: "project",
          configurationSource: "shared",
          preLaunchTargets: [],
          command: {
            executable: "go",
            args: ["run", "."],
            cwd: "/repo/two",
            env: {},
            display: "go run .",
            source: "path",
          },
        },
        {
          id: "shared-run:one-alt",
          projectId: "project:one",
          label: "One alternate launch",
          kind: "project",
          configurationSource: "shared",
          preLaunchTargets: [],
          command: {
            executable: "go",
            args: ["run", "./cmd/alternate"],
            cwd: "/repo/one",
            env: {},
            display: "go run ./cmd/alternate",
            source: "path",
          },
        },
      ],
      debugConfigurations: [],
      tools: [],
    });

    renderWorkspace(workspace);
    await screen.findByTitle("one / src/main.go");
    await waitFor(() => expect(screen.getByTestId("code-workspace-active-run-configuration")).toBeInTheDocument());
    const selector = screen.getByTestId("code-workspace-active-run-configuration");
    expect(selector).toHaveTextContent("One project launch");
    expect(selector).not.toHaveTextContent("Two project launch");
  });

  it("starts a Java debug session from the toolbar under StrictMode", async () => {
    // Regression: the tab's mounted-guard ref was cleared by StrictMode's dev
    // double-invoke and never re-armed, so `if (!mountedRef.current) return`
    // aborted the launch right after the main class was resolved — the click
    // resolved the class, then silently did nothing (no session, no message).
    runtimeState.tauri = true;
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-java-debug",
      workspaceInstanceId: "instance-java-debug",
      name: "Java debug",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main/java/com/acme/App.java" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file(
      "src/main/java/com/acme/App.java",
      "package com.acme; class App { public static void main(String[] args) {} }",
    ));
    dapMocks.dapResolveJavaMainClasses.mockResolvedValue({
      kind: "resolved",
      main: {
        mainClass: "com.acme.App",
        projectName: "app",
        filePath: "/repo/app/src/main/java/com/acme/App.java",
      },
    });
    dapMocks.dapStartSession.mockResolvedValue({
      sessionId: "sess-1",
      capabilities: {},
      request: "launch",
      arguments: { mainClass: "com.acme.App" },
    });

    renderWorkspace(workspace, {}, { strict: true });
    await screen.findByTitle("app / src/main/java/com/acme/App.java");
    fireEvent.click(screen.getByTestId("code-workspace-debug-target"));

    await waitFor(() => expect(dapMocks.dapStartSession).toHaveBeenCalledWith(
      "java",
      expect.objectContaining({
        rootPath: "/repo/app",
        filePath: "/repo/app/src/main/java/com/acme/App.java",
        mainClass: "com.acme.App",
        projectName: "app",
      }),
    ));
    // Make-before-launch must run as an incremental build (jdtls autobuilds on
    // save; a clean rebuild would add minutes to every debug start) and must
    // target the file being launched: the jdtls session key includes the
    // nearest module walking up from the path, so a synthetic root-level path
    // misses the module session in a multi-module build and the build is
    // skipped with "no language server session is active".
    expect(lspMocks.lspBuildWorkspace).toHaveBeenCalledWith(
      expect.objectContaining({
        rootPath: "/repo/app",
        filePath: "src/main/java/com/acme/App.java",
      }),
      false,
    );
    // The panel reports each pre-launch step, so a slow start is never blank.
    const consoleOutput = await screen.findByTestId("debug-console-output");
    expect(consoleOutput.textContent).toContain("Starting debug for App.java");
    expect(consoleOutput.textContent).toContain("Building project…");
    expect(consoleOutput.textContent).toContain("Launching com.acme.App…");
  });

  it("releases a workspace's store instance when the tab is rebound to another", async () => {
    // The StrictMode-safe teardown defers disposal by a macrotask so a remount
    // can cancel it. Only a remount of the SAME workspace may cancel: rebinding
    // the tab to a different workspace must still release the old instance, or
    // its entry (open files, editor groups, LSP state) leaks for the session.
    const first: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/one",
      workspaceId: "ws-rebind-1",
      workspaceInstanceId: "instance-rebind-1",
      name: "One",
      roots: [{ id: "one", name: "one", path: "/repo/one", kind: "git" }],
      looseFiles: [],
    };
    const second: CodeWorkspaceTabInfo = {
      ...first,
      repoRoot: "/repo/two",
      workspaceId: "ws-rebind-2",
      workspaceInstanceId: "instance-rebind-2",
      name: "Two",
      roots: [{ id: "two", name: "two", path: "/repo/two", kind: "git" }],
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([]);

    const view = render(<CodeWorkspaceTab tabId="tab-code" workspace={first} visible />);
    await waitFor(() => expect(
      useCodeWorkspaceStore.getState().byInstanceId["instance-rebind-1"],
    ).toBeTruthy());

    view.rerender(<CodeWorkspaceTab tabId="tab-code" workspace={second} visible />);
    await waitFor(() => expect(
      useCodeWorkspaceStore.getState().byInstanceId["instance-rebind-1"],
    ).toBeUndefined());
    expect(useCodeWorkspaceStore.getState().byInstanceId["instance-rebind-2"]).toBeTruthy();
  });

  it("blocks a Java debug launch when the pre-launch build fails", async () => {
    // A failed build must say so rather than launching stale bytecode.
    runtimeState.tauri = true;
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-java-debug-build-fail",
      workspaceInstanceId: "instance-java-debug-build-fail",
      name: "Java debug build fail",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main/java/com/acme/App.java" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file(
      "src/main/java/com/acme/App.java",
      "package com.acme; class App { public static void main(String[] args) {} }",
    ));
    lspMocks.lspBuildWorkspace.mockResolvedValue("failed");

    renderWorkspace(workspace, {}, { strict: true });
    await screen.findByTitle("app / src/main/java/com/acme/App.java");
    fireEvent.click(screen.getByTestId("code-workspace-debug-target"));

    const consoleOutput = await screen.findByTestId("debug-console-output");
    await waitFor(() => expect(consoleOutput.textContent).toContain(
      "Cannot start debug: the project build failed",
    ));
    expect(dapMocks.dapResolveJavaMainClasses).not.toHaveBeenCalled();
    expect(dapMocks.dapStartSession).not.toHaveBeenCalled();
  });

  it("blocks a Java debug launch when the build compiles with errors and opens Problems", async () => {
    // `withError` is the compiler's own verdict (jdtls BuildWorkspaceStatus):
    // surface the real error list in project-scope Problems instead of launching.
    runtimeState.tauri = true;
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-java-debug-with-error",
      workspaceInstanceId: "instance-java-debug-with-error",
      name: "Java debug with error",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main/java/com/acme/App.java" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file(
      "src/main/java/com/acme/App.java",
      "package com.acme; class App { public static void main(String[] args) {} }",
    ));
    lspMocks.lspBuildWorkspace.mockResolvedValue("withError");

    renderWorkspace(workspace, {}, { strict: true });
    await screen.findByTitle("app / src/main/java/com/acme/App.java");
    fireEvent.click(screen.getByTestId("code-workspace-debug-target"));

    const consoleOutput = await screen.findByTestId("debug-console-output");
    await waitFor(() => expect(consoleOutput.textContent).toContain(
      "Cannot start debug: the project compiled with errors",
    ));
    expect(dapMocks.dapResolveJavaMainClasses).not.toHaveBeenCalled();
    expect(dapMocks.dapStartSession).not.toHaveBeenCalled();
  });

  it("recovers and launches when incremental build reports withError but full rebuild succeeds", async () => {
    runtimeState.tauri = true;
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-java-debug-rebuild-recover",
      workspaceInstanceId: "instance-java-debug-rebuild-recover",
      name: "Java debug rebuild recover",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main/java/com/acme/App.java" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file(
      "src/main/java/com/acme/App.java",
      "package com.acme; class App { public static void main(String[] args) {} }",
    ));
    lspMocks.lspBuildWorkspace
      .mockResolvedValueOnce("withError")
      .mockResolvedValueOnce("succeed");
    dapMocks.dapResolveJavaMainClasses.mockResolvedValue({
      kind: "resolved",
      main: {
        mainClass: "com.acme.App",
        projectName: "app",
        filePath: "/repo/app/src/main/java/com/acme/App.java",
      },
    });
    dapMocks.dapStartSession.mockResolvedValue({
      sessionId: "sess-recover",
      capabilities: {},
      request: "launch",
      arguments: { mainClass: "com.acme.App" },
    });

    renderWorkspace(workspace, {}, { strict: true });
    await screen.findByTitle("app / src/main/java/com/acme/App.java");
    fireEvent.click(screen.getByTestId("code-workspace-debug-target"));

    const consoleOutput = await screen.findByTestId("debug-console-output");
    await waitFor(() => expect(consoleOutput.textContent).toContain("Rebuilding project…"));
    await waitFor(() => expect(dapMocks.dapResolveJavaMainClasses).toHaveBeenCalled());
    await waitFor(() => expect(dapMocks.dapStartSession).toHaveBeenCalled());
  });

  it("launches on a clean build even when stale workspace diagnostics report errors", async () => {
    // Regression: the barrier swept EVERY published diagnostic in the workspace
    // instance, so a stale or foreign-language severity-1 entry blocked the
    // launch and flipped the bottom dock onto Problems for projects that
    // compile clean. The build status is the compiler verdict — trust it.
    runtimeState.tauri = true;
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-java-debug-stale-diags",
      workspaceInstanceId: "instance-java-debug-stale-diags",
      name: "Java debug stale diags",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main/java/com/acme/App.java" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file(
      "src/main/java/com/acme/App.java",
      "package com.acme; class App { public static void main(String[] args) {} }",
    ));
    lspMocks.lspBuildWorkspace.mockResolvedValue("succeed");
    lspMocks.lspWorkspaceDiagnostics.mockResolvedValue([
      {
        path: "/repo/app/legacy/Stale.java",
        uri: "file:///repo/app/legacy/Stale.java",
        diagnostics: [{
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
          severity: 1,
          code: null,
          source: "jdtls",
          message: "stale unresolved import",
        }],
      },
    ]);
    dapMocks.dapResolveJavaMainClasses.mockResolvedValue({
      kind: "resolved",
      main: {
        mainClass: "com.acme.App",
        projectName: "app",
        filePath: "/repo/app/src/main/java/com/acme/App.java",
      },
    });
    dapMocks.dapStartSession.mockResolvedValue({
      sessionId: "sess-1",
      capabilities: {},
      request: "launch",
      arguments: { mainClass: "com.acme.App" },
    });

    renderWorkspace(workspace, {}, { strict: true });
    await screen.findByTitle("app / src/main/java/com/acme/App.java");
    fireEvent.click(screen.getByTestId("code-workspace-debug-target"));

    await waitFor(() => expect(dapMocks.dapStartSession).toHaveBeenCalledWith(
      "java",
      expect.objectContaining({ mainClass: "com.acme.App" }),
    ));
    // The dock stays on the Debug console; Problems is not hijacked.
    await waitFor(() => expect(
      screen.getByTestId("code-workspace-bottom-tab-debug"),
    ).toHaveAttribute("aria-selected", "true"));
    expect(screen.getByTestId("code-workspace-bottom-tab-problems")).not.toHaveAttribute("data-active");
  });

  it("retains a same-file split buffer until the final view closes, then releases it once", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-split",
      workspaceInstanceId: "instance-split",
      name: "Split",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Program.cs" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/Program.cs", "class Program {}"));
    lspMocks.lspDetectServers.mockResolvedValue([csharpStatus({ available: true, active: true })]);
    lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({ available: true, active: true }));

    renderWorkspace(workspace);
    await screen.findAllByText("Program.cs");
    await waitFor(() => expect(lspMocks.lspOpenDocument).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByTestId("code-workspace-split-right"));

    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-split").splitOrientation,
    ).toBe("vertical"));
    expect(await screen.findByTestId("code-workspace-editor-split")).toBeInTheDocument();
    expect(screen.getAllByTestId("code-workspace-editor-pane")).toHaveLength(2);
    // §8.16.4 N6.6: a split materializes two recursive leaves sharing one buffer.
    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-split");
    const tree = ui.layoutTreeV2;
    expect(tree?.type).toBe("split");
    if (tree?.type === "split") {
      const leafActiveKeys = tree.children
        .filter((child) => child.type === "leaf")
        .map((child) => child.activeKey);
      expect(leafActiveKeys).toHaveLength(2);
      expect(leafActiveKeys[0]).toBe(leafActiveKeys[1]);
    }
    expect(Object.keys(ui.openFiles)).toHaveLength(1);

    const fileKey = "root:app:src/Program.cs";
    fireEvent.click(within(screen.getAllByTestId("code-workspace-editor-pane")[0]).getByTitle("Close"));
    await waitFor(() => expect(Object.values(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-split").editorGroups,
    ).filter((group) => group.openOrder.includes(fileKey))).toHaveLength(1));
    expect(lspMocks.lspCloseDocument).not.toHaveBeenCalled();
    expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-split").openFiles[fileKey]).toBeDefined();

    const remainingPane = screen.getAllByTestId("code-workspace-editor-pane").find(
      (pane) => within(pane).queryByTitle("Close") !== null,
    );
    expect(remainingPane).toBeDefined();
    fireEvent.click(within(remainingPane!).getByTitle("Close"));
    await waitFor(() => expect(lspMocks.lspCloseDocument).toHaveBeenCalledTimes(1));
    expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-split").openFiles[fileKey]).toBeUndefined();
  });

  // ED-AUDIT-009 A1: two real leaves of one file share ONE logical history —
  // an edit in either leaf reaches the other in real time without clobbering
  // its caret/scroll, and one undo/redo stroke issued from one leaf reverts
  // (re-applies) in both leaves through the production keymap routing.
  it("ED-AUDIT-009: same-file split leaves share one edit/undo history in real time", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-audit009-split",
      workspaceInstanceId: "instance-audit009-split",
      name: "Audit009 Split",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, _path: string) => (
      file("src/main.ts", "alpha\nbeta\n")
    ));
    lspMocks.lspDetectServers.mockResolvedValue([csharpStatus({ available: false, active: false })]);
    window.localStorage.setItem("taomni.codeWorkspace.layout.v1.instance-audit009-split", JSON.stringify({
      version: 1,
      splitOrientation: "vertical",
      activeEditorGroupId: "primary",
      editorGroups: {
        primary: {
          openOrder: ["root:app:src/main.ts"],
          activeKey: "root:app:src/main.ts",
          previewKey: null,
          pinnedKeys: [],
        },
        secondary: {
          openOrder: ["root:app:src/main.ts"],
          activeKey: "root:app:src/main.ts",
          previewKey: null,
          pinnedKeys: [],
        },
      },
    }));

    renderWorkspace(workspace);
    await screen.findAllByTitle("app / src/main.ts");

    const panes = screen.getAllByTestId("code-workspace-editor-pane");
    const primaryPane = panes.find((pane) => pane.getAttribute("data-editor-group-id") === "primary")!;
    const secondaryPane = panes.find((pane) => pane.getAttribute("data-editor-group-id") === "secondary")!;
    const primaryView = EditorView.findFromDOM(primaryPane.querySelector<HTMLElement>(".cm-editor")!)!;
    const secondaryView = EditorView.findFromDOM(secondaryPane.querySelector<HTMLElement>(".cm-editor")!)!;
    // History strokes target the editor surface (.cm-content): a pane-div
    // target resolves as workspace focus, so the requiresEditor history
    // actions are rejected before the shared owner is ever consulted.
    const primaryContent = primaryPane.querySelector<HTMLElement>(".cm-content")!;
    const secondaryContent = secondaryPane.querySelector<HTMLElement>(".cm-content")!;

    // Edit in the primary leaf: the secondary leaf shows it in real time.
    primaryView.dispatch({ changes: { from: 0, to: 0, insert: "HEAD;" } });
    await waitFor(() => expect(secondaryView.state.doc.toString()).toBe("HEAD;alpha\nbeta\n"));
    expect(primaryView.state.doc.toString()).toBe("HEAD;alpha\nbeta\n");

    // Park the primary caret mid-document and scroll it away from the top;
    // the secondary leaf's edit must not clobber either.
    primaryView.dispatch({ selection: EditorSelection.cursor(5) });
    const primaryScroller = primaryPane.querySelector<HTMLElement>(".cm-scroller")!;
    primaryScroller.scrollTop = 40;
    secondaryView.dispatch({
      changes: { from: "HEAD;alpha\nbeta\n".length, to: "HEAD;alpha\nbeta\n".length, insert: "TAIL;" },
    });
    await waitFor(() => expect(primaryView.state.doc.toString()).toBe("HEAD;alpha\nbeta\nTAIL;"));
    expect(secondaryView.state.doc.toString()).toBe("HEAD;alpha\nbeta\nTAIL;");
    expect(primaryView.state.selection.main.head).toBe(5);
    expect(primaryScroller.scrollTop).toBe(40);

    // One Ctrl+Z in the SECONDARY leaf reverts the shared history in BOTH leaves.
    fireEvent.keyDown(secondaryContent, { key: "z", ctrlKey: true });
    await waitFor(() => expect(primaryView.state.doc.toString()).toBe("HEAD;alpha\nbeta\n"));
    expect(secondaryView.state.doc.toString()).toBe("HEAD;alpha\nbeta\n");

    // One redo from the PRIMARY leaf re-applies the same shared entry in both.
    fireEvent.keyDown(primaryContent, { key: "z", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(primaryView.state.doc.toString()).toBe("HEAD;alpha\nbeta\nTAIL;"));
    expect(secondaryView.state.doc.toString()).toBe("HEAD;alpha\nbeta\nTAIL;");
  });

  // ED-AUDIT-009 A2: closing a non-last leaf keeps text AND history in the
  // survivor (no didClose, no save); the last dirty view's cancel is a zero
  // effect; confirming the discard closes without writing; the closed-tab
  // reopen reads the saved disk bytes — discarded text is not revived.
  it("ED-AUDIT-009: split close keeps survivor history, dirty cancel is zero effect, reopen reads saved bytes", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-audit009-close",
      workspaceInstanceId: "instance-audit009-close",
      name: "Audit009 Close",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, _path: string) => (
      file("src/main.ts", "alpha\nbeta\n")
    ));
    lspMocks.lspDetectServers.mockResolvedValue([csharpStatus({ available: true, active: true })]);
    lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({ available: true, active: true }));

    renderWorkspace(workspace);
    await screen.findAllByTitle("app / src/main.ts");
    await waitFor(() => expect(lspMocks.lspOpenDocument).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByTestId("code-workspace-split-right"));
    await waitFor(() => expect(screen.getAllByTestId("code-workspace-editor-pane")).toHaveLength(2));

    const panes = screen.getAllByTestId("code-workspace-editor-pane");
    const primaryPane = panes.find((pane) => pane.getAttribute("data-editor-group-id") === "primary")!;
    // A live split generates a fresh leaf id for the new pane (unlike the
    // seeded V1 snapshot's "secondary"), so select it by set difference.
    const splitPane = panes.find((pane) => pane.getAttribute("data-editor-group-id") !== "primary")!;
    const primaryView = EditorView.findFromDOM(primaryPane.querySelector<HTMLElement>(".cm-editor")!)!;
    const splitView = EditorView.findFromDOM(splitPane.querySelector<HTMLElement>(".cm-editor")!)!;

    // A dirty edit in the primary leaf reaches the split leaf.
    primaryView.dispatch({ changes: { from: 0, to: 0, insert: "DIRTY;" } });
    await waitFor(() => expect(splitView.state.doc.toString()).toBe("DIRTY;alpha\nbeta\n"));

    // Close the primary tab: the other leaf still holds the buffer, so no
    // discard confirm appears, no didClose fires, and nothing is written.
    // The emptied leaf keeps rendering (it loses only its tab strip entry).
    fireEvent.click(within(primaryPane).getByTitle("Close"));
    await waitFor(() => expect(
      within(primaryPane).queryByTitle("app / src/main.ts"),
    ).not.toBeInTheDocument());
    expect(lspMocks.lspCloseDocument).not.toHaveBeenCalled();
    expect(confirmAppDialog).not.toHaveBeenCalled();
    expect(workspaceMocks.workspaceWriteFile).not.toHaveBeenCalled();

    // Re-resolve the survivor: the leaf that still holds the tab.
    const survivorPane = screen.getAllByTestId("code-workspace-editor-pane").find(
      (pane) => within(pane).queryByTitle("app / src/main.ts") !== null,
    )!;
    const survivorView = EditorView.findFromDOM(survivorPane.querySelector<HTMLElement>(".cm-editor")!)!;
    expect(survivorView.state.doc.toString()).toBe("DIRTY;alpha\nbeta\n");
    // History strokes go through the editor surface (.cm-content): a pane-div
    // target resolves as workspace focus and the requiresEditor history
    // actions are rejected before the shared owner is consulted.
    const survivorContent = () => survivorPane.querySelector<HTMLElement>(".cm-content")!;

    // The survivor keeps the shared history: undo reverts the pre-close edit.
    fireEvent.keyDown(survivorContent(), { key: "z", ctrlKey: true });
    await waitFor(() => expect(survivorView.state.doc.toString()).toBe("alpha\nbeta\n"));
    // Redo makes the buffer dirty again for the cancel segment.
    fireEvent.keyDown(survivorContent(), { key: "z", ctrlKey: true, shiftKey: true });
    await waitFor(() => expect(survivorView.state.doc.toString()).toBe("DIRTY;alpha\nbeta\n"));

    // Close the LAST dirty view: cancel must have zero effect.
    vi.mocked(confirmAppDialog).mockImplementationOnce(async () => false);
    fireEvent.click(within(survivorPane).getByTitle("Close"));
    await waitFor(() => expect(vi.mocked(confirmAppDialog)).toHaveBeenCalledTimes(1));
    expect(within(survivorPane).getByTitle("app / src/main.ts")).toBeInTheDocument();
    expect(survivorView.state.doc.toString()).toBe("DIRTY;alpha\nbeta\n");
    expect(workspaceMocks.workspaceWriteFile).not.toHaveBeenCalled();
    expect(lspMocks.lspCloseDocument).not.toHaveBeenCalled();

    // Confirming the discard closes the last view — still without writing.
    fireEvent.click(within(survivorPane).getByTitle("Close"));
    await waitFor(() => expect(lspMocks.lspCloseDocument).toHaveBeenCalledTimes(1));
    expect(screen.queryByTitle("app / src/main.ts")).not.toBeInTheDocument();
    expect(workspaceMocks.workspaceWriteFile).not.toHaveBeenCalled();

    // Reopen (Ctrl+Shift+T) reads the saved disk bytes: the discarded dirty
    // text is not revived and the read is a fresh decode of the same file.
    fireEvent.keyDown(window, { key: "T", ctrlKey: true, shiftKey: true });
    const reopened = await screen.findByTitle("app / src/main.ts");
    expect(reopened).toBeInTheDocument();
    await waitFor(() => expect(
      EditorView.findFromDOM(
        screen.getAllByTestId("code-workspace-editor-pane")
          .find((pane) => within(pane).queryByTitle("app / src/main.ts") !== null)!
          .querySelector<HTMLElement>(".cm-editor")!,
      )!.state.doc.toString(),
    ).toBe("alpha\nbeta\n"));
    expect(workspaceMocks.workspaceWriteFile).not.toHaveBeenCalled();
  });

  it("keeps the committed layout and buffer recovery state when final-view didClose fails", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-close-recovery",
      workspaceInstanceId: "instance-close-recovery",
      name: "Close Recovery",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Program.cs" },
    };
    const fileKey = "root:app:src/Program.cs";
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/Program.cs", "class Program {}"));
    lspMocks.lspDetectServers.mockResolvedValue([csharpStatus({ available: true, active: true })]);
    lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({ available: true, active: true }));
    lspMocks.lspCloseDocument.mockRejectedValueOnce(new Error("didClose transport failed"));

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/Program.cs");
    await waitFor(() => expect(lspMocks.lspOpenDocument).toHaveBeenCalledTimes(1));
    fireEvent.keyDown(window, { key: "F4", ctrlKey: true });

    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-close-recovery")
        .editorGroups.primary.openOrder,
    ).toHaveLength(0));
    await waitFor(() => expect(useAppStore.getState().statusMessage).toMatch(
      /committed with recovery resource-recovery-instance-close-recovery-1/,
    ));
    expect(lspMocks.lspCloseDocument).toHaveBeenCalledTimes(1);
    expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-close-recovery").openFiles[fileKey],
    ).toBeDefined();

    const recovery = screen.getByTestId("workspace-resource-cleanup-recovery");
    expect(recovery).toHaveAttribute("role", "status");
    const recoveryItem = screen.getByTestId("workspace-resource-cleanup-recovery-item");
    expect(recoveryItem).toHaveAttribute("data-recovery-id", "resource-recovery-instance-close-recovery-1");
    expect(recoveryItem).toHaveAttribute("data-next-stage", "didClose");
    expect(recoveryItem).toHaveAttribute("data-attempt-count", "1");
    expect(recovery).toHaveTextContent("didClose transport failed");

    const retry = screen.getByRole("button", { name: `Retry resource cleanup for ${fileKey}` });
    fireEvent.click(retry);
    await waitFor(() => expect(lspMocks.lspCloseDocument).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("workspace-resource-cleanup-recovery")).not.toBeInTheDocument());
    expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-close-recovery").openFiles[fileKey],
    ).toBeUndefined();
    expect(useAppStore.getState().statusMessage).toContain("Completed resource cleanup recovery");
  });

  it("exposes and replays cleanup recovery from a committed tab policy eviction", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-policy-recovery",
      workspaceInstanceId: "instance-policy-recovery",
      name: "Policy Recovery",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "A.cs" },
    };
    const firstKey = "root:app:A.cs";
    const secondKey = "root:app:B.cs";
    workspaceMocks.workspaceListDir.mockResolvedValue([
      entry("A.cs", "A.cs"),
      entry("B.cs", "B.cs"),
    ]);
    workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => (
      file(path, path === "A.cs" ? "class A {}" : "class B {}")
    ));
    lspMocks.lspDetectServers.mockResolvedValue([csharpStatus({ available: true, active: true })]);
    lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({ available: true, active: true }));

    renderWorkspace(workspace);
    await screen.findByTitle("app / A.cs");
    const secondRow = (await screen.findAllByTestId("code-workspace-tree-file")).find(
      (row) => row.getAttribute("data-path") === "B.cs",
    );
    expect(secondRow).toBeDefined();
    fireEvent.click(secondRow!);
    await screen.findByTitle("app / B.cs");
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-policy-recovery")
        .editorGroups.primary.openOrder,
    ).toEqual([firstKey, secondKey]));

    lspMocks.lspCloseDocument.mockRejectedValueOnce(new Error("policy didClose failed"));
    fireEvent.click(screen.getByTestId("code-workspace-tab-policy-settings"));
    fireEvent.change(await screen.findByTestId("workspace-tab-policy-limit"), {
      target: { value: "1" },
    });
    fireEvent.click(screen.getByTestId("workspace-tab-policy-apply"));

    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-policy-recovery")
        .editorGroups.primary.openOrder,
    ).toEqual([secondKey]));
    const root = screen.getByTestId("code-workspace-tab");
    await waitFor(() => expect(root).toHaveAttribute("data-tab-policy-receipt-status", "applied"));
    expect(root).toHaveAttribute("data-tab-policy-receipt-evicted-count", "1");
    expect(root).toHaveAttribute("data-tab-policy-receipt-cleanup-count", "1");
    expect(root).toHaveAttribute("data-tab-policy-receipt-cleanup-recovery-count", "1");
    expect(root).toHaveAttribute("data-resource-recovery-count", "1");
    expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-policy-recovery").openFiles[firstKey],
    ).toBeDefined();
    expect(screen.getByTestId("workspace-resource-cleanup-recovery")).toHaveTextContent(
      "policy didClose failed",
    );

    fireEvent.click(screen.getByRole("button", { name: `Retry resource cleanup for ${firstKey}` }));
    await waitFor(() => expect(lspMocks.lspCloseDocument).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(root).toHaveAttribute("data-resource-recovery-count", "0"));
    expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-policy-recovery").openFiles[firstKey],
    ).toBeUndefined();
    expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-policy-recovery").openFiles[secondKey],
    ).toBeDefined();
  });

  it("closes the active editor tab with Ctrl+F4", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-close-tab",
      workspaceInstanceId: "instance-close-tab",
      name: "Close Tab",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "export const value = 1;"));

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    fireEvent.keyDown(window, { key: "F4", ctrlKey: true });

    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-close-tab")
        .editorGroups.primary.openOrder,
      ).toHaveLength(0));
  });

  it("publishes the reopen claim before delayed resource cleanup completes", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-close-reopen-race",
      workspaceInstanceId: "instance-close-reopen-race",
      name: "Close Reopen Race",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Program.cs" },
    };
    const fileKey = "root:app:src/Program.cs";
    let resolveClose!: (status: LspDocumentStatus) => void;
    const closePromise = new Promise<LspDocumentStatus>((resolve) => {
      resolveClose = resolve;
    });
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/Program.cs", "class Program {}"));
    lspMocks.lspDetectServers.mockResolvedValue([csharpStatus({ available: true, active: true })]);
    lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({ available: true, active: true }));
    lspMocks.lspCloseDocument.mockReturnValueOnce(closePromise);
    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });

    renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/Program.cs");
    await waitFor(() => expect(lspMocks.lspOpenDocument).toHaveBeenCalledTimes(1));

    fireEvent.keyDown(window, { key: "F4", ctrlKey: true });
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-close-reopen-race")
        .editorGroups.primary.openOrder,
    ).toHaveLength(0));
    await waitFor(() => expect(screen.getByTestId("code-workspace-tab"))
      .toHaveAttribute("data-reopen-stack-count", "1"));
    expect(registrationRef.current?.shellShortcutClaims).toHaveLength(1);
    expect(lspMocks.lspCloseDocument).toHaveBeenCalledTimes(1);

    await act(async () => {
      await registrationRef.current?.executeAction("workspace.reopenClosedTab");
    });
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-close-reopen-race")
        .editorGroups.primary.openOrder,
    ).toContain(fileKey));
    expect(screen.getByTestId("code-workspace-tab")).toHaveAttribute("data-reopen-stack-count", "0");

    resolveClose(documentStatus({ available: true, active: true }));
    await waitFor(() => expect(lspMocks.lspOpenDocument).toHaveBeenCalledTimes(2));
    expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-close-reopen-race",
    ).openFiles[fileKey]).toBeDefined();
  });

  it("opens the selected tree file in a split with Ctrl+Enter", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-tree-split",
      workspaceInstanceId: "instance-tree-split",
      name: "Tree Split",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("README.md", "README.md")]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("README.md", "# Readme"));

    renderWorkspace(workspace);
    const row = await screen.findByTestId("code-workspace-tree-file");
    fireEvent.click(row);
    fireEvent.keyDown(screen.getByTestId("code-workspace-tree-pane"), {
      key: "Enter",
      ctrlKey: true,
    });

    expect(await screen.findByTestId("code-workspace-editor-split")).toBeInTheDocument();
    // §8.16.4 N6.6: Ctrl+Enter opens the tree file in a new recursive leaf.
    const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-tree-split");
    const tree = ui.layoutTreeV2;
    expect(tree?.type).toBe("split");
    const leafKeys = tree?.type === "split"
      ? tree.children.flatMap((child) => (child.type === "leaf" ? [child.activeKey] : []))
      : [];
    expect(leafKeys).toContain("root:app:README.md");
  });

  it("scans open-file TODOs and toggles persistent bookmarks with F11", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-todos",
      workspaceInstanceId: "instance-todos",
      name: "TODOs",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file(
      "src/main.ts",
      "const value = 1; // TODO: replace fixture",
    ));

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.ts");
    const editor = screen.getByTestId("code-workspace-editor-pane");
    fireEvent.keyDown(editor, { key: "F11", code: "F11" });

    const panel = await screen.findByTestId("code-workspace-todos-panel");
    expect(screen.getByRole("tab", { name: /TODOs/, selected: true })).toBeInTheDocument();
    expect(panel).toHaveTextContent("replace fixture");
    expect(panel).toHaveTextContent("const value = 1");
    expect(window.localStorage.getItem("taomni.codeWorkspace.bookmarks.v1.instance-todos"))
      .toContain("root:app:src/main.ts");

    fireEvent.keyDown(editor, { key: "F11", code: "F11" });
    await waitFor(() => expect(panel).toHaveTextContent("No bookmarks yet"));
  });

  it("sets mnemonic bookmarks through the mounted prompt and replaces conflicts", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-mnemonic-mounted",
      workspaceInstanceId: "instance-mnemonic-mounted",
      name: "Mnemonic bookmarks",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file(
      "src/main.ts",
      "const first = 1;\nconst second = 2;\n",
    ));

    const rendered = renderWorkspace(workspace);
    const content = await screen.findByTestId("code-workspace-editor").then((editor) => (
      editor.querySelector<HTMLElement>(".cm-content")
    ));
    expect(content).not.toBeNull();
    const cmEditor = content?.closest<HTMLElement>(".cm-editor");
    expect(cmEditor).not.toBeNull();
    const view = EditorView.findFromDOM(cmEditor!);
    expect(view).not.toBeNull();

    vi.mocked(promptAppDialog).mockResolvedValueOnce("a");
    fireEvent.keyDown(content!, { key: "F11", code: "F11", ctrlKey: true });

    const panel = await screen.findByTestId("code-workspace-todos-panel");
    // setMnemonicBookmark writes localStorage synchronously and only then dispatches
    // replaceBookmarks, so the persisted value becomes observable one React commit
    // before the panel re-renders. Gating on storage alone and asserting the DOM
    // afterwards therefore reads a fact the gate never waited for. Both facts are
    // asserted under the same gate so the wait covers the later one too.
    await waitFor(() => {
      const saved = JSON.parse(
        window.localStorage.getItem("taomni.codeWorkspace.bookmarks.v1.instance-mnemonic-mounted") ?? "[]",
      ) as Array<{ line: number; mnemonic: string | null; group: string | null }>;
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({ line: 0, mnemonic: "A", group: "Mnemonic" });
      expect(panel).toHaveTextContent("A");
    });
    expect(promptAppDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: "Set Bookmark Mnemonic",
      label: "Mnemonic (0-9 or A-Z)",
    }));

    view!.dispatch({ selection: EditorSelection.cursor(view!.state.doc.line(2).from) });
    vi.mocked(promptAppDialog).mockResolvedValueOnce("A");
    fireEvent.keyDown(content!, { key: "F11", code: "F11", ctrlKey: true });

    await waitFor(() => {
      const saved = JSON.parse(
        window.localStorage.getItem("taomni.codeWorkspace.bookmarks.v1.instance-mnemonic-mounted") ?? "[]",
      ) as Array<{ line: number; mnemonic: string | null }>;
      expect(saved).toHaveLength(2);
      expect(saved.find((bookmark) => bookmark.line === 0)?.mnemonic).toBeNull();
      expect(saved.find((bookmark) => bookmark.line === 1)?.mnemonic).toBe("A");
      // Same ordering hazard as above: this is the row count the storage gate does
      // not imply, so it belongs inside the gate.
      expect(screen.getAllByTestId("code-workspace-bookmark-open")).toHaveLength(2);
    });
    rendered.unmount();
  });

  it("renames bookmark groups with Enter or Escape and returns focus to the group action", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-bookmark-group-focus",
      workspaceInstanceId: "instance-bookmark-group-focus",
      name: "Bookmark group focus",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "const value = 1;\n"));

    renderWorkspace(workspace);
    const editor = await screen.findByTestId("code-workspace-editor-pane");
    fireEvent.keyDown(editor, { key: "F11", code: "F11" });
    await screen.findByTestId("code-workspace-bookmark-group");

    const rename = screen.getByTestId("code-workspace-bookmark-group-rename");
    fireEvent.click(rename);
    const input = await screen.findByTestId("code-workspace-bookmark-group-input");
    expect(document.activeElement).toBe(input);
    fireEvent.change(input, { target: { value: "Review" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() => expect(screen.getByTestId("code-workspace-bookmark-group"))
      .toHaveAttribute("data-group-name", "Review"));
    expect(document.activeElement).toBe(screen.getByTestId("code-workspace-bookmark-group-rename"));
    expect(window.localStorage.getItem("taomni.codeWorkspace.bookmarks.v1.instance-bookmark-group-focus"))
      .toContain("Review");

    const renamed = screen.getByTestId("code-workspace-bookmark-group-rename");
    fireEvent.click(renamed);
    const secondInput = await screen.findByTestId("code-workspace-bookmark-group-input");
    fireEvent.change(secondInput, { target: { value: "Canceled" } });
    fireEvent.keyDown(secondInput, { key: "Escape" });

    await waitFor(() => expect(screen.getByTestId("code-workspace-bookmark-group"))
      .toHaveAttribute("data-group-name", "Review"));
    expect(document.activeElement).toBe(screen.getByTestId("code-workspace-bookmark-group-rename"));
    expect(window.localStorage.getItem("taomni.codeWorkspace.bookmarks.v1.instance-bookmark-group-focus"))
      .not.toContain("Canceled");
  });

  it("jumps to a mnemonic bookmark and uses Back to restore the origin", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-bookmark-history",
      workspaceInstanceId: "instance-bookmark-history",
      name: "Bookmark history",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/one.ts" },
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([
      entry("one.ts", "src/one.ts"),
      entry("two.ts", "src/two.ts"),
    ]);
    workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => (
      path === "src/two.ts"
        ? file(path, "zero\nmarked\n")
        : file(path, "origin\n")
    ));
    window.localStorage.setItem(
      "taomni.codeWorkspace.bookmarks.v1.instance-bookmark-history",
      JSON.stringify([{
        id: "bookmark-two",
        fileKey: "root:app:src/two.ts",
        pathLabel: "app / src/two.ts",
        line: 1,
        character: 0,
        label: "marked",
        mnemonic: "J",
        group: "Mnemonic",
        state: "current",
        createdAt: 1,
      }]),
    );
    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      registrationRef.current = next;
    });

    renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/one.ts");
    await waitFor(() => expect(registrationRef.current).not.toBeNull());

    expect(registrationRef.current?.execute("workspace.jumpToBookmarkJ")).toBe(true);
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-bookmark-history").activeKey,
    ).toBe("root:app:src/two.ts"));
    const backButton = screen.getByTestId("code-workspace-nav-back");
    await waitFor(() => expect(backButton).not.toBeDisabled());
    fireEvent.click(backButton);
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-bookmark-history").activeKey,
    ).toBe("root:app:src/one.ts"));
  });

  it("keeps a deleted bookmark as missing and restores it when the file is recreated", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-bookmark-resource-lifecycle",
      workspaceInstanceId: "instance-bookmark-resource-lifecycle",
      name: "Bookmark resource lifecycle",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
      looseFiles: [],
    };
    const disk = new Map([["src/bookmark.ts", "const bookmarked = true;\n"]]);
    const listDirectory = (_root: string, path = "") => {
      if (path === "") return [entry("src", "src", "dir")];
      if (path === "src" && disk.has("src/bookmark.ts")) return [entry("bookmark.ts", "src/bookmark.ts")];
      return [];
    };
    workspaceMocks.workspaceListDir.mockImplementation(async (root: string, path = "") => listDirectory(root, path));
    workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => {
      const text = disk.get(path);
      if (text === undefined) throw new Error(`missing fixture ${path}`);
      return file(path, text);
    });
    workspaceMocks.workspaceApplyResourceOperation.mockImplementation(async (
      _root: string,
      operation: { kind: string; path?: string },
    ) => {
      if (operation.kind === "delete" && operation.path) disk.delete(operation.path);
      return { ignored: false };
    });
    workspaceMocks.workspaceCreateFile.mockImplementation(async (_root: string, path: string) => {
      const text = "const recreated = true;\n";
      disk.set(path, text);
      return file(path, text);
    });

    renderWorkspace(workspace);
    const directory = await screen.findByTestId("code-workspace-tree-dir");
    fireEvent.click(directory);
    const row = await screen.findByTestId("code-workspace-tree-file");
    fireEvent.click(row);
    await screen.findByTitle("app / src/bookmark.ts");
    const editor = screen.getByTestId("code-workspace-editor-pane");
    fireEvent.keyDown(editor, { key: "F11", code: "F11" });
    await screen.findByTestId("code-workspace-bookmark-item");

    // The tree pane is the keyboard owner; dispatch against its focus target
    // so the test follows the mounted tree shortcut path used by the app.
    fireEvent.keyDown(screen.getByTestId("code-workspace-tree-pane"), {
      key: "Delete",
      code: "Delete",
    });
    await waitFor(() => expect(workspaceMocks.workspaceApplyResourceOperation).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId("code-workspace-bookmark-item"))
      .toHaveAttribute("data-state", "missing"));
    expect(screen.getByTestId("code-workspace-bookmark-missing")).toHaveTextContent("Missing target");
    expect(disk.has("src/bookmark.ts")).toBe(false);

    vi.mocked(promptAppDialog).mockResolvedValueOnce("src/bookmark.ts");
    fireEvent.click(screen.getByTestId("code-workspace-tree-new-file"));
    await waitFor(() => expect(screen.getByTestId("code-workspace-bookmark-item"))
      .toHaveAttribute("data-state", "current"));
    expect(disk.has("src/bookmark.ts")).toBe(true);
    expect(screen.getByTestId("code-workspace-bookmark-open")).toBeInTheDocument();
  });

  it("restores open editor tabs and dock chrome from the layout snapshot", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-layout-restore",
      workspaceInstanceId: "instance-layout-restore",
      name: "Layout Restore",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => (
      path === "src/util.ts"
        ? file("src/util.ts", "export const util = 1;")
        : path === "src/other.ts"
          ? file("src/other.ts", "export const other = 1;")
        : file("src/main.ts", "export const main = 1;")
    ));
    window.localStorage.setItem("taomni.codeWorkspace.layout.v1.instance-layout-restore", JSON.stringify({
      version: 1,
      bottomDockOpen: false,
      bottomDockTab: "search",
      rightPaneOpen: true,
      rightPaneTab: "outline",
      languagePanelOpen: false,
      splitOrientation: "vertical",
      activeEditorGroupId: "primary",
      expandedRootIds: ["app"],
      expandedDirKeys: ["app:"],
      editorGroups: {
        primary: {
          openOrder: ["root:app:src/main.ts", "root:app:src/other.ts"],
          activeKey: "root:app:src/main.ts",
          previewKey: null,
          pinnedKeys: ["root:app:src/main.ts"],
        },
        secondary: {
          openOrder: ["root:app:src/util.ts"],
          activeKey: "root:app:src/util.ts",
          previewKey: null,
          pinnedKeys: [],
        },
      },
    }));

    renderWorkspace(workspace, {}, { strict: true });

    await screen.findByTitle("app / src/main.ts");
    await screen.findByTitle("app / src/util.ts");
    await screen.findByTitle("app / src/other.ts");
    await waitFor(() => {
      const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-layout-restore");
      expect(ui.bottomDockOpen).toBe(false);
      expect(ui.bottomDockTab).toBe("search");
      expect(ui.rightPaneOpen).toBe(true);
      expect(ui.languagePanelOpen).toBe(false);
      expect(ui.splitOrientation).toBe("vertical");
      expect(ui.editorGroups.primary.openOrder).toContain("root:app:src/main.ts");
      expect(ui.editorGroups.secondary.openOrder).toContain("root:app:src/util.ts");
      expect(ui.editorGroups.primary.activeKey).toBe("root:app:src/main.ts");
      expect(ui.editorGroups.secondary.activeKey).toBe("root:app:src/util.ts");
    });
    expect(screen.getByTestId("code-workspace-project-collapsed-rail")).toBeInTheDocument();
    expect(screen.getByTestId("code-workspace-project-expand")).toBeInTheDocument();
    expect(workspaceMocks.workspaceReadFile).toHaveBeenCalledWith("/repo/app", "src/main.ts");
    expect(workspaceMocks.workspaceReadFile).toHaveBeenCalledWith("/repo/app", "src/util.ts");
    expect(workspaceMocks.workspaceReadFile).toHaveBeenCalledWith("/repo/app", "src/other.ts");
    expect(workspaceMocks.workspaceReadFile).toHaveBeenCalledTimes(3);
  });

  it("routes editor actions through ActionHost to the active recursive leaf", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-editor-actions",
      workspaceInstanceId: "instance-editor-actions",
      name: "Editor Actions",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => (
      path === "src/util.ts"
        ? file("src/util.ts", "alpha\nbeta")
        : file("src/main.ts", "first\nsecond")
    ));
    window.localStorage.setItem("taomni.codeWorkspace.layout.v1.instance-editor-actions", JSON.stringify({
      version: 1,
      splitOrientation: "vertical",
      activeEditorGroupId: "primary",
      editorGroups: {
        primary: {
          openOrder: ["root:app:src/main.ts"],
          activeKey: "root:app:src/main.ts",
          previewKey: null,
          pinnedKeys: [],
        },
        secondary: {
          openOrder: ["root:app:src/util.ts"],
          activeKey: "root:app:src/util.ts",
          previewKey: null,
          pinnedKeys: [],
        },
      },
    }));
    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      registrationRef.current = next;
    });

    renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/main.ts");
    await screen.findByTitle("app / src/util.ts");
    const { EditorView } = await import("@codemirror/view");
    const panes = screen.getAllByTestId("code-workspace-editor-pane");
    const primaryPane = panes.find((pane) => pane.getAttribute("data-editor-group-id") === "primary");
    const secondaryPane = panes.find((pane) => pane.getAttribute("data-editor-group-id") === "secondary");
    const primaryEditor = primaryPane?.querySelector<HTMLElement>(".cm-editor");
    const secondaryEditor = secondaryPane?.querySelector<HTMLElement>(".cm-editor");
    expect(primaryEditor).not.toBeNull();
    expect(secondaryEditor).not.toBeNull();
    const primaryView = EditorView.findFromDOM(primaryEditor!);
    const secondaryView = EditorView.findFromDOM(secondaryEditor!);
    expect(primaryView).not.toBeNull();
    expect(secondaryView).not.toBeNull();

    fireEvent.mouseDown(primaryPane!);
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-editor-actions")
        .activeEditorGroupId,
    ).toBe("primary"));
    await waitFor(() => expect(
      registrationRef.current?.items.find((item) => item.id === "workspace.editor.cloneCaretBelow")?.enabled,
    ).toBe(true));
    await act(async () => {
      expect((await registrationRef.current?.executeAction(
        "workspace.editor.cloneCaretBelow",
      ))?.kind).toBe("applied");
    });
    expect(primaryView!.state.selection.ranges).toHaveLength(2);
    expect(secondaryView!.state.selection.ranges).toHaveLength(1);

    fireEvent.mouseDown(secondaryPane!);
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-editor-actions")
        .activeEditorGroupId,
    ).toBe("secondary"));
    await act(async () => {
      expect((await registrationRef.current?.executeAction(
        "workspace.editor.cloneCaretBelow",
      ))?.kind).toBe("applied");
    });
    expect(primaryView!.state.selection.ranges).toHaveLength(2);
    expect(secondaryView!.state.selection.ranges).toHaveLength(2);
  });

  it("toggles the project tree from the panel-local collapse control and collapsed rail", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-tree-collapse",
      workspaceInstanceId: "instance-tree-collapse",
      name: "Tree Collapse",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
    };
    renderWorkspace(workspace);

    await screen.findByTestId("code-workspace-tree-pane");
    expect(screen.getByTestId("code-workspace-tree-collapse")).toBeInTheDocument();
    expect(screen.getByTestId("code-workspace-project-resize-handle")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("code-workspace-tree-collapse"));
    await waitFor(() => {
      expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-tree-collapse").languagePanelOpen)
        .toBe(false);
    });
    expect(screen.getByTestId("code-workspace-project-collapsed-rail")).toBeInTheDocument();
    expect(screen.getByTestId("code-workspace-project-expand")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("code-workspace-project-expand"));
    await waitFor(() => {
      expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-tree-collapse").languagePanelOpen)
        .toBe(true);
    });
    expect(screen.queryByTestId("code-workspace-project-collapsed-rail")).toBeNull();
    expect(screen.getByTestId("code-workspace-tree-collapse")).toBeInTheDocument();
  });

  it("opens the encoding chooser from workspace status and saves through the encoded writer", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-encoding-save",
      workspaceInstanceId: "instance-encoding-save",
      name: "Encoding Save",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.txt" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file(
      "src/main.txt",
      "café",
      { encoding: "UTF-8", bom: false },
    ));
    workspaceMocks.workspaceWriteFileEncoded.mockResolvedValue(writeAck(file(
      "src/main.txt",
      "café",
      { encoding: "windows-1252", bom: false, hash: "hash-latin1" },
    )));

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/main.txt");
    await waitFor(() => expect(useCodeWorkspaceStatusStore.getState().actions?.chooseEncoding)
      .toBeTypeOf("function"));

    act(() => useCodeWorkspaceStatusStore.getState().actions?.chooseEncoding?.());
    expect(await screen.findByTestId("file-encoding-dialog")).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Encoding"), { target: { value: "ISO-8859-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Convert on Save" }));

    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-encoding-save")
        .openFiles["root:app:src/main.txt"]?.dirty,
    ).toBe(true));
    fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });

    await waitFor(() => expect(workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledWith(
      "/repo/app",
      "src/main.txt",
      "café",
      "hash-src/main.txt",
      "ISO-8859-1",
      false,
    ));
    expect(workspaceMocks.workspaceWriteFile).not.toHaveBeenCalled();
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-encoding-save")
        .openFiles["root:app:src/main.txt"]?.dirty,
    ).toBe(false));
    expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-encoding-save")
        .openFiles["root:app:src/main.txt"]?.encoding,
    ).toBe("ISO-8859-1");
  });

  it("reloads the active file with an explicit encoding from the status action", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-encoding-reload",
      workspaceInstanceId: "instance-encoding-reload",
      name: "Encoding Reload",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/legacy.txt" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file(
      "src/legacy.txt",
      "caf\u00E9",
      { encoding: "windows-1252", bom: false },
    ));
    workspaceMocks.workspaceReadFileWithEncoding.mockResolvedValue(file(
      "src/legacy.txt",
      "caf\u00E9",
      { encoding: "UTF-16LE", bom: true, hash: "hash-utf16" },
    ));

    renderWorkspace(workspace);
    await screen.findByTitle("app / src/legacy.txt");
    await waitFor(() => expect(useCodeWorkspaceStatusStore.getState().actions?.chooseEncoding)
      .toBeTypeOf("function"));
    act(() => useCodeWorkspaceStatusStore.getState().actions?.chooseEncoding?.());
    await screen.findByTestId("file-encoding-dialog");

    fireEvent.change(screen.getByLabelText("Encoding"), { target: { value: "UTF-16LE" } });
    fireEvent.click(screen.getByRole("button", { name: "Reload from Disk" }));

    await waitFor(() => expect(workspaceMocks.workspaceReadFileWithEncoding).toHaveBeenCalledWith(
      "/repo/app",
      "src/legacy.txt",
      "UTF-16LE",
    ));
    await waitFor(() => {
      const open = selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-encoding-reload",
      ).openFiles["root:app:src/legacy.txt"];
      expect(open?.encoding).toBe("UTF-16LE");
      expect(open?.bom).toBe(true);
      expect(open?.dirty).toBe(false);
    });
    expect(screen.queryByTestId("file-encoding-dialog")).toBeNull();
  });

  it("blocks Safe Delete when provider does not attest complete coverage and performs 0 disk writes", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-safe-delete",
      workspaceInstanceId: "instance-safe-delete",
      name: "Safe Delete",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    const disk = new Map([
      ["src/main.ts", "const answer = 42;"],
      ["src/use.ts", "use(answer);"],
    ]);
    workspaceMocks.workspaceListDir.mockImplementation(async (_root: string, path = "") => (
      path === "src"
        ? [entry("main.ts", "src/main.ts"), entry("use.ts", "src/use.ts")]
        : []
    ));
    workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => {
      const text = disk.get(path);
      if (text === undefined) throw new Error(`missing fixture ${path}`);
      return file(path, text, { hash: `hash-${path}` });
    });
    workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
      _root: string,
      path: string,
      text: string,
    ) => {
      disk.set(path, text);
      return writeAck(file(path, text, { hash: `hash-${path}-${text}` }));
    });
    const capabilities = {
      completion: false,
      signatureHelp: false,
      hover: false,
      definition: true,
      typeDefinition: false,
      implementation: false,
      references: true,
      documentSymbol: false,
      workspaceSymbol: false,
      rename: true,
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
    };
    const activeStatus = documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities,
    });
    lspMocks.lspOpenDocument.mockResolvedValue(activeStatus);
    lspMocks.lspChangeDocument.mockResolvedValue(activeStatus);
    lspMocks.lspSaveDocument.mockResolvedValue(activeStatus);
    const declarationRange = {
      start: { line: 0, character: 6 },
      end: { line: 0, character: 12 },
    };
    lspMocks.lspPrepareRename.mockResolvedValue({
      status: activeStatus,
      allowed: true,
      range: declarationRange,
      placeholder: "answer",
      message: null,
    });
    lspMocks.lspDefinition.mockResolvedValue({
      status: activeStatus,
      locations: [{
        uri: "file:///repo/app/src/main.ts",
        path: "/repo/app/src/main.ts",
        range: declarationRange,
      }],
    });
    lspMocks.lspReferences.mockResolvedValue({
      status: activeStatus,
      locations: [
        {
          uri: "file:///repo/app/src/main.ts",
          path: "/repo/app/src/main.ts",
          range: declarationRange,
        },
        {
          uri: "file:///repo/app/src/use.ts",
          path: "/repo/app/src/use.ts",
          range: {
            start: { line: 0, character: 4 },
            end: { line: 0, character: 10 },
          },
        },
      ],
    });
    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });

    const rendered = renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/main.ts");
    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    await waitFor(() => expect(registrationRef.current).not.toBeNull());
    const safeDeleteCmd = registrationRef.current?.items.find((item) => item.id === "workspace.safeDeleteSymbol");
    expect(safeDeleteCmd?.enabled).toBe(false);
    expect(registrationRef.current?.execute("workspace.safeDeleteSymbol")).toBe(false);

    const execResult = await registrationRef.current?.executeAction("workspace.safeDeleteSymbol");
    expect(execResult?.kind).toBe("no-op");
    expect(execResult?.message).toContain("Language provider does not attest complete Safe Delete coverage");
    expect(lspMocks.lspPrepareRename).not.toHaveBeenCalled();
    expect(lspMocks.lspReferences).not.toHaveBeenCalled();
    expect(lspMocks.lspDefinition).not.toHaveBeenCalled();
    expect(workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
    expect(disk.get("src/main.ts")).toBe("const answer = 42;");
    expect(disk.get("src/use.ts")).toBe("use(answer);");
  });

  it("navigates diagnostics with F2 / Shift+F2 and executes parameter info, quick definition, and optimize imports commands", async () => {
    runtimeState.tauri = true;
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-parity",
      workspaceInstanceId: "instance-parity",
      name: "Parity commands",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Program.cs" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file(
      "src/Program.cs",
      "using System;\nclass Program { static void Main() {} }\n",
    ));
    lspMocks.lspDetectServers.mockResolvedValue([csharpStatus({ available: true, active: true })]);
    const activeStatus = documentStatus({
      available: true,
      active: true,
      selectedCommand: "csharp-ls",
      capabilities: defaultCapabilities({
        codeAction: true,
        definition: true,
        typeDefinition: true,
        implementation: true,
        signatureHelp: true,
      }),
    });
    lspMocks.lspOpenDocument.mockResolvedValue(activeStatus);
    lspMocks.lspChangeDocument.mockResolvedValue(activeStatus);
    lspMocks.lspSaveDocument.mockResolvedValue(activeStatus);
    lspMocks.lspGetDiagnostics.mockResolvedValue({
      status: activeStatus,
      diagnostics: [
        {
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 12 } },
          severity: 2,
          message: "Unnecessary using directive",
        },
        {
          range: { start: { line: 1, character: 6 }, end: { line: 1, character: 13 } },
          severity: 1,
          message: "Type error on Program",
        },
        {
          range: { start: { line: 2, character: 0 }, end: { line: 2, character: 5 } },
          severity: 1,
          message: "Missing return statement",
        },
      ],
    });
    lspMocks.lspDefinition.mockResolvedValue({
      status: activeStatus,
      locations: [{
        uri: "file:///repo/app/src/Lib.cs",
        path: "/repo/app/src/Lib.cs",
        range: { start: { line: 10, character: 0 }, end: { line: 10, character: 10 } },
      }],
    });
    lspMocks.lspSignatureHelp.mockResolvedValue({
      status: activeStatus,
      signatures: [{
        label: "Main(): void",
        parameters: [],
      }],
      activeSignature: 0,
      activeParameter: 0,
    });
    lspMocks.lspCodeActions.mockResolvedValue({
      status: activeStatus,
      actions: [{
        title: "Organize Imports",
        kind: "source.organizeImports",
        edit: {
          changes: {
            "file:///repo/app/src/Program.cs": [
              { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 13 } }, newText: "" },
            ],
          },
        },
      }],
    });

    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });

    renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/Program.cs");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
    await waitFor(() => expect(lspMocks.lspGetDiagnostics).toHaveBeenCalled(), { timeout: 3_000 });

    // 1. F2 Next error & Shift+F2 Prev error (wrapping)
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.nextError")?.enabled).toBe(true);
    await act(async () => {
      registrationRef.current?.execute("workspace.nextError");
    });
    expect(useAppStore.getState().statusMessage).toBe("Error: Type error on Program");

    expect(registrationRef.current?.items.find((item) => item.id === "workspace.prevError")?.enabled).toBe(true);
    await act(async () => {
      registrationRef.current?.execute("workspace.prevError");
    });
    expect(useAppStore.getState().statusMessage).toBe("Warning: Unnecessary using directive");

    // 2. Ctrl+P Parameter Info
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.parameterInfo")?.enabled).toBe(true);
    await act(async () => {
      registrationRef.current?.execute("workspace.parameterInfo");
    });
    await waitFor(() => expect(lspMocks.lspSignatureHelp).toHaveBeenCalled());
    expect(await screen.findByRole("dialog", { name: "Parameter info" })).toHaveTextContent("Main(): void");

    // 3. Ctrl+Shift+I Quick Definition Peek
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.quickDefinition")?.enabled).toBe(true);
    await act(async () => {
      registrationRef.current?.execute("workspace.quickDefinition");
    });
    await waitFor(() => expect(lspMocks.lspDefinition).toHaveBeenCalled());

    // 4. Ctrl+Alt+O Optimize Imports
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.optimizeImports")?.enabled).toBe(true);
    await act(async () => {
      registrationRef.current?.execute("workspace.optimizeImports");
    });
    await waitFor(() => expect(lspMocks.lspCodeActions).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      ["source.organizeImports"],
    ));
    expect(useAppStore.getState().statusMessage).toBe("Imports organized");

    // 5. Ctrl+Shift+F10 Run Context Configuration
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.runContextConfiguration")?.enabled).toBe(true);

    // 6. Ctrl+Alt+Shift+T Refactor This
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.refactorThis")?.enabled).toBe(true);

    // 7. Breakpoints: Ctrl+F8, Ctrl+Shift+F8, Mute
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.toggleBreakpoint")?.enabled).toBe(true);
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.viewBreakpoints")?.enabled).toBe(true);
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.toggleMuteBreakpoints")?.enabled).toBe(true);
    await act(async () => {
      registrationRef.current?.execute("workspace.toggleMuteBreakpoints");
    });
    expect(useAppStore.getState().statusMessage).toBe("Breakpoints muted");

    // 8. Ctrl+Shift+F9 Recompile Active File
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.recompileActiveFile")?.enabled).toBe(true);

    // 9. ED-STYLE-002: Rearrange Code & Code Cleanup fail-closed with honest unavailable reasons
    // (live discovery: the mock provider returns no arrangement/cleanup kinds).
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.rearrangeCode")?.enabled).toBe(true);
    await act(async () => {
      registrationRef.current?.execute("workspace.rearrangeCode");
    });
    expect(useAppStore.getState().statusMessage).toContain("Provider returned no rearrange action");

    expect(registrationRef.current?.items.find((item) => item.id === "workspace.codeCleanup")?.enabled).toBe(true);
    await act(async () => {
      registrationRef.current?.execute("workspace.codeCleanup");
    });
    expect(useAppStore.getState().statusMessage).toContain("Provider returned no cleanup action");
  });

  it("routes every common semantic navigation command through the provider host", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-query-routing",
      workspaceInstanceId: "instance-query-routing",
      name: "Query routing",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Program.cs" },
    };
    const activeStatus = documentStatus({
      path: "/repo/app/src/Program.cs",
      uri: "file:///repo/app/src/Program.cs",
      available: true,
      active: true,
      capabilities: defaultCapabilities({
        definition: true,
        declaration: true,
        typeDefinition: true,
        implementation: true,
        references: true,
      }),
    });
    const target = {
      uri: "file:///repo/app/src/Program.cs",
      path: "/repo/app/src/Program.cs",
      range: { start: { line: 1, character: 6 }, end: { line: 1, character: 13 } },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file(
      "src/Program.cs",
      "class Program {\n  void Main() {}\n}\n",
    ));
    lspMocks.lspDetectServers.mockResolvedValue([csharpStatus({ available: true, active: true })]);
    lspMocks.lspOpenDocument.mockResolvedValue(activeStatus);
    lspMocks.lspChangeDocument.mockResolvedValue(activeStatus);
    lspMocks.lspGetDiagnostics.mockResolvedValue({ status: activeStatus, diagnostics: [] });
    lspMocks.lspDefinition.mockResolvedValue({ status: activeStatus, locations: [target] });
    lspMocks.lspDeclaration.mockResolvedValue({ status: activeStatus, locations: [target] });
    lspMocks.lspTypeDefinition.mockResolvedValue({ status: activeStatus, locations: [target] });
    lspMocks.lspImplementation.mockResolvedValue({ status: activeStatus, locations: [target] });
    lspMocks.lspReferences.mockResolvedValue({ status: activeStatus, locations: [target] });

    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });

    renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/Program.cs");
    await waitFor(() => expect(registrationRef.current).not.toBeNull());
    await waitFor(() => expect(registrationRef.current?.items.find(
      (item) => item.id === "workspace.gotoDeclaration",
    )?.enabled).toBe(true));

    lspMocks.lspDefinition.mockClear();
    lspMocks.lspDeclaration.mockClear();
    lspMocks.lspTypeDefinition.mockClear();
    lspMocks.lspImplementation.mockClear();
    lspMocks.lspReferences.mockClear();

    const queryCommands = [
      ["workspace.gotoDefinition", lspMocks.lspDefinition],
      ["workspace.gotoDeclaration", lspMocks.lspDeclaration],
      ["workspace.gotoTypeDefinition", lspMocks.lspTypeDefinition],
      ["workspace.gotoImplementation", lspMocks.lspImplementation],
    ] as const;
    for (const [commandId, provider] of queryCommands) {
      await act(async () => {
        await registrationRef.current?.executeAction(commandId);
      });
      await waitFor(() => expect(provider).toHaveBeenCalled());
      expect(provider).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({
          signal: expect.anything(),
          cancelKey: "instance-query-routing|root:app:src/Program.cs",
          requestSeq: expect.any(Number),
        }),
      );
    }

    await act(async () => {
      await registrationRef.current?.executeAction("workspace.findReferences");
    });
    fireEvent.click(await screen.findByTestId("usages-scope-confirm"));
    await waitFor(() => expect(lspMocks.lspReferences).toHaveBeenCalled());
    expect(lspMocks.lspReferences).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      true,
      expect.objectContaining({
        signal: expect.anything(),
        cancelKey: "instance-query-routing|root:app:src/Program.cs",
        requestSeq: expect.any(Number),
      }),
    );
  });

  it("ingests workspace test coverage report and renders coverage dock panel", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-coverage",
      workspaceInstanceId: "instance-coverage",
      name: "Coverage test",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Program.cs" },
    };

    const lcovContent = `
SF:src/Program.cs
DA:1,3
DA:2,0
LF:2
LH:1
end_of_record
`;

    workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, rel: string) => {
      if (rel === "coverage/lcov.info") {
        return file("coverage/lcov.info", lcovContent);
      }
      return file("src/Program.cs", "class Program {\n  void Main() {}\n}\n");
    });

    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });

    renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/Program.cs");

    // Execute workspace.showCoverage command
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.showCoverage")?.enabled).toBe(true);
    await act(async () => {
      registrationRef.current?.execute("workspace.showCoverage");
    });

    await waitFor(() => {
      expect(screen.getByTestId("coverage-overall-badge")).toBeInTheDocument();
      expect(screen.getByTestId("coverage-overall-badge")).toHaveTextContent("50%");
    });
  });

  it("toggles synchronized split scrolling when editor is split", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-split",
      workspaceInstanceId: "instance-split",
      name: "Split test",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/Program.cs" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/Program.cs", "line1\nline2\nline3\nline4\nline5\n"));

    const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });

    renderWorkspace(workspace, { onCommandsChange });
    await screen.findByTitle("app / src/Program.cs");

    // Split editor right
    const splitRightBtn = screen.getByTestId("code-workspace-split-right");
    fireEvent.click(splitRightBtn);

    // Sync scroll button should appear
    const syncScrollBtn = await screen.findByTestId("code-workspace-split-sync-scroll");
    expect(syncScrollBtn).toBeInTheDocument();
    expect(syncScrollBtn).toHaveAttribute("aria-pressed", "false");

    // Click to enable synchronized scrolling
    fireEvent.click(syncScrollBtn);
    expect(syncScrollBtn).toHaveAttribute("aria-pressed", "true");
    expect(useAppStore.getState().statusMessage).toBe("Synchronized split scrolling enabled");

    // Toggle via command
    expect(registrationRef.current?.items.find((item) => item.id === "workspace.toggleSyncSplitScroll")?.enabled).toBe(true);
    await act(async () => {
      registrationRef.current?.execute("workspace.toggleSyncSplitScroll");
    });
    expect(useAppStore.getState().statusMessage).toBe("Synchronized split scrolling disabled");
  });

  it("opens Search Everywhere with Ctrl+N and Ctrl+Shift+N when viewing a Java file", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-shortcuts-test",
      workspaceInstanceId: "instance-shortcuts-test",
      name: "Shortcuts test",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/App.java" },
    };
    workspaceMocks.workspaceReadFile.mockResolvedValue(
      file("src/App.java", "public class App { public static void main(String[] args) {} }"),
    );
    workspaceMocks.workspaceListDir.mockResolvedValue([
      { name: "App.java", path: "src/App.java", fileType: "file", size: 50, mtime: 1 },
    ]);
    workspaceMocks.workspaceListFilesRecursive.mockResolvedValue([
      { name: "App.java", path: "src/App.java", fileType: "file", size: 50, mtime: 1 },
    ]);

    renderWorkspace(workspace, {}, { strict: true });
    await screen.findByTitle("app / src/App.java");

    // 1. Press Ctrl+Shift+N to open Search Everywhere (Files mode)
    await act(async () => {
      fireEvent.keyDown(window, {
        key: "N",
        code: "KeyN",
        ctrlKey: true,
        shiftKey: true,
      });
    });

    const overlay1 = await screen.findByTestId("code-workspace-search-everywhere");
    expect(overlay1).toBeInTheDocument();

    // Close with Escape on the searchbox input
    await act(async () => {
      fireEvent.keyDown(within(overlay1).getByRole("searchbox"), { key: "Escape" });
    });
    await waitFor(() => {
      expect(screen.queryByTestId("code-workspace-search-everywhere")).not.toBeInTheDocument();
    });

    // 2. Press Ctrl+N to open Search Everywhere (Classes mode or fallback)
    await act(async () => {
      fireEvent.keyDown(window, {
        key: "n",
        code: "KeyN",
        ctrlKey: true,
        shiftKey: false,
      });
    });

    const overlay2 = await screen.findByTestId("code-workspace-search-everywhere");
    expect(overlay2).toBeInTheDocument();

    // Close with Escape
    await act(async () => {
      fireEvent.keyDown(within(overlay2).getByRole("searchbox"), { key: "Escape" });
    });
    await waitFor(() => {
      expect(screen.queryByTestId("code-workspace-search-everywhere")).not.toBeInTheDocument();
    });
  });

  describe("P0-J1 completion identity host containment", () => {
    it("lets the completion popup own Arrow keys and Tab in the workspace capture phase", async () => {
      const { EditorView } = await import("@codemirror/view");
      const { startCompletion } = await import("@codemirror/autocomplete");
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-completion-keyboard",
        workspaceInstanceId: "instance-completion-keyboard",
        name: "Completion Keyboard",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/App.java" },
      };
      workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
      workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/App.java", "sout"));

      const rendered = renderWorkspace(workspace);
      await screen.findByTitle("app / src/App.java");
      const content = rendered.container.querySelector<HTMLElement>(".cm-content");
      expect(content).not.toBeNull();
      const view = EditorView.findFromDOM(content!);
      expect(view).not.toBeNull();
      act(() => {
        view!.dispatch({ selection: { anchor: view!.state.doc.length } });
        startCompletion(view!);
      });
      await waitFor(() => {
        const element = document.querySelector(".cm-tooltip-autocomplete");
        expect(element).not.toBeNull();
        return element!;
      });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
      });
      const selectedId = () => content!.getAttribute("aria-activedescendant");
      const before = selectedId();

      fireEvent.keyDown(content!, { key: "ArrowDown", code: "ArrowDown" });
      await waitFor(() => expect(selectedId()).not.toBe(before));
      fireEvent.keyDown(content!, { key: "Tab", code: "Tab" });

      await waitFor(() => expect(view!.state.doc.toString()).toContain("System.out"));
      expect(document.querySelector(".cm-tooltip-autocomplete")).toBeNull();
    });

    it("never renders inactive-provider completion candidates in a mounted editor", async () => {
      const { EditorView } = await import("@codemirror/view");
      const { startCompletion } = await import("@codemirror/autocomplete");
      lspMocks.lspCompletion.mockResolvedValue({
        status: {
          path: "src/main.ts",
          uri: "file:///repo/app/src/main.ts",
          presetId: null,
          languageId: "typescript",
          displayName: "TypeScript",
          available: true,
          active: false,
          selectedCommandId: null,
          selectedCommand: null,
          installHint: null,
          error: null,
        } satisfies LspDocumentStatus,
        isIncomplete: false,
        items: [{
          label: "StaleServerCandidate",
          kind: 7,
          detail: null,
          documentation: null,
          insertText: "StaleServerCandidate",
          insertTextFormat: 1,
          filterText: null,
          sortText: null,
          textEdit: null,
          additionalTextEdits: [],
          raw: {},
        }],
      });

      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-completion-inactive",
        workspaceInstanceId: "instance-completion-inactive",
        name: "Completion Inactive",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
      workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "const value = 1;\n"));

      const rendered = renderWorkspace(workspace);
      await screen.findByTitle("app / src/main.ts");
      const content = rendered.container.querySelector<HTMLElement>(".cm-content");
      expect(content).not.toBeNull();

      const view = EditorView.findFromDOM(content!);
      expect(view).not.toBeNull();
      act(() => {
        view!.dispatch({
          changes: { from: view!.state.doc.length, insert: "valu" },
          selection: { anchor: view!.state.doc.length + 4 },
          userEvent: "input.type",
        });
        startCompletion(view!);
      });

      // Give the deferred provider response (inactive + stale items) time to
      // settle; whatever the popup shows, stale provider labels must not be
      // among the options.
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 400));
      });
      const optionEls = rendered.container.querySelectorAll(".cm-tooltip-autocomplete li, .cm-completionLabel");
      for (const optionEl of optionEls) {
        expect(optionEl.textContent).not.toContain("StaleServerCandidate");
      }
    });
  });

  describe("N2.6 Ctrl+Tab Switcher", () => {
    it("opens on Ctrl+Tab, cycles with Shift, commits on Control release", async () => {
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-switcher",
        workspaceInstanceId: "instance-switcher",
        name: "Switcher",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      workspaceMocks.workspaceListDir.mockResolvedValue([
        entry("src", "src", "dir"),
        entry("other.ts", "other.ts"),
      ]);
      workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) =>
        file(path, path === "src/main.ts" ? "const main = 1;\n" : "const other = 2;\n"));

      const rendered = renderWorkspace(workspace);
      await screen.findByTitle("app / src/main.ts");
      fireEvent.click(screen.getByTestId("code-workspace-tree-file"));
      await screen.findByTitle("app / other.ts");

      // Ctrl+Tab opens the switcher with the previous file preselected.
      fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
      const switcher = await screen.findByTestId("workspace-tab-switcher");
      expect(switcher).toBeInTheDocument();
      // The previous file (main.ts) is preselected per IDEA MRU semantics.
      const selected = switcher.querySelector('[data-switcher-selected="true"]');
      expect(selected?.textContent).toContain("main.ts");

      // Releasing Control commits the preselected entry.
      fireEvent.keyUp(window, { key: "Control" });
      await waitFor(() => {
        expect(screen.queryByTestId("workspace-tab-switcher")).not.toBeInTheDocument();
      });
      await waitFor(() => {
        const active = rendered.container.querySelector("[data-editor-tab-key][data-active=true]");
        expect(active?.getAttribute("data-editor-tab-key")).toBe("root:app:src/main.ts");
      });
    });

    it("cancels with Escape without changing the active tab", async () => {
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-switcher-cancel",
        workspaceInstanceId: "instance-switcher-cancel",
        name: "Switcher Cancel",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      workspaceMocks.workspaceListDir.mockResolvedValue([
        entry("src", "src", "dir"),
        entry("other.ts", "other.ts"),
      ]);
      workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) =>
        file(path, "const value = 1;\n"));

      const rendered = renderWorkspace(workspace);
      await screen.findByTitle("app / src/main.ts");
      fireEvent.click(screen.getByTestId("code-workspace-tree-file"));
      await screen.findByTitle("app / other.ts");

      fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
      await screen.findByTestId("workspace-tab-switcher");
      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => {
        expect(screen.queryByTestId("workspace-tab-switcher")).not.toBeInTheDocument();
      });
      const active = rendered.container.querySelector("[data-editor-tab-key][data-active=true]");
      expect(active?.getAttribute("data-editor-tab-key")).toBe("root:app:other.ts");
    });

    it("refuses Backspace close for pinned tabs and keeps the switcher open (§8.19.6)", async () => {
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-switcher-pin",
        workspaceInstanceId: "instance-switcher-pin",
        name: "Switcher Pin",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      workspaceMocks.workspaceListDir.mockResolvedValue([
        entry("src", "src", "dir"),
        entry("other.ts", "other.ts"),
      ]);
      workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) =>
        file(path, "const value = 1;\n"));

      renderWorkspace(workspace);
      await screen.findByTitle("app / src/main.ts");
      fireEvent.click(screen.getByTestId("code-workspace-tree-file"));
      await screen.findByTitle("app / other.ts");

      // MRU is [other, main]: index 1 preselects main.ts. Pin it directly in
      // its group so Backspace must refuse instead of closing protected work.
      // The Switcher freezes its snapshot at open time, so the pin must be
      // committed to the tree BEFORE the popup opens to be part of it.
      await act(async () => {
        useCodeWorkspaceStore.getState().updateEditorGroup("instance-switcher-pin", "primary", (group) => ({
          ...group,
          pinnedKeys: [...group.pinnedKeys, "root:app:src/main.ts"],
        }));
      });

      fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
      const switcher = await screen.findByTestId("workspace-tab-switcher");
      expect(switcher.querySelector('[data-switcher-selected="true"]')?.textContent).toContain("main.ts");
      expect(switcher.querySelector('[data-switcher-selected="true"]')?.textContent).toContain("📌");

      fireEvent.keyDown(window, { key: "Backspace" });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("pinned"));
      // Protected work stays open and the popup remains up for another pick.
      expect(screen.getByTestId("workspace-tab-switcher")).toBeInTheDocument();
      expect(
        selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-switcher-pin")
          .editorGroups.primary?.openOrder,
      ).toContain("root:app:src/main.ts");

      fireEvent.keyDown(window, { key: "Escape" });
    });

    it("reopens a closed tab into the nearest surviving split after its leaf closes (§8.19.6)", async () => {
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-switcher-reopen",
        workspaceInstanceId: "instance-switcher-reopen",
        name: "Switcher Reopen",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      workspaceMocks.workspaceListDir.mockResolvedValue([
        entry("src", "src", "dir"),
        entry("other.ts", "other.ts"),
      ]);
      workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) =>
        file(path, path === "src/main.ts" ? "const main = 1;\n" : "const other = 2;\n"));

      const rendered = renderWorkspace(workspace);
      await screen.findByTitle("app / src/main.ts");
      // Split right: the new leaf owns main.ts and becomes active…
      fireEvent.click(screen.getByTestId("code-workspace-split-right"));
      await waitFor(() => expect(
        selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-switcher-reopen").splitOrientation,
      ).toBe("vertical"));
      // …then other.ts opens in THAT leaf, recording its location evidence.
      fireEvent.click(screen.getByTestId("code-workspace-tree-file"));
      await screen.findByTitle("app / other.ts");

      // Close other.ts (clean tab → direct close, captures ReopenLocationV2).
      fireEvent.keyDown(window, { key: "f4", ctrlKey: true });
      await waitFor(() => {
        const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-switcher-reopen");
        expect(Object.values(ui.editorGroups).some((g) => g.openOrder.includes("root:app:other.ts"))).toBe(false);
      });

      // Collapse the split: other.ts's owning leaf disappears entirely.
      fireEvent.click(screen.getByTestId("code-workspace-split-close"));
      await waitFor(() => expect(
        selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-switcher-reopen").splitOrientation,
      ).toBeNull());

      // Reopen resolves against the LIVE collapsed tree → relocated sibling.
      fireEvent.keyDown(window, { key: "t", shiftKey: true, ctrlKey: true });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("former tab group"));
      await waitFor(() => {
        const active = rendered.container.querySelector("[data-editor-tab-key][data-active=true]");
        expect(active?.getAttribute("data-editor-tab-key")).toBe("root:app:other.ts");
      });
    }, 20000);
  });

  describe("P0-S / N1.7 Atomic Save Commit Host Race Tests", () => {
    it("deletes a Java line with Ctrl+Y and saves from the editor surface", async () => {
      const path = "src/main/java/com/example/App.java";
      const initialText = "class App {\n  int value = 1;\n}\n";
      const savedText = "  int value = 1;\n}\n";
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-editor-delete-save",
        workspaceInstanceId: "instance-editor-delete-save",
        name: "Editor Delete Save",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path },
      };
      workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
      workspaceMocks.workspaceReadFile.mockResolvedValue(file(path, initialText));
      localHistoryMocks.historySnapshot.mockResolvedValue({
        id: 41,
        path: `/repo/app/${path}`,
        contentHash: "history-preimage-hash",
        createdAt: 1_788_888_888,
        reason: "save",
        byteLen: initialText.length,
      });
      workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _root: string,
        writtenPath: string,
        text: string,
      ) => writeAck(
        file(writtenPath, text, { hash: `hash-saved-${writtenPath}` }),
        {
          intentHash: `hash-saved-${writtenPath}`,
          oldHash: `hash-${writtenPath}`,
        },
      ));

      const rendered = renderWorkspace(workspace);
      await screen.findByTitle(`app / ${path}`);
      const content = rendered.container.querySelector<HTMLElement>(".cm-content");
      expect(content).not.toBeNull();

      fireEvent.keyDown(content!, { key: "y", code: "KeyY", ctrlKey: true });
      await waitFor(() => {
        const fileState = selectCodeWorkspaceUi(
          useCodeWorkspaceStore.getState(),
          "instance-editor-delete-save",
        ).openFiles[`root:app:${path}`];
        expect(fileState?.text).toBe(savedText);
        expect(fileState?.dirty).toBe(true);
      });
      expect(screen.getByTestId("code-workspace-save-observation")).toHaveAttribute("data-state", "dirty");
      expect(screen.getByTestId("code-workspace-save-observation")).toHaveTextContent("Unsaved changes in App.java");

      fireEvent.keyDown(content!, { key: "s", code: "KeyS", ctrlKey: true });
      await waitFor(() => expect(workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledWith(
        "/repo/app",
        path,
        savedText,
        `hash-${path}`,
        "UTF-8",
        false,
      ));
      expect(workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(saveCommitObservations.results).toHaveLength(1));
      const result = saveCommitObservations.results[0];
      expect(result).toMatchObject({
        kind: "saved-current",
        diskEffect: "committed",
        historyId: "local-history-41",
        receipt: {
          workspaceId: "instance-editor-delete-save",
          filePath: `/repo/app/${path}`,
          writeCount: 1,
          encodedBytesSha256: `hash-saved-${path}`,
          encodedByteLength: savedText.length,
          diskPreSha256: `hash-${path}`,
          diskPostSha256: `hash-saved-${path}`,
          historyId: "local-history-41",
        },
      });
      expect((result as { receipt: { receiptId: string; transactionId: string; finalTextSha256: string } }).receipt)
        .toMatchObject({
          receiptId: expect.stringMatching(/^receipt-tx-save-/),
          transactionId: expect.stringMatching(/^tx-save-/),
          finalTextSha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
      const saveObservation = screen.getByTestId("code-workspace-save-observation");
      expect(saveObservation).toHaveAttribute("data-state", "saved");
      expect(saveObservation).toHaveAttribute("data-result-kind", "saved-current");
      expect(saveObservation).toHaveAttribute("data-receipt-id", expect.stringMatching(/^receipt-tx-save-/));
      expect(saveObservation).toHaveAttribute("data-encoded-bytes-sha256", `hash-saved-${path}`);
      expect(saveObservation).toHaveAttribute("data-write-count", "1");
      expect(saveObservation).toHaveAttribute("data-dirty", "false");
      expect(saveObservation).toHaveAccessibleName("Save status");
      expect(saveObservation).toHaveAttribute("aria-live", "polite");
      expect(saveObservation).toHaveTextContent("Saved App.java");
    });

    it("cancels save with 0 disk writes when user edits buffer during historySnapshot await", async () => {
      let resolveHistory: () => void = () => {};
      const historyDeferred = new Promise<null>((r) => {
        resolveHistory = () => r(null);
      });
      localHistoryMocks.historySnapshot.mockReturnValue(historyDeferred);

      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-save-race-history",
        workspaceInstanceId: "instance-save-race-history",
        name: "Save Race History",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
      workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "original_v1\n"));

      const rendered = renderWorkspace(workspace);
      await screen.findByTitle("app / src/main.ts");
      const content = rendered.container.querySelector<HTMLElement>(".cm-content");
      expect(content).not.toBeNull();

      // Make buffer dirty first by typing Ctrl+D (duplicate line)
      fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
      await waitFor(() => {
        const fileState = selectCodeWorkspaceUi(
          useCodeWorkspaceStore.getState(),
          "instance-save-race-history",
        ).openFiles["root:app:src/main.ts"];
        expect(fileState?.dirty).toBe(true);
        expect(fileState?.text).toBe("original_v1\noriginal_v1\n");
      });

      // Trigger Save (Ctrl+S) -> enters prepare phase and awaits historySnapshot
      fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });

      await waitFor(() => {
        expect(localHistoryMocks.historySnapshot).toHaveBeenCalled();
      });

      // While historySnapshot is awaiting, user edits buffer again (Ctrl+D)
      fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
      await waitFor(() => {
        const fileState = selectCodeWorkspaceUi(
          useCodeWorkspaceStore.getState(),
          "instance-save-race-history",
        ).openFiles["root:app:src/main.ts"];
        expect(fileState?.text).toBe("original_v1\noriginal_v1\noriginal_v1\n");
      });

      // Now resolve historySnapshot
      await act(async () => {
        resolveHistory();
      });

      // Assert pre-write commit boundary cancelled save: zero disk writes
      expect(workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
      expect(workspaceMocks.workspaceWriteLooseFileEncoded).not.toHaveBeenCalled();
      expect(workspaceMocks.workspaceWriteFile).not.toHaveBeenCalled();

      // Editor and store retain latest user edits, dirty remains true
      const finalFileState = selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-save-race-history",
      ).openFiles["root:app:src/main.ts"];
      expect(finalFileState?.text).toBe("original_v1\noriginal_v1\noriginal_v1\n");
      expect(finalFileState?.dirty).toBe(true);
      expect(finalFileState?.saving).toBe(false);
    });

    it("preserves concurrent edits and marks dirty when disk write was in-flight", async () => {
      let resolveWrite: (res: any) => void = () => {};
      const writeDeferred = new Promise<any>((r) => {
        resolveWrite = r;
      });
      workspaceMocks.workspaceWriteFileEncoded.mockReturnValue(writeDeferred);

      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-save-race-inflight",
        workspaceInstanceId: "instance-save-race-inflight",
        name: "Save Race InFlight",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
      workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "initial_text\n"));

      const rendered = renderWorkspace(workspace);
      await screen.findByTitle("app / src/main.ts");
      const content = rendered.container.querySelector<HTMLElement>(".cm-content");
      expect(content).not.toBeNull();

      // Make buffer dirty (Ctrl+D)
      fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
      await waitFor(() => {
        const fileState = selectCodeWorkspaceUi(
          useCodeWorkspaceStore.getState(),
          "instance-save-race-inflight",
        ).openFiles["root:app:src/main.ts"];
        expect(fileState?.dirty).toBe(true);
        expect(fileState?.text).toBe("initial_text\ninitial_text\n");
      });

      // Trigger Save (Ctrl+S) -> historySnapshot resolves immediately, disk writer is called and deferred
      fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });

      await waitFor(() => {
        expect(workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledWith(
          "/repo/app",
          "src/main.ts",
          "initial_text\ninitial_text\n",
          "hash-src/main.ts",
          "UTF-8",
          false,
        );
      });

      // While write is in-flight, user edits buffer further (Ctrl+D)
      fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
      await waitFor(() => {
        const fileState = selectCodeWorkspaceUi(
          useCodeWorkspaceStore.getState(),
          "instance-save-race-inflight",
        ).openFiles["root:app:src/main.ts"];
        expect(fileState?.text).toBe("initial_text\ninitial_text\ninitial_text\n");
      });

      // Now resolve the disk writer with snapshot result
      await act(async () => {
        resolveWrite(writeAck(file("src/main.ts", "initial_text\ninitial_text\n", { hash: "hash-saved-snapshot" })));
      });

      // Assert writeback merged cleanly: savedText is updated, but buffer text keeps revision 11 edits and dirty is true
      await waitFor(() => {
        const fileState = selectCodeWorkspaceUi(
          useCodeWorkspaceStore.getState(),
          "instance-save-race-inflight",
        ).openFiles["root:app:src/main.ts"];
        expect(fileState?.text).toBe("initial_text\ninitial_text\ninitial_text\n");
        expect(fileState?.savedText).toBe("initial_text\ninitial_text\n");
        expect(fileState?.dirty).toBe(true);
        expect(fileState?.saving).toBe(false);
      });

      expect(useAppStore.getState().statusMessage).toContain("current changes remain unsaved");
      const staleObservation = screen.getByTestId("code-workspace-save-observation");
      expect(staleObservation).toHaveAttribute("data-state", "stale");
      expect(staleObservation).toHaveAttribute("data-result-kind", "saved-stale-snapshot");
      expect(staleObservation).toHaveAttribute("data-dirty", "true");
      expect(staleObservation).toHaveAttribute("data-encoded-bytes-sha256", "hash-saved-snapshot");
      expect(staleObservation).toHaveTextContent("current changes remain unsaved");

      // P0-S3 stale-save ordering: the provider must never receive the stale
      // snapshot text via didSave; only the current buffer may be synced.
      const staleDidSave = lspMocks.lspSaveDocument.mock.calls.some(
        (call) => call.includes("initial_text\ninitial_text\n"),
      );
      expect(staleDidSave).toBe(false);
    });

    it("discards writeback and never recreates a closed buffer when writer resolves after close", async () => {
      let resolveWrite: (res: any) => void = () => {};
      const writeDeferred = new Promise<any>((r) => {
        resolveWrite = r;
      });
      workspaceMocks.workspaceWriteFileEncoded.mockReturnValue(writeDeferred);

      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-save-race-close",
        workspaceInstanceId: "instance-save-race-close",
        name: "Save Race Close",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
      workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "close_race\n"));

      const rendered = renderWorkspace(workspace);
      await screen.findByTitle("app / src/main.ts");
      const content = rendered.container.querySelector<HTMLElement>(".cm-content");
      expect(content).not.toBeNull();

      // Dirty the buffer, then start a save whose writer stays in flight.
      fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
      await waitFor(() => {
        const fileState = selectCodeWorkspaceUi(
          useCodeWorkspaceStore.getState(),
          "instance-save-race-close",
        ).openFiles["root:app:src/main.ts"];
        expect(fileState?.dirty).toBe(true);
      });
      fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
      await waitFor(() => {
        expect(workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalled();
      });

      // Close the tab while the writer is pending (dialog mock confirms).
      const closeButton = rendered.container.querySelector<HTMLElement>(
        '[data-editor-tab-key="root:app:src/main.ts"] button[title="Close"]',
      );
      expect(closeButton).not.toBeNull();
      fireEvent.click(closeButton!);
      await waitFor(() => {
        const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-save-race-close");
        expect(ui.openFiles["root:app:src/main.ts"]).toBeUndefined();
      });

      // Writer finishes with the stale snapshot: writeback must be discarded.
      await act(async () => {
        resolveWrite(writeAck(file("src/main.ts", "close_race\nclose_race\n", { hash: "hash-closed-snapshot" })));
      });

      const uiAfter = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-save-race-close");
      expect(uiAfter.openFiles["root:app:src/main.ts"]).toBeUndefined();
      expect(lspMocks.lspSaveDocument).not.toHaveBeenCalled();

      // §8.19.1: a discarded writeback must leave a committed ledger row so
      // the recovery center can surface "saved to disk, buffer discarded".
      const ledgerRows = listDiskEffectLedgerEntries("instance-save-race-close")
        .filter((row) => row.path === "/repo/app/src/main.ts");
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0]).toMatchObject({
        diskEffect: "committed",
        memoryEffect: "writeback-discarded",
        providerEffect: "discarded",
        resolution: "confirmed-committed",
        intendedNewHash: "hash-closed-snapshot",
        observedHash: "hash-closed-snapshot",
      });
      expect(hasBlockingDiskEffectResolution("instance-save-race-close", "/repo/app/src/main.ts")).toBe(false);
      resolveDiskEffectLedgerEntry("instance-save-race-close", ledgerRows[0].transactionId, "/repo/app/src/main.ts");
    });

    it("records unknown disk effects for recovery and blocks an automatic retry", async () => {
      const path = "src/main.ts";
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-save-unknown-effect",
        workspaceInstanceId: "instance-save-unknown-effect",
        name: "Save Unknown Effect",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path },
      };
      workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
      workspaceMocks.workspaceReadFile.mockResolvedValue(file(path, "initial\n"));
      workspaceMocks.workspaceReadFileWithEncoding.mockResolvedValue(file(path, "foreign\n", {
        hash: "foreign-disk-hash",
      }));
      workspaceMocks.workspaceWriteFileEncoded.mockRejectedValue(Object.assign(
        new Error("atomic replace acknowledgement was lost"),
        {
          kind: "io",
          effect: "unknown",
          intentHash: "intended-new-hash",
          intentByteLength: 16,
          oldHash: `hash-${path}`,
        },
      ));

      const rendered = renderWorkspace(workspace);
      await screen.findByTitle(`app / ${path}`);
      const content = rendered.container.querySelector<HTMLElement>(".cm-content");
      expect(content).not.toBeNull();
      fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
      await waitFor(() => expect(selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-save-unknown-effect",
      ).openFiles[`root:app:${path}`]?.dirty).toBe(true));

      fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Save result unknown"));
      expect(workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(1);
      expect(workspaceMocks.workspaceReadFileWithEncoding).toHaveBeenCalledWith(
        "/repo/app",
        path,
        "UTF-8",
      );
      const recoveryObservation = screen.getByTestId("code-workspace-save-observation");
      expect(recoveryObservation).toHaveAttribute("data-state", "recovery");
      expect(recoveryObservation).toHaveAttribute("data-result-kind", "failed");
      expect(recoveryObservation).toHaveAttribute("data-disk-effect", "unknown");
      expect(recoveryObservation).toHaveAttribute("data-recovery-id", expect.stringMatching(/^tx-save-/));
      expect(recoveryObservation).not.toHaveAttribute("data-receipt-id");
      expect(recoveryObservation).toHaveTextContent("Save recovery required for main.ts");

      const ledgerRows = listDiskEffectLedgerEntries("instance-save-unknown-effect")
        .filter((row) => row.path === `/repo/app/${path}`);
      expect(ledgerRows).toHaveLength(1);
      expect(ledgerRows[0]).toMatchObject({
        transactionId: expect.stringMatching(/^tx-save-/),
        expectedOldHash: `hash-${path}`,
        intendedNewHash: "intended-new-hash",
        observedHash: "foreign-disk-hash",
        diskEffect: "unknown",
        memoryEffect: "unchanged",
        providerEffect: "unknown",
        resolution: "foreign-blocked",
      });
      expect(hasBlockingDiskEffectResolution(
        "instance-save-unknown-effect",
        `/repo/app/${path}`,
      )).toBe(true);

      fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Save blocked"));
      expect(workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(1);

      resolveDiskEffectLedgerEntry(
        "instance-save-unknown-effect",
        ledgerRows[0].transactionId,
        `/repo/app/${path}`,
      );
    });

    it("surfaces a real hash-mismatch save as conflict with zero disk effect and no blocking row", async () => {
      const path = "src/main.ts";
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-save-external-conflict",
        workspaceInstanceId: "instance-save-external-conflict",
        name: "Save External Conflict",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path },
      };
      workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
      workspaceMocks.workspaceReadFile.mockResolvedValue(file(path, "disk_v1\n"));
      // Native precondition failure (§ED-AUDIT-004 A3): the disk changed under
      // the dirty buffer (external rewrite between load and save). The native
      // writer proves zero bytes landed via effect=none and never fabricates a
      // success receipt.
      workspaceMocks.workspaceWriteFileEncoded.mockRejectedValue(Object.assign(
        new Error("disk hash changed since load"),
        {
          kind: "hash-mismatch",
          expectedHash: `hash-${path}`,
          actualHash: "hash-external-rewrite",
          effect: "none",
        },
      ));

      const rendered = renderWorkspace(workspace);
      await screen.findByTitle(`app / ${path}`);
      const content = rendered.container.querySelector<HTMLElement>(".cm-content");
      expect(content).not.toBeNull();
      fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
      await waitFor(() => expect(selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-save-external-conflict",
      ).openFiles[`root:app:${path}`]?.dirty).toBe(true));

      fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Save conflict"));
      expect(workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(1);

      const conflictObservation = screen.getByTestId("code-workspace-save-observation");
      expect(conflictObservation).toHaveAttribute("data-state", "conflict");
      expect(conflictObservation).toHaveAttribute("data-result-kind", "conflict");
      expect(conflictObservation).toHaveAttribute("data-disk-effect", "none");
      expect(conflictObservation).toHaveAttribute("data-dirty", "true");
      expect(conflictObservation).not.toHaveAttribute("data-receipt-id");
      expect(conflictObservation).not.toHaveAttribute("data-recovery-id");

      // The buffer keeps the user's edits dirty; no ledger row blocks a later
      // save because a conflict provably wrote nothing.
      const fileState = selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-save-external-conflict",
      ).openFiles[`root:app:${path}`];
      expect(fileState?.dirty).toBe(true);
      expect(fileState?.text).toBe("disk_v1\ndisk_v1\n");
      expect(hasBlockingDiskEffectResolution(
        "instance-save-external-conflict",
        `/repo/app/${path}`,
      )).toBe(false);

      // A conflict never blocks the retry: the next Ctrl+S invokes the
      // writer again against the refreshed expectation.
      fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
      await waitFor(() => expect(workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(2));
    });

    it("continues a lost-acknowledge save as committed when the read-back proves the intended bytes landed", async () => {
      const path = "src/main.ts";
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-save-unknown-committed",
        workspaceInstanceId: "instance-save-unknown-committed",
        name: "Save Unknown Committed",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path },
      };
      workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
      workspaceMocks.workspaceReadFile.mockResolvedValue(file(path, "initial\n"));
      // Native unknown-effect contract: the atomic replace acknowledgement was
      // lost, so the error carries the intent hash and old hash but no proof.
      workspaceMocks.workspaceWriteFileEncoded.mockRejectedValue(Object.assign(
        new Error("atomic replace acknowledgement was lost"),
        {
          kind: "io",
          effect: "unknown",
          intentHash: "intended-new-hash",
          intentByteLength: 16,
          oldHash: `hash-${path}`,
        },
      ));
      // The frontend read-back proves the intended bytes are on disk.
      workspaceMocks.workspaceReadFileWithEncoding.mockResolvedValue(file(path, "initial\ninitial\n", {
        hash: "intended-new-hash",
      }));

      const rendered = renderWorkspace(workspace);
      await screen.findByTitle(`app / ${path}`);
      const content = rendered.container.querySelector<HTMLElement>(".cm-content");
      expect(content).not.toBeNull();
      fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
      await waitFor(() => expect(selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-save-unknown-committed",
      ).openFiles[`root:app:${path}`]?.dirty).toBe(true));

      fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Saved"));
      // Exactly one write attempt and one real read-back verification.
      expect(workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(1);
      expect(workspaceMocks.workspaceReadFileWithEncoding).toHaveBeenCalledWith(
        "/repo/app",
        path,
        "UTF-8",
      );

      const savedObservation = screen.getByTestId("code-workspace-save-observation");
      expect(savedObservation).toHaveAttribute("data-state", "saved");
      expect(savedObservation).toHaveAttribute("data-result-kind", "saved-current");
      expect(savedObservation).toHaveAttribute("data-disk-effect", "committed");
      expect(savedObservation).toHaveAttribute("data-dirty", "false");
      expect(savedObservation).toHaveAttribute("data-receipt-id", expect.stringMatching(/^receipt-tx-save-/));
      expect(savedObservation).toHaveAttribute("data-encoded-bytes-sha256", "intended-new-hash");
      expect(savedObservation).toHaveAttribute("data-disk-pre-sha256", `hash-${path}`);
      expect(savedObservation).toHaveAttribute("data-disk-post-sha256", "intended-new-hash");
      expect(savedObservation).toHaveAttribute("data-write-count", "1");
      expect(savedObservation).not.toHaveAttribute("data-recovery-id");

      // The verified-committed path never leaves a blocking ledger row.
      expect(hasBlockingDiskEffectResolution(
        "instance-save-unknown-committed",
        `/repo/app/${path}`,
      )).toBe(false);

      // The provider is synced with the proven on-disk text.
      await waitFor(() => expect(lspMocks.lspSaveDocument).toHaveBeenCalledWith(
        expect.anything(),
        "initial\ninitial\n",
        expect.anything(),
      ));
    });

    it("reports a verified zero-effect unknown failure and unblocks the retry after read-back", async () => {
      const path = "src/main.ts";
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-save-unknown-none",
        workspaceInstanceId: "instance-save-unknown-none",
        name: "Save Unknown None",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path },
      };
      workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
      workspaceMocks.workspaceReadFile.mockResolvedValue(file(path, "initial\n"));
      workspaceMocks.workspaceWriteFileEncoded.mockRejectedValue(Object.assign(
        new Error("atomic replace acknowledgement was lost"),
        {
          kind: "io",
          effect: "unknown",
          intentHash: "intended-new-hash",
          intentByteLength: 16,
          oldHash: `hash-${path}`,
        },
      ));
      // The read-back proves the old bytes are still on disk: nothing landed.
      workspaceMocks.workspaceReadFileWithEncoding.mockResolvedValue(file(path, "initial\n"));

      const rendered = renderWorkspace(workspace);
      await screen.findByTitle(`app / ${path}`);
      const content = rendered.container.querySelector<HTMLElement>(".cm-content");
      expect(content).not.toBeNull();
      fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
      await waitFor(() => expect(selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-save-unknown-none",
      ).openFiles[`root:app:${path}`]?.dirty).toBe(true));

      fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Save failed"));
      expect(workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(1);
      expect(workspaceMocks.workspaceReadFileWithEncoding).toHaveBeenCalledWith(
        "/repo/app",
        path,
        "UTF-8",
      );

      const errorObservation = screen.getByTestId("code-workspace-save-observation");
      expect(errorObservation).toHaveAttribute("data-state", "error");
      expect(errorObservation).toHaveAttribute("data-result-kind", "failed");
      expect(errorObservation).toHaveAttribute("data-disk-effect", "none");
      expect(errorObservation).toHaveAttribute("data-dirty", "true");
      expect(errorObservation).not.toHaveAttribute("data-receipt-id");
      expect(errorObservation).not.toHaveAttribute("data-recovery-id");

      // Verified zero effect: no blocking ledger row, and the buffer keeps
      // the user's edits dirty for an ordinary retry.
      const fileState = selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-save-unknown-none",
      ).openFiles[`root:app:${path}`];
      expect(fileState?.dirty).toBe(true);
      expect(fileState?.text).toBe("initial\ninitial\n");
      expect(hasBlockingDiskEffectResolution(
        "instance-save-unknown-none",
        `/repo/app/${path}`,
      )).toBe(false);

      // The retry is unblocked: the next Ctrl+S invokes the writer again.
      fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
      await waitFor(() => expect(workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(2));
    });

    it("§8.27.2 BB1 passes root clipboard handle via WorkspaceClipboardSessionContext to CodeMirror split instances", async () => {
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-clipboard-bb1",
        workspaceInstanceId: "instance-clipboard-bb1",
        name: "Clipboard Workspace",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      workspaceMocks.workspaceReadFile.mockImplementation(async (path: string) => {
        if (path === "/repo/app/src/main.ts") return file("src/main.ts", "content-in-main\n");
        return file("src/util.ts", "content-in-util\n");
      });

      renderWorkspace(workspace);
      await screen.findByTitle("app / src/main.ts");

      // Verify that the clipboard store was acquired and is active for this workspaceInstanceId
      const store = acquireClipboardStore("instance-clipboard-bb1");
      const snap = store.getSnapshot();
      expect(snap.consumerCount).toBeGreaterThanOrEqual(1);
      expect(snap.permissionGeneration).toBe(1);

      // Write to the workspace clipboard handle
      store.write({
        sourceViewId: null,
        plainText: "copied-across-split",
        rectangular: false,
        sourceEol: "lf",
      });

      expect(store.read()?.plainText).toBe("copied-across-split");
      store.release();
    });

    it("ED-CLIP-003: cross-split multi-caret copy in primary and paste in secondary with single undo (different files)", async () => {
      resetWorkspaceClipboardStores();
      const baselineConsumerCount = 0;
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-clip-split-diff",
        workspaceInstanceId: "instance-clip-split-diff",
        name: "Different Files Split",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => (
        path === "src/util.ts" || path === "/repo/app/src/util.ts"
          ? file("src/util.ts", "let a = 0;\nlet b = 0;\n")
          : file("src/main.ts", "const x = 10;\nconst y = 20;\n")
      ));

      window.localStorage.setItem("taomni.codeWorkspace.layout.v1.instance-clip-split-diff", JSON.stringify({
        version: 1,
        splitOrientation: "vertical",
        activeEditorGroupId: "primary",
        editorGroups: {
          primary: {
            openOrder: ["root:app:src/main.ts"],
            activeKey: "root:app:src/main.ts",
            previewKey: null,
            pinnedKeys: [],
          },
          secondary: {
            openOrder: ["root:app:src/util.ts"],
            activeKey: "root:app:src/util.ts",
            previewKey: null,
            pinnedKeys: [],
          },
        },
      }));

      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        registrationRef.current = next;
      });

      const { unmount } = renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/main.ts");
      await screen.findByTitle("app / src/util.ts");

      const panes = screen.getAllByTestId("code-workspace-editor-pane");
      const primaryPane = panes.find((p) => p.getAttribute("data-editor-group-id") === "primary");
      const secondaryPane = panes.find((p) => p.getAttribute("data-editor-group-id") === "secondary");
      const primaryEditor = primaryPane?.querySelector<HTMLElement>(".cm-editor");
      const secondaryEditor = secondaryPane?.querySelector<HTMLElement>(".cm-editor");

      expect(primaryEditor).not.toBeNull();
      expect(secondaryEditor).not.toBeNull();
      const primaryView = EditorView.findFromDOM(primaryEditor!);
      const secondaryView = EditorView.findFromDOM(secondaryEditor!);
      expect(primaryView).not.toBeNull();
      expect(secondaryView).not.toBeNull();

      // Assert consumer lease count: both splits hold active leases with distinct tokens
      const store = acquireClipboardStore("instance-clip-split-diff");
      const snap = store.getSnapshot();
      expect(snap.consumerCount).toBe(2);
      expect(snap.consumers[0].token).not.toBe(snap.consumers[1].token);

      // Select 2 segments in primary view (src/main.ts)
      primaryView!.dispatch({
        selection: EditorSelection.create([
          EditorSelection.range(0, 13), // "const x = 10;"
          EditorSelection.range(14, 27), // "const y = 20;"
        ], 0),
      });

      // Focus primary pane and execute copy
      fireEvent.mouseDown(primaryPane!);
      await waitFor(() => expect(
        selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-clip-split-diff").activeEditorGroupId,
      ).toBe("primary"));
      await waitFor(() => expect(
        registrationRef.current?.items.find((item) => item.id === "workspace.editor.copy")?.enabled,
      ).toBe(true));

      await act(async () => {
        await registrationRef.current?.executeAction("workspace.editor.copy");
      });

      // Assert copied payload in workspace session
      const session = store.read();
      expect(session).not.toBeNull();
      expect(session?.segments).toEqual(["const x = 10;", "const y = 20;"]);
      expect(session?.plainText).toBe("const x = 10;\nconst y = 20;");

      // Place 2 carets in secondary view (src/util.ts)
      secondaryView!.dispatch({
        selection: EditorSelection.create([
          EditorSelection.cursor(0), // before "let a = 0;"
          EditorSelection.cursor(11), // before "let b = 0;"
        ], 0),
      });
      const destinationSelectionBeforePaste = secondaryView!.state.selection;
      expect(destinationSelectionBeforePaste.ranges.map((range) => range.head)).toEqual([0, 11]);

      // Focus secondary pane and execute paste
      fireEvent.mouseDown(secondaryPane!);
      await waitFor(() => expect(
        selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-clip-split-diff").activeEditorGroupId,
      ).toBe("secondary"));
      await waitFor(() => expect(
        registrationRef.current?.items.find((item) => item.id === "workspace.editor.paste")?.enabled,
      ).toBe(true));

      await act(async () => {
        await registrationRef.current?.executeAction("workspace.editor.paste");
      });

      // Assert target text in secondary view has distributed segments
      await waitFor(() => {
        expect(secondaryView!.state.doc.toString()).toBe("const x = 10;let a = 0;\nconst y = 20;let b = 0;\n");
        expect(secondaryView!.state.selection.ranges.map((range) => range.head)).toEqual([13, 37]);
        expect(primaryView!.state.doc.toString()).toBe("const x = 10;\nconst y = 20;\n");
      });

      // Single undo restores pre-paste state. Drive the production entry
      // (Ctrl+Z -> workspace.undo -> shared transaction owner): a shared
      // document has no local CodeMirror history() to undo.
      fireEvent.keyDown(secondaryPane!, { key: "z", ctrlKey: true });
      await waitFor(() => {
        expect(secondaryView!.state.doc.toString()).toBe("let a = 0;\nlet b = 0;\n");
        expect(secondaryView!.state.selection.eq(destinationSelectionBeforePaste, true)).toBe(true);
      });

      store.release();
      unmount();
      await new Promise((resolve) => setTimeout(resolve, 20));

      // After workspace unmount, consumer leases and slot are cleaned up
      const afterStore = acquireClipboardStore("instance-clip-split-diff");
      expect(afterStore.getSnapshot().consumerCount).toBe(baselineConsumerCount);
      expect(afterStore.read()).toBeNull();
      afterStore.release();
      resetWorkspaceClipboardStores();
    });

    it("ED-CLIP-004: projects typed copy/paste outcome, OS effect and fallback into the clipboard observation seam", async () => {
      resetWorkspaceClipboardStores();
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-clip-observe",
        workspaceInstanceId: "instance-clip-observe",
        name: "Clipboard Observation",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      workspaceMocks.workspaceReadFile.mockImplementation(async () => (
        file("src/main.ts", "const x = 10;\nconst y = 20;\n")
      ));

      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        registrationRef.current = next;
      });

      renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/main.ts");

      const observation = screen.getByTestId("code-workspace-clipboard-observation");
      // Live-region semantics exist before any clipboard operation ran.
      expect(observation.getAttribute("role")).toBe("status");
      expect(observation.getAttribute("aria-live")).toBe("polite");
      expect(observation.getAttribute("aria-label")).toBe("Clipboard status");
      expect(observation.getAttribute("data-outcome")).toBeNull();

      const pane = screen.getAllByTestId("code-workspace-editor-pane")[0];
      const view = EditorView.findFromDOM(pane.querySelector<HTMLElement>(".cm-editor")!);
      expect(view).not.toBeNull();

      // Two carets so the seam reports the real multi-caret shape.
      view!.dispatch({
        selection: EditorSelection.create([
          EditorSelection.range(0, 13),
          EditorSelection.range(14, 27),
        ], 0),
      });
      fireEvent.mouseDown(pane);
      await waitFor(() => expect(
        registrationRef.current?.items.find((item) => item.id === "workspace.editor.copy")?.enabled,
      ).toBe(true));
      await act(async () => {
        await registrationRef.current?.executeAction("workspace.editor.copy");
      });

      await waitFor(() => {
        expect(observation.getAttribute("data-operation")).toBe("copy");
        expect(observation.getAttribute("data-outcome")).toBe("success");
        expect(observation.getAttribute("data-system-effect")).toBe("performed");
      });
      expect(observation.getAttribute("data-segment-count")).toBe("2");
      expect(observation.getAttribute("data-caret-count")).toBe("2");
      expect(observation.getAttribute("data-payload-length")).toBe(
        String("const x = 10;\nconst y = 20;".length),
      );
      expect(observation.getAttribute("data-workspace-fallback")).toBe("false");
      // Metadata only: the copied text never reaches the DOM seam.
      expect(observation.outerHTML).not.toContain("const x = 10;");
      expect(observation.textContent).toContain("system clipboard effect performed");

      // Real OS read failure: the workspace slot answers and the seam reports
      // unavailable + unknown effect + a visible fallback, never success.
      // mockImplementationOnce, restored below: a leftover queued *Once value
      // would otherwise leak into a later test's clipboard read.
      const defaultNativeReadTextResult = clipboardMocks.readNativeTextResult.getMockImplementation();
      runtimeState.tauri = true;
      clipboardMocks.readNativeTextResult.mockImplementationOnce(async () => ({ ok: false, text: "" }));
      clipboardMocks.readTextResult.mockClear();
      view!.dispatch({ selection: EditorSelection.single(0) });
      await waitFor(() => expect(
        registrationRef.current?.items.find((item) => item.id === "workspace.editor.paste")?.enabled,
      ).toBe(true));
      await act(async () => {
        await registrationRef.current?.executeAction("workspace.editor.paste");
      });

      await waitFor(() => {
        expect(observation.getAttribute("data-operation")).toBe("paste");
        expect(observation.getAttribute("data-outcome")).toBe("unavailable");
      });
      expect(observation.getAttribute("data-system-effect")).toBe("unknown");
      expect(observation.getAttribute("data-workspace-fallback")).toBe("true");
      expect(observation.textContent).toContain("workspace clipboard slot");
      expect(clipboardMocks.readNativeTextResult).toHaveBeenCalledTimes(1);
      expect(clipboardMocks.readTextResult).not.toHaveBeenCalled();
      // The fallback really inserted the payload rather than reporting success.
      expect(view!.state.doc.toString()).toContain("const x = 10;\nconst y = 20;const x = 10;");

      // Drain any unconsumed one-shot and restore the shared mock so this test
      // cannot alter a later test's clipboard behaviour.
      clipboardMocks.readNativeTextResult.mockReset();
      if (defaultNativeReadTextResult) {
        clipboardMocks.readNativeTextResult.mockImplementation(defaultNativeReadTextResult);
      }
      resetWorkspaceClipboardStores();
    });

    it("ED-CLIP-003: cross-split copy/paste with same-file dual split under StrictMode", async () => {
      resetWorkspaceClipboardStores();
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-clip-split-same",
        workspaceInstanceId: "instance-clip-split-same",
        name: "Same File Split",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, _path: string) => (
        file("src/main.ts", "line1: alpha\nline2: beta\nline3: gamma\n")
      ));

      window.localStorage.setItem("taomni.codeWorkspace.layout.v1.instance-clip-split-same", JSON.stringify({
        version: 1,
        splitOrientation: "vertical",
        activeEditorGroupId: "primary",
        editorGroups: {
          primary: {
            openOrder: ["root:app:src/main.ts"],
            activeKey: "root:app:src/main.ts",
            previewKey: null,
            pinnedKeys: [],
          },
          secondary: {
            openOrder: ["root:app:src/main.ts"],
            activeKey: "root:app:src/main.ts",
            previewKey: null,
            pinnedKeys: [],
          },
        },
      }));

      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        registrationRef.current = next;
      });

      const { unmount } = render(
        <StrictMode>
          <CodeWorkspaceTab
            tabId="code-strict-split"
            workspace={workspace}
            onCommandsChange={onCommandsChange}
          />
        </StrictMode>,
      );
      await screen.findAllByTitle("app / src/main.ts");

      const panes = screen.getAllByTestId("code-workspace-editor-pane");
      const primaryPane = panes.find((p) => p.getAttribute("data-editor-group-id") === "primary");
      const secondaryPane = panes.find((p) => p.getAttribute("data-editor-group-id") === "secondary");
      const primaryEditor = primaryPane?.querySelector<HTMLElement>(".cm-editor");
      const secondaryEditor = secondaryPane?.querySelector<HTMLElement>(".cm-editor");

      const primaryView = EditorView.findFromDOM(primaryEditor!);
      const secondaryView = EditorView.findFromDOM(secondaryEditor!);
      expect(primaryView).not.toBeNull();
      expect(secondaryView).not.toBeNull();

      const store = acquireClipboardStore("instance-clip-split-same");
      expect(store.getSnapshot().consumerCount).toBe(2);

      // Select line 1 in primary view
      primaryView!.dispatch({
        selection: EditorSelection.range(0, 12), // "line1: alpha"
      });

      fireEvent.mouseDown(primaryPane!);
      await waitFor(() => expect(
        registrationRef.current?.items.find((item) => item.id === "workspace.editor.copy")?.enabled,
      ).toBe(true));

      await act(async () => {
        await registrationRef.current?.executeAction("workspace.editor.copy");
      });

      expect(store.read()?.plainText).toBe("line1: alpha");

      // Select line 3 in secondary view and paste
      secondaryView!.dispatch({
        selection: EditorSelection.range(25, 37), // "line3: gamma"
      });

      fireEvent.mouseDown(secondaryPane!);
      await waitFor(() => expect(
        registrationRef.current?.items.find((item) => item.id === "workspace.editor.paste")?.enabled,
      ).toBe(true));

      await act(async () => {
        await registrationRef.current?.executeAction("workspace.editor.paste");
      });

      await waitFor(() => {
        expect(secondaryView!.state.doc.toString()).toBe("line1: alpha\nline2: beta\nline1: alpha\n");
      });

      // Undo in secondary view through the production entry.
      fireEvent.keyDown(secondaryPane!, { key: "z", ctrlKey: true });
      await waitFor(() => {
        expect(secondaryView!.state.doc.toString()).toBe("line1: alpha\nline2: beta\nline3: gamma\n");
      });

      store.release();
      unmount();
      await new Promise((resolve) => setTimeout(resolve, 20));
      resetWorkspaceClipboardStores();
    });
  });

  describe("ED-COMPARE-001 editor compare workflow", () => {
    const compareWorkspace = (instanceId: string): CodeWorkspaceTabInfo => ({
      repoRoot: "/repo/app",
      workspaceId: `ws-${instanceId}`,
      workspaceInstanceId: instanceId,
      name: "Compare Workflow",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    });

    const captureCommands = () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      return { registrationRef, onCommandsChange };
    };

    it("reads the selected file and mounts the shared compare surface", async () => {
      const workspace = compareWorkspace("instance-compare-file");
      workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => (
        path === "reference.ts"
          ? file(path, "const value = 2;\n", { encoding: "UTF-16LE", bom: true })
          : file(path, "const value = 1;\n")
      ));
      ipcMocks.selectFilePath.mockResolvedValue("/repo/app/reference.ts");
      const { registrationRef, onCommandsChange } = captureCommands();

      renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/main.ts");
      await waitFor(() => expect(registrationRef.current).not.toBeNull());

      await act(async () => {
        expect((await registrationRef.current!.executeAction("workspace.compareWithFile"))?.kind)
          .toBe("applied");
      });

      expect(ipcMocks.selectFilePath).toHaveBeenCalledTimes(1);
      expect(workspaceMocks.workspaceReadFile.mock.calls.slice(-1)[0]).toEqual([
        "/repo/app",
        "reference.ts",
        expect.any(Number),
      ]);
      const dialog = await screen.findByTestId("code-workspace-compare-dialog");
      expect(dialog).toHaveAttribute("aria-label", 'Compare "reference.ts" ↔ "main.ts"');
      expect(screen.getByTestId("compare-session-metadata")).toHaveTextContent("file");
      expect(screen.getByLabelText("reference.ts comparison side")).toHaveTextContent("UTF-16LE");
      expect(screen.getByTestId("compare-left-line-0")).toHaveTextContent("const value = 2;");
      expect(screen.getByTestId("compare-right-line-0")).toHaveTextContent("const value = 1;");
    });

    it("routes Local History tab action into the same compare dialog", async () => {
      const workspace = compareWorkspace("instance-compare-history-dialog");
      const historyEntry = {
        id: 42,
        path: "/repo/app/src/main.ts",
        contentHash: "snapshot-hash",
        createdAt: 1_788_888_800,
        reason: "save",
        byteLen: 17,
      };
      workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "const value = 1;\n"));
      localHistoryMocks.historyList.mockResolvedValue([historyEntry]);
      localHistoryMocks.historyRead.mockResolvedValue("const value = 0;\n");

      renderWorkspace(workspace);
      await screen.findByTitle("app / src/main.ts");
      const tab = document.querySelector<HTMLElement>(
        '[data-editor-tab-key="root:app:src/main.ts"] button[title="app / src/main.ts"]',
      );
      expect(tab).not.toBeNull();
      fireEvent.contextMenu(tab!);
      fireEvent.click(await screen.findByRole("button", { name: /^Local History/ }));

      await screen.findByTestId("code-workspace-local-history-dialog");
      await waitFor(() => expect(localHistoryMocks.historyRead).toHaveBeenCalledWith(42));
      const compareButton = await screen.findByTestId("code-workspace-local-history-compare");
      expect(compareButton).not.toBeDisabled();
      fireEvent.click(compareButton);

      const dialog = await screen.findByTestId("code-workspace-compare-dialog");
      expect(dialog).toHaveAttribute("aria-label", 'Compare "main.ts @ save #42" ↔ "main.ts"');
      expect(screen.getByTestId("compare-left-line-0")).toHaveTextContent("const value = 0;");
    });

    it("applies a clipboard comparison to a selected range", async () => {
      const workspace = compareWorkspace("instance-compare-selection");
      const initialText = "const one = 1;\nconst two = 2;\n";
      workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", initialText));
      clipboardMocks.readTextResult.mockResolvedValue({ ok: true, text: "const two = 3;" });
      const { registrationRef, onCommandsChange } = captureCommands();

      const rendered = renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/main.ts");
      const content = rendered.container.querySelector<HTMLElement>(".cm-content");
      const view = EditorView.findFromDOM(content!);
      expect(view).not.toBeNull();
      const selectionStart = initialText.indexOf("const two");
      const selectionEnd = selectionStart + "const two = 2;".length;
      act(() => {
        view!.dispatch({ selection: EditorSelection.range(selectionStart, selectionEnd) });
      });
      await waitFor(() => expect(registrationRef.current).not.toBeNull());

      await act(async () => {
        await registrationRef.current!.executeAction("workspace.compareWithClipboard");
      });
      expect(await screen.findByTestId("compare-right-line-0")).toHaveTextContent("const two = 2;");
      fireEvent.click(screen.getByTestId("compare-apply-left-to-right"));

      await waitFor(() => expect(
        selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-compare-selection")
          .openFiles["root:app:src/main.ts"]?.text,
      ).toBe("const one = 1;\nconst two = 3;\n"));
      expect(screen.queryByTestId("code-workspace-compare-dialog")).not.toBeInTheDocument();
      expect(useAppStore.getState().statusMessage).toContain("undo is available");
    });

    it("keeps the compare dialog and makes no apply effect when the target is stale", async () => {
      const workspace = compareWorkspace("instance-compare-stale");
      workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "const value = 1;\n"));
      clipboardMocks.readTextResult.mockResolvedValue({ ok: true, text: "const value = 2;\n" });
      const { registrationRef, onCommandsChange } = captureCommands();

      const rendered = renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/main.ts");
      await waitFor(() => expect(registrationRef.current).not.toBeNull());
      await act(async () => {
        await registrationRef.current!.executeAction("workspace.compareWithClipboard");
      });

      const content = rendered.container.querySelector<HTMLElement>(".cm-content");
      expect(content).not.toBeNull();
      const view = EditorView.findFromDOM(content!);
      act(() => {
        view!.dispatch({
          changes: { from: 0, to: view!.state.doc.length, insert: "const changed = true;\n" },
          userEvent: "input.type",
        });
      });
      await waitFor(() => expect(
        selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-compare-stale")
          .openFiles["root:app:src/main.ts"]?.text,
      ).toBe("const changed = true;\n"));

      fireEvent.click(screen.getByTestId("compare-apply-left-to-right"));
      const error = await screen.findByTestId("compare-apply-error");
      expect(error).toHaveTextContent("Comparison target is stale");
      expect(screen.getByTestId("code-workspace-compare-dialog")).toBeInTheDocument();
      expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-compare-stale")
        .openFiles["root:app:src/main.ts"]?.text).toBe("const changed = true;\n");
    });

    it("asks before replacing dirty text and preserves it when cancelled", async () => {
      const workspace = compareWorkspace("instance-compare-dirty-cancel");
      workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "const value = 1;\n"));
      clipboardMocks.readTextResult.mockResolvedValue({ ok: true, text: "const value = 3;\n" });
      vi.mocked(confirmAppDialog).mockResolvedValueOnce(false);
      const { registrationRef, onCommandsChange } = captureCommands();

      const rendered = renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/main.ts");
      const content = rendered.container.querySelector<HTMLElement>(".cm-content");
      expect(content).not.toBeNull();
      const view = EditorView.findFromDOM(content!);
      act(() => {
        view!.dispatch({
          changes: { from: 0, to: view!.state.doc.length, insert: "const dirty = true;\n" },
          userEvent: "input.type",
        });
      });
      await waitFor(() => expect(
        selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-compare-dirty-cancel")
          .openFiles["root:app:src/main.ts"]?.dirty,
      ).toBe(true));
      await waitFor(() => expect(registrationRef.current).not.toBeNull());
      await act(async () => {
        await registrationRef.current!.executeAction("workspace.compareWithClipboard");
      });

      fireEvent.click(screen.getByTestId("compare-apply-left-to-right"));
      await waitFor(() => expect(confirmAppDialog).toHaveBeenCalledWith(expect.objectContaining({
        title: "Apply comparison",
      })));
      expect(screen.getByTestId("code-workspace-compare-dialog")).toBeInTheDocument();
      expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-compare-dirty-cancel")
        .openFiles["root:app:src/main.ts"]?.text).toBe("const dirty = true;\n");
      expect(useAppStore.getState().statusMessage).toContain("unsaved changes were kept");
    });

    it("records one comparison transaction that supports undo and redo", async () => {
      const workspace = compareWorkspace("instance-compare-history");
      workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "const value = 1;\n"));
      clipboardMocks.readTextResult.mockResolvedValue({ ok: true, text: "const value = 2;\n" });
      const { registrationRef, onCommandsChange } = captureCommands();
      const rendered = renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/main.ts");
      await waitFor(() => expect(registrationRef.current).not.toBeNull());
      await act(async () => {
        await registrationRef.current!.executeAction("workspace.compareWithClipboard");
      });
      fireEvent.click(screen.getByTestId("compare-apply-left-to-right"));
      await waitFor(() => expect(
        selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-compare-history")
          .openFiles["root:app:src/main.ts"]?.text,
      ).toBe("const value = 2;\n"));

      // ED-AUDIT-008: the journal action is focus-gated off the editor surface
      // (the shared document undo claims the stroke there), so the comparison
      // undo/redo is driven from non-editor focus (window target).
      await waitFor(() => expect(
        registrationRef.current?.items.find((item) => item.id === "workspace.undoWorkspaceEdit")?.enabled,
      ).toBe(false));
      await act(async () => {
        fireEvent.keyDown(window, { key: "z", ctrlKey: true });
      });
      await waitFor(() => expect(
        selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-compare-history")
          .openFiles["root:app:src/main.ts"]?.text,
      ).toBe("const value = 1;\n"));

      await act(async () => {
        fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
      });
      await waitFor(() => expect(
        selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-compare-history")
          .openFiles["root:app:src/main.ts"]?.text,
      ).toBe("const value = 2;\n"));
      expect(rendered.container.querySelector(".cm-content")?.textContent).toContain("const value = 2;");
    });
  });

  describe("ED-AUDIT-014: refactor recovery journal", () => {
    const RECOVERY_V2_PREFIX = "taomni.refactor.recovery.v2:";
    // Simulated disk keyed by root-relative path. The rename edits both files:
    // main.ts is the open buffer, other.ts is a closed disk file.
    const PRE: Record<string, string> = {
      "src/main.ts": "alpha = 1",
      "src/other.ts": "alpha = 2",
      "src/reader.ts": "reader",
    };
    const POST: Record<string, string> = {
      "src/main.ts": "omega = 1",
      "src/other.ts": "omega = 2",
    };

    interface RecoveryFixture {
      disk: Record<string, string>;
      workspace: CodeWorkspaceTabInfo;
      registrationRef: { current: WorkspaceCommandRegistration | null };
      onCommandsChange: (tabId: string, next: WorkspaceCommandRegistration | null) => void;
    }

    /** Simulated workspace disk: reads and encoded writes hit one shared map. */
    function setupWorkspace(instanceId: string, openFile: string): RecoveryFixture {
      const disk: Record<string, string> = { ...PRE };
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: `ws-${instanceId}`,
        workspaceInstanceId: `instance-${instanceId}`,
        name: instanceId,
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: openFile },
      };
      workspaceMocks.workspaceListDir.mockImplementation(async (_root: string, path: string) => (
        path === "src"
          ? Object.keys(disk).map((rel) => entry(rel.split("/").pop()!, rel))
          : [entry("src", "src", "dir")]
      ));
      workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => {
        if (!(path in disk)) throw new Error(`missing fixture file: ${path}`);
        return file(path, disk[path]);
      });
      workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _root: string,
        path: string,
        text: string,
      ) => {
        disk[path] = text;
        return writeAck(file(path, text, { hash: `hash-${text}` }));
      });
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      return { disk, workspace, registrationRef, onCommandsChange };
    }

    /**
     * Provider rename fixture: renames `alpha` to `omega` in the open document
     * and in the closed sibling. The rename-symbol flow is the journal-gated
     * production path (code actions manage their own adapter transaction with
     * recordHistory disabled, so they intentionally do not journal here).
     */
    function mockTwoFileRename(): void {
      const status = documentStatus({
        path: "/repo/app/src/main.ts",
        uri: "file:///repo/app/src/main.ts",
        available: true,
        active: true,
        capabilities: defaultCapabilities({ rename: true }),
      });
      lspMocks.lspOpenDocument.mockResolvedValue(status);
      lspMocks.lspChangeDocument.mockResolvedValue(status);
      lspMocks.lspPrepareRename.mockResolvedValue({
        status,
        allowed: true,
        range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
        placeholder: "alpha",
        message: null,
      });
      lspMocks.lspRename.mockResolvedValue({
        status,
        edit: {
          documentEdits: [
            {
              uri: "file:///repo/app/src/main.ts",
              path: "/repo/app/src/main.ts",
              edits: [{
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
                newText: "omega",
              }],
            },
            {
              uri: "file:///repo/app/src/other.ts",
              path: "/repo/app/src/other.ts",
              edits: [{
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } },
                newText: "omega",
              }],
            },
          ],
        },
      });
    }

    /** Drives Rename Symbol -> new name -> preview confirm. */
    async function runRename(
      registrationRef: RecoveryFixture["registrationRef"],
    ): Promise<void> {
      vi.mocked(promptAppDialog).mockResolvedValue("omega");
      await registrationRef.current!.executeAction("workspace.renameSymbol");
      const preview = await screen.findByTestId("refactoring-preview-dialog");
      fireEvent.click(within(preview).getByTestId("refactoring-preview-apply"));
    }

    function recoveryDocument(
      uri: string,
      canonicalPath: string,
      preText: string,
      postText: string,
    ) {
      return {
        uri,
        canonicalPath,
        preText,
        preHash: sha256Hex(preText),
        postText,
        postHash: sha256Hex(postText),
        encoding: "UTF-8",
        bom: false,
        eol: "lf" as const,
      };
    }

    function seedPendingJournal(): void {
      const result = recordRefactorRecoveryJournalV2({
        schemaVersion: 2,
        recoveryId: "rec-reopen-1",
        transactionId: "tx-reopen-1",
        actionId: "rename:update-two-files",
        kind: "rename",
        workspaceRoot: "/repo/app",
        createdAt: 100,
        updatedAt: 200,
        status: "recovery-required",
        appliedOperationIndex: null,
        documents: [
          recoveryDocument("file:///repo/app/src/main.ts", "/repo/app/src/main.ts", PRE["src/main.ts"], POST["src/main.ts"]),
          recoveryDocument("file:///repo/app/src/other.ts", "/repo/app/src/other.ts", PRE["src/other.ts"], POST["src/other.ts"]),
        ],
        resourceMoves: [],
        verification: { mismatchedUris: [], checkedAt: null },
      });
      expect(result.ok).toBe(true);
    }

    function storedRecoveryEntries(): Array<{
      key: string;
      entry: { status: string; verification: { mismatchedUris: string[] } };
    }> {
      return Object.keys(window.localStorage)
        .filter((key) => key.startsWith(RECOVERY_V2_PREFIX))
        .map((key) => ({ key, entry: JSON.parse(window.localStorage.getItem(key)!) }));
    }

    function recoveryCalls(): Array<{ title: string; message: string }> {
      return vi.mocked(confirmAppDialog).mock.calls.map((call) => ({
        title: (call[0] as { title: string }).title,
        message: (call[0] as { message: string }).message,
      }));
    }

    function undoItem(registrationRef: RecoveryFixture["registrationRef"]) {
      return registrationRef.current?.items.find((item) => item.id === "workspace.undoWorkspaceEdit");
    }

    /**
     * jsdom's Storage instance cannot be spied reliably, so tests that must
     * observe or fail journal writes swap in a recording Storage fake.
     */
    function installRecordingStorage(
      onWrite?: (key: string, value: string) => void,
    ): { restore: () => void; keys: () => string[] } {
      const backing = new Map<string, string>();
      const fake: Storage = {
        get length() { return backing.size; },
        clear: () => backing.clear(),
        getItem: (k) => backing.get(k) ?? null,
        key: (i) => Array.from(backing.keys())[i] ?? null,
        removeItem: (k) => { backing.delete(k); },
        setItem: (k, v) => { onWrite?.(k, v); backing.set(k, v); },
      };
      const original = window.localStorage;
      Object.defineProperty(window, "localStorage", { value: fake, configurable: true, writable: true });
      return {
        restore: () => Object.defineProperty(window, "localStorage", { value: original, configurable: true, writable: true }),
        keys: () => Array.from(backing.keys()),
      };
    }

    it("closes a postcondition-mismatched transaction as recovery-required without success history", async () => {
      const { disk, workspace, registrationRef, onCommandsChange } = setupWorkspace("recovery-mismatch", "src/main.ts");
      mockTwoFileRename();
      // A concurrent writer wins the race on the closed file: the write ack
      // says committed, but the on-disk post-state is third-party content.
      workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _root: string,
        path: string,
        _text: string,
      ) => {
        disk[path] = "third-party edit";
        return writeAck(file(path, "third-party edit", { hash: "hash-third-party" }));
      });

      renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/main.ts");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
      await runRename(registrationRef);

      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("recovery required"));
      expect(useAppStore.getState().statusMessage).toContain("Refactor postcondition failed");
      expect(useAppStore.getState().statusMessage).toContain("mismatch on /repo/app/src/other.ts");
      expect(useAppStore.getState().statusMessage).toContain("Applied changes on: /repo/app/src/main.ts, /repo/app/src/other.ts");
      // The applied changes stay; nothing is rolled back silently.
      expect(selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-recovery-mismatch",
      ).openFiles["root:app:src/main.ts"]?.text).toBe(POST["src/main.ts"]);
      // No normal success history: undo stays unavailable.
      expect(undoItem(registrationRef)?.enabled).toBe(false);
      // The pending journal records the mismatch for recovery.
      const entries = storedRecoveryEntries();
      expect(entries).toHaveLength(1);
      expect(entries[0]!.entry.status).toBe("recovery-required");
      expect(entries[0]!.entry.verification.mismatchedUris).toContain("file:///repo/app/src/other.ts");
    });

    it("aborts with zero writes when the recovery journal cannot be persisted", async () => {
      const { workspace, registrationRef, onCommandsChange } = setupWorkspace("recovery-quota", "src/main.ts");
      mockTwoFileRename();
      const storage = installRecordingStorage((key) => {
        if (key.startsWith(RECOVERY_V2_PREFIX)) throw new Error("quota exceeded");
      });

      renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/main.ts");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
      await runRename(registrationRef);

      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
        "Refactor recovery journal could not be persisted, no changes were applied",
      ));
      expect(useAppStore.getState().statusMessage).toContain("quota exceeded");
      expect(workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
      expect(selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        "instance-recovery-quota",
      ).openFiles["root:app:src/main.ts"]?.text).toBe(PRE["src/main.ts"]);
      expect(undoItem(registrationRef)?.enabled).toBe(false);
      expect(storage.keys().filter((key) => key.startsWith(RECOVERY_V2_PREFIX))).toHaveLength(0);
      storage.restore();
    });

    it("prepares the journal before the first mutation, commits it after verified postconditions, and supports undo/redo", async () => {
      const { disk, workspace, registrationRef, onCommandsChange } = setupWorkspace("recovery-order", "src/reader.ts");
      mockTwoFileRename();
      // Recording storage fake: jsdom's Storage cannot be spied reliably, so
      // writes are observed (and values captured) through the fake itself.
      const events: Array<{ kind: string; key: string; value: string }> = [];
      const storage = installRecordingStorage((key, value) => {
        events.push({ kind: key.startsWith(RECOVERY_V2_PREFIX) ? "journal" : "other", key, value });
      });
      const writeMock = workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _root: string,
        path: string,
        text: string,
      ) => {
        events.push({ kind: "disk-write", key: path, value: text });
        disk[path] = text;
        return writeAck(file(path, text, { hash: `hash-${text}` }));
      });

      renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/reader.ts");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
      await runRename(registrationRef);

      await waitFor(() => expect(writeMock).toHaveBeenCalledTimes(2));
      const journalEventIndex = events.findIndex((event) => event.kind === "journal");
      const firstWriteIndex = events.findIndex((event) => event.kind === "disk-write");
      expect(journalEventIndex).toBeGreaterThanOrEqual(0);
      expect(firstWriteIndex).toBeGreaterThan(journalEventIndex);
      // The prepared entry (captured at write time, before the later committed
      // patch overwrites the same key) is what precedes mutation.
      const journalEvent = events[journalEventIndex]!;
      const journalKey = journalEvent.key;
      expect(JSON.parse(journalEvent.value)).toMatchObject({ status: "prepared" });

      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Applied 2"));
      expect(getRefactorRecoveryJournalV2(journalKey.slice(RECOVERY_V2_PREFIX.length))?.status).toBe("committed");
      expect(disk["src/main.ts"]).toBe(POST["src/main.ts"]);
      expect(disk["src/other.ts"]).toBe(POST["src/other.ts"]);

      // ED-AUDIT-008: the journal action is focus-gated off the editor surface;
      // the recovery stroke is taken from non-editor focus (window target).
      // "Applied 2" is set after the journal entry is pushed, so it is the
      // readiness signal for an undoable transaction.
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Applied 2"));
      await act(async () => {
        fireEvent.keyDown(window, { key: "z", ctrlKey: true });
      });
      await waitFor(() => expect(disk["src/main.ts"]).toBe(PRE["src/main.ts"]));
      await waitFor(() => expect(disk["src/other.ts"]).toBe(PRE["src/other.ts"]));

      await act(async () => {
        fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
      });
      await waitFor(() => expect(disk["src/main.ts"]).toBe(POST["src/main.ts"]));
      await waitFor(() => expect(disk["src/other.ts"]).toBe(POST["src/other.ts"]));
      storage.restore();
    });

    it("blocks undo when a later edit changed a recorded file and protects that edit", async () => {
      const { disk, workspace, registrationRef, onCommandsChange } = setupWorkspace("recovery-undo-block", "src/reader.ts");
      mockTwoFileRename();

      renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/reader.ts");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
      await runRename(registrationRef);
      await waitFor(() => expect(disk["src/other.ts"]).toBe(POST["src/other.ts"]));

      // ED-AUDIT-008: "Applied 2" is set after the journal entry is pushed, so
      // it is the readiness signal; the undo stroke is taken from non-editor
      // focus (window target) because the journal action is focus-gated off
      // the editor surface.
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Applied 2"));
      // A later edit lands on one recorded file before the user undoes.
      disk["src/other.ts"] = "later third-party edit";
      await act(async () => {
        fireEvent.keyDown(window, { key: "z", ctrlKey: true });
      });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
        "Cannot undo workspace edit: Undo blocked to protect later edits",
      ));
      expect(useAppStore.getState().statusMessage).toContain("/repo/app/src/other.ts");
      // Zero overwrite: the later edit and the other recorded file are intact.
      expect(disk["src/other.ts"]).toBe("later third-party edit");
      expect(disk["src/main.ts"]).toBe(POST["src/main.ts"]);
    });

    it("restores pending recovery entries through the real UI after reopen", async () => {
      const { disk, workspace } = setupWorkspace("recovery-restore", "src/reader.ts");
      // The interrupted transaction already applied its post-state on disk.
      disk["src/main.ts"] = POST["src/main.ts"];
      disk["src/other.ts"] = POST["src/other.ts"];
      seedPendingJournal();

      renderWorkspace(workspace, {});
      await screen.findByTitle("app / src/reader.ts");
      await waitFor(() => expect(recoveryCalls().some((call) => call.title === "Refactor recovery pending")).toBe(true));
      expect(recoveryCalls()[0]?.message).toContain("/repo/app/src/main.ts");
      expect(recoveryCalls()[0]?.message).toContain("/repo/app/src/other.ts");

      await waitFor(() => expect(disk["src/main.ts"]).toBe(PRE["src/main.ts"]));
      await waitFor(() => expect(disk["src/other.ts"]).toBe(PRE["src/other.ts"]));
      expect(getRefactorRecoveryJournalV2("rec-reopen-1")?.status).toBe("rolled-back");
      expect(useAppStore.getState().statusMessage).toContain("Refactor recovery complete: restored 2");
    });

    it("closes an already-restored pending entry idempotently without rewriting files", async () => {
      const { disk, workspace } = setupWorkspace("recovery-idempotent", "src/reader.ts");
      // Disk is already at the pre-refactor content (someone restored it).
      seedPendingJournal();

      renderWorkspace(workspace, {});
      await screen.findByTitle("app / src/reader.ts");
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
        "already matches its pre-refactor content",
      ));
      expect(workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
      expect(disk["src/main.ts"]).toBe(PRE["src/main.ts"]);
      expect(getRefactorRecoveryJournalV2("rec-reopen-1")?.status).toBe("rolled-back");
    });

    it("keeps conflicting files untouched and the entry pending", async () => {
      const { disk, workspace } = setupWorkspace("recovery-conflict", "src/reader.ts");
      disk["src/main.ts"] = POST["src/main.ts"];
      disk["src/other.ts"] = "user edited after the refactor";
      seedPendingJournal();

      renderWorkspace(workspace, {});
      await screen.findByTitle("app / src/reader.ts");
      await waitFor(() => expect(recoveryCalls().some((call) => call.title === "Refactor recovery blocked")).toBe(true));
      const blocked = recoveryCalls().find((call) => call.title === "Refactor recovery blocked");
      expect(blocked?.message).toContain("/repo/app/src/other.ts (conflict)");
      expect(blocked?.message).toContain("will not be overwritten");
      // Zero overwrite: the third-party content and the post-state stay as-is.
      expect(disk["src/other.ts"]).toBe("user edited after the refactor");
      expect(disk["src/main.ts"]).toBe(POST["src/main.ts"]);
      expect(workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
      expect(getRefactorRecoveryJournalV2("rec-reopen-1")?.status).toBe("recovery-required");
    });

    it("never replays legacy v1 recovery journals", async () => {
      const { workspace } = setupWorkspace("recovery-legacy", "src/reader.ts");
      window.localStorage.setItem(
        "taomni.refactor.recovery.v1:legacy-1",
        JSON.stringify({ schemaVersion: 1, recoveryId: "legacy-1", status: "pending" }),
      );

      renderWorkspace(workspace, {});
      await screen.findByTitle("app / src/reader.ts");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
      // Let every pending microtask/discovery pass settle.
      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(recoveryCalls().filter((call) => call.title === "Refactor recovery pending")).toHaveLength(0);
      expect(window.localStorage.getItem("taomni.refactor.recovery.v1:legacy-1")).not.toBeNull();
      expect(Object.keys(window.localStorage).filter((key) => key.startsWith(RECOVERY_V2_PREFIX))).toHaveLength(0);
    });
  });

  describe("ED-AUDIT-015 rearrange execute wiring (mounted, model boundary for the supported path)", () => {
    const SERVICE_PRE = "package com.example;\n\npublic class Service {\n    public void beta() {}\n    public void alpha() {}\n}\n";
    const SERVICE_POST = "package com.example;\n\npublic class Service {\n    public void alpha() {}\n    public void beta() {}\n}\n";
    const SWAP_EDIT = {
      range: { start: { line: 3, character: 0 }, end: { line: 4, character: 26 } },
      newText: "    public void alpha() {}\n    public void beta() {}",
    };

    function rearrangeWorkspace(instance: string): CodeWorkspaceTabInfo {
      return {
        repoRoot: "/repo/app",
        workspaceId: "ws-rearrange",
        workspaceInstanceId: instance,
        name: "Rearrange",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/Service.java" },
      };
    }

    function mockRearrangeServer(codeActionKinds: string[]) {
      workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
      workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/Service.java", SERVICE_PRE));
      workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _rootPath: string,
        path: string,
        text: string,
      ) => writeAck(file(path, text, { hash: `hash-${text}` })));
      lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({
        path: "/repo/app/src/Service.java",
        uri: "file:///repo/app/src/Service.java",
        presetId: "jdtls",
        languageId: "java",
        displayName: "Eclipse JDT Language Server",
        available: true,
        active: true,
        capabilities: defaultCapabilities({ codeAction: true, codeActionKinds }),
      }));
    }

    function fileText(instance: string): string | undefined {
      return selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        instance,
      ).openFiles["root:app:src/Service.java"]?.text;
    }

    it("reports honest unavailable via live discovery when rearrange is unadvertised", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockRearrangeServer(["quickfix", "source.organizeImports"]);
      vi.mocked(confirmAppDialog).mockClear();
      lspMocks.lspCodeActions.mockClear();
      // Live discovery returns only the advertised non-rearrange actions.
      lspMocks.lspCodeActions.mockResolvedValue({
        status: documentStatus({ available: true, active: true }),
        actions: [
          { title: "Organize imports", kind: "source.organizeImports", raw: {} },
        ],
      });

      renderWorkspace(rearrangeWorkspace("instance-rearrange-unavail"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await act(async () => {
        await registrationRef.current?.executeAction("workspace.rearrangeCode");
      });
      // Advertised summaries never arbitrate (JDT LS never advertises
      // arrangement kinds): the handler discovers live, finds no
      // rearrange-kind action, and reports the received kinds with zero
      // commits and no fake success.
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Provider returned no rearrange action"));
      expect(fileText("instance-rearrange-unavail")).toBe(SERVICE_PRE);
      expect(lspMocks.lspCodeActions).toHaveBeenCalled();
      expect(confirmAppDialog).not.toHaveBeenCalled();
    });

    it("refuses a provider-disabled rearrange action before resolve and shows the reason (ED-MAIN-002)", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockRearrangeServer(["source.rearrange"]);
      vi.mocked(confirmAppDialog).mockClear();
      lspMocks.lspCodeActions.mockClear();
      lspMocks.lspCodeActionResolve.mockClear();
      // LSP standard disabled object: the action is returned by discovery but
      // the provider marks it disabled with a reason.
      lspMocks.lspCodeActions.mockResolvedValue({
        status: documentStatus({ available: true, active: true }),
        actions: [{
          title: "Rearrange members",
          kind: "source.rearrange",
          isPreferred: true,
          edit: null,
          command: null,
          commandArguments: null,
          raw: { title: "Rearrange members", disabled: { reason: "cannot rearrange generated file" } },
        }],
      });

      renderWorkspace(rearrangeWorkspace("instance-rearrange-disabled"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await act(async () => {
        await registrationRef.current?.executeAction("workspace.rearrangeCode");
      });
      await waitFor(() => expect(useAppStore.getState().statusMessage)
        .toContain("cannot rearrange generated file"));
      expect(useAppStore.getState().statusMessage).toContain("disabled by the provider");
      expect(lspMocks.lspCodeActionResolve).not.toHaveBeenCalled();
      expect(confirmAppDialog).not.toHaveBeenCalled();
      expect(fileText("instance-rearrange-disabled")).toBe(SERVICE_PRE);
    });

    it("commits one verified transaction from the action entry on the supported path", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockRearrangeServer(["source.rearrange"]);
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockResolvedValue(true);
      const rearrangeAction = {
        title: "Rearrange members",
        kind: "source.rearrange",
        isPreferred: true,
        edit: null,
        command: null,
        commandArguments: null,
        raw: { title: "Rearrange members" },
      };
      lspMocks.lspCodeActions.mockResolvedValue({
        status: documentStatus({ available: true, active: true }),
        actions: [rearrangeAction],
      });
      lspMocks.lspCodeActionResolve.mockResolvedValue({
        status: documentStatus({ available: true, active: true }),
        action: {
          ...rearrangeAction,
          edit: {
            documentEdits: [{
              uri: "file:///repo/app/src/Service.java",
              path: "/repo/app/src/Service.java",
              edits: [SWAP_EDIT],
            }],
          },
        },
      });

      renderWorkspace(rearrangeWorkspace("instance-rearrange-apply"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await act(async () => {
        await registrationRef.current?.executeAction("workspace.rearrangeCode");
      });
      await waitFor(() => expect(confirmAppDialog).toHaveBeenCalledWith(expect.objectContaining({
        title: "Rearrange preview",
      })));
      await waitFor(() => expect(fileText("instance-rearrange-apply")).toBe(SERVICE_POST));
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Rearranged"));
      // Test-double provider: this proves the handler wiring (request ->
      // resolve -> plan -> confirm -> apply -> post-verify), not a live
      // capable provider.
    });

    it("cancels at the preview gate with zero commits", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockRearrangeServer(["source.rearrange"]);
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockResolvedValue(false);
      const rearrangeAction = {
        title: "Rearrange members",
        kind: "source.rearrange",
        isPreferred: true,
        edit: null,
        command: null,
        commandArguments: null,
        raw: { title: "Rearrange members" },
      };
      lspMocks.lspCodeActions.mockResolvedValue({
        status: documentStatus({ available: true, active: true }),
        actions: [rearrangeAction],
      });
      lspMocks.lspCodeActionResolve.mockResolvedValue({
        status: documentStatus({ available: true, active: true }),
        action: {
          ...rearrangeAction,
          edit: {
            documentEdits: [{
              uri: "file:///repo/app/src/Service.java",
              path: "/repo/app/src/Service.java",
              edits: [SWAP_EDIT],
            }],
          },
        },
      });

      renderWorkspace(rearrangeWorkspace("instance-rearrange-cancel"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await act(async () => {
        await registrationRef.current?.executeAction("workspace.rearrangeCode");
      });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("cancelled"));
      expect(fileText("instance-rearrange-cancel")).toBe(SERVICE_PRE);
      expect(workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
    });
  });

  describe("ED-IMPROVE-001 preview-window identity guard (mounted, model boundary)", () => {
    const SERVICE_PRE = "package com.example;\n\npublic class Service {\n    public void beta() {}\n    public void alpha() {}\n}\n";
    const SERVICE_RELOADED = "package com.example;\n\npublic class Service {\n    public void gamma() {}\n    public void alpha() {}\n}\n";
    const SWAP_EDIT = {
      range: { start: { line: 3, character: 0 }, end: { line: 4, character: 26 } },
      newText: "    public void alpha() {}\n    public void beta() {}",
    };

    function stalePreviewWorkspace(instance: string): CodeWorkspaceTabInfo {
      return {
        repoRoot: "/repo/app",
        workspaceId: "ws-improve001",
        workspaceInstanceId: instance,
        name: "Improve 001",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/Service.java" },
      };
    }

    function fileText(instance: string): string | undefined {
      return selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        instance,
      ).openFiles["root:app:src/Service.java"]?.text;
    }

    function mockProvider() {
      workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
      workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _rootPath: string,
        path: string,
        text: string,
      ) => writeAck(file(path, text, { hash: `hash-${text}` })));
      lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({
        path: "/repo/app/src/Service.java",
        uri: "file:///repo/app/src/Service.java",
        presetId: "jdtls",
        languageId: "java",
        displayName: "Eclipse JDT Language Server",
        available: true,
        active: true,
        capabilities: defaultCapabilities({ codeAction: true, codeActionKinds: ["source.rearrange"] }),
      }));
      const rearrangeAction = {
        title: "Rearrange members",
        kind: "source.rearrange",
        isPreferred: true,
        edit: null,
        command: null,
        commandArguments: null,
        raw: { title: "Rearrange members" },
      };
      lspMocks.lspCodeActions.mockResolvedValue({
        status: documentStatus({ available: true, active: true }),
        actions: [rearrangeAction],
      });
      lspMocks.lspCodeActionResolve.mockResolvedValue({
        status: documentStatus({ available: true, active: true }),
        action: {
          ...rearrangeAction,
          edit: {
            documentEdits: [{
              uri: "file:///repo/app/src/Service.java",
              path: "/repo/app/src/Service.java",
              edits: [SWAP_EDIT],
            }],
          },
        },
      });
    }

    it("refuses the plan when the document changed while the preview was open", async () => {
      runtimeState.tauri = true;
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockProvider();
      let disk = file("src/Service.java", SERVICE_PRE, { hash: "hash-pre" });
      workspaceMocks.workspaceReadFile.mockImplementation(async () => disk);
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockImplementation(async () => {
        // A real external process writes the file while the preview dialog is
        // open; the watcher reloads the clean buffer before the user confirms.
        disk = file("src/Service.java", SERVICE_RELOADED, { hash: "hash-reloaded" });
        await emit("lsp://external-file-change", {
          workspaceId: "instance-improve001-stale",
          path: "/repo/app/src/Service.java",
          type: 2,
        });
        // The watcher coalesces events for EXTERNAL_FILE_EVENT_SETTLE_MS
        // before reloading the clean buffer; give the real debounce time to
        // land so the confirmation truly races a changed document.
        await new Promise((resolve) => setTimeout(resolve, 240));
        return true;
      });

      renderWorkspace(stalePreviewWorkspace("instance-improve001-stale"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await act(async () => {
        await registrationRef.current?.executeAction("workspace.rearrangeCode");
      });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
        "changed since the frozen preimage",
      ));
      expect(fileText("instance-improve001-stale")).toBe(SERVICE_RELOADED);
      expect(workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
    });
  });

  describe("ED-AUDIT-016 cleanup execute wiring (mounted, model boundary for the supported path)", () => {
    const SERVICE_PRE = "package com.example;\n\npublic class Service {\n    public void beta() {}\n    public void alpha() {}\n}\n";
    const SERVICE_POST = "package com.example;\n\npublic class Service {\n    public void alpha() {}\n    public void beta() {}\n}\n";
    const CLEANUP_EDIT = {
      range: { start: { line: 3, character: 0 }, end: { line: 4, character: 26 } },
      newText: "    public void alpha() {}\n    public void beta() {}",
    };

    function cleanupWorkspace(instance: string): CodeWorkspaceTabInfo {
      return {
        repoRoot: "/repo/app",
        workspaceId: "ws-cleanup",
        workspaceInstanceId: instance,
        name: "Cleanup",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/Service.java" },
      };
    }

    function mockCleanupServer(codeActionKinds: string[]) {
      workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
      workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/Service.java", SERVICE_PRE));
      workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _rootPath: string,
        path: string,
        text: string,
      ) => writeAck(file(path, text, { hash: `hash-${text}` })));
      lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({
        path: "/repo/app/src/Service.java",
        uri: "file:///repo/app/src/Service.java",
        presetId: "jdtls",
        languageId: "java",
        displayName: "Eclipse JDT Language Server",
        available: true,
        active: true,
        capabilities: defaultCapabilities({ codeAction: true, codeActionKinds }),
      }));
    }

    function fileText(instance: string): string | undefined {
      return selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        instance,
      ).openFiles["root:app:src/Service.java"]?.text;
    }

    it("reports honest unavailable via live discovery when cleanup is unadvertised", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockCleanupServer(["quickfix", "source.organizeImports"]);
      vi.mocked(confirmAppDialog).mockClear();
      lspMocks.lspCodeActions.mockClear();
      lspMocks.lspCodeActions.mockResolvedValue({
        status: documentStatus({ available: true, active: true }),
        actions: [
          { title: "Organize imports", kind: "source.organizeImports", raw: {} },
        ],
      });

      renderWorkspace(cleanupWorkspace("instance-cleanup-unavail"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await act(async () => {
        await registrationRef.current?.executeAction("workspace.codeCleanup");
      });
      // Advertised summaries never arbitrate: live discovery finds no
      // cleanup-kind action and reports the received kinds, zero commits.
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Provider returned no cleanup action"));
      expect(fileText("instance-cleanup-unavail")).toBe(SERVICE_PRE);
      expect(lspMocks.lspCodeActions).toHaveBeenCalled();
      expect(confirmAppDialog).not.toHaveBeenCalled();
    });

    it("commits one verified transaction from the action entry on the supported path", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockCleanupServer(["source.cleanup"]);
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockResolvedValue(true);
      const cleanupAction = {
        title: "Clean up",
        kind: "source.cleanup",
        isPreferred: true,
        edit: null,
        command: null,
        commandArguments: null,
        raw: { title: "Clean up" },
      };
      lspMocks.lspCodeActions.mockResolvedValue({
        status: documentStatus({ available: true, active: true }),
        actions: [cleanupAction],
      });
      lspMocks.lspCodeActionResolve.mockResolvedValue({
        status: documentStatus({ available: true, active: true }),
        action: {
          ...cleanupAction,
          edit: {
            documentEdits: [{
              uri: "file:///repo/app/src/Service.java",
              path: "/repo/app/src/Service.java",
              edits: [CLEANUP_EDIT],
            }],
          },
        },
      });

      renderWorkspace(cleanupWorkspace("instance-cleanup-apply"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await act(async () => {
        await registrationRef.current?.executeAction("workspace.codeCleanup");
      });
      await waitFor(() => expect(confirmAppDialog).toHaveBeenCalledWith(expect.objectContaining({
        title: "Code cleanup preview",
      })));
      await waitFor(() => expect(fileText("instance-cleanup-apply")).toBe(SERVICE_POST));
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Cleaned up"));
      // Test-double provider: this proves the handler wiring (request ->
      // resolve -> plan -> confirm -> apply -> post-verify), not a live
      // capable provider.
    });

    it("cancels at the preview gate with zero commits", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockCleanupServer(["source.cleanup"]);
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockResolvedValue(false);
      const cleanupAction = {
        title: "Clean up",
        kind: "source.cleanup",
        isPreferred: true,
        edit: null,
        command: null,
        commandArguments: null,
        raw: { title: "Clean up" },
      };
      lspMocks.lspCodeActions.mockResolvedValue({
        status: documentStatus({ available: true, active: true }),
        actions: [cleanupAction],
      });
      lspMocks.lspCodeActionResolve.mockResolvedValue({
        status: documentStatus({ available: true, active: true }),
        action: {
          ...cleanupAction,
          edit: {
            documentEdits: [{
              uri: "file:///repo/app/src/Service.java",
              path: "/repo/app/src/Service.java",
              edits: [CLEANUP_EDIT],
            }],
          },
        },
      });

      renderWorkspace(cleanupWorkspace("instance-cleanup-cancel"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await act(async () => {
        await registrationRef.current?.executeAction("workspace.codeCleanup");
      });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("cancelled"));
      expect(fileText("instance-cleanup-cancel")).toBe(SERVICE_PRE);
      expect(workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
    });
  });

  describe("ED-IMPROVE-002 workflow postcondition/history/recovery (mounted)", () => {
    const SERVICE_PRE = "package com.example;\n\npublic class Service {\n    public void beta() {}\n    public void alpha() {}\n}\n";
    const SERVICE_POST = "package com.example;\n\npublic class Service {\n    public void alpha() {}\n    public void beta() {}\n}\n";
    const SWAP_EDIT = {
      range: { start: { line: 3, character: 0 }, end: { line: 4, character: 26 } },
      newText: "    public void alpha() {}\n    public void beta() {}",
    };
    const RECOVERY_V2_PREFIX = "taomni.refactor.recovery.v2:";
    const OPEN_KEY = "root:app:src/Service.java";

    function workflowWorkspace(instance: string): CodeWorkspaceTabInfo {
      return {
        repoRoot: "/repo/app",
        workspaceId: "ws-improve002",
        workspaceInstanceId: instance,
        name: "Improve 002",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/Service.java" },
      };
    }

    function fileText(instance: string): string | undefined {
      return selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        instance,
      ).openFiles[OPEN_KEY]?.text;
    }

    function mockWorkflowProvider(kind: "source.rearrange" | "source.cleanup") {
      workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
      workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/Service.java", SERVICE_PRE, { hash: "hash-pre" }));
      workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _rootPath: string,
        path: string,
        text: string,
      ) => writeAck(file(path, text, { hash: `hash-${text}` })));
      lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({
        path: "/repo/app/src/Service.java",
        uri: "file:///repo/app/src/Service.java",
        presetId: "jdtls",
        languageId: "java",
        displayName: "Eclipse JDT Language Server",
        available: true,
        active: true,
        capabilities: defaultCapabilities({ codeAction: true, codeActionKinds: [kind] }),
      }));
      const action = {
        title: kind === "source.rearrange" ? "Rearrange members" : "Clean up",
        kind,
        isPreferred: true,
        edit: null,
        command: null,
        commandArguments: null,
        raw: { title: kind },
      };
      lspMocks.lspCodeActions.mockResolvedValue({
        status: documentStatus({ available: true, active: true }),
        actions: [action],
      });
      lspMocks.lspCodeActionResolve.mockResolvedValue({
        status: documentStatus({ available: true, active: true }),
        action: {
          ...action,
          edit: {
            documentEdits: [{
              uri: "file:///repo/app/src/Service.java",
              path: "/repo/app/src/Service.java",
              edits: [SWAP_EDIT],
            }],
          },
        },
      });
    }

    function storedJournals(): Array<{ key: string; entry: { status: string } }> {
      return Object.keys(window.localStorage)
        .filter((key) => key.startsWith(RECOVERY_V2_PREFIX))
        .map((key) => ({ key, entry: JSON.parse(window.localStorage.getItem(key)!) }));
    }

    function installRecordingStorage(
      onWrite?: (key: string, value: string) => void,
    ): { restore: () => void; keys: () => string[] } {
      const backing = new Map<string, string>();
      const fake: Storage = {
        get length() { return backing.size; },
        clear: () => backing.clear(),
        getItem: (k) => backing.get(k) ?? null,
        key: (i) => Array.from(backing.keys())[i] ?? null,
        removeItem: (k) => { backing.delete(k); },
        setItem: (k, v) => { onWrite?.(k, v); backing.set(k, v); },
      };
      const original = window.localStorage;
      Object.defineProperty(window, "localStorage", { value: fake, configurable: true, writable: true });
      return {
        restore: () => Object.defineProperty(window, "localStorage", { value: original, configurable: true, writable: true }),
        keys: () => Array.from(backing.keys()),
      };
    }

    async function runWorkflow(
      registrationRef: { current: WorkspaceCommandRegistration | null },
      commandId: string,
    ): Promise<void> {
      await act(async () => {
        await registrationRef.current?.executeAction(commandId);
      });
    }

    it("registers exactly one success history entry whose single undo/redo spans the transaction", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockWorkflowProvider("source.rearrange");
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockResolvedValue(true);

      renderWorkspace(workflowWorkspace("instance-improve002-normal"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await runWorkflow(registrationRef, "workspace.rearrangeCode");
      await waitFor(() => expect(fileText("instance-improve002-normal")).toBe(SERVICE_POST));
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Rearranged"));
      // The committed journal is closed, not left pending.
      expect(storedJournals().filter((entry) => entry.entry.status === "committed")).toHaveLength(1);

      // The shared editor undo claims the journal entry: one Ctrl+Z restores
      // the whole transaction, a second one is a no-op (exactly one entry).
      const pane = screen.getByTestId("code-workspace-editor-pane");
      fireEvent.keyDown(pane, { key: "z", ctrlKey: true });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Undid Rearrange Code"));
      expect(fileText("instance-improve002-normal")).toBe(SERVICE_PRE);
      expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-improve002-normal")
        .openFiles[OPEN_KEY]?.historyReplay).toBe(true);
      fireEvent.keyDown(pane, { key: "z", ctrlKey: true });
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30));
      });
      expect(fileText("instance-improve002-normal")).toBe(SERVICE_PRE);

      // The journal entry stays redoable at the history-owner level; the
      // native AUDIT-015 redo stroke exercises the surface route.
    });

    it("aborts with zero writes when the workflow recovery journal cannot be persisted", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockWorkflowProvider("source.rearrange");
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockResolvedValue(true);
      const storage = installRecordingStorage((key) => {
        if (key.startsWith(RECOVERY_V2_PREFIX)) throw new Error("quota exceeded");
      });
      try {
        renderWorkspace(workflowWorkspace("instance-improve002-quota"), { onCommandsChange });
        await screen.findByTitle("app / src/Service.java");
        await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

        await runWorkflow(registrationRef, "workspace.rearrangeCode");
        await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
          "Refactor recovery journal could not be persisted",
        ));
        expect(useAppStore.getState().statusMessage).toContain("quota exceeded");
        expect(workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
        expect(fileText("instance-improve002-quota")).toBe(SERVICE_PRE);
        expect(storedJournals()).toHaveLength(0);
        expect(storage.keys().filter((key) => key.startsWith(RECOVERY_V2_PREFIX))).toHaveLength(0);
      } finally {
        storage.restore();
      }
    });

    it("keeps a postcondition mismatch out of success history and leaves a pending journal", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockWorkflowProvider("source.rearrange");
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockResolvedValue(true);
      const concurrentText = `${SERVICE_POST}// third-party typing during save\n`;
      workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _rootPath: string,
        path: string,
        text: string,
      ) => {
        // A concurrent writer replaces the buffer while the save is in
        // flight, so the writeback is a stale snapshot: disk gets the applied
        // text, the live buffer keeps the newer third-party text. The
        // canonical postcondition must detect the mismatch and refuse a
        // success history entry.
        useCodeWorkspaceStore.getState().updateOpenFiles(
          "instance-improve002-mismatch",
          (current) => {
            const target = current[OPEN_KEY];
            if (!target) return current;
            return {
              ...current,
              [OPEN_KEY]: {
                ...target,
                text: concurrentText,
                dirty: true,
                documentRevision: (target.documentRevision ?? 0) + 2,
              },
            };
          },
        );
        await new Promise((resolve) => setTimeout(resolve, 0));
        return writeAck(file(path, text, { hash: `hash-${text}` }));
      });

      renderWorkspace(workflowWorkspace("instance-improve002-mismatch"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await runWorkflow(registrationRef, "workspace.rearrangeCode");
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
        "postcondition could not be verified",
      ));
      expect(fileText("instance-improve002-mismatch")).toBe(concurrentText);
      expect(useAppStore.getState().statusMessage).not.toContain("Rearranged Service.java");
      const journals = storedJournals();
      expect(journals).toHaveLength(1);
      expect(journals[0]!.entry.status).toBe("recovery-required");
    });

    // ED-MAIN-001: a clean-buffer workflow edit mutates the buffer before the
    // awaited save. When that save fails, the mounted transaction must report
    // the already-performed buffer effect, keep the journal discoverable for
    // recovery, and never register a normal success history entry.
    it("reports the performed buffer effect and recovery-required when the workflow save fails (ED-MAIN-001)", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockWorkflowProvider("source.rearrange");
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockImplementation(async (opts) => opts.title === "Rearrange preview");
      // The disk write reports a proven zero disk effect (e.g. a readonly or
      // rejected save) after the buffer has already taken the applied text.
      workspaceMocks.workspaceWriteFileEncoded.mockRejectedValue(Object.assign(
        new Error("cannot replace readonly file"),
        { kind: "io", effect: "none" },
      ));

      renderWorkspace(workflowWorkspace("instance-main001-buffer-effect"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await runWorkflow(registrationRef, "workspace.rearrangeCode");
      // The applied text is present in the buffer even though the save failed.
      await waitFor(() => expect(fileText("instance-main001-buffer-effect")).toBe(SERVICE_POST));
      const message = useAppStore.getState().statusMessage;
      expect(message).toContain("postcondition could not be verified");
      expect(message).not.toContain("Rearranged Service.java");
      // The prepared journal is not closed as a committed no-op.
      const journals = storedJournals();
      expect(journals).toHaveLength(1);
      expect(journals[0]!.entry.status).toBe("recovery-required");
      expect(workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(1);
    });

    it("treats an unreadable post-state as recovery-required without success history", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockWorkflowProvider("source.rearrange");
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockResolvedValue(true);
      workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _rootPath: string,
        path: string,
        text: string,
      ) => {
        // The buffer closes while the save is in flight; the post-state read
        // then falls back to disk, which this fault makes unreadable.
        useCodeWorkspaceStore.getState().updateOpenFiles(
          "instance-improve002-unreadable",
          (current) => {
            const next = { ...current };
            delete next[OPEN_KEY];
            return next;
          },
        );
        workspaceMocks.workspaceListDir.mockRejectedValue(new Error("post-state listing failed"));
        await new Promise((resolve) => setTimeout(resolve, 0));
        return writeAck(file(path, text, { hash: `hash-${text}` }));
      });

      renderWorkspace(workflowWorkspace("instance-improve002-unreadable"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await runWorkflow(registrationRef, "workspace.rearrangeCode");
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
        "postcondition could not be verified",
      ));
      expect(useAppStore.getState().statusMessage).not.toContain("Rearranged Service.java");
      const journals = storedJournals();
      expect(journals).toHaveLength(1);
      expect(journals[0]!.entry.status).toBe("recovery-required");
    });

    it("surfaces an unknown write acknowledgement without success history", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockWorkflowProvider("source.rearrange");
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockResolvedValue(true);
      workspaceMocks.workspaceReadFileWithEncoding.mockResolvedValue(
        file("src/Service.java", "foreign bytes on disk\n", { hash: "foreign-disk-hash" }),
      );
      workspaceMocks.workspaceWriteFileEncoded.mockRejectedValue(Object.assign(
        new Error("atomic replace acknowledgement was lost"),
        {
          kind: "io",
          effect: "unknown",
          intentHash: "intended-rearranged-hash",
          intentByteLength: SERVICE_POST.length,
          oldHash: "hash-pre",
        },
      ));

      renderWorkspace(workflowWorkspace("instance-improve002-unknown"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await runWorkflow(registrationRef, "workspace.rearrangeCode");
      await waitFor(() => expect(useAppStore.getState().statusMessage).toMatch(
        /write result is unknown/i,
      ));
      expect(useAppStore.getState().statusMessage).not.toContain("Rearranged Service.java");
      const journals = storedJournals();
      expect(journals).toHaveLength(1);
      expect(journals[0]!.entry.status).toBe("recovery-required");
    });

    it("cleanup shares the single-history journal contract", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockWorkflowProvider("source.cleanup");
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockResolvedValue(true);

      renderWorkspace(workflowWorkspace("instance-improve002-cleanup"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await runWorkflow(registrationRef, "workspace.codeCleanup");
      await waitFor(() => expect(fileText("instance-improve002-cleanup")).toBe(SERVICE_POST));
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Cleaned up"));

      const pane = screen.getByTestId("code-workspace-editor-pane");
      fireEvent.keyDown(pane, { key: "z", ctrlKey: true });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Undid Code Cleanup"));
      expect(fileText("instance-improve002-cleanup")).toBe(SERVICE_PRE);
    });
  });

  describe("ED-REPAIR-001: workspace edit save failure retry safety (mounted)", () => {
    const SERVICE_PRE = "package com.example;\n\npublic class Service {\n    public void beta() {}\n    public void alpha() {}\n}\n";
    const SERVICE_POST = "package com.example;\n\npublic class Service {\n    public void alpha() {}\n    public void beta() {}\n}\n";
    const SWAP_EDIT = {
      range: { start: { line: 3, character: 0 }, end: { line: 4, character: 26 } },
      newText: "    public void alpha() {}\n    public void beta() {}",
    };
    const RECOVERY_V2_PREFIX = "taomni.refactor.recovery.v2:";
    const OPEN_KEY = "root:app:src/Service.java";

    function repairWorkspace(instance: string): CodeWorkspaceTabInfo {
      return {
        repoRoot: "/repo/app",
        workspaceId: "ws-repair001",
        workspaceInstanceId: instance,
        name: "Repair 001",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/Service.java" },
      };
    }

    function fileText(instance: string): string | undefined {
      return selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        instance,
      ).openFiles[OPEN_KEY]?.text;
    }

    function mockWorkflowProvider(kind: "source.rearrange" | "source.cleanup" = "source.rearrange") {
      workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
      workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/Service.java", SERVICE_PRE, { hash: "hash-pre" }));
      workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _rootPath: string,
        path: string,
        text: string,
      ) => writeAck(file(path, text, { hash: `hash-${text}` })));
      lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({
        path: "/repo/app/src/Service.java",
        uri: "file:///repo/app/src/Service.java",
        presetId: "jdtls",
        languageId: "java",
        displayName: "Eclipse JDT Language Server",
        available: true,
        active: true,
        capabilities: defaultCapabilities({ codeAction: true, codeActionKinds: [kind] }),
      }));
      const action = {
        title: kind === "source.rearrange" ? "Rearrange members" : "Clean up",
        kind,
        isPreferred: true,
        edit: null,
        command: null,
        commandArguments: null,
        raw: { title: kind },
      };
      lspMocks.lspCodeActions.mockResolvedValue({
        status: documentStatus({ available: true, active: true }),
        actions: [action],
      });
      lspMocks.lspCodeActionResolve.mockResolvedValue({
        status: documentStatus({ available: true, active: true }),
        action: {
          ...action,
          edit: {
            documentEdits: [{
              uri: "file:///repo/app/src/Service.java",
              path: "/repo/app/src/Service.java",
              edits: [SWAP_EDIT],
            }],
          },
        },
      });
    }

    function storedJournals(): Array<{ key: string; entry: { status: string } }> {
      return Object.keys(window.localStorage)
        .filter((key) => key.startsWith(RECOVERY_V2_PREFIX))
        .map((key) => ({ key, entry: JSON.parse(window.localStorage.getItem(key)!) }));
    }

    async function runWorkflow(
      registrationRef: { current: WorkspaceCommandRegistration | null },
      commandId: string,
    ): Promise<void> {
      await act(async () => {
        await registrationRef.current?.executeAction(commandId);
      });
    }

    it("retries save without duplicating buffer edits when save fails known-zero and user confirms retry (ED-REPAIR-001-A1, A2)", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockWorkflowProvider("source.rearrange");
      let writeAttempts = 0;
      workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _rootPath: string,
        path: string,
        text: string,
      ) => {
        writeAttempts += 1;
        if (writeAttempts === 1) {
          throw Object.assign(new Error("disk locked"), { kind: "io", effect: "none" });
        }
        return writeAck(file(path, text, { hash: `hash-${text}` }));
      });
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockImplementation(async (opts) => {
        if (opts.title === "Rearrange preview") return true;
        if (opts.title === "Workspace edit save failed") return true;
        return false;
      });

      renderWorkspace(repairWorkspace("instance-repair001-retry-success"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await runWorkflow(registrationRef, "workspace.rearrangeCode");
      // The buffer has the applied text, NOT duplicated
      await waitFor(() => expect(fileText("instance-repair001-retry-success")).toBe(SERVICE_POST));
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Rearranged Service.java"));
      expect(writeAttempts).toBe(2);

      // Verify single history entry undo/redo
      const pane = screen.getByTestId("code-workspace-editor-pane");
      fireEvent.keyDown(pane, { key: "z", ctrlKey: true });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Undid Rearrange Code"));
      expect(fileText("instance-repair001-retry-success")).toBe(SERVICE_PRE);

      // Redo restores to clean post-text
      fireEvent.keyDown(pane, { key: "z", ctrlKey: true, shiftKey: true });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Redid Rearrange Code"));
      expect(fileText("instance-repair001-retry-success")).toBe(SERVICE_POST);
    });

    it("preserves mutated buffer and marks journal recovery-required when save retry is cancelled (ED-REPAIR-001-A1, A2)", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockWorkflowProvider("source.rearrange");
      workspaceMocks.workspaceWriteFileEncoded.mockRejectedValue(Object.assign(
        new Error("disk locked permanently"),
        { kind: "io", effect: "none" },
      ));
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockImplementation(async (opts) => {
        if (opts.title === "Rearrange preview") return true;
        // User cancels retry
        if (opts.title === "Workspace edit save failed") return false;
        return false;
      });

      renderWorkspace(repairWorkspace("instance-repair001-retry-cancel"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await runWorkflow(registrationRef, "workspace.rearrangeCode");
      // Applied text remains in buffer
      await waitFor(() => expect(fileText("instance-repair001-retry-cancel")).toBe(SERVICE_POST));
      const message = useAppStore.getState().statusMessage;
      expect(message).toContain("postcondition could not be verified");
      expect(message).not.toContain("Rearranged Service.java");

      const journals = storedJournals();
      expect(journals).toHaveLength(1);
      expect(journals[0]!.entry.status).toBe("recovery-required");
    });

    it("refuses save retry if buffer text was modified by user typing before retry (ED-REPAIR-001-A2)", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockWorkflowProvider("source.rearrange");
      let writeAttempts = 0;
      workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _rootPath: string,
        path: string,
        text: string,
      ) => {
        writeAttempts += 1;
        if (writeAttempts === 1) {
          throw Object.assign(new Error("disk locked"), { kind: "io", effect: "none" });
        }
        return writeAck(file(path, text, { hash: `hash-${text}` }));
      });
      const typedUserComment = "\n// concurrent user typing\n";
      let dialogCalls = 0;
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockImplementation(async (opts) => {
        if (opts.title === "Rearrange preview") return true;
        if (opts.title === "Workspace edit save failed") {
          dialogCalls += 1;
          // Simulate user typing into the buffer while the dialog was open
          useCodeWorkspaceStore.getState().updateOpenFiles(
            "instance-repair001-typing-before-retry",
            (current) => {
              const target = current[OPEN_KEY];
              if (!target) return current;
              return {
                ...current,
                [OPEN_KEY]: {
                  ...target,
                  text: target.text + typedUserComment,
                  dirty: true,
                },
              };
            },
          );
          return true;
        }
        return false;
      });

      renderWorkspace(repairWorkspace("instance-repair001-typing-before-retry"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await runWorkflow(registrationRef, "workspace.rearrangeCode");
      // Newer typing was protected and not overwritten
      await waitFor(() => expect(fileText("instance-repair001-typing-before-retry")).toBe(SERVICE_POST + typedUserComment));
      // Retry was aborted, so only the initial write was attempted (writeAttempts === 1)
      expect(writeAttempts).toBe(1);
      expect(dialogCalls).toBe(1);
      expect(useAppStore.getState().statusMessage).not.toContain("Rearranged Service.java");
      const journals = storedJournals();
      expect(journals).toHaveLength(1);
      expect(journals[0]!.entry.status).toBe("recovery-required");
    });

    it("does not offer save retry when disk write reports unknown effect (ED-REPAIR-001-A1)", async () => {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      mockWorkflowProvider("source.rearrange");
      workspaceMocks.workspaceWriteFileEncoded.mockRejectedValue(Object.assign(
        new Error("network timeout writing file"),
        { kind: "io", effect: "unknown" },
      ));
      const dialogTitles: string[] = [];
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockImplementation(async (opts) => {
        if (opts.title) dialogTitles.push(opts.title);
        return opts.title === "Rearrange preview";
      });

      renderWorkspace(repairWorkspace("instance-repair001-unknown-effect"), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await runWorkflow(registrationRef, "workspace.rearrangeCode");
      // Save retry dialog must NEVER be shown for unknown disk effects
      expect(dialogTitles).not.toContain("Workspace edit save failed");
      expect(dialogTitles).not.toContain("Workspace edit partially applied");
      expect(useAppStore.getState().statusMessage).toContain("write result is unknown");
      const journals = storedJournals();
      expect(journals).toHaveLength(1);
      expect(journals[0]!.entry.status).toBe("recovery-required");
    });
  });

  describe("ED-IMPROVE-003 provider payload boundary (mounted)", () => {
    const SERVICE_PRE = "package com.example;\n\npublic class Service {\n    public void beta() {}\n    public void alpha() {}\n}\n";
    const TARGET_URI = "file:///repo/app/src/Service.java";
    const TARGET_PATH = "/repo/app/src/Service.java";
    const SWAP_EDIT = {
      range: { start: { line: 3, character: 0 }, end: { line: 4, character: 26 } },
      newText: "    public void alpha() {}\n    public void beta() {}",
    };

    function boundaryWorkspace(instance: string): CodeWorkspaceTabInfo {
      return {
        repoRoot: "/repo/app",
        workspaceId: "ws-improve003",
        workspaceInstanceId: instance,
        name: "Improve 003",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/Service.java" },
      };
    }

    function fileText(instance: string): string | undefined {
      return selectCodeWorkspaceUi(
        useCodeWorkspaceStore.getState(),
        instance,
      ).openFiles["root:app:src/Service.java"]?.text;
    }

    const ACTION = {
      title: "Rearrange members",
      kind: "source.rearrange",
      isPreferred: true,
      edit: null,
      command: null,
      commandArguments: null,
      raw: { title: "Rearrange members" },
    };

    async function runBoundary(
      instance: string,
      commandId: string,
      resolvedAction: Record<string, unknown> | null,
      advertisedKinds: string[] = ["source.rearrange"],
    ): Promise<void> {
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
      workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/Service.java", SERVICE_PRE, { hash: "hash-pre" }));
      workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _rootPath: string,
        path: string,
        text: string,
      ) => writeAck(file(path, text, { hash: `hash-${text}` })));
      lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({
        path: TARGET_PATH,
        uri: TARGET_URI,
        presetId: "jdtls",
        languageId: "java",
        displayName: "Eclipse JDT Language Server",
        available: true,
        active: true,
        capabilities: defaultCapabilities({ codeAction: true, codeActionKinds: advertisedKinds }),
      }));
      const resolvedKind = resolvedAction && typeof resolvedAction.kind === "string"
        ? resolvedAction.kind
        : ACTION.kind;
      lspMocks.lspCodeActions.mockResolvedValue({
        status: documentStatus({ available: true, active: true }),
        actions: [{ ...ACTION, kind: resolvedKind }],
      });
      lspMocks.lspCodeActionResolve.mockResolvedValue({
        status: documentStatus({ available: true, active: true }),
        action: resolvedAction,
      });
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockResolvedValue(true);

      renderWorkspace(boundaryWorkspace(instance), { onCommandsChange });
      await screen.findByTitle("app / src/Service.java");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await act(async () => {
        await registrationRef.current?.executeAction(commandId);
      });
    }

    function expectRejected(instance: string, reason: string): void {
      expect(useAppStore.getState().statusMessage).toContain(reason);
      expect(useAppStore.getState().statusMessage).toContain("nothing applied");
      expect(fileText(instance)).toBe(SERVICE_PRE);
      expect(workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
      expect(confirmAppDialog).not.toHaveBeenCalled();
    }

    it("rejects a cross-file payload without filtering it", async () => {
      await runBoundary("instance-improve003-cross-file", "workspace.rearrangeCode", {
        ...ACTION,
        edit: {
          documentEdits: [
            { uri: TARGET_URI, path: TARGET_PATH, edits: [SWAP_EDIT] },
            { uri: "file:///repo/app/src/Other.java", path: "/repo/app/src/Other.java", edits: [SWAP_EDIT] },
          ],
        },
      });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
        "/repo/app/src/Other.java",
      ));
      expectRejected("instance-improve003-cross-file", "different or contradictory document");
    });

    it("rejects a rename resource operation even beside a text edit", async () => {
      await runBoundary("instance-improve003-resource", "workspace.rearrangeCode", {
        ...ACTION,
        edit: {
          documentEdits: [{ uri: TARGET_URI, path: TARGET_PATH, edits: [SWAP_EDIT] }],
          operations: [{ kind: "rename", oldUri: TARGET_URI, newUri: "file:///repo/app/src/Renamed.java" }],
        },
      });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
        "resource operations (rename)",
      ));
      expectRejected("instance-improve003-resource", "resource operations (rename)");
    });

    it("rejects an edit+command payload", async () => {
      await runBoundary("instance-improve003-mixed", "workspace.rearrangeCode", {
        ...ACTION,
        edit: { documentEdits: [{ uri: TARGET_URI, path: TARGET_PATH, edits: [SWAP_EDIT] }] },
        command: "editor.action.extraSideEffect",
      });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
        "both an edit and the command",
      ));
      expectRejected("instance-improve003-mixed", "both an edit and the command");
    });

    it("rejects a provider-disabled action", async () => {
      await runBoundary("instance-improve003-disabled", "workspace.rearrangeCode", {
        ...ACTION,
        edit: { documentEdits: [{ uri: TARGET_URI, path: TARGET_PATH, edits: [SWAP_EDIT] }] },
        raw: { title: "Rearrange members", disabled: true },
      });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("disabled"));
      expectRejected("instance-improve003-disabled", "disabled");
    });

    it("rejects a malformed or reversed edit range", async () => {
      await runBoundary("instance-improve003-range", "workspace.rearrangeCode", {
        ...ACTION,
        edit: {
          documentEdits: [{
            uri: TARGET_URI,
            path: TARGET_PATH,
            edits: [{
              range: { start: { line: 4, character: 5 }, end: { line: 3, character: 0 } },
              newText: "x",
            }],
          }],
        },
      });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
        "malformed or reversed",
      ));
      expectRejected("instance-improve003-range", "malformed or reversed");
    });

    it("rejects a null resolve as malformed", async () => {
      await runBoundary("instance-improve003-null", "workspace.rearrangeCode", null);
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
        "resolve returned no action",
      ));
      expect(fileText("instance-improve003-null")).toBe(SERVICE_PRE);
      expect(workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
    });

    it("does not relabel source.fixAll as an equivalent cleanup", async () => {
      await runBoundary(
        "instance-improve003-fixall",
        "workspace.codeCleanup",
        {
          title: "Fix all",
          kind: "source.fixAll",
          isPreferred: true,
          edit: { documentEdits: [{ uri: TARGET_URI, path: TARGET_PATH, edits: [SWAP_EDIT] }] },
          command: null,
          commandArguments: null,
          raw: { title: "Fix all" },
        },
        ["source.fixAll"],
      );
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
        "Provider returned no cleanup action",
      ));
      expect(fileText("instance-improve003-fixall")).toBe(SERVICE_PRE);
      expect(workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
      expect(confirmAppDialog).not.toHaveBeenCalled();
    });
  });

  describe("ED-IMPROVE-007 per-leaf/file view snapshots (mounted)", () => {
    const LONG_DOC = Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n");

    function viewWorkspace(instance: string): CodeWorkspaceTabInfo {
      return {
        repoRoot: "/repo/app",
        workspaceId: "ws-improve007",
        workspaceInstanceId: instance,
        name: "Improve 007",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/Long.java" },
      };
    }

    function fileKeyFor(): string {
      return "root:app:src/Long.java";
    }

    function storedViewStates(instance: string): Record<string, Record<string, {
      mainSelection: { anchor: number; head: number };
    }>> {
      const raw = window.localStorage.getItem(`taomni.codeWorkspace.layout.v2.${instance}`);
      if (!raw) return {};
      return JSON.parse(raw).viewStates ?? {};
    }

    it("pushes per-leaf caret state into the layout snapshot after the debounce", async () => {
      workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
      workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/Long.java", LONG_DOC, { hash: "hash-long" }));
      lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({ available: true, active: false }));

      renderWorkspace(viewWorkspace("instance-improve007-persist"));
      await screen.findByTitle("app / src/Long.java");
      const pane = screen.getAllByTestId("code-workspace-editor-pane")[0]!;
      const view = EditorView.findFromDOM(pane.querySelector(".cm-editor")!)!;
      act(() => {
        view.dispatch({ selection: EditorSelection.cursor(40) });
      });
      await waitFor(() => expect(
        Object.keys(storedViewStates("instance-improve007-persist")).length,
      ).toBeGreaterThan(0), { timeout: 4000 });
      const states = storedViewStates("instance-improve007-persist");
      const leafIds = Object.keys(states);
      expect(leafIds.length).toBeGreaterThan(0);
      const persisted = leafIds
        .map((leafId) => states[leafId]?.[fileKeyFor()]?.mainSelection.head)
        .filter((head): head is number => typeof head === "number");
      expect(persisted).toContain(40);
    });

    it("keeps independent caret state for the same file in two leaves and restores the right leaf after reopen", async () => {
      workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
      workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/Long.java", LONG_DOC, { hash: "hash-long" }));
      lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({ available: true, active: false }));

      renderWorkspace(viewWorkspace("instance-improve007-split"));
      await screen.findByTitle("app / src/Long.java");
      const firstPane = screen.getAllByTestId("code-workspace-editor-pane")[0]!;
      const firstView = EditorView.findFromDOM(firstPane.querySelector(".cm-editor")!)!;
      act(() => {
        firstView.dispatch({ selection: EditorSelection.cursor(40) });
      });
      await waitFor(() => {
        const heads = Object.values(storedViewStates("instance-improve007-split"))
          .map((files) => files[fileKeyFor()]?.mainSelection.head);
        expect(heads).toContain(40);
      }, { timeout: 4000 });

      fireEvent.click(screen.getByTestId("code-workspace-split-right"));
      await waitFor(() => expect(screen.getAllByTestId("code-workspace-editor-pane")).toHaveLength(2));
      const panes = screen.getAllByTestId("code-workspace-editor-pane");
      const secondView = EditorView.findFromDOM(panes[1]!.querySelector(".cm-editor")!)!;
      act(() => {
        secondView.dispatch({ selection: EditorSelection.cursor(10) });
      });
      await waitFor(() => {
        const heads = Object.values(storedViewStates("instance-improve007-split"))
          .map((files) => files[fileKeyFor()]?.mainSelection.head);
        expect(heads).toContain(10);
        expect(heads).toContain(40);
      }, { timeout: 4000 });

      const states = storedViewStates("instance-improve007-split");
      const heads = Object.values(states)
        .map((files) => files[fileKeyFor()]?.mainSelection.head)
        .filter((head): head is number => typeof head === "number")
        .sort((a, b) => a - b);
      // Same document, two leaves: each leaf kept its own caret.
      expect(heads).toEqual([10, 40]);

      // Restart/reopen restore is covered by the CodeMirrorHost one-shot
      // apply tests and the native C4-03 reload_window case.
    });
  });

  describe("ED-REPAIR-004: plan-less workspace edit recovery journal", () => {
    const RECOVERY_V2_PREFIX = "taomni.refactor.recovery.v2:";
    const PRE: Record<string, string> = {
      "src/a.ts": "hello alpha",
      "src/b.ts": "hello beta",
      "src/c.ts": "reader",
    };

    interface Fixture {
      disk: Record<string, string>;
      workspace: CodeWorkspaceTabInfo;
      registrationRef: { current: WorkspaceCommandRegistration | null };
      onCommandsChange: (tabId: string, next: WorkspaceCommandRegistration | null) => void;
    }

    function setupWorkspace(instanceId: string, openFile: string): Fixture {
      const disk: Record<string, string> = { ...PRE };
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: `ws-${instanceId}`,
        workspaceInstanceId: `instance-${instanceId}`,
        name: instanceId,
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: openFile },
      };
      workspaceMocks.workspaceListDir.mockImplementation(async (_root: string, path: string) => (
        path === "src"
          ? Object.keys(disk).map((rel) => entry(rel.split("/").pop()!, rel))
          : [entry("src", "src", "dir")]
      ));
      workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => {
        if (!(path in disk)) throw new Error(`missing fixture file: ${path}`);
        return file(path, disk[path]!);
      });
      workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _root: string,
        path: string,
        text: string,
      ) => {
        disk[path] = text;
        return writeAck(file(path, text, { hash: `hash-${text}` }));
      });
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      return { disk, workspace, registrationRef, onCommandsChange };
    }

    function storedRecoveryEntries(): Array<{
      key: string;
      entry: {
        recoveryId: string;
        status: string;
        kind: string;
        verification?: {
          mismatchedUris: readonly string[];
          appliedEffects?: readonly string[];
          failedEffects?: readonly unknown[];
        };
      };
    }> {
      return Object.keys(window.localStorage)
        .filter((key) => key.startsWith(RECOVERY_V2_PREFIX))
        .map((key) => ({ key, entry: JSON.parse(window.localStorage.getItem(key)!) }));
    }

    function recoveryCalls(): Array<{ title: string; message: string }> {
      return vi.mocked(confirmAppDialog).mock.calls.map((call) => ({
        title: (call[0] as { title: string }).title,
        message: (call[0] as { message: string }).message,
      }));
    }

    function undoItem(registrationRef: Fixture["registrationRef"]) {
      return registrationRef.current?.items.find((item) => item.id === "workspace.undoWorkspaceEdit");
    }

    function installRecordingStorage(
      onWrite?: (key: string, value: string) => void,
    ): { restore: () => void; keys: () => string[] } {
      const backing = new Map<string, string>();
      const fake: Storage = {
        get length() { return backing.size; },
        clear: () => backing.clear(),
        getItem: (k) => backing.get(k) ?? null,
        key: (i) => Array.from(backing.keys())[i] ?? null,
        removeItem: (k) => { backing.delete(k); },
        setItem: (k, v) => { onWrite?.(k, v); backing.set(k, v); },
      };
      const original = window.localStorage;
      Object.defineProperty(window, "localStorage", { value: fake, configurable: true, writable: true });
      return {
        restore: () => Object.defineProperty(window, "localStorage", { value: original, configurable: true, writable: true }),
        keys: () => Array.from(backing.keys()),
      };
    }

    async function applyEditWithPreview(workspaceId: string | undefined, edit: unknown, label = "Replace all matches") {
      expect(workspaceId).toBeDefined();
      void emit("lsp://workspace-apply-edit", {
        requestId: `req-${Date.now()}`,
        workspaceId: workspaceId!,
        edit,
        label,
      });
      const preview = await screen.findByTestId("refactoring-preview-dialog");
      fireEvent.click(within(preview).getByTestId("refactoring-preview-apply"));
    }

    it("refuses text mutations when recovery snapshots cannot be captured", async () => {
      const { disk, workspace, onCommandsChange } = setupWorkspace("missing-snapshots", "src/c.ts");
      vi.mocked(confirmAppDialog).mockReset().mockResolvedValue(true);
      renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/c.ts");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
      workspaceMocks.workspaceListDir.mockRejectedValue(new Error("listing unavailable"));
      await act(async () => {
        await emit("lsp://workspace-apply-edit", {
          requestId: "missing-snapshots", workspaceId: workspace.workspaceInstanceId,
          edit: { documentEdits: [{ uri: "file:///repo/app/src/a.ts", path: "/repo/app/src/a.ts",
            edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } }, newText: "ALPHA" }] }] },
        });
      });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toMatch(/preimage|snapshot/i));
      expect(workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
      expect(disk["src/a.ts"]).toBe(PRE["src/a.ts"]);
    });

    it("retries successive failure boundaries against the full confirmed plan and undoes all files", async () => {
      const { disk, workspace, onCommandsChange } = setupWorkspace("successive-retries", "src/c.ts");
      disk["src/d.ts"] = "hello delta";
      vi.mocked(confirmAppDialog).mockReset().mockResolvedValue(true);
      const attempts = new Map<string, number>();
      workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (_root: string, path: string, text: string) => {
        const attempt = (attempts.get(path) ?? 0) + 1;
        attempts.set(path, attempt);
        if ((path === "src/b.ts" || path === "src/d.ts") && attempt === 1) {
          throw new Error("temporary write failure");
        }
        disk[path] = text;
        return writeAck(file(path, text, { hash: `hash-${text}` }));
      });
      renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/c.ts");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
      await applyEditWithPreview(workspace.workspaceInstanceId, {
        documentEdits: ["a", "b", "d"].map((name) => ({
          uri: `file:///repo/app/src/${name}.ts`, path: `/repo/app/src/${name}.ts`,
          edits: [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 5 } }, newText: "HELLO" }],
        })),
      });
      await waitFor(() => expect(disk["src/d.ts"]).toBe("HELLO delta"));
      expect(attempts).toEqual(new Map([["src/a.ts", 1], ["src/b.ts", 2], ["src/d.ts", 2]]));
      await waitFor(() => expect(storedRecoveryEntries().some(({ entry }) => entry.status === "committed")).toBe(true));
      await act(async () => { fireEvent.keyDown(window, { key: "z", ctrlKey: true }); });
      await waitFor(() => expect(disk["src/a.ts"]).toBe(PRE["src/a.ts"]));
      expect(disk["src/b.ts"]).toBe(PRE["src/b.ts"]);
      expect(disk["src/d.ts"]).toBe("hello delta");
    });

    it("creates recovery journal for plan-less text edits, captures partial failure effects, and restores via recovery entry", async () => {
      const { disk, workspace, registrationRef, onCommandsChange } = setupWorkspace("planless-partial", "src/c.ts");
      vi.mocked(confirmAppDialog).mockReset().mockResolvedValue(true);

      // Make write to src/b.ts fail with disk error
      workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _root: string,
        path: string,
        text: string,
      ) => {
        if (path === "src/b.ts") {
          throw new Error("disk I/O error on b.ts");
        }
        disk[path] = text;
        return writeAck(file(path, text, { hash: `hash-${text}` }));
      });

      renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/c.ts");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await applyEditWithPreview(workspace.workspaceInstanceId, {
        documentEdits: [
          {
            uri: "file:///repo/app/src/a.ts",
            path: "/repo/app/src/a.ts",
            edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } }, newText: "ALPHA" }],
          },
          {
            uri: "file:///repo/app/src/b.ts",
            path: "/repo/app/src/b.ts",
            edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } }, newText: "BETA" }],
          },
        ],
      });

      // Verification:
      // a.ts was applied to disk, b.ts was not modified
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("recovery required"));
      expect(useAppStore.getState().statusMessage).toContain("Workspace edit postcondition failed");
      expect(useAppStore.getState().statusMessage).toContain("Applied changes on: /repo/app/src/a.ts");
      expect(disk["src/a.ts"]).toBe("hello ALPHA");
      expect(disk["src/b.ts"]).toBe("hello beta");

      // Undo must stay disabled (no success history registered for partial failure)
      expect(undoItem(registrationRef)?.enabled).toBe(false);

      // Journal entry must be in recovery-required state with applied effects
      const entries = storedRecoveryEntries();
      expect(entries).toHaveLength(1);
      const journalEntry = entries[0]!.entry;
      expect(journalEntry.status).toBe("recovery-required");
      expect(journalEntry.verification?.appliedEffects).toContain("/repo/app/src/a.ts");

      // Review and execute recovery via reviewRefactorRecovery action
      vi.mocked(confirmAppDialog).mockClear();
      vi.mocked(confirmAppDialog).mockResolvedValue(true);

      await act(async () => {
        await registrationRef.current?.executeAction("workspace.reviewRefactorRecovery");
      });

      await waitFor(() => expect(recoveryCalls().length).toBeGreaterThan(0));
      const pendingDialog = recoveryCalls().find((call) => call.title.includes("recovery pending"));
      expect(pendingDialog).toBeDefined();

      // Recovery restored src/a.ts to preText and left src/b.ts untouched
      await waitFor(() => expect(disk["src/a.ts"]).toBe(PRE["src/a.ts"]));
      expect(disk["src/b.ts"]).toBe(PRE["src/b.ts"]);
      expect(getRefactorRecoveryJournalV2(journalEntry.recoveryId)?.status).toBe("rolled-back");
      expect(useAppStore.getState().statusMessage).toContain("recovery complete");

      // Idempotent re-run reports no pending entries
      await act(async () => {
        await registrationRef.current?.executeAction("workspace.reviewRefactorRecovery");
      });
      expect(useAppStore.getState().statusMessage).toContain("No pending recovery entries found");
    });

    it("aborts with zero writes when the plan-less recovery journal cannot be persisted", async () => {
      const { disk, workspace, registrationRef, onCommandsChange } = setupWorkspace("planless-quota", "src/c.ts");
      vi.mocked(confirmAppDialog).mockReset().mockResolvedValue(true);
      const storage = installRecordingStorage((key) => {
        if (key.startsWith(RECOVERY_V2_PREFIX)) throw new Error("quota exceeded");
      });

      renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/c.ts");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await act(async () => {
        await emit("lsp://workspace-apply-edit", {
          requestId: "req-quota",
          workspaceId: workspace.workspaceInstanceId,
          edit: {
            documentEdits: [
              {
                uri: "file:///repo/app/src/a.ts",
                path: "/repo/app/src/a.ts",
                edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } }, newText: "ALPHA" }],
              },
            ],
          },
          label: "Replace matches",
        });
      });

      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain(
        "Refactor recovery journal could not be persisted, no changes were applied",
      ));
      expect(workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
      expect(disk["src/a.ts"]).toBe(PRE["src/a.ts"]);
      expect(undoItem(registrationRef)?.enabled).toBe(false);
      storage.restore();
    });

    it("refuses to overwrite conflicting third-party edits during plan-less recovery", async () => {
      const { disk, workspace, registrationRef, onCommandsChange } = setupWorkspace("planless-conflict", "src/c.ts");
      const preA = PRE["src/a.ts"]!;
      const postA = "hello ALPHA";
      recordRefactorRecoveryJournalV2({
        schemaVersion: 2,
        recoveryId: "rec-conflict-1",
        transactionId: "tx-conflict-1",
        actionId: "workspace-edit:replace-1",
        kind: "replace",
        workspaceRoot: "/repo/app",
        createdAt: 100,
        updatedAt: 200,
        status: "recovery-required",
        appliedOperationIndex: null,
        documents: [
          {
            uri: "file:///repo/app/src/a.ts",
            canonicalPath: "/repo/app/src/a.ts",
            preText: preA,
            preHash: sha256Hex(preA),
            postText: postA,
            postHash: sha256Hex(postA),
            encoding: "UTF-8",
            bom: false,
            eol: "lf",
          },
        ],
        resourceMoves: [],
        verification: { mismatchedUris: [], checkedAt: null },
      });

      // Third-party modifies src/a.ts to something else before recovery runs
      disk["src/a.ts"] = "third-party content";
      vi.mocked(confirmAppDialog).mockReset().mockResolvedValue(true);

      renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/c.ts");

      await act(async () => {
        await registrationRef.current?.executeAction("workspace.reviewRefactorRecovery");
      });

      await waitFor(() => expect(recoveryCalls().some((call) => call.title.includes("recovery blocked"))).toBe(true));
      const blocked = recoveryCalls().find((call) => call.title.includes("recovery blocked"));
      expect(blocked?.message).toContain("/repo/app/src/a.ts (conflict)");
      expect(blocked?.message).toContain("will not be overwritten");
      expect(disk["src/a.ts"]).toBe("third-party content");
      expect(workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
      expect(getRefactorRecoveryJournalV2("rec-conflict-1")?.status).toBe("recovery-required");
    });

    it("commits recovery journal and supports single undo on verified success", async () => {
      const { disk, workspace, onCommandsChange } = setupWorkspace("planless-success", "src/c.ts");
      vi.mocked(confirmAppDialog).mockReset().mockResolvedValue(true);

      renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/c.ts");
      await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());

      await applyEditWithPreview(workspace.workspaceInstanceId, {
        documentEdits: [
          {
            uri: "file:///repo/app/src/a.ts",
            path: "/repo/app/src/a.ts",
            edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 11 } }, newText: "ALPHA" }],
          },
          {
            uri: "file:///repo/app/src/b.ts",
            path: "/repo/app/src/b.ts",
            edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 10 } }, newText: "BETA" }],
          },
        ],
      });

      await waitFor(() => expect(disk["src/a.ts"]).toBe("hello ALPHA"));
      expect(disk["src/b.ts"]).toBe("hello BETA");

      // Pending recovery entry is not left behind
      const pending = storedRecoveryEntries().filter((e) => e.entry.status === "recovery-required");
      expect(pending).toHaveLength(0);

      // Execute undo via window keydown: both files restored to PRE
      await act(async () => {
        fireEvent.keyDown(window, { key: "z", ctrlKey: true });
      });
      await waitFor(() => expect(disk["src/a.ts"]).toBe(PRE["src/a.ts"]));
      expect(disk["src/b.ts"]).toBe(PRE["src/b.ts"]);

      // Redo: both files re-applied
      await act(async () => {
        fireEvent.keyDown(window, { key: "z", ctrlKey: true, shiftKey: true });
      });
      await waitFor(() => expect(disk["src/a.ts"]).toBe("hello ALPHA"));
      expect(disk["src/b.ts"]).toBe("hello BETA");
    });
  });

  describe("ED-REPAIR-006: case-preserving POSIX replace path identity (mounted)", () => {
    function setupWorkspace(instanceId: string, openFile: string) {
      const disk: Record<string, string> = {};
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: `ws-${instanceId}`,
        workspaceInstanceId: `instance-${instanceId}`,
        name: instanceId,
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: openFile },
      };
      workspaceMocks.workspaceListDir.mockImplementation(async (_root: string, path: string) => (
        path === "src"
          ? Object.keys(disk).map((rel) => entry(rel.split("/").pop()!, rel))
          : [entry("src", "src", "dir")]
      ));
      workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => {
        if (!(path in disk)) throw new Error(`missing fixture file: ${path}`);
        return file(path, disk[path]!);
      });
      workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _root: string,
        path: string,
        text: string,
      ) => {
        disk[path] = text;
        return writeAck(file(path, text, { hash: `hash-${text}` }));
      });
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      return { disk, workspace, registrationRef, onCommandsChange };
    }

    async function applyEditWithPreview(workspaceId: string | undefined, edit: unknown, label = "Replace all matches") {
      expect(workspaceId).toBeDefined();
      void emit("lsp://workspace-apply-edit", {
        requestId: `req-${Date.now()}`,
        workspaceId: workspaceId!,
        edit,
        label,
      });
      const preview = await screen.findByTestId("refactoring-preview-dialog");
      fireEvent.click(within(preview).getByTestId("refactoring-preview-apply"));
    }

    it("preserves distinct identities for /repo/app/src/A.java and /repo/app/src/a.java during replace preimages and apply (ED-REPAIR-006-A1, A3)", async () => {
      const { disk, workspace, onCommandsChange } = setupWorkspace("case-replace", "src/c.ts");
      disk["src/c.ts"] = "hello reader";
      disk["src/A.java"] = "hello UPPER_A";
      disk["src/a.java"] = "hello lower_a";

      renderWorkspace(workspace, { onCommandsChange });

      // Apply multi-file WorkspaceEdit that edits both case-distinct files
      await applyEditWithPreview(workspace.workspaceInstanceId, {
        documentEdits: [
          {
            uri: "file:///repo/app/src/A.java",
            path: "/repo/app/src/A.java",
            edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } }, newText: "REPLACED_UPPER" }],
          },
          {
            uri: "file:///repo/app/src/a.java",
            path: "/repo/app/src/a.java",
            edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } }, newText: "replaced_lower" }],
          },
        ],
      });

      // Both distinct files must be updated accurately on disk without overwriting each other
      await waitFor(() => expect(disk["src/A.java"]).toBe("hello REPLACED_UPPER"));
      expect(disk["src/a.java"]).toBe("hello replaced_lower");

      // Undo restores both distinct files accurately
      await act(async () => {
        fireEvent.keyDown(window, { key: "z", ctrlKey: true });
      });
      await waitFor(() => expect(disk["src/A.java"]).toBe("hello UPPER_A"));
      expect(disk["src/a.java"]).toBe("hello lower_a");
    });
  });

  describe("ED-REPAIR-002: replace preflight and open buffer freeze conditions (mounted)", () => {
    function setupWorkspace(instanceId: string, openFile: string) {
      const disk: Record<string, string> = {};
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: `ws-${instanceId}`,
        workspaceInstanceId: `instance-${instanceId}`,
        name: instanceId,
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: openFile },
      };
      workspaceMocks.workspaceListDir.mockImplementation(async (_root: string, path: string) => (
        path === "src"
          ? Object.keys(disk).map((rel) => entry(rel.split("/").pop()!, rel))
          : [entry("src", "src", "dir")]
      ));
      workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => {
        if (!(path in disk)) throw new Error(`missing fixture file: ${path}`);
        return file(path, disk[path]!, { hash: `hash-${disk[path]!}` });
      });
      workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _root: string,
        path: string,
        text: string,
      ) => {
        disk[path] = text;
        return writeAck(file(path, text, { hash: `hash-${text}` }));
      });
      const registrationRef: { current: WorkspaceCommandRegistration | null } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      return { disk, workspace, registrationRef, onCommandsChange };
    }

    it.each(["disk-before", "open-during-final-read", "open-during-history-read", "excluded"])("validates exactly the selected replace set before the first effect: %s (ED-REPAIR-002-A1)", async (scenario) => {
      const { disk, workspace, registrationRef, onCommandsChange } = setupWorkspace("repair-002-b-modified", "src/c.ts");
      disk["src/c.ts"] = "hello reader";
      disk["src/a.ts"] = "hello needle";
      disk["src/b.ts"] = "hello needle";

      let searchHandler: ((event: workspaceSearchModule.WorkspaceSearchEvent) => void) | null = null;
      const unlisten = vi.fn();
      vi.spyOn(workspaceSearchModule, "subscribeWorkspaceSearch").mockImplementation(async (_id, handler) => {
        searchHandler = handler;
        return unlisten;
      });
      vi.spyOn(workspaceSearchModule, "workspaceSearchStart").mockResolvedValue("search-repair-002");

      renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/c.ts");

      // Open find in files panel
      await act(async () => {
        await registrationRef.current?.executeAction("workspace.findInFiles");
      });

      const searchInput = await screen.findByLabelText("Search query");
      fireEvent.change(searchInput, { target: { value: "needle" } });
      fireEvent.keyDown(searchInput, { key: "Enter" });

      await waitFor(() => expect(searchHandler).not.toBeNull());

      // Emit search matches for a.ts and b.ts
      await act(async () => {
        searchHandler?.({
          searchId: "search-repair-002",
          kind: "batch",
          matches: [
            {
              rootId: "app",
              rootName: "app",
              rootPath: "/repo/app",
              path: "src/a.ts",
              lineNumber: 1,
              column: 7,
              matchStart: 6,
              matchEnd: 12,
              lineText: "hello needle",
            },
            {
              rootId: "app",
              rootName: "app",
              rootPath: "/repo/app",
              path: "src/b.ts",
              lineNumber: 1,
              column: 7,
              matchStart: 6,
              matchEnd: 12,
              lineText: "hello needle",
            },
          ],
          truncated: false,
          cancelled: false,
          filesScanned: 2,
          totalMatches: 2,
          error: null,
        });
        searchHandler?.({
          searchId: "search-repair-002",
          kind: "done",
          matches: [],
          truncated: false,
          cancelled: false,
          filesScanned: 2,
          totalMatches: 2,
          error: null,
        });
      });

      // Enter replace text and preview
      fireEvent.change(screen.getByLabelText("Replace text"), { target: { value: "REPLACED" } });
      fireEvent.click(screen.getByRole("button", { name: "Preview replace all matches" }));

      const preview = await screen.findByTestId("code-workspace-replace-preview");
      expect(preview).toBeInTheDocument();

      if (scenario.startsWith("open-during")) {
        let readsOfB = 0;
        let readsOfA = 0;
        workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => {
          // Commit reads B for outer validation, recovery snapshot, then final preflight.
          // A is read again by the applier (4) and the local-history committer (5).
          if (path === "src/b.ts") readsOfB += 1;
          if (path === "src/a.ts") readsOfA += 1;
          if ((scenario === "open-during-final-read" && path === "src/b.ts" && readsOfB === 3)
            || (scenario === "open-during-history-read" && path === "src/a.ts" && readsOfA === 5)) {
            useCodeWorkspaceStore.getState().updateOpenFiles(workspace.workspaceInstanceId!, (current) => ({
              ...current,
              "root:app:src/b.ts": { ...current["root:app:src/c.ts"]!, key: "root:app:src/b.ts", path: "src/b.ts",
                ref: { kind: "root", rootId: "app", path: "src/b.ts" },
                text: "hello user typing", savedText: "hello needle", dirty: true, documentRevision: 1 },
            }));
            await new Promise((resolve) => setTimeout(resolve, 0));
          }
          return file(path, disk[path]!, { hash: `hash-${disk[path]!}` });
        });
      } else {
        if (scenario === "excluded") {
          fireEvent.click(within(preview).getByLabelText("Include all matches in /repo/app/src/b.ts"));
        }
        disk["src/b.ts"] = "hello modified";
      }

      // Click Replace All
      fireEvent.click(screen.getByTestId("code-workspace-replace-commit"));

      if (scenario === "excluded") {
        await waitFor(() => expect(disk["src/a.ts"]).toBe("hello REPLACED"));
        expect(disk["src/b.ts"]).toBe("hello modified");
        await waitFor(() => expect(registrationRef.current?.items.find((item) => item.id === "workspace.undoWorkspaceEdit")?.enabled).toBe(true));
        await act(async () => { await registrationRef.current?.executeAction("workspace.undoWorkspaceEdit"); });
        await waitFor(() => expect(disk["src/a.ts"]).toBe("hello needle"));
        expect(disk["src/b.ts"]).toBe("hello modified");
        return;
      }

      // Preflight detects disk hash mismatch on src/b.ts and refuses with zero writes
      await waitFor(() => {
        const status = useAppStore.getState().statusMessage;
        expect(status).toMatch(scenario === "disk-before" ? /changed on disk since/ : /opened since replace preview|unsaved modifications/);
      });

      // Both files must have ZERO writes applied
      expect(disk["src/a.ts"]).toBe("hello needle");
      expect(disk["src/b.ts"]).toBe(scenario === "disk-before" ? "hello modified" : "hello needle");
      expect(workspaceMocks.workspaceWriteFileEncoded).not.toHaveBeenCalled();
    });

    it("preserves file A effect when file B write fails after first write (ED-REPAIR-002-A2)", async () => {
      const { disk, workspace, registrationRef, onCommandsChange } = setupWorkspace("repair-002-b-fail", "src/c.ts");
      disk["src/c.ts"] = "hello reader";
      disk["src/a.ts"] = "hello needle";
      disk["src/b.ts"] = "hello needle";

      let searchHandler: ((event: workspaceSearchModule.WorkspaceSearchEvent) => void) | null = null;
      const unlisten = vi.fn();
      vi.spyOn(workspaceSearchModule, "subscribeWorkspaceSearch").mockImplementation(async (_id, handler) => {
        searchHandler = handler;
        return unlisten;
      });
      vi.spyOn(workspaceSearchModule, "workspaceSearchStart").mockResolvedValue("search-repair-002-post");

      // Inject write failure on src/b.ts
      workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _root: string,
        path: string,
        text: string,
      ) => {
        if (path === "src/b.ts") {
          throw new Error("disk I/O error on b.ts");
        }
        disk[path] = text;
        return writeAck(file(path, text, { hash: `hash-${text}` }));
      });

      renderWorkspace(workspace, { onCommandsChange });
      await screen.findByTitle("app / src/c.ts");

      await act(async () => {
        await registrationRef.current?.executeAction("workspace.findInFiles");
      });

      const searchInput = await screen.findByLabelText("Search query");
      fireEvent.change(searchInput, { target: { value: "needle" } });
      fireEvent.keyDown(searchInput, { key: "Enter" });

      await waitFor(() => expect(searchHandler).not.toBeNull());

      await act(async () => {
        searchHandler?.({
          searchId: "search-repair-002-post",
          kind: "batch",
          matches: [
            {
              rootId: "app",
              rootName: "app",
              rootPath: "/repo/app",
              path: "src/a.ts",
              lineNumber: 1,
              column: 7,
              matchStart: 6,
              matchEnd: 12,
              lineText: "hello needle",
            },
            {
              rootId: "app",
              rootName: "app",
              rootPath: "/repo/app",
              path: "src/b.ts",
              lineNumber: 1,
              column: 7,
              matchStart: 6,
              matchEnd: 12,
              lineText: "hello needle",
            },
          ],
          truncated: false,
          cancelled: false,
          filesScanned: 2,
          totalMatches: 2,
          error: null,
        });
        searchHandler?.({
          searchId: "search-repair-002-post",
          kind: "done",
          matches: [],
          truncated: false,
          cancelled: false,
          filesScanned: 2,
          totalMatches: 2,
          error: null,
        });
      });

      fireEvent.change(screen.getByLabelText("Replace text"), { target: { value: "REPLACED" } });
      fireEvent.click(screen.getByRole("button", { name: "Preview replace all matches" }));

      const preview = await screen.findByTestId("code-workspace-replace-preview");
      expect(preview).toBeInTheDocument();

      fireEvent.click(screen.getByTestId("code-workspace-replace-commit"));

      // Operation A succeeded and its effect is preserved on disk!
      await waitFor(() => expect(disk["src/a.ts"]).toBe("hello REPLACED"));
      // Operation B failed and was not modified
      expect(disk["src/b.ts"]).toBe("hello needle");

      // Status message indicates failure / recovery required
      await waitFor(() => {
        const status = useAppStore.getState().statusMessage;
        expect(status).toContain("recovery required");
      });
    });
  });

  describe("ED-REPAIR-009: view state snapshot consistency (mounted)", () => {
    const DOC_A = "line0\nline1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9";
    const DOC_B = "other0\nother1\nother2\nother3\nother4\nother5";

    function repairWorkspace(instance: string): CodeWorkspaceTabInfo {
      return {
        repoRoot: "/repo/app",
        workspaceId: "ws-repair009",
        workspaceInstanceId: instance,
        name: "Repair 009",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/A.java" },
      };
    }

    function storedLayout(instance: string) {
      const raw = window.localStorage.getItem(`taomni.codeWorkspace.layout.v2.${instance}`);
      return raw ? JSON.parse(raw) : null;
    }

    it("restores caret after editing and switching tabs within 1 second (ED-REPAIR-009-A1)", async () => {
      workspaceMocks.workspaceListDir.mockResolvedValue([
        entry("src", "src", "dir"),
        entry("src/A.java", "A.java", "file"),
        entry("src/B.java", "B.java", "file"),
      ]);
      workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => {
        if (path.endsWith("A.java")) return file("src/A.java", DOC_A, { hash: "hash-a" });
        return file("src/B.java", DOC_B, { hash: "hash-b" });
      });
      lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({ available: true, active: false }));

      const seedLayout = {
        version: 2,
        bottomDockOpen: false,
        bottomDockTab: "problems",
        rightPaneOpen: false,
        rightPaneTab: "outline",
        languagePanelOpen: false,
        splitOrientation: "vertical",
        activeEditorGroupId: "primary",
        expandedRootIds: ["app"],
        expandedDirKeys: [],
        layoutTreeV2: {
          type: "leaf",
          id: "primary",
          openFileKeys: ["root:app:src/A.java", "root:app:src/B.java"],
          activeKey: "root:app:src/A.java",
        },
        editorGroups: {
          primary: {
            openOrder: ["root:app:src/A.java", "root:app:src/B.java"],
            activeKey: "root:app:src/A.java",
            previewKey: null,
            pinnedKeys: [],
          },
        },
        viewStates: {},
      };
      window.localStorage.setItem("taomni.codeWorkspace.layout.v2.instance-repair009-switch", JSON.stringify(seedLayout));

      renderWorkspace(repairWorkspace("instance-repair009-switch"));
      await screen.findByTitle("app / src/A.java");
      await screen.findByTitle("app / src/B.java");

      const pane = screen.getAllByTestId("code-workspace-editor-pane")[0]!;
      const viewA = EditorView.findFromDOM(pane.querySelector(".cm-editor")!)!;

      // Insert text and move cursor to offset 25 within 1 second
      act(() => {
        viewA.dispatch({
          changes: { from: 0, insert: "ZZ" },
          selection: EditorSelection.cursor(25),
        });
      });

      // Switch to B.java before any 1s debounce/throttle has settled
      const tabB = screen.getByTitle("app / src/B.java");
      fireEvent.click(tabB);

      await waitFor(() => {
        const currentPane = screen.getAllByTestId("code-workspace-editor-pane")[0]!;
        const currentView = EditorView.findFromDOM(currentPane.querySelector(".cm-editor")!)!;
        expect(currentView.state.doc.toString()).toBe(DOC_B);
      });

      // Now switch back to A.java
      const tabA = screen.getByTitle("app / src/A.java");
      fireEvent.click(tabA);

      await waitFor(() => {
        const paneBack = screen.getAllByTestId("code-workspace-editor-pane")[0]!;
        const viewABack = EditorView.findFromDOM(paneBack.querySelector(".cm-editor")!)!;
        expect(viewABack.state.doc.toString().startsWith("ZZ")).toBe(true);
        // Caret must be restored to 25!
        expect(viewABack.state.selection.main.head).toBe(25);
      });
    });

    it("flushes tail capture to localStorage on workspace unmount (ED-REPAIR-009-A1, A2)", async () => {
      workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
      workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/A.java", DOC_A, { hash: "hash-a" }));
      lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({ available: true, active: false }));

      const { unmount } = renderWorkspace(repairWorkspace("instance-repair009-unmount"));
      await screen.findByTitle("app / src/A.java");
      const pane = screen.getAllByTestId("code-workspace-editor-pane")[0]!;
      const view = EditorView.findFromDOM(pane.querySelector(".cm-editor")!)!;

      act(() => {
        view.dispatch({ selection: EditorSelection.cursor(35) });
      });

      // Immediately unmount (workspace closing / tab closing)
      unmount();

      const layout = storedLayout("instance-repair009-unmount");
      expect(layout).not.toBeNull();
      const primaryState = layout.viewStates?.primary?.["root:app:src/A.java"];
      expect(primaryState?.mainSelection?.head).toBe(35);
      expect(primaryState?.textIdentity).toBe(textIdentityFromString(DOC_A));
    });

    it("inactive leaf snapshot preserves original identity when text changes in active leaf and drops stale position on restore (ED-REPAIR-009-A2)", async () => {
      workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
      workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/A.java", DOC_A, { hash: "hash-a" }));
      lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({ available: true, active: false }));

      // Seed a layout where secondary leaf has an old snapshot for "abc" with caret 2
      const oldDocIdentity = textIdentityFromString("abc");
      const seedLayout = {
        version: 2,
        bottomDockOpen: false,
        bottomDockTab: "problems",
        rightPaneOpen: false,
        rightPaneTab: "outline",
        languagePanelOpen: false,
        splitOrientation: "vertical",
        activeEditorGroupId: "primary",
        expandedRootIds: ["app"],
        expandedDirKeys: [],
        layoutTreeV2: {
          type: "split",
          id: "split-root",
          orientation: "vertical",
          ratios: [0.5, 0.5],
          children: [
            { type: "leaf", id: "primary", openFileKeys: ["root:app:src/A.java"], activeKey: "root:app:src/A.java" },
            { type: "leaf", id: "secondary", openFileKeys: ["root:app:src/A.java"], activeKey: "root:app:src/A.java" },
          ],
        },
        editorGroups: {
          primary: { openOrder: ["root:app:src/A.java"], activeKey: "root:app:src/A.java", previewKey: null, pinnedKeys: [] },
          secondary: { openOrder: ["root:app:src/A.java"], activeKey: "root:app:src/A.java", previewKey: null, pinnedKeys: [] },
        },
        viewStates: {
          primary: { "root:app:src/A.java": { mainSelection: { anchor: 10, head: 10 }, selections: [], scrollTop: 0, folds: [], textIdentity: textIdentityFromString(DOC_A) } },
          secondary: { "root:app:src/A.java": { mainSelection: { anchor: 2, head: 2 }, selections: [], scrollTop: 0, folds: [], textIdentity: oldDocIdentity } },
        },
      };
      window.localStorage.setItem("taomni.codeWorkspace.layout.v2.instance-repair009-inactive", JSON.stringify(seedLayout));

      renderWorkspace(repairWorkspace("instance-repair009-inactive"));
      await screen.findAllByTitle("app / src/A.java");
      await waitFor(() => {
        const panes = screen.getAllByTestId("code-workspace-editor-pane");
        expect(panes).toHaveLength(2);
        const primaryCm = panes[0]?.querySelector<HTMLElement>(".cm-editor");
        const secondaryCm = panes[1]?.querySelector<HTMLElement>(".cm-editor");
        expect(primaryCm).toBeTruthy();
        expect(secondaryCm).toBeTruthy();
        const primaryView = EditorView.findFromDOM(primaryCm!)!;
        const secondaryView = EditorView.findFromDOM(secondaryCm!)!;
        // Primary had matching identity for DOC_A -> restored caret at 10
        expect(primaryView.state.selection.main.head).toBe(10);
        // Secondary had identity for "abc" (mismatches DOC_A) -> stale caret 2 was DROPPED, defaults to 0
        expect(secondaryView.state.selection.main.head).toBe(0);
      });
    });
  });
});
