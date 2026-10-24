import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DEFAULT_TERMINAL_PROFILE } from "../../../../lib/terminalProfile";
import { CWD_INTEGRATION_DONE_MARKER } from "../../../../lib/terminalShellIntegration";
import { useAppStore } from "../../../../stores/appStore";
import { TerminalPanel } from "../../TerminalPanel";
import { ipcMocks, sshInfo, terminalMocks, webglMocks } from "./harness";

export function registerTerminalPanelClipboard4Cases() {

/**
 * Pin the platform detection to Linux for POSIX SSH-integration cases; on a
 * Windows host the default jsdom userAgent routes them into the
 * browser-preview skip branch instead.
 */
function stubLinuxNavigator(): () => void {
  const navigatorObject = window.navigator as Navigator & { platform: string; userAgent: string };
  const originalPlatform = navigatorObject.platform;
  const originalUserAgent = navigatorObject.userAgent;
  Object.defineProperty(navigatorObject, "platform", { configurable: true, value: "Linux x86_64" });
  Object.defineProperty(navigatorObject, "userAgent", { configurable: true, value: "Mozilla/5.0 (X11; Linux x86_64)" });
  return () => {
    Object.defineProperty(navigatorObject, "platform", { configurable: true, value: originalPlatform });
    Object.defineProperty(navigatorObject, "userAgent", { configurable: true, value: originalUserAgent });
  };
}

  it("tracks a submitted program and returns to idle on the next shell prompt", async () => {
    render(<TerminalPanel tabId="term-activity" visible />);

    await waitFor(() => {
      expect(useAppStore.getState().terminalRuntimeByTab["term-activity"]?.backendSessionId).toBe(
        "terminal-session",
      );
    });

    terminalMocks.state.onDataHandler?.("sudo -u deploy vite --host");
    terminalMocks.state.onDataHandler?.("\r");

    expect(useAppStore.getState().terminalRuntimeByTab["term-activity"]).toMatchObject({
      state: "running",
      program: "vite",
      activitySource: "input-heuristic",
    });

    terminalMocks.oscHandlers.get(7)?.("file://localhost/work/taomni");
    expect(useAppStore.getState().terminalRuntimeByTab["term-activity"]).toMatchObject({
      state: "idle",
      activitySource: "shell-integration",
    });
    expect(useAppStore.getState().terminalRuntimeByTab["term-activity"]?.program).toBeUndefined();
  });

  it("installs SSH cwd reporting when a delayed startup later reaches an idle prompt", async () => {
    // This case covers the POSIX integration path; pin the platform so the
    // Windows browser-preview skip branch cannot mask the flow.
    const restoreLinux = stubLinuxNavigator();
    let onOutput: ((data: Uint8Array) => void) | undefined;
    ipcMocks.createSshTerminal.mockImplementation(async (...args: unknown[]) => {
      onOutput = args[9] as (data: Uint8Array) => void;
      return "terminal-session";
    });
    const onSessionReady = vi.fn();
    try {
    render(<TerminalPanel tabId="slow-ssh" visible ssh={sshInfo} onSessionReady={onSessionReady} />);

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
      expect(onOutput).toBeTypeOf("function");
    });

    const term = terminalMocks.terminalCtor.mock.results[0].value;
    const prompt = "(base) user@example.test:/srv/project$ ";
    term.buffer.active = {
      type: "normal",
      length: 1,
      baseY: 0,
      cursorY: 0,
      cursorX: prompt.length,
      getLine: vi.fn(() => ({
        isWrapped: false,
        translateToString: () => prompt,
      })),
    };
    term.write.mockImplementation((_data: Uint8Array, callback?: () => void) => callback?.());
    ipcMocks.writeTerminal.mockClear();
    const panel = screen.getByTestId("terminal-pane");

    act(() => terminalMocks.state.onRenderHandler?.());
    expect(panel).not.toHaveAttribute("data-terminal-ready");

    await act(async () => {
      onOutput?.(new TextEncoder().encode(prompt));
    });

    await waitFor(() => {
      const integrationWrite = (ipcMocks.writeTerminal.mock.calls as unknown[][]).find(
        ([sessionId, encoded]) =>
          sessionId === "terminal-session" &&
          typeof encoded === "string" &&
          atob(encoded).includes("__taomni_osc7"),
      );
      expect(integrationWrite).toBeTruthy();
    });
    expect(panel).not.toHaveAttribute("data-terminal-ready");

    await act(async () => {
      onOutput?.(
        new TextEncoder().encode(`\x1b]7;file://example.test/srv/project\x1b\\${CWD_INTEGRATION_DONE_MARKER}${prompt}`),
      );
    });

    await waitFor(() => {
      expect(panel).toHaveAttribute("data-terminal-ready", "true");
    });
    } finally {
      restoreLinux();
    }
  });

  it("holds keystrokes while a hidden SSH setup line is still being installed", async () => {
    const restoreLinux = stubLinuxNavigator();
    let onOutput: ((data: Uint8Array) => void) | undefined;
    ipcMocks.createSshTerminal.mockImplementation(async (...args: unknown[]) => {
      onOutput = args[9] as (data: Uint8Array) => void;
      return "terminal-session";
    });
    try {
    render(<TerminalPanel tabId="held-ssh" visible ssh={sshInfo} />);
    await waitFor(() => expect(onOutput).toBeTypeOf("function"));

    const term = terminalMocks.terminalCtor.mock.results[0].value;
    const prompt = "user@example.test:/srv/project$ ";
    term.buffer.active = {
      type: "normal",
      length: 1,
      baseY: 0,
      cursorY: 0,
      cursorX: prompt.length,
      getLine: vi.fn(() => ({
        isWrapped: false,
        translateToString: () => prompt,
      })),
    };
    term.write.mockImplementation((_data: Uint8Array, callback?: () => void) => callback?.());

    // Fake timers keep the injected line's own TTL from expiring behind the
    // test, so the hold/flush window is exactly the one under test.
    vi.useFakeTimers();
    try {
      await act(async () => {
        onOutput?.(new TextEncoder().encode(prompt));
        vi.advanceTimersByTime(120);
      });
      const integrationWrite = (ipcMocks.writeTerminal.mock.calls as unknown[][]).find(
        ([sessionId, encoded]) =>
          sessionId === "terminal-session" &&
          typeof encoded === "string" &&
          atob(encoded).includes("__taomni_osc7"),
      );
      expect(integrationWrite).toBeTruthy();
      ipcMocks.writeTerminal.mockClear();

      // The injected line has not reported back yet: the keystrokes must wait
      // instead of interleaving with it on the shared pty.
      act(() => terminalMocks.state.onDataHandler?.("ls\r"));
      expect((ipcMocks.writeTerminal.mock.calls as unknown[][]).some(([, encoded]) =>
        typeof encoded === "string" && atob(encoded) === "ls\r",
      )).toBe(false);

      // The injected command's own OSC 7 output proves it landed, so the held
      // keystrokes are delivered in order afterwards.
      await act(async () => {
        onOutput?.(new TextEncoder().encode(`\x1b]7;file://example.test/srv/project\x1b\\${CWD_INTEGRATION_DONE_MARKER}${prompt}`));
        vi.advanceTimersByTime(200);
      });
      expect((ipcMocks.writeTerminal.mock.calls as unknown[][]).some(([sessionId, encoded]) =>
        sessionId === "terminal-session" &&
        typeof encoded === "string" &&
        atob(encoded) === "ls\r",
      )).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    } finally {
      restoreLinux();
    }
  });
  it("releases SSH readiness when a Windows cwd probe never reports OSC 7", async () => {
    const originalPlatform = window.navigator.platform;
    Object.defineProperty(window.navigator, "platform", { configurable: true, value: "Win32" });
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    let onOutput: ((data: Uint8Array) => void) | undefined;
    ipcMocks.createSshTerminal.mockImplementation(async (...args: unknown[]) => {
      onOutput = args[9] as (data: Uint8Array) => void;
      return "terminal-session";
    });

    try {
      render(<TerminalPanel tabId="windows-ssh" visible ssh={sshInfo} />);
      await waitFor(() => expect(onOutput).toBeTypeOf("function"));

      const term = terminalMocks.terminalCtor.mock.results[0].value;
      const prompt = "user@host MINGW64 ~\n$ ";
      term.buffer.active = {
        type: "normal",
        length: 2,
        baseY: 0,
        cursorY: 1,
        cursorX: 2,
        getLine: vi.fn((row: number) => ({
          isWrapped: false,
          translateToString: () => prompt.split("\n")[row],
        })),
      };
      term.write.mockImplementation((_data: Uint8Array, callback?: () => void) => callback?.());
      const panel = screen.getByTestId("terminal-pane");

      vi.useFakeTimers();
      await act(async () => {
        onOutput?.(new TextEncoder().encode(prompt));
        vi.advanceTimersByTime(120);
      });
      const cwdProbe = (ipcMocks.writeTerminal.mock.calls as unknown[][])
        .map(([, encoded]) => typeof encoded === "string" ? atob(encoded) : "")
        .find((command) => command.includes("__taomni_cwd_sync_done"));
      expect(cwdProbe).toContain("__taomni_cwd_sync_done");
      expect(cwdProbe).not.toContain("__taomni_osc7");
      expect(panel).not.toHaveAttribute("data-terminal-ready");

      await act(async () => {
        vi.advanceTimersByTime(3_000);
      });
      expect(panel).not.toHaveAttribute("data-terminal-ready");

      await act(async () => {
        vi.advanceTimersByTime(1_500);
      });
      expect(panel).toHaveAttribute("data-terminal-ready", "true");
    } finally {
      vi.useRealTimers();
      Object.defineProperty(window.navigator, "platform", {
        configurable: true,
        value: originalPlatform,
      });
    }
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

  it("keeps a browser Windows SSH terminal ready without injecting startup integration", async () => {
    const originalPlatform = window.navigator.platform;
    Object.defineProperty(window.navigator, "platform", { configurable: true, value: "Win32" });
    let onOutput: ((data: Uint8Array) => void) | undefined;
    ipcMocks.createSshTerminal.mockImplementation(async (...args: unknown[]) => {
      onOutput = args[9] as (data: Uint8Array) => void;
      return "terminal-session";
    });

    try {
      render(<TerminalPanel tabId="browser-windows-ssh" visible ssh={sshInfo} />);
      await waitFor(() => expect(onOutput).toBeTypeOf("function"));

      const term = terminalMocks.terminalCtor.mock.results[0].value;
      const prompt = "user@host MINGW64 ~\n$ ";
      term.buffer.active = {
        type: "normal",
        length: 2,
        baseY: 0,
        cursorY: 1,
        cursorX: 2,
        getLine: vi.fn((row: number) => ({
          isWrapped: false,
          translateToString: () => prompt.split("\n")[row],
        })),
      };
      term.write.mockImplementation((_data: Uint8Array, callback?: () => void) => callback?.());
      const panel = screen.getByTestId("terminal-pane");

      vi.useFakeTimers();
      await act(async () => {
        onOutput?.(new TextEncoder().encode(prompt));
        vi.advanceTimersByTime(120);
      });

      expect(panel).toHaveAttribute("data-terminal-ready", "true");
      expect((ipcMocks.writeTerminal.mock.calls as unknown[][]).some(([, encoded]) =>
        typeof encoded === "string" && atob(encoded).includes("__taomni_osc7"),
      )).toBe(false);
    } finally {
      vi.useRealTimers();
      Object.defineProperty(window.navigator, "platform", {
        configurable: true,
        value: originalPlatform,
      });
    }
  });

  it("applies an initial cwd with a short browser Windows SSH probe", async () => {
    const originalPlatform = window.navigator.platform;
    Object.defineProperty(window.navigator, "platform", { configurable: true, value: "Win32" });
    let onOutput: ((data: Uint8Array) => void) | undefined;
    ipcMocks.createSshTerminal.mockImplementation(async (...args: unknown[]) => {
      onOutput = args[9] as (data: Uint8Array) => void;
      return "terminal-session";
    });

    try {
      render(
        <TerminalPanel
          tabId="browser-windows-ssh-initial-cwd"
          visible
          ssh={sshInfo}
          initialCwd="C:/qa-temp"
        />,
      );
      await waitFor(() => expect(onOutput).toBeTypeOf("function"));

      const term = terminalMocks.terminalCtor.mock.results[0].value;
      const prompt = "user@host MINGW64 ~\n$ ";
      term.buffer.active = {
        type: "normal",
        length: 2,
        baseY: 0,
        cursorY: 1,
        cursorX: 2,
        getLine: vi.fn((row: number) => ({
          isWrapped: false,
          translateToString: () => prompt.split("\n")[row],
        })),
      };
      term.write.mockImplementation((_data: Uint8Array, callback?: () => void) => callback?.());
      const panel = screen.getByTestId("terminal-pane");

      await act(async () => {
        onOutput?.(new TextEncoder().encode(prompt));
        await new Promise((resolve) => window.setTimeout(resolve, 150));
      });

      let probeWrite: unknown[] | undefined;
      await waitFor(() => {
        probeWrite = (ipcMocks.writeTerminal.mock.calls as unknown[][]).find(([, encoded]) =>
          typeof encoded === "string" && atob(encoded).includes("__taomni_cwd_sync_done"),
        );
        expect(probeWrite).toBeTruthy();
      });
      expect(probeWrite).toBeTruthy();
      expect(atob(probeWrite?.[1] as string)).toContain("cd 'C:/qa-temp'");
      expect(atob(probeWrite?.[1] as string)).not.toContain("__taomni_osc7");
      expect(panel).not.toHaveAttribute("data-terminal-ready");

      await act(async () => {
        onOutput?.(
          new TextEncoder().encode(`\x1b]7;file://example.test/C:/qa-temp\x1b\\${prompt}`),
        );
      });

      await waitFor(() => {
        expect(panel).toHaveAttribute("data-terminal-ready", "true");
      });
    } finally {
      Object.defineProperty(window.navigator, "platform", {
        configurable: true,
        value: originalPlatform,
      });
    }
  });

  it("does not load the WebGL renderer when disabled in the terminal profile", async () => {
    render(
      <TerminalPanel
        visible
        terminalProfile={{
          ...DEFAULT_TERMINAL_PROFILE,
          webglRenderer: false,
        }}
      />,
    );

    await waitFor(() => {
      expect(terminalMocks.terminalCtor).toHaveBeenCalled();
    });
    expect(webglMocks.ctor).not.toHaveBeenCalled();
  });

  it("falls back to the default renderer when the WebGL context is lost", async () => {
    render(<TerminalPanel visible terminalProfile={DEFAULT_TERMINAL_PROFILE} />);

    await waitFor(() => {
      expect(webglMocks.ctor).toHaveBeenCalledTimes(1);
    });

    const term = terminalMocks.terminalCtor.mock.results[0].value;
    const webgl = webglMocks.instances[0];
    webgl.contextLossHandler?.();

    expect(webgl.contextLossDispose).toHaveBeenCalledTimes(1);
    expect(webgl.dispose).toHaveBeenCalledTimes(1);
    expect(term.refresh).toHaveBeenCalledWith(0, 23);
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

  it("handles macOS Cmd+V through the active clipboard path without double-pasting", async () => {
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
      await waitFor(() => {
        expect(ipcMocks.writeTerminal).toHaveBeenCalledWith(
          "terminal-session",
          btoa("permission paste"),
        );
      });
      expect(readText).toHaveBeenCalledTimes(1);

      const screenEl = screen.getByTestId("terminal-pane").querySelector(".xterm-screen");
      expect(screenEl).toBeTruthy();
      const getData = vi.fn((type: string) => (type === "text/plain" ? "native paste" : ""));
      fireEvent.paste(screenEl as Element, {
        clipboardData: { getData },
      });

      await Promise.resolve();
      expect(ipcMocks.writeTerminal).toHaveBeenCalledTimes(1);
      expect(getData).not.toHaveBeenCalled();
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
}
