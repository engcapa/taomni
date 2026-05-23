import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPanel } from "./TerminalPanel";
import { DEFAULT_TERMINAL_PROFILE } from "../../lib/terminalProfile";
import { NATIVE_FILE_DROP_EVENT } from "../../lib/osFileDrop";

const terminalMocks = vi.hoisted(() => {
  const focus = vi.fn();
  const modes = { bracketedPasteMode: false };
  const oscHandlers = new Map<number, (data: string) => boolean | Promise<boolean>>();
  const state = {
    onDataHandler: null as ((data: string) => void) | null,
  };
  const terminalCtor = vi.fn().mockImplementation(() => ({
    cols: 80,
    rows: 24,
    buffer: {
      active: {
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
    onRender: vi.fn(() => ({ dispose: vi.fn() })),
    onResize: vi.fn(() => ({ dispose: vi.fn() })),
    onSelectionChange: vi.fn(() => ({ dispose: vi.fn() })),
    attachCustomKeyEventHandler: vi.fn(),
    refresh: vi.fn(),
    write: vi.fn(),
    focus,
    dispose: vi.fn(),
    getSelection: vi.fn(() => ""),
    hasSelection: vi.fn(() => false),
    clearSelection: vi.fn(),
    scrollToLine: vi.fn(),
    select: vi.fn(),
  }));

  return { focus, modes, terminalCtor, oscHandlers, state };
});

const fitMocks = vi.hoisted(() => ({
  fit: vi.fn(),
}));

const webglMocks = vi.hoisted(() => ({
  ctor: vi.fn().mockImplementation(() => ({})),
}));

const ipcMocks = vi.hoisted(() => ({
  closeTerminal: vi.fn(async () => undefined),
  createLocalTerminal: vi.fn(async (sessionId: string) => ({ sessionId, shellId: "default" })),
  createSshTerminal: vi.fn(async (sessionId: string) => sessionId),
  createTerminalSessionId: vi.fn(() => "terminal-session"),
  encodeBase64: vi.fn((value: string) => btoa(value)),
  listenTerminalExit: vi.fn(async () => vi.fn()),
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
  historyAppend: vi.fn(async () => undefined),
  historyMatchPrefix: vi.fn(async () => [] as string[]),
  historyListRecent: vi.fn(async () => [] as string[]),
  historyClear: vi.fn(async () => undefined),
}));

vi.mock("@xterm/xterm", () => ({
  Terminal: terminalMocks.terminalCtor,
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn().mockImplementation(() => ({ fit: fitMocks.fit })),
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: vi.fn().mockImplementation(() => ({
    clearDecorations: vi.fn(),
    findNext: vi.fn(),
    findPrevious: vi.fn(),
  })),
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: vi.fn().mockImplementation(() => ({})),
}));

vi.mock("@xterm/addon-webgl", () => ({
  WebglAddon: webglMocks.ctor,
}));

vi.mock("../../lib/ipc", () => ipcMocks);

vi.mock("../../lib/terminalImeGuard", () => ({
  attachTerminalImeGuard: vi.fn(() => vi.fn()),
  shouldUseLinuxImeGuard: vi.fn(() => false),
  TerminalImeInputGuard: vi.fn(),
}));

class ResizeObserverMock {
  observe = vi.fn();
  disconnect = vi.fn();
}

function encodeOsc52Text(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return `c;${btoa(binary)}`;
}

const sshInfo = {
  host: "example.test",
  port: 22,
  username: "user",
  authMethod: "Password",
  authData: "secret",
};

describe("TerminalPanel focus behavior", () => {
  beforeEach(() => {
    terminalMocks.oscHandlers.clear();
    terminalMocks.state.onDataHandler = null;
    webglMocks.ctor.mockClear();
    vi.stubGlobal("ResizeObserver", ResizeObserverMock);
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      return window.setTimeout(() => callback(performance.now()), 0);
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => {
      window.clearTimeout(id);
    });
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it("focuses the terminal after mounting an active tab", async () => {
    render(<TerminalPanel visible />);

    await waitFor(() => {
      expect(terminalMocks.focus).toHaveBeenCalledTimes(1);
    });
  });

  it("does not load the WebGL renderer inside the macOS Tauri webview", async () => {
    const originalPlatform = window.navigator.platform;
    Object.defineProperty(window.navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    vi.stubGlobal("__TAURI_INTERNALS__", {});

    try {
      render(<TerminalPanel visible />);

      await waitFor(() => {
        expect(terminalMocks.terminalCtor).toHaveBeenCalled();
      });
      expect(webglMocks.ctor).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window.navigator, "platform", {
        configurable: true,
        value: originalPlatform,
      });
    }
  });

  it("focuses the terminal when a hidden tab becomes active", async () => {
    const { rerender } = render(<TerminalPanel visible={false} />);

    expect(terminalMocks.focus).not.toHaveBeenCalled();

    rerender(<TerminalPanel visible />);

    await waitFor(() => {
      expect(terminalMocks.focus).toHaveBeenCalledTimes(1);
    });
  });

  it("pastes clipboard text with Shift+Insert", async () => {
    const readText = vi.fn(async () => "pasted text");
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { readText },
    });
    const onSessionReady = vi.fn();

    render(<TerminalPanel visible onSessionReady={onSessionReady} />);

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    fireEvent.keyDown(window, { key: "Insert", shiftKey: true });

    await waitFor(() => {
      expect(ipcMocks.writeTerminal).toHaveBeenCalledWith(
        "terminal-session",
        btoa("pasted text"),
      );
    });
  });

  it("converts LF to CR for multi-line paste when bracketed paste is off", async () => {
    terminalMocks.modes.bracketedPasteMode = false;
    const readText = vi.fn(async () => "line1\nline2\nline3");
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { readText },
    });
    vi.stubGlobal("confirm", () => true);
    const onSessionReady = vi.fn();

    render(<TerminalPanel visible onSessionReady={onSessionReady} />);

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    fireEvent.keyDown(window, { key: "Insert", shiftKey: true });

    await waitFor(() => {
      expect(ipcMocks.writeTerminal).toHaveBeenCalledWith(
        "terminal-session",
        btoa("line1\rline2\rline3"),
      );
    });
  });

  it("wraps multi-line paste in CSI 200~/201~ when bracketed paste is on", async () => {
    terminalMocks.modes.bracketedPasteMode = true;
    const readText = vi.fn(async () => "line1\nline2\nline3");
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { readText },
    });
    vi.stubGlobal("confirm", () => true);
    const onSessionReady = vi.fn();

    try {
      render(<TerminalPanel visible onSessionReady={onSessionReady} />);

      await waitFor(() => {
        expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
      });

      fireEvent.keyDown(window, { key: "Insert", shiftKey: true });

      await waitFor(() => {
        expect(ipcMocks.writeTerminal).toHaveBeenCalledWith(
          "terminal-session",
          btoa("\x1b[200~line1\nline2\nline3\x1b[201~"),
        );
      });
    } finally {
      terminalMocks.modes.bracketedPasteMode = false;
    }
  });

  it("inserts shell-quoted dropped file paths into the terminal", async () => {
    const onSessionReady = vi.fn();
    render(<TerminalPanel visible onSessionReady={onSessionReady} />);

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    const dataTransfer = {
      types: ["Files", "text/uri-list"],
      files: [new File(["x"], "a b.png", { type: "image/png" })],
      dropEffect: "none",
      getData: (format: string) => (format === "text/uri-list" ? "file:///home/me/a%20b.png" : ""),
    };

    fireEvent.dragOver(screen.getByTestId("terminal-pane"), { dataTransfer });
    fireEvent.drop(screen.getByTestId("terminal-pane"), { dataTransfer });

    await waitFor(() => {
      expect(ipcMocks.writeTerminal).toHaveBeenCalledWith(
        "terminal-session",
        btoa("'/home/me/a b.png' "),
      );
    });
    expect(dataTransfer.dropEffect).toBe("copy");
  });

  it("inserts native Tauri dropped file paths into the terminal", async () => {
    const onSessionReady = vi.fn();
    render(<TerminalPanel visible onSessionReady={onSessionReady} />);

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    const pane = screen.getByTestId("terminal-pane");
    const originalElementFromPoint = document.elementFromPoint;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: vi.fn(() => pane),
    });

    try {
      window.dispatchEvent(
        new CustomEvent(NATIVE_FILE_DROP_EVENT, {
          detail: {
            paths: ["/home/me/a b.png"],
            clientX: 10,
            clientY: 10,
          },
        }),
      );

      await waitFor(() => {
        expect(ipcMocks.writeTerminal).toHaveBeenCalledWith(
          "terminal-session",
          btoa("'/home/me/a b.png' "),
        );
      });
    } finally {
      Object.defineProperty(document, "elementFromPoint", {
        configurable: true,
        value: originalElementFromPoint,
      });
    }
  });

  it("blocks typed input when split input is locked", async () => {
    const onSessionReady = vi.fn();
    render(<TerminalPanel visible inputLocked onSessionReady={onSessionReady} />);

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
      expect(terminalMocks.state.onDataHandler).toBeTruthy();
    });

    terminalMocks.state.onDataHandler?.("blocked");

    expect(ipcMocks.writeTerminal).not.toHaveBeenCalled();
    expect(screen.getByTestId("terminal-input-locked")).toHaveTextContent("Input locked");
  });

  it("blocks clipboard paste when split input is locked", async () => {
    const readText = vi.fn(async () => "locked paste");
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { readText },
    });
    const onSessionReady = vi.fn();

    render(<TerminalPanel visible inputLocked onSessionReady={onSessionReady} />);

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    fireEvent.keyDown(window, { key: "Insert", shiftKey: true });
    await Promise.resolve();

    expect(readText).not.toHaveBeenCalled();
    expect(ipcMocks.writeTerminal).not.toHaveBeenCalled();
  });

  it("blocks dropped file paths when split input is locked", async () => {
    const onSessionReady = vi.fn();
    render(<TerminalPanel visible inputLocked onSessionReady={onSessionReady} />);

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    const dataTransfer = {
      types: ["Files", "text/uri-list"],
      files: [new File(["x"], "a b.png", { type: "image/png" })],
      dropEffect: "none",
      getData: (format: string) => (format === "text/uri-list" ? "file:///home/me/a%20b.png" : ""),
    };

    fireEvent.drop(screen.getByTestId("terminal-pane"), { dataTransfer });

    expect(ipcMocks.writeTerminal).not.toHaveBeenCalled();
  });

  it("honors the right-click paste terminal setting", async () => {
    const readText = vi.fn(async () => "right click paste");
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { readText },
    });
    const onSessionReady = vi.fn();

    render(
      <TerminalPanel
        visible
        onSessionReady={onSessionReady}
        terminalProfile={{
          ...DEFAULT_TERMINAL_PROFILE,
          rightClickBehavior: "paste",
        }}
      />,
    );

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    fireEvent.contextMenu(screen.getByTestId("terminal-pane"));

    await waitFor(() => {
      expect(ipcMocks.writeTerminal).toHaveBeenCalledWith(
        "terminal-session",
        btoa("right click paste"),
      );
    });
    expect(screen.queryByTestId("context-menu")).not.toBeInTheDocument();
  });

  it("accepts OSC 52 clipboard writes from local terminals", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText },
    });

    render(<TerminalPanel visible terminalProfile={DEFAULT_TERMINAL_PROFILE} />);

    await waitFor(() => {
      expect(terminalMocks.oscHandlers.get(52)).toBeTruthy();
    });

    terminalMocks.oscHandlers.get(52)?.(encodeOsc52Text("local copy"));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("local copy");
    });
  });

  it("blocks OSC 52 clipboard writes from SSH terminals by default", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText },
    });

    render(<TerminalPanel visible ssh={sshInfo} terminalProfile={DEFAULT_TERMINAL_PROFILE} />);

    await waitFor(() => {
      expect(terminalMocks.oscHandlers.get(52)).toBeTruthy();
    });

    terminalMocks.oscHandlers.get(52)?.(encodeOsc52Text("remote copy"));
    await Promise.resolve();

    expect(writeText).not.toHaveBeenCalled();
  });

  it("accepts OSC 52 clipboard writes from SSH terminals when enabled", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: { writeText },
    });

    render(
      <TerminalPanel
        visible
        ssh={sshInfo}
        terminalProfile={{
          ...DEFAULT_TERMINAL_PROFILE,
          allowRemoteOsc52Clipboard: true,
        }}
      />,
    );

    await waitFor(() => {
      expect(terminalMocks.oscHandlers.get(52)).toBeTruthy();
    });

    terminalMocks.oscHandlers.get(52)?.(encodeOsc52Text("remote copy"));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith("remote copy");
    });
  });

  it("omits the no-op ZMODEM receive action from the context menu", async () => {
    const onSessionReady = vi.fn();

    render(<TerminalPanel visible onSessionReady={onSessionReady} />);

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    fireEvent.contextMenu(screen.getByTestId("terminal-pane"));

    await waitFor(() => {
      expect(screen.queryAllByTestId("context-menu").length).toBeGreaterThan(0);
    });
    expect(screen.queryByTestId("context-menu-item-receive-file-using-z-modem")).not.toBeInTheDocument();
    expect(screen.getByTestId("context-menu-item-send-file-using-z-modem")).toBeInTheDocument();
  });

  it("queues a ZMODEM send from the context menu without reading the selected file into memory", async () => {
    ipcMocks.selectUploadFile.mockResolvedValueOnce(["/preview/uploads/big.bin"]);
    const onSessionReady = vi.fn();

    render(<TerminalPanel visible onSessionReady={onSessionReady} />);

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    fireEvent.contextMenu(screen.getByTestId("terminal-pane"));
    await waitFor(() => {
      expect(screen.getByTestId("context-menu-item-send-file-using-z-modem")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("context-menu-item-send-file-using-z-modem"));

    await waitFor(() => {
      expect(ipcMocks.writeTerminal).toHaveBeenCalledWith("terminal-session", btoa("rz\r"));
    });
    expect(ipcMocks.selectUploadFile).toHaveBeenCalledTimes(1);
    expect(ipcMocks.readFileBytes).not.toHaveBeenCalled();
    expect(ipcMocks.readStreamOpen).not.toHaveBeenCalled();
  });
});
