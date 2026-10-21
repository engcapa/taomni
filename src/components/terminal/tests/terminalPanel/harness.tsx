import { vi } from "vitest";

const terminalMocks = vi.hoisted(() => {
  const focus = vi.fn();
  const modes = { bracketedPasteMode: false };
  const oscHandlers = new Map<number, (data: string) => boolean | Promise<boolean>>();
  const state = {
    onDataHandler: null as ((data: string) => void) | null,
    onRenderHandler: null as (() => void) | null,
    onResizeHandler: null as ((size: { cols: number; rows: number; }) => void) | null,
    customKeyEventHandler: null as ((event: KeyboardEvent) => boolean) | null,
  };
  const terminalCtor = vi.fn().mockImplementation(function() {
    return {
      cols: 80,
      rows: 24,
      buffer: {
        active: {
          type: "normal",
          length: 0,
          viewportY: 0,
          getLine: vi.fn(),
        },
      },
      modes,
      parser: {
        registerOscHandler: vi.fn((ident: number, handler: (data: string) => boolean | Promise<boolean>) => {
          oscHandlers.set(ident, handler);
          return { dispose: vi.fn() };
        }),
      },
      loadAddon: vi.fn(),
      open: vi.fn((el: HTMLElement) => {
        const screen = document.createElement("div");
        screen.className = "xterm-screen";
        el.appendChild(screen);
      }),
      onData: vi.fn((handler: (data: string) => void) => {
        state.onDataHandler = handler;
        return { dispose: vi.fn() };
      }),
      onBinary: vi.fn(() => ({ dispose: vi.fn() })),
      onScroll: vi.fn(() => ({ dispose: vi.fn() })),
      onRender: vi.fn((handler: () => void) => {
        state.onRenderHandler = handler;
        return { dispose: vi.fn() };
      }),
      onResize: vi.fn((handler: (size: { cols: number; rows: number; }) => void) => {
        state.onResizeHandler = handler;
        return { dispose: vi.fn() };
      }),
      onSelectionChange: vi.fn(() => ({ dispose: vi.fn() })),
      attachCustomKeyEventHandler: vi.fn((handler: (event: KeyboardEvent) => boolean) => {
        state.customKeyEventHandler = handler;
      }),
      refresh: vi.fn(),
      write: vi.fn(),
      clear: vi.fn(),
      focus,
      dispose: vi.fn(),
      getSelection: vi.fn(() => ""),
      hasSelection: vi.fn(() => false),
      clearSelection: vi.fn(),
      scrollToLine: vi.fn(),
      select: vi.fn(),
    };
  });

  return { focus, modes, terminalCtor, oscHandlers, state };
});

const fitMocks = vi.hoisted(() => ({
  fit: vi.fn(),
}));

const webglMocks = vi.hoisted(() => {
  const instances: Array<{
    contextLossDispose: ReturnType<typeof vi.fn>;
    contextLossHandler: (() => void) | null;
    dispose: ReturnType<typeof vi.fn>;
    onContextLoss: ReturnType<typeof vi.fn>;
  }> = [];

  const ctor = vi.fn().mockImplementation(function() {
    const instance = {
      contextLossDispose: vi.fn(),
      contextLossHandler: null as (() => void) | null,
      dispose: vi.fn(),
      onContextLoss: vi.fn((handler: () => void) => {
        instance.contextLossHandler = handler;
        return { dispose: instance.contextLossDispose };
      }),
    };
    instances.push(instance);
    return instance;
  });

  return { ctor, instances };
});

const ipcMocks = vi.hoisted(() => {
  const terminalExitHandlers = new Map<string, () => void>();

  return {
    terminalExitHandlers,
    closeTerminal: vi.fn(async () => undefined),
    createLocalTerminal: vi.fn(async (
      sessionId: string,
      _cols?: number,
      _rows?: number,
      _shell?: string,
      _shellArgs?: string[],
      _cwd?: string,
      _onOutput?: (data: Uint8Array) => void,
      _workspaceRoot?: string,
    ) => ({ sessionId, shellId: "default" })),
    createSshTerminal: vi.fn(async (sessionId: string) => sessionId),
    listenSshAuthPrompt: vi.fn(async () => vi.fn()),
    submitSshAuthResponse: vi.fn(async () => undefined),
    createTerminalSessionId: vi.fn(() => "terminal-session"),
    encodeBase64: vi.fn((value: string) => btoa(value)),
    listenTerminalExit: vi.fn(async (sessionId: string, callback: () => void) => {
      terminalExitHandlers.set(sessionId, callback);
      return vi.fn(() => terminalExitHandlers.delete(sessionId));
    }),
    listenTerminalForwardError: vi.fn(async () => vi.fn()),
    listSystemFonts: vi.fn(async () => ["Source Code Pro"]),
    readFileBytes: vi.fn(async () => new Uint8Array()),
    readStreamClose: vi.fn(async () => undefined),
    readStreamOpen: vi.fn(async () => ({ handleId: "read-handle", size: 0, mtime: 0 })),
    readStreamRead: vi.fn(async () => new Uint8Array()),
    resizeTerminal: vi.fn(async () => undefined),
    selectSaveDirectory: vi.fn(async () => null),
    selectUploadFile: vi.fn(async (): Promise<string[]> => []),
    sendTerminalSignal: vi.fn(async () => undefined),
    writeTerminal: vi.fn(async () => undefined),
    writeStreamAbort: vi.fn(async () => undefined),
    writeStreamAppend: vi.fn(async () => undefined),
    writeStreamClose: vi.fn(async () => undefined),
    writeStreamOpen: vi.fn(async () => "stream-handle"),
    checkFileExists: vi.fn(async () => false),
    ccTrackTerminal: vi.fn(async () => undefined),
    ccUntrackTerminal: vi.fn(async () => undefined),
    recordLocalDirectoryUse: vi.fn(async () => ({ changed: true })),
    historyAppend: vi.fn(async () => undefined),
    historyMatchPrefix: vi.fn(async () => [] as string[]),
    historyListRecent: vi.fn(async () => [] as string[]),
    historyClear: vi.fn(async () => undefined),
  };
});

const clipboardMocks = vi.hoisted(() => ({
  readFiles: vi.fn(async () => [] as string[]),
  parseFilePaths: vi.fn(async (_text: string) => [] as string[]),
}));

const sockscapMocks = vi.hoisted(() => ({
  sockscapLaunchTerminalApp: vi.fn(async (
    terminalSessionId: string,
    profileId: string,
    path: string,
    args: string[],
  ) => ({
    pid: 4242,
    profileId,
    path,
    args,
    running: true,
    terminalSessionId,
  })),
  sockscapStopLaunchedApp: vi.fn(async () => undefined),
}));

const gitMocks = vi.hoisted(() => ({
  gitProbePath: vi.fn(async (path: string) => ({
    path,
    gitAvailable: true,
    isRepo: true,
    repoRoot: path,
    error: null,
  })),
  gitSnapshot: vi.fn(async (repoRoot: string) => ({
    repoRoot,
    currentBranch: "main",
    headOid: "abc123",
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    changes: [],
    remotes: [],
    branches: [],
    stashes: [],
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
  })),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: terminalMocks.terminalCtor,
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn().mockImplementation(function() {
    return { fit: fitMocks.fit };
  }),
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: vi.fn().mockImplementation(function() {
    return {
      clearDecorations: vi.fn(),
      findNext: vi.fn(),
      findPrevious: vi.fn(),
    };
  }),
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: vi.fn().mockImplementation(function() {
    return {};
  }),
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: webglMocks.ctor,
}));

vi.mock("../../../../lib/ipc", () => ipcMocks);

vi.mock("../../../../lib/clipboard", async () => {
  const actual = await vi.importActual<typeof import("../../../../lib/clipboard")>("../../../../lib/clipboard");
  return {
    ...actual,
    readFiles: clipboardMocks.readFiles,
    parseFilePaths: clipboardMocks.parseFilePaths,
  };
});

vi.mock("../../../../lib/git", () => gitMocks);

vi.mock("../../../../lib/sockscap", () => sockscapMocks);

vi.mock("../../../../lib/terminalImeGuard", () => ({
  attachTerminalImeGuard: vi.fn(() => vi.fn()),
  shouldUseLinuxImeGuard: vi.fn(() => false),
  TerminalImeInputGuard: vi.fn(),
}));

export class ResizeObserverMock {
  observe = vi.fn();
  disconnect = vi.fn();
}

export function encodeOsc52Text(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return `c;${btoa(binary)}`;
}

export const sshInfo = {
  host: "example.test",
  port: 22,
  username: "user",
  authMethod: "Password",
  authData: "secret",
};

export { clipboardMocks, fitMocks, gitMocks, ipcMocks, sockscapMocks, terminalMocks, webglMocks };
