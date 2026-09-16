import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCodeWorkspaceStore, selectCodeWorkspaceUi } from "../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../types";

// This suite exercises the real react-resizable-panels implementation: the
// global setup mock replaces it with plain divs and cannot observe drag
// sessions, panel re-registration or release-time layout callbacks.
vi.unmock("react-resizable-panels");

import { CodeWorkspaceTab } from "../CodeWorkspaceTab";

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

const lspMocks = vi.hoisted(() => ({
  nextLspRequestSequence: vi.fn(() => 1),
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

vi.mock("../../../lib/editor/dap", () => dapMocks);

const runtimeState = vi.hoisted(() => ({
  tauri: false,
  platform: "linux" as "linux" | "macos" | "windows" | "unknown",
}));

vi.mock("../../../lib/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/runtime")>()),
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

vi.mock("../../../hooks/useProjectFacts", () => ({
  useProjectFacts: projectFactsMock.useProjectFacts,
}));

const descriptorDiscoveryMock = vi.hoisted(() => {
  const refresh = vi.fn(async () => undefined);
  const state = {
    status: "idle" as const,
    discovery: null,
    reason: null as string | null,
    refresh,
  };
  return {
    state,
    refresh,
    useProjectDescriptorDiscovery: vi.fn(() => state),
  };
});

vi.mock("../../../hooks/useProjectDescriptorDiscovery", () => ({
  useProjectDescriptorDiscovery: descriptorDiscoveryMock.useProjectDescriptorDiscovery,
}));

vi.mock("../../../lib/clipboard", () => clipboardMocks);

vi.mock("../../../lib/settingsNavigation", () => settingsNavigationMocks);

vi.mock("../../../lib/appDialogs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../lib/appDialogs")>()),
  confirmAppDialog: vi.fn(async () => true),
  promptAppDialog: vi.fn(async () => null),
}));

const gitMocks = vi.hoisted(() => ({
  gitSnapshot: vi.fn(),
  gitIgnorePath: vi.fn(),
  gitBlobPair: vi.fn(),
  gitBlameLines: vi.fn(),
  gitChangeLabel: vi.fn(() => ""),
}));

vi.mock("../../../lib/editor/workspace", () => {
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

vi.mock("../../../lib/editor/lsp", () => lspMocks);

vi.mock("@tauri-apps/api/event", () => import("../../../stubs/tauri-event"));

vi.mock("../../../lib/ipc", () => ipcMocks);

vi.mock("../../../lib/git", () => gitMocks);

const localHistoryMocks = vi.hoisted(() => ({
  historySnapshot: vi.fn(async () => null),
  historyList: vi.fn(async () => []),
  historyRead: vi.fn(async () => ""),
  formatLocalHistoryTime: vi.fn(() => "just now"),
  historyRevert: vi.fn(async () => null),
  historyPurge: vi.fn(async () => null),
}));

vi.mock("../../../lib/localHistory", () => localHistoryMocks);

const chatMocks = vi.hoisted(() => ({
  attachToComposer: vi.fn(async () => undefined),
  explainSelection: vi.fn(async () => undefined),
  sendPromptToTabChat: vi.fn(async () => undefined),
}));

vi.mock("../../../stores/chatStore", () => ({
  useChatStore: (selector: (state: typeof chatMocks) => unknown) => selector(chatMocks),
}));

vi.mock("../../git/diffLanguage", () => ({
  languageForPath: vi.fn(async () => null),
}));

vi.mock("../../terminal/TerminalPanel", () => ({
  TerminalPanel: () => null,
}));

const workspaceInstanceId = "instance-splitter-integration";

const workspace: CodeWorkspaceTabInfo = {
  repoRoot: "/repo/app",
  workspaceId: "ws-splitter-integration",
  workspaceInstanceId,
  name: "Splitter Integration",
  roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
  looseFiles: [],
};

class IntegrationResizeObserver {
  static observers: IntegrationResizeObserver[] = [];
  private readonly callback: ResizeObserverCallback;
  readonly targets = new Set<Element>();

  constructor(callback: ResizeObserverCallback) {
    this.callback = callback;
    IntegrationResizeObserver.observers.push(this);
  }

  observe(target: Element) {
    this.targets.add(target);
  }

  unobserve(target: Element) {
    this.targets.delete(target);
  }

  disconnect() {
    this.targets.clear();
  }

  trigger() {
    const entries = Array.from(this.targets).map((target) => {
      const element = target as HTMLElement;
      const width = element.offsetWidth;
      const height = element.offsetHeight;
      return {
        target,
        borderBoxSize: [{ inlineSize: width, blockSize: height }],
        contentRect: element.getBoundingClientRect(),
      };
    }) as unknown as ResizeObserverEntry[];
    this.callback(entries, this as unknown as ResizeObserver);
  }
}

function setElementBox(
  element: HTMLElement,
  box: { x: number; y: number; width: number; height: number },
) {
  Object.defineProperty(element, "clientWidth", { configurable: true, value: box.width });
  Object.defineProperty(element, "clientHeight", { configurable: true, value: box.height });
  Object.defineProperty(element, "offsetWidth", { configurable: true, value: box.width });
  Object.defineProperty(element, "offsetHeight", { configurable: true, value: box.height });
  element.getBoundingClientRect = () => ({
    x: box.x,
    y: box.y,
    width: box.width,
    height: box.height,
    top: box.y,
    right: box.x + box.width,
    bottom: box.y + box.height,
    left: box.x,
    toJSON: () => ({}),
  }) as DOMRect;
}

const TOTAL_WIDTH = 1200;
const GROUP_HEIGHT = 800;

function splitterElements(container: HTMLElement) {
  const group = container.querySelector<HTMLElement>(`[data-group][id="code-workspace-${workspaceInstanceId}"]`);
  const project = container.querySelector<HTMLElement>('[data-panel][id="project"]');
  const editor = container.querySelector<HTMLElement>('[data-panel][id="editor"]');
  const documentation = container.querySelector<HTMLElement>('[data-panel][id="documentation"]');
  const handle = screen.getByTestId("code-workspace-project-resize-handle");
  expect(group).toBeTruthy();
  expect(project).toBeTruthy();
  expect(editor).toBeTruthy();
  expect(documentation).toBeTruthy();
  return {
    group: group!,
    project: project!,
    editor: editor!,
    documentation: documentation!,
    handle,
  };
}

/**
 * jsdom has no layout engine: panel/separator geometry has to be staged by
 * hand, then pushed through the stubbed ResizeObserver exactly like a browser
 * would after a real render.
 */
function applyGeometry(container: HTMLElement, projectWidth: number) {
  const { group, project, editor, documentation, handle } = splitterElements(container);
  setElementBox(group, { x: 0, y: 0, width: TOTAL_WIDTH, height: GROUP_HEIGHT });
  setElementBox(project, { x: 0, y: 0, width: projectWidth, height: GROUP_HEIGHT });
  setElementBox(editor, {
    x: projectWidth + 3,
    y: 0,
    width: TOTAL_WIDTH - projectWidth - 3,
    height: GROUP_HEIGHT,
  });
  setElementBox(documentation, { x: TOTAL_WIDTH, y: 0, width: 0, height: GROUP_HEIGHT });
  setElementBox(handle, { x: projectWidth, y: 0, width: 3, height: GROUP_HEIGHT });
  IntegrationResizeObserver.observers.forEach((observer) => observer.trigger());
  fireEvent(window, new Event("resize"));
}

function styleFlexGrow(element: HTMLElement): number {
  return Number.parseFloat(element.style.flexGrow || "0");
}

describe("CodeWorkspace project splitter integration (real react-resizable-panels)", () => {
  beforeEach(() => {
    window.localStorage.clear();
    IntegrationResizeObserver.observers = [];
    vi.stubGlobal("ResizeObserver", IntegrationResizeObserver);
    useCodeWorkspaceStore.setState({ byInstanceId: {} });
    workspaceMocks.workspaceListDir.mockReset().mockResolvedValue([]);
    workspaceMocks.workspaceCompactChain.mockReset().mockResolvedValue({});
    workspaceMocks.workspaceListFilesRecursive.mockReset().mockResolvedValue([]);
    workspaceMocks.workspaceDetectGitRoots.mockReset().mockResolvedValue([]);
    workspaceMocks.workspaceDetectTasks.mockReset().mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("keeps responding to continuous pointermove and persists only on pointerup (ED-SPLITTER-001)", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const { container } = render(
      <CodeWorkspaceTab tabId="tab-splitter-integration" workspace={workspace} visible />,
    );

    await screen.findByTestId("code-workspace-tree-pane");
    const { handle, project } = splitterElements(container);

    // Stage the initial 452px shell layout and let the library learn it.
    act(() => {
      applyGeometry(container, 452);
    });
    await waitFor(() => {
      expect(styleFlexGrow(project)).toBeGreaterThan(0);
    });
    const initialFlexGrow = styleFlexGrow(project);

    // Drag 452 -> 480 -> 520; a store write per move used to re-register the
    // panel and silently drop every pointermove after the first one.
    fireEvent.pointerDown(handle, {
      button: 0,
      buttons: 1,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      clientX: 453,
      clientY: 300,
    });
    fireEvent.pointerMove(document, {
      buttons: 1,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      clientX: 480,
      clientY: 300,
    });
    act(() => {
      applyGeometry(container, 479);
    });
    const firstMoveFlexGrow = styleFlexGrow(project);
    expect(firstMoveFlexGrow).toBeGreaterThan(initialFlexGrow);
    expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId)
        .shellChromeState?.projectWidthPx,
    ).toBe(452);

    fireEvent.pointerMove(document, {
      buttons: 1,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      clientX: 520,
      clientY: 300,
    });
    act(() => {
      applyGeometry(container, 519);
    });
    const secondMoveFlexGrow = styleFlexGrow(project);
    expect(secondMoveFlexGrow).toBeGreaterThan(firstMoveFlexGrow);
    expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId)
        .shellChromeState?.projectWidthPx,
    ).toBe(452);

    fireEvent.pointerUp(document, {
      buttons: 0,
      pointerId: 1,
      pointerType: "mouse",
      isPrimary: true,
      clientX: 520,
      clientY: 300,
    });

    await waitFor(() => {
      expect(
        selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId)
          .shellChromeState?.projectWidthPx,
      ).toBe(519);
    });

    const layoutErrors = consoleError.mock.calls
      .map((call) => call.map(String).join(" "))
      .filter((message) => message.includes("Panel constraints not found"));
    expect(layoutErrors).toEqual([]);
  });

  it("restores the last expanded width after collapsing and expanding the project tree (ED-SPLITTER-001)", async () => {
    const { container } = render(
      <CodeWorkspaceTab tabId="tab-splitter-integration" workspace={workspace} visible />,
    );
    await screen.findByTestId("code-workspace-tree-pane");
    const { project } = splitterElements(container);

    act(() => {
      applyGeometry(container, 452);
    });
    await waitFor(() => {
      expect(styleFlexGrow(project)).toBeGreaterThan(0);
    });

    fireEvent.click(screen.getByTestId("code-workspace-tree-collapse"));
    await waitFor(() => {
      expect(styleFlexGrow(project)).toBeCloseTo(0, 2);
    });

    fireEvent.click(screen.getByTestId("code-workspace-project-expand"));
    await waitFor(() => {
      // The group is 1197px wide in this harness, so the restored percentage
      // must map back to the 452px default the panel was mounted at.
      const restoredPixels = Math.round((1197 * styleFlexGrow(project)) / 100);
      expect(Math.abs(restoredPixels - 452)).toBeLessThanOrEqual(16);
    });
    expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), workspaceInstanceId)
        .shellChromeState?.projectWidthPx,
    ).toBe(452);
  });
});
