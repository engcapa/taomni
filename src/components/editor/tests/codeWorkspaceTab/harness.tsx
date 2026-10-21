import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode, type ComponentProps } from "react";
import { expect, vi } from "vitest";
import type { ProjectDescriptorDiscoveryState } from "../../../../hooks/useProjectDescriptorDiscovery";
import type { LspCapabilitySummary, LspDocumentStatus, LspServerStatus } from "../../../../lib/editor/lsp";
import type { WorkspaceEntry, WorkspaceFile, WorkspaceWriteAck } from "../../../../lib/editor/workspace";
import type { LocalHistoryEntry } from "../../../../lib/localHistory";
import type { CodeWorkspaceTabInfo } from "../../../../types";
import { CodeWorkspaceTab } from "../../CodeWorkspaceTab";

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

vi.mock("../../workspace/workspaceStyleController", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../workspace/workspaceStyleController")>();
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

vi.mock("../../../../lib/editor/dap", () => dapMocks);

/**
 * Whether the component sees the desktop runtime. Defaults to false (the value
 * every other test in this file has always run with); the Java debug test opts
 * in, since the Debug button is disabled outside the Tauri webview.
 */
const runtimeState = vi.hoisted(() => ({
  tauri: false,
  platform: "linux" as "linux" | "macos" | "windows" | "unknown",
}));

vi.mock("../../../../lib/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/runtime")>()),
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

vi.mock("../../../../hooks/useProjectFacts", () => ({
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

vi.mock("../../../../hooks/useProjectDescriptorDiscovery", () => ({
  useProjectDescriptorDiscovery: descriptorDiscoveryMock.useProjectDescriptorDiscovery,
}));

vi.mock("../../../../lib/clipboard", () => clipboardMocks);

vi.mock("../../../../lib/settingsNavigation", () => settingsNavigationMocks);

// CodeWorkspaceTab is rendered in isolation (without the app-level dialog
// provider). Auto-confirm preview-only WorkspaceEdits so those tests can
// continue to assert the resource operation lifecycle itself.
vi.mock("../../../../lib/appDialogs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../../lib/appDialogs")>()),
  confirmAppDialog: vi.fn(async () => true),
  promptAppDialog: vi.fn(async () => null),
}));

const gitMocks = vi.hoisted(() => ({
  gitSnapshot: vi.fn(),
  gitIgnorePath: vi.fn(),
  gitBlobPair: vi.fn(),
  gitBlameLines: vi.fn(),
  gitChangeLabel: vi.fn((change: { conflict?: boolean; status: string; }) => (
    change.conflict ? "Conflicted" : change.status[0]?.toUpperCase() + change.status.slice(1)
  )),
}));

vi.mock("../../../../lib/editor/workspace", () => {
  // W0 §8.20.1: the production tree IPC returns the WorkspaceTreeLoadResult
  // union. Test fixtures keep writing raw arrays/chain objects; these
  // delegates convert them (and rejections) exactly like the real decoder.
  const wrapResult = (value: unknown): unknown => {
    if (value && typeof value === "object" && "state" in (value as Record<string, unknown>)) return value;
    if (Array.isArray(value)) return { state: "ready", entries: value, truncated: false };
    if (value && typeof value === "object" && "path" in (value as Record<string, unknown>)
      && "entries" in (value as Record<string, unknown>)) {
      return { state: "ready", entries: (value as { entries: unknown[]; }).entries, truncated: false };
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

vi.mock("../../../../lib/editor/lsp", () => lspMocks);

vi.mock("@tauri-apps/api/event", () => import("../../../../stubs/tauri-event"));

vi.mock("../../../../lib/ipc", () => ipcMocks);

vi.mock("../../../../lib/git", () => gitMocks);

const localHistoryMocks = vi.hoisted(() => ({
  historySnapshot: vi.fn<() => Promise<LocalHistoryEntry | null>>(async () => null),
  historyList: vi.fn<() => Promise<LocalHistoryEntry[]>>(async () => []),
  historyRead: vi.fn(async () => ""),
  formatLocalHistoryTime: vi.fn(() => "just now"),
  historyRevert: vi.fn(async () => null),
  historyPurge: vi.fn(async () => null),
}));

vi.mock("../../../../lib/localHistory", () => localHistoryMocks);

const chatMocks = vi.hoisted(() => ({
  attachToComposer: vi.fn(async () => undefined),
  explainSelection: vi.fn(async () => undefined),
  sendPromptToTabChat: vi.fn(async () => undefined),
}));

vi.mock("../../../../stores/chatStore", () => ({
  useChatStore: (selector: (state: typeof chatMocks) => unknown) => selector(chatMocks),
}));

vi.mock("../../../git/diffLanguage", () => ({
  languageForPath: vi.fn(async () => null),
}));

vi.mock("../../../terminal/TerminalPanel", () => ({
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
export function toolbarControl(testId: string): HTMLElement {
  if (!screen.queryByTestId(testId)) fireEvent.click(screen.getByTestId("code-workspace-toolbar-more"));
  return screen.getByTestId(testId);
}

export function file(
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
export function writeAck(
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
  arm(request: Record<string, unknown>): { ok: boolean; reason?: string; };
  status(): { held: null | { stage: string; transactionId: string; }; };
  release(request?: { reason?: string; }): { ok: boolean; reason?: string; };
  trace(): Array<{ event: string; revision?: number | null; detail?: Record<string, unknown>; }>;
}

export function saveRaceGate(): SaveRaceGateForTest {
  const control = (window as unknown as { __taomniQaSaveGate?: SaveRaceGateForTest; }).__taomniQaSaveGate;
  if (!control) throw new Error("save race gate is not installed");
  return control;
}

export function entry(
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

export function csharpStatus(overrides: Partial<LspServerStatus> = {}): LspServerStatus {
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

export function defaultCapabilities(overrides: Partial<LspCapabilitySummary> = {}): LspCapabilitySummary {
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

export function documentStatus(overrides: Partial<LspDocumentStatus> = {}): LspDocumentStatus {
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

export function renderWorkspace(
  workspace: CodeWorkspaceTabInfo,
  props: Partial<ComponentProps<typeof CodeWorkspaceTab>> = {},
  options: { strict?: boolean; } = {},
) {
  const element = <CodeWorkspaceTab tabId="tab-code" workspace={workspace} visible {...props} />;
  // `strict` reproduces how the app actually mounts (src/main.tsx wraps the tree
  // in React.StrictMode): mount → effect cleanups → effects again. Anything that
  // latches state in an effect cleanup behaves differently there.
  return render(options.strict ? <StrictMode>{element}</StrictMode> : element);
}

export async function confirmWorkspaceUndo() {
  const dialog = await screen.findByRole("dialog", { name: "Undo" });
  fireEvent.click(within(dialog).getByRole("button", { name: "OK" }));
  await waitFor(() => expect(screen.queryByTestId("code-workspace-undo-confirm")).not.toBeInTheDocument());
}

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

export {
  chatMocks,
  clipboardMocks,
  dapMocks,
  descriptorDiscoveryMock,
  gitMocks,
  ipcMocks,
  localHistoryMocks,
  lspMocks,
  projectFactsMock,
  runtimeState,
  saveCommitObservations,
  settingsNavigationMocks,
  workspaceMocks,
};
