import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import mermaid from "mermaid";
import { StrictMode, type ComponentProps } from "react";
import { useAppStore } from "../../stores/appStore";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../types";
import type { LspCapabilitySummary, LspDocumentStatus, LspServerStatus } from "../../lib/editor/lsp";
import type { ProjectDescriptorDiscoveryState } from "../../hooks/useProjectDescriptorDiscovery";
import type { StructuredTestResults, WorkspaceEntry, WorkspaceFile, WorkspaceWriteAck } from "../../lib/editor/workspace";
import type { LocalHistoryEntry } from "../../lib/localHistory";
import { CodeWorkspaceTab, debugCurrentLineForFile, extractContextSnippet } from "./CodeWorkspaceTab";
import { confirmAppDialog, promptAppDialog } from "../../lib/appDialogs";
import { workspaceActionRegistry } from "./workspace/workspaceActionRegistry";
import { clearGitSnapshotCache, clearGitSnapshotInFlight } from "./workspace/useWorkspaceGitSnapshots";
import { globalEditorConfigResolver } from "./workspace/editorConfigResolver";
import { registerInteractionCases } from "./workspace/tests/interaction.cases";
import { registerFilesCases } from "./workspace/tests/files.cases";
import { registerLanguageCases } from "./workspace/tests/language.cases";
import { registerLayoutCases } from "./workspace/tests/layout.cases";
import { registerWorkspaceEditsCases } from "./workspace/tests/workspaceEdits.cases";
import { registerSaveCases } from "./workspace/tests/save.cases";

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
  const mocks = {
    probeClipboardCapabilities: vi.fn(async () => null),
    readText: vi.fn(async () => inMemoryClipboard),
    readNativeTextResult: vi.fn(async () => ({ ok: true, text: inMemoryClipboard })),
    readTextResult: vi.fn(async () => ({ ok: true, text: inMemoryClipboard })),
    writeText: vi.fn(async (text: string) => {
      inMemoryClipboard = text;
    }),
  };
  return {
    ...mocks,
    reset() {
      inMemoryClipboard = "";
      mocks.probeClipboardCapabilities.mockReset().mockResolvedValue(null);
      mocks.readText.mockReset().mockImplementation(async () => inMemoryClipboard);
      mocks.readNativeTextResult.mockReset().mockImplementation(async () => ({ ok: true, text: inMemoryClipboard }));
      mocks.readTextResult.mockReset().mockImplementation(async () => ({ ok: true, text: inMemoryClipboard }));
      mocks.writeText.mockReset().mockImplementation(async (text: string) => { inMemoryClipboard = text; });
    },
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

/** ED-PARITY-010: secondary toolbar controls live behind the ⋮ "More actions" menu. */
function toolbarControl(testId: string): HTMLElement {
  if (!screen.queryByTestId(testId)) fireEvent.click(screen.getByTestId("code-workspace-toolbar-more"));
  return screen.getByTestId(testId);
}

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

/** ED-PARITY-002 QA-only save-race gate installed by installSaveRaceProbe. */
export interface SaveRaceGateForTest {
  arm(request: Record<string, unknown>): { ok: boolean; reason?: string };
  status(): { held: null | { stage: string; transactionId: string } };
  release(request?: { reason?: string }): { ok: boolean; reason?: string };
  trace(): Array<{ event: string; revision?: number | null; detail?: Record<string, unknown> }>;
}

function saveRaceGate(): SaveRaceGateForTest {
  const control = (window as unknown as { __taomniQaSaveGate?: SaveRaceGateForTest }).__taomniQaSaveGate;
  if (!control) throw new Error("save race gate is not installed");
  return control;
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

async function confirmWorkspaceUndo() {
  const dialog = await screen.findByRole("dialog", { name: "Undo" });
  fireEvent.click(within(dialog).getByRole("button", { name: "OK" }));
  await waitFor(() => expect(screen.queryByTestId("code-workspace-undo-confirm")).not.toBeInTheDocument());
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
    // Compare cases override clipboard reads. Restore both the implementations
    // and contents so clipboard workflows do not depend on registration order.
    clipboardMocks.reset();
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

  registerInteractionCases({
get projectFactsMock() { return projectFactsMock; },
get descriptorDiscoveryMock() { return descriptorDiscoveryMock; },
get renderWorkspace() { return renderWorkspace; },
get clipboardMocks() { return clipboardMocks; },
get workspaceMocks() { return workspaceMocks; },
get entry() { return entry; },
get file() { return file; },
get gitMocks() { return gitMocks; },
get toolbarControl() { return toolbarControl; },
get documentStatus() { return documentStatus; },
get lspMocks() { return lspMocks; },
get defaultCapabilities() { return defaultCapabilities; },
get writeAck() { return writeAck; },
get runtimeState() { return runtimeState; },
get dapMocks() { return dapMocks; },
get ipcMocks() { return ipcMocks; },
get localHistoryMocks() { return localHistoryMocks; },
get confirmWorkspaceUndo() { return confirmWorkspaceUndo; },
});
registerFilesCases({
get renderWorkspace() { return renderWorkspace; },
get workspaceMocks() { return workspaceMocks; },
get file() { return file; },
get toolbarControl() { return toolbarControl; },
get entry() { return entry; },
get gitMocks() { return gitMocks; },
get lspMocks() { return lspMocks; },
get documentStatus() { return documentStatus; },
get defaultCapabilities() { return defaultCapabilities; },
get clipboardMocks() { return clipboardMocks; },
get writeAck() { return writeAck; },
get confirmWorkspaceUndo() { return confirmWorkspaceUndo; },
});
registerLanguageCases({
get workspaceMocks() { return workspaceMocks; },
get entry() { return entry; },
get file() { return file; },
get lspMocks() { return lspMocks; },
get csharpStatus() { return csharpStatus; },
get documentStatus() { return documentStatus; },
get renderWorkspace() { return renderWorkspace; },
get settingsNavigationMocks() { return settingsNavigationMocks; },
get writeAck() { return writeAck; },
get defaultCapabilities() { return defaultCapabilities; },
get toolbarControl() { return toolbarControl; },
get runtimeState() { return runtimeState; },
get dapMocks() { return dapMocks; },
});
registerLayoutCases({
get workspaceMocks() { return workspaceMocks; },
get entry() { return entry; },
get file() { return file; },
get renderWorkspace() { return renderWorkspace; },
get lspMocks() { return lspMocks; },
get csharpStatus() { return csharpStatus; },
get documentStatus() { return documentStatus; },
get toolbarControl() { return toolbarControl; },
});
registerWorkspaceEditsCases({
get workspaceMocks() { return workspaceMocks; },
get file() { return file; },
get renderWorkspace() { return renderWorkspace; },
get entry() { return entry; },
get writeAck() { return writeAck; },
get lspMocks() { return lspMocks; },
get documentStatus() { return documentStatus; },
get confirmWorkspaceUndo() { return confirmWorkspaceUndo; },
get runtimeState() { return runtimeState; },
get dapMocks() { return dapMocks; },
get csharpStatus() { return csharpStatus; },
get toolbarControl() { return toolbarControl; },
get defaultCapabilities() { return defaultCapabilities; },
});
registerSaveCases({
get documentStatus() { return documentStatus; },
get defaultCapabilities() { return defaultCapabilities; },
get workspaceMocks() { return workspaceMocks; },
get file() { return file; },
get lspMocks() { return lspMocks; },
get renderWorkspace() { return renderWorkspace; },
get writeAck() { return writeAck; },
get entry() { return entry; },
get runtimeState() { return runtimeState; },
get csharpStatus() { return csharpStatus; },
get toolbarControl() { return toolbarControl; },
get localHistoryMocks() { return localHistoryMocks; },
get saveCommitObservations() { return saveCommitObservations; },
get saveRaceGate() { return saveRaceGate; },
get clipboardMocks() { return clipboardMocks; },
});

  // V-ALT-01: Linux WebKitGTK reports real chords such as Alt+Enter as
  // key="Unidentified" with a physical code. The unified dispatcher must still
  // open the Code Actions menu and leave the buffer untouched.
  it.each(["Enter", "Unidentified"])("opens code actions under StrictMode for Alt+Enter key=%s", async (key) => {
    const instanceId = `instance-actions-alt-enter-${key}`;
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: `ws-actions-alt-enter-${key}`,
      workspaceInstanceId: instanceId,
      name: "Actions Linux",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    workspaceMocks.workspaceListDir.mockResolvedValue([entry("src", "src", "dir")]);
    workspaceMocks.workspaceReadFile.mockResolvedValue(file("src/main.ts", "x=1"));
    lspMocks.lspOpenDocument.mockResolvedValue(documentStatus({
      path: "/repo/app/src/main.ts",
      uri: "file:///repo/app/src/main.ts",
      available: true,
      active: true,
      capabilities: defaultCapabilities({ codeAction: true }),
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
        raw: { title: "Insert space", data: { fixId: "space" } },
      }],
    });

    const rendered = renderWorkspace(workspace, {}, { strict: true });
    await screen.findByTitle("app / src/main.ts");
    await waitFor(() => expect(screen.queryByText("LSP idle")).not.toBeInTheDocument());
    await waitFor(() => expect(rendered.container.querySelector(".cm-content")).not.toBeNull());

    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    content.focus();
    fireEvent.keyDown(content, { key, code: "Enter", altKey: true });

    expect(await screen.findByRole("button", { name: "Insert space" })).toBeInTheDocument();
    expect(lspMocks.lspCodeActions).toHaveBeenCalled();
    // Focus and buffer stay untouched: no newline was inserted.
    expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      instanceId,
    ).openFiles["root:app:src/main.ts"]?.text).toBe("x=1");
  });

  // ED-AUDIT-008 A1/A3: after an intention apply, Ctrl+Z on the editor
  // surface must run the journal undo — one history unit with its verified
  // restore — instead of colliding with the document ledger, and a follow-up
  // Ctrl+Z must not re-apply the change the journal just undid.

  // ED-AUDIT-008 A2: a provider command that fails AFTER the WorkspaceEdit
  // landed must not be reported as a zero-effect success — the already-written
  // text is automatically recovered and the status message names both the
  // failure and the performed recovery, and the failed run registers no
  // undoable history entry.

  // ED-AUDIT-008 A2: a resolve that returns null keeps the file untouched and
  // shows the retryable resolve-failure result instead of a generic error.

  // ED-AUDIT-008 A1 regression: jdtls keeps reporting work-done progress while
  // the candidates are requested and applied, so the semantic snapshot is
  // still "building" with an active provider at both gates. Background
  // provider progress must not stale a revision-pinned response — pre-fix the
  // strict build gate blocked the menu ("Refactor actions became stale…") or
  // aborted the apply ("Semantic result became stale before changes were
  // applied") on roughly half of the native runs. The workspace revision is
  // unchanged throughout, so the menu must open and the apply must land.

  // ED-PARITY-007 DEC-05: the Rust/TS failure classification change must not
  // turn a provider failure into a silent "no actions" claim, and must never
  // block the user's save.

  // ED-AUDIT-009 A1: two real leaves of one file share ONE logical history —
  // an edit in either leaf reaches the other in real time without clobbering
  // its caret/scroll, and one undo/redo stroke issued from one leaf reverts
  // (re-applies) in both leaves through the production keymap routing.

  // ED-AUDIT-009 A2: closing a non-last leaf keeps text AND history in the
  // survivor (no didClose, no save); the last dirty view's cancel is a zero
  // effect; confirming the discard closes without writing; the closed-tab
  // reopen reads the saved disk bytes — discarded text is not revived.

  // ED-PARITY-003 S0..S7: one file preview→formal→split→independent
  // selection→shared edit→single undo→close non-last keeps the survivor
  // alive. The S1b typing-promotion assertion is the regression: the baseline
  // kept the preview italic/dirty-false split (memo-skipped onChange) instead
  // of promoting to formal like IDEA R1.



});

// Type-only fixture contract: case modules do not import this suite at runtime.
export interface WorkspaceTestFixture {
  renderWorkspace: typeof renderWorkspace;
  workspaceMocks: typeof workspaceMocks;
  file: typeof file;
  toolbarControl: typeof toolbarControl;
  entry: typeof entry;
  gitMocks: typeof gitMocks;
  lspMocks: typeof lspMocks;
  documentStatus: typeof documentStatus;
  defaultCapabilities: typeof defaultCapabilities;
  clipboardMocks: typeof clipboardMocks;
  writeAck: typeof writeAck;
  confirmWorkspaceUndo: typeof confirmWorkspaceUndo;
  projectFactsMock: typeof projectFactsMock;
  descriptorDiscoveryMock: typeof descriptorDiscoveryMock;
  runtimeState: typeof runtimeState;
  dapMocks: typeof dapMocks;
  ipcMocks: typeof ipcMocks;
  localHistoryMocks: typeof localHistoryMocks;
  csharpStatus: typeof csharpStatus;
  settingsNavigationMocks: typeof settingsNavigationMocks;
  saveCommitObservations: typeof saveCommitObservations;
  saveRaceGate: typeof saveRaceGate;
}
