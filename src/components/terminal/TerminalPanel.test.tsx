import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TerminalPanel, collectTerminalBlockSelectionText } from "./TerminalPanel";
import { DEFAULT_TERMINAL_PROFILE } from "../../lib/terminalProfile";
import { NATIVE_FILE_DROP_EVENT } from "../../lib/osFileDrop";

const terminalMocks = vi.hoisted(() => {
  const focus = vi.fn();
  const modes = { bracketedPasteMode: false };
  const oscHandlers = new Map<number, (data: string) => boolean | Promise<boolean>>();
  const state = {
    onDataHandler: null as ((data: string) => void) | null,
  };
  const terminalCtor = vi.fn().mockImplementation(function () {
    return {
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
    };
  });

  return { focus, modes, terminalCtor, oscHandlers, state };
});

const fitMocks = vi.hoisted(() => ({
  fit: vi.fn(),
}));

const webglMocks = vi.hoisted(() => ({
  ctor: vi.fn().mockImplementation(function () {
    return {};
  }),
}));

const ipcMocks = vi.hoisted(() => {
  const terminalExitHandlers = new Map<string, () => void>();

  return {
    terminalExitHandlers,
    closeTerminal: vi.fn(async () => undefined),
    createLocalTerminal: vi.fn(async (sessionId: string) => ({ sessionId, shellId: "default" })),
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
    historyAppend: vi.fn(async () => undefined),
    historyMatchPrefix: vi.fn(async () => [] as string[]),
    historyListRecent: vi.fn(async () => [] as string[]),
    historyClear: vi.fn(async () => undefined),
  };
});

vi.mock("@xterm/xterm", () => ({
  Terminal: terminalMocks.terminalCtor,
}));

vi.mock("@xterm/addon-fit", () => ({
  FitAddon: vi.fn().mockImplementation(function () {
    return { fit: fitMocks.fit };
  }),
}));

vi.mock("@xterm/addon-search", () => ({
  SearchAddon: vi.fn().mockImplementation(function () {
    return {
      clearDecorations: vi.fn(),
      findNext: vi.fn(),
      findPrevious: vi.fn(),
    };
  }),
}));

vi.mock("@xterm/addon-web-links", () => ({
  WebLinksAddon: vi.fn().mockImplementation(function () {
    return {};
  }),
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

describe("terminal block selection helpers", () => {
  it("extracts fixed-column text across terminal buffer rows", () => {
    const rows = ["alpha bravo", "xy", "123456789"];
    const term = {
      cols: 12,
      buffer: {
        active: {
          getLine: (row: number) => ({
            translateToString: () => rows[row] ?? "",
          }),
        },
      },
    };

    expect(
      collectTerminalBlockSelectionText(term as never, {
        anchor: { row: 2, col: 5 },
        focus: { row: 0, col: 2 },
      }),
    ).toBe("pha\n\n3456");
  });
});

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
    ipcMocks.terminalExitHandlers.clear();
    ipcMocks.createTerminalSessionId.mockImplementation(() => "terminal-session");
    ipcMocks.createLocalTerminal.mockImplementation(async (sessionId: string) => ({
      sessionId,
      shellId: "default",
    }));
    ipcMocks.createSshTerminal.mockImplementation(async (sessionId: string) => sessionId);
    ipcMocks.listenTerminalExit.mockImplementation(async (sessionId: string, callback: () => void) => {
      ipcMocks.terminalExitHandlers.set(sessionId, callback);
      return vi.fn(() => ipcMocks.terminalExitHandlers.delete(sessionId));
    });
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

  it("handles macOS Cmd+V through the native paste event without reading clipboard permissions", async () => {
    const originalPlatform = window.navigator.platform;
    const originalClipboard = window.navigator.clipboard;
    const readText = vi.fn(async () => "permission paste");
    Object.defineProperty(window.navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { readText },
    });
    const onSessionReady = vi.fn();

    try {
      render(<TerminalPanel visible onSessionReady={onSessionReady} />);

      await waitFor(() => {
        expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
      });

      fireEvent.keyDown(window, { key: "v", metaKey: true });
      await Promise.resolve();

      expect(readText).not.toHaveBeenCalled();
      expect(ipcMocks.writeTerminal).not.toHaveBeenCalled();

      const screenEl = screen.getByTestId("terminal-pane").querySelector(".xterm-screen");
      expect(screenEl).toBeTruthy();
      const getData = vi.fn((type: string) => (type === "text/plain" ? "native paste" : ""));
      fireEvent.paste(screenEl as Element, {
        clipboardData: { getData },
      });

      await waitFor(() => {
        expect(ipcMocks.writeTerminal).toHaveBeenCalledWith(
          "terminal-session",
          btoa("native paste"),
        );
      });
      expect(readText).not.toHaveBeenCalled();
      expect(getData).toHaveBeenCalledWith("text/plain");
    } finally {
      Object.defineProperty(window.navigator, "platform", {
        configurable: true,
        value: originalPlatform,
      });
      Object.defineProperty(window.navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
    }
  });

  it("confirms macOS native multi-line paste before writing to the terminal", async () => {
    const originalPlatform = window.navigator.platform;
    const originalClipboard = window.navigator.clipboard;
    const readText = vi.fn(async () => "permission paste");
    Object.defineProperty(window.navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { readText },
    });
    const onSessionReady = vi.fn();

    try {
      render(<TerminalPanel visible onSessionReady={onSessionReady} />);

      await waitFor(() => {
        expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
      });

      const screenEl = screen.getByTestId("terminal-pane").querySelector(".xterm-screen");
      expect(screenEl).toBeTruthy();
      const getData = vi.fn((type: string) => (type === "text/plain" ? "line1\nline2" : ""));
      fireEvent.paste(screenEl as Element, {
        clipboardData: { getData },
      });

      await waitFor(() => {
        expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
      });
      expect(readText).not.toHaveBeenCalled();
      expect(ipcMocks.writeTerminal).not.toHaveBeenCalledWith(
        "terminal-session",
        btoa("line1\rline2"),
      );

      fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));

      await waitFor(() => {
        expect(ipcMocks.writeTerminal).toHaveBeenCalledWith(
          "terminal-session",
          btoa("line1\rline2"),
        );
      });
      expect(readText).not.toHaveBeenCalled();
      expect(getData).toHaveBeenCalledWith("text/plain");
    } finally {
      Object.defineProperty(window.navigator, "platform", {
        configurable: true,
        value: originalPlatform,
      });
      Object.defineProperty(window.navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
    }
  });

  it("converts LF to CR for multi-line paste when bracketed paste is off", async () => {
    terminalMocks.modes.bracketedPasteMode = false;
    const readText = vi.fn(async () => "line1\nline2\nline3");
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
      expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
    });
    expect(ipcMocks.writeTerminal).not.toHaveBeenCalledWith(
      "terminal-session",
      btoa("line1\rline2\rline3"),
    );

    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));

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
    const onSessionReady = vi.fn();

    try {
      render(<TerminalPanel visible onSessionReady={onSessionReady} />);

      await waitFor(() => {
        expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
      });

      fireEvent.keyDown(window, { key: "Insert", shiftKey: true });

      await waitFor(() => {
        expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));

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

  it("keeps a block selection alive when pressing the floating selection toolbar", async () => {
    const onSessionReady = vi.fn();
    render(<TerminalPanel visible onSessionReady={onSessionReady} />);

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    const term = terminalMocks.terminalCtor.mock.results[0].value;
    term.buffer.active.length = 4;
    term.buffer.active.viewportY = 0;
    term.buffer.active.getLine.mockImplementation((row: number) => ({
      translateToString: () => ["alpha bravo", "charlie delta", "echo foxtrot", ""][row] ?? "",
    }));

    const screenEl = screen.getByTestId("terminal-pane").querySelector(".xterm-screen") as HTMLElement;
    vi.spyOn(screenEl, "getBoundingClientRect").mockReturnValue({
      left: 0,
      top: 0,
      right: 800,
      bottom: 240,
      width: 800,
      height: 240,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    });

    fireEvent.mouseDown(screenEl, { button: 0, ctrlKey: true, shiftKey: true, clientX: 10, clientY: 10 });
    fireEvent.mouseMove(document, { clientX: 70, clientY: 20 });
    fireEvent.mouseUp(document, { clientX: 70, clientY: 20 });

    const copyButton = await screen.findByTitle("Copy (Ctrl+C)");
    fireEvent.mouseDown(copyButton, { button: 0 });

    expect(screen.getByTitle("Copy (Ctrl+C)")).toBeInTheDocument();
  });

  it("pastes the captured terminal selection on macOS middle mouse up", async () => {
    const originalPlatform = window.navigator.platform;
    const originalClipboard = window.navigator.clipboard;
    const readText = vi.fn(async () => "clipboard fallback");
    Object.defineProperty(window.navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { readText },
    });
    const onSessionReady = vi.fn();

    try {
      render(<TerminalPanel visible onSessionReady={onSessionReady} />);

      await waitFor(() => {
        expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
      });

      const term = terminalMocks.terminalCtor.mock.results[0].value;
      term.getSelection.mockReturnValue("selected text");
      const pane = screen.getByTestId("terminal-pane");

      fireEvent.mouseDown(pane, { button: 1 });
      term.getSelection.mockReturnValue("");
      fireEvent.mouseUp(pane, { button: 1 });

      await waitFor(() => {
        expect(ipcMocks.writeTerminal).toHaveBeenCalledWith(
          "terminal-session",
          btoa("selected text"),
        );
      });
      expect(readText).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(window.navigator, "platform", {
        configurable: true,
        value: originalPlatform,
      });
      Object.defineProperty(window.navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
    }
  });

  it("falls back to the clipboard on macOS middle mouse up when there is no terminal selection", async () => {
    const originalPlatform = window.navigator.platform;
    const originalClipboard = window.navigator.clipboard;
    const readText = vi.fn(async () => "mac clipboard");
    Object.defineProperty(window.navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { readText },
    });
    const onSessionReady = vi.fn();

    try {
      render(<TerminalPanel visible onSessionReady={onSessionReady} />);

      await waitFor(() => {
        expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
      });

      const pane = screen.getByTestId("terminal-pane");
      fireEvent.mouseDown(pane, { button: 1 });
      fireEvent.mouseUp(pane, { button: 1 });

      await waitFor(() => {
        expect(ipcMocks.writeTerminal).toHaveBeenCalledWith(
          "terminal-session",
          btoa("mac clipboard"),
        );
      });
      expect(readText).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window.navigator, "platform", {
        configurable: true,
        value: originalPlatform,
      });
      Object.defineProperty(window.navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
    }
  });

  it("does not paste twice when macOS emits both mouseup and auxclick for the middle button", async () => {
    const originalPlatform = window.navigator.platform;
    Object.defineProperty(window.navigator, "platform", {
      configurable: true,
      value: "MacIntel",
    });
    const onSessionReady = vi.fn();

    try {
      render(<TerminalPanel visible onSessionReady={onSessionReady} />);

      await waitFor(() => {
        expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
      });

      const term = terminalMocks.terminalCtor.mock.results[0].value;
      term.getSelection.mockReturnValue("selected once");
      const pane = screen.getByTestId("terminal-pane");

      fireEvent.mouseDown(pane, { button: 1 });
      fireEvent.mouseUp(pane, { button: 1 });
      fireEvent(pane, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));

      await waitFor(() => {
        expect(ipcMocks.writeTerminal).toHaveBeenCalledTimes(1);
      });
      expect(ipcMocks.writeTerminal).toHaveBeenCalledWith(
        "terminal-session",
        btoa("selected once"),
      );
    } finally {
      Object.defineProperty(window.navigator, "platform", {
        configurable: true,
        value: originalPlatform,
      });
    }
  });

  it("keeps non-macOS middle-click paste on the existing auxclick path", async () => {
    const originalPlatform = window.navigator.platform;
    const originalClipboard = window.navigator.clipboard;
    const readText = vi.fn(async () => "windows clipboard");
    Object.defineProperty(window.navigator, "platform", {
      configurable: true,
      value: "Win32",
    });
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { readText },
    });
    const onSessionReady = vi.fn();

    try {
      render(<TerminalPanel visible onSessionReady={onSessionReady} />);

      await waitFor(() => {
        expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
      });

      const pane = screen.getByTestId("terminal-pane");
      fireEvent.mouseDown(pane, { button: 1 });
      fireEvent.mouseUp(pane, { button: 1 });
      await Promise.resolve();

      expect(readText).not.toHaveBeenCalled();
      expect(ipcMocks.writeTerminal).not.toHaveBeenCalled();

      fireEvent(pane, new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));

      await waitFor(() => {
        expect(ipcMocks.writeTerminal).toHaveBeenCalledWith(
          "terminal-session",
          btoa("windows clipboard"),
        );
      });
      expect(readText).toHaveBeenCalledTimes(1);
    } finally {
      Object.defineProperty(window.navigator, "platform", {
        configurable: true,
        value: originalPlatform,
      });
      Object.defineProperty(window.navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
    }
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

  it("reconnects an SSH terminal with Enter after exit while keeping the same xterm instance", async () => {
    ipcMocks.createTerminalSessionId
      .mockReturnValueOnce("terminal-session")
      .mockReturnValueOnce("terminal-session-reconnect");
    const onSessionReady = vi.fn();

    render(<TerminalPanel visible ssh={sshInfo} onSessionReady={onSessionReady} />);

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    const term = terminalMocks.terminalCtor.mock.results[0].value;
    ipcMocks.terminalExitHandlers.get("terminal-session")?.();

    await waitFor(() => {
      expect(term.write).toHaveBeenCalledWith(expect.stringContaining("Press Enter to reconnect"));
    });
    expect(ipcMocks.writeTerminal).not.toHaveBeenCalledWith("terminal-session", btoa("\r"));

    terminalMocks.state.onDataHandler?.("\r");

    await waitFor(() => {
      expect(ipcMocks.createSshTerminal).toHaveBeenCalledTimes(2);
    });
    expect(ipcMocks.createSshTerminal).toHaveBeenLastCalledWith(
      "terminal-session-reconnect",
      sshInfo.host,
      sshInfo.port,
      sshInfo.username,
      sshInfo.authMethod,
      sshInfo.authData,
      80,
      24,
      expect.any(String),
      expect.any(Function),
      true,
      true,
    );
    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session-reconnect");
    });
    expect(terminalMocks.terminalCtor).toHaveBeenCalledTimes(1);
    expect(term.write).toHaveBeenCalledWith(expect.stringContaining("[Reconnecting"));
    expect(term.write).toHaveBeenCalledWith(expect.stringContaining("[Reconnected"));

    ipcMocks.writeTerminal.mockClear();
    terminalMocks.state.onDataHandler?.("whoami\r");

    await waitFor(() => {
      expect(ipcMocks.writeTerminal).toHaveBeenCalledWith(
        "terminal-session-reconnect",
        btoa("whoami\r"),
      );
    });
  });

  it("shows a retry prompt when SSH reconnect fails and does not write Enter to the old session", async () => {
    ipcMocks.createTerminalSessionId
      .mockReturnValueOnce("terminal-session")
      .mockReturnValueOnce("terminal-session-reconnect");
    ipcMocks.createSshTerminal
      .mockImplementationOnce(async (sessionId: string) => sessionId)
      .mockImplementationOnce(async () => {
        throw new Error("network down");
      });
    const onSessionReady = vi.fn();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);

    try {
      render(<TerminalPanel visible ssh={sshInfo} onSessionReady={onSessionReady} />);

      await waitFor(() => {
        expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
      });

      const term = terminalMocks.terminalCtor.mock.results[0].value;
      ipcMocks.terminalExitHandlers.get("terminal-session")?.();

      ipcMocks.writeTerminal.mockClear();
      terminalMocks.state.onDataHandler?.("\r");

      await waitFor(() => {
        expect(term.write).toHaveBeenCalledWith(expect.stringContaining("[Reconnect failed]"));
        expect(term.write).toHaveBeenCalledWith(expect.stringContaining("Press Enter to retry"));
      });
      expect(ipcMocks.writeTerminal).not.toHaveBeenCalled();

      terminalMocks.state.onDataHandler?.("ls\r");
      expect(ipcMocks.writeTerminal).not.toHaveBeenCalled();
    } finally {
      consoleError.mockRestore();
    }
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
