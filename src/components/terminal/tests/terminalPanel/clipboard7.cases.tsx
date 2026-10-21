import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DEFAULT_TERMINAL_PROFILE } from "../../../../lib/terminalProfile";
import { TerminalPanel } from "../../TerminalPanel";
import { encodeOsc52Text, ipcMocks, sshInfo, terminalMocks } from "./harness";

export function registerTerminalPanelClipboard7Cases() {

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
      null,
      false,
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

  it("waits for an idle SSH shell before sending the saved startup command", async () => {
    render(
      <TerminalPanel
        visible
        ssh={{
          ...sshInfo,
          optionsJson: JSON.stringify({
            startupCmd: "  tmux new -A -s main  ",
          }),
        }}
      />,
    );

    await waitFor(() => {
      expect(ipcMocks.createSshTerminal).toHaveBeenCalled();
    });

    expect(ipcMocks.createSshTerminal).toHaveBeenCalledWith(
      "terminal-session",
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
      null,
      true,
    );

    const term = terminalMocks.terminalCtor.mock.results[0].value;
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 600));
    });
    expect(ipcMocks.writeTerminal).not.toHaveBeenCalled();

    const prompt = "user@host:~$ ";
    term.buffer.active = {
      type: "normal",
      length: 1,
      baseY: 0,
      cursorY: 0,
      cursorX: prompt.length,
      viewportY: 0,
      getLine: vi.fn(() => ({ isWrapped: false, translateToString: () => prompt })),
    };

    await waitFor(() => {
      expect(ipcMocks.writeTerminal).toHaveBeenCalledWith(
        "terminal-session",
        btoa("tmux new -A -s main\r"),
      );
    });
  });

  it("waits for the startup command to return before installing SSH cwd reporting", async () => {
    const originalPlatform = window.navigator.platform;
    Object.defineProperty(window.navigator, "platform", { configurable: true, value: "Win32" });
    vi.stubGlobal("__TAURI_INTERNALS__", {});
    const startupCommand = "printf 'qa-startup-marker\\n'";
    let onOutput: ((data: Uint8Array) => void) | undefined;
    const onSessionReady = vi.fn();
    ipcMocks.createSshTerminal.mockImplementation(async (...args: unknown[]) => {
      onOutput = args[9] as (data: Uint8Array) => void;
      return "terminal-session";
    });

    try {
      render(
        <TerminalPanel
          visible
          onSessionReady={onSessionReady}
          ssh={{ ...sshInfo, optionsJson: JSON.stringify({ startupCmd: startupCommand }) }}
        />,
      );
      await waitFor(() => {
        expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
        expect(onOutput).toBeTypeOf("function");
      });

      const term = terminalMocks.terminalCtor.mock.results[0].value;
      const promptRows = ["user@host MINGW64 ~", "$ "];
      const setBufferRows = (rows: string[]) => {
        term.buffer.active = {
          type: "normal",
          // Real xterm buffers include unused viewport rows below the prompt.
          length: Math.max(24, rows.length),
          baseY: 0,
          cursorY: rows.length - 1,
          cursorX: rows[rows.length - 1].length,
          viewportY: 0,
          getLine: vi.fn((row: number) => ({
            isWrapped: false,
            translateToString: () => rows[row] ?? "",
          })),
        };
      };
      term.write.mockImplementation((_data: Uint8Array, callback?: () => void) => callback?.());
      ipcMocks.writeTerminal.mockClear();
      setBufferRows(promptRows);
      await act(async () => {
        onOutput?.(new TextEncoder().encode("user@host MINGW64 ~\r\n$ "));
      });

      await waitFor(() => {
        expect(ipcMocks.writeTerminal).toHaveBeenCalledTimes(1);
      });
      const firstWrite = (ipcMocks.writeTerminal.mock.calls as unknown[][])[0];
      expect(atob(firstWrite[1] as string)).toBe(`${startupCommand}\r`);
      await act(async () => {
        await new Promise((resolve) => window.setTimeout(resolve, 650));
      });
      expect(ipcMocks.writeTerminal).toHaveBeenCalledTimes(1);

      vi.useFakeTimers();
      setBufferRows([
        promptRows[0],
        "$ printf 'qa-startup-marker\\n'",
        "qa-startup-marker",
        ...promptRows,
      ]);
      await act(async () => {
        onOutput?.(new TextEncoder().encode("qa-startup-marker\r\nuser@host MINGW64 ~\r\n$ "));
      });

      const writes = (ipcMocks.writeTerminal.mock.calls as unknown[][]).map(([, encoded]) =>
        typeof encoded === "string" ? atob(encoded) : "",
      );
      expect(writes[0]).toBe(`${startupCommand}\r`);
      expect(writes[1]).toContain("__taomni_cwd_sync_done");
      expect(writes[1]).not.toContain("PROMPT_COMMAND");
      expect(screen.getByTestId("terminal-pane")).not.toHaveAttribute("data-terminal-ready");
    } finally {
      vi.useRealTimers();
      Object.defineProperty(window.navigator, "platform", {
        configurable: true,
        value: originalPlatform,
      });
    }
  });

  it("uses the latest measured terminal size when reconnecting SSH", async () => {
    ipcMocks.createTerminalSessionId
      .mockReturnValueOnce("terminal-session")
      .mockReturnValueOnce("terminal-session-reconnect");
    const clientWidth = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(960);
    const clientHeight = vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockReturnValue(480);
    const onSessionReady = vi.fn();

    try {
      render(<TerminalPanel visible ssh={sshInfo} onSessionReady={onSessionReady} />);

      await waitFor(() => {
        expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
      });

      const term = terminalMocks.terminalCtor.mock.results[0].value;
      term.cols = 132;
      term.rows = 37;
      ipcMocks.terminalExitHandlers.get("terminal-session")?.();

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
        132,
        37,
        expect.any(String),
        expect.any(Function),
        true,
        true,
        null,
        false,
      );
      await waitFor(() => {
        expect(ipcMocks.resizeTerminal).toHaveBeenCalledWith("terminal-session-reconnect", 132, 37);
      });
    } finally {
      clientWidth.mockRestore();
      clientHeight.mockRestore();
    }
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

  it("sends macOS Option printable characters directly to the terminal", async () => {
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

      fireEvent.keyDown(window, { key: "@", code: "Digit2", altKey: true });

      await waitFor(() => {
        expect(ipcMocks.writeTerminal).toHaveBeenCalledWith("terminal-session", btoa("@"));
      });
    } finally {
      Object.defineProperty(window.navigator, "platform", {
        configurable: true,
        value: originalPlatform,
      });
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

  it("puts terminal zoom actions at the top level and keeps font settings in appearance", async () => {
    const onProfileChange = vi.fn();
    render(
      <TerminalPanel
        visible
        terminalProfile={{ ...DEFAULT_TERMINAL_PROFILE, fontSize: 14 }}
        onTerminalProfileChange={onProfileChange}
      />,
    );

    await waitFor(() => {
      expect(terminalMocks.terminalCtor).toHaveBeenCalled();
    });

    fireEvent.contextMenu(screen.getByTestId("terminal-pane"));

    expect(await screen.findByText("Zoom in")).toBeInTheDocument();
    expect(screen.getByText("Zoom out")).toBeInTheDocument();
    expect(screen.getByText("Reset zoom")).toBeInTheDocument();
    expect(screen.queryByTestId("context-menu-item-font-size")).not.toBeInTheDocument();
    expect(screen.queryByTestId("context-menu-item-font-settings")).not.toBeInTheDocument();
    expect(screen.queryByText(/^Use font/)).not.toBeInTheDocument();
    expect(screen.queryByText("More fonts...")).not.toBeInTheDocument();
    expect(screen.queryByText("Display font ligatures")).not.toBeInTheDocument();

    fireEvent.click(screen.getByText("Zoom in"));

    expect(onProfileChange).toHaveBeenLastCalledWith(expect.objectContaining({
      fontSize: 15,
      theme: DEFAULT_TERMINAL_PROFILE.theme,
    }));
  });

  it("emits a complete terminal profile when a context menu theme is selected", async () => {
    const onProfileChange = vi.fn();
    render(
      <TerminalPanel
        visible
        terminalProfile={{ ...DEFAULT_TERMINAL_PROFILE, theme: "classic", fontSize: 16 }}
        onTerminalProfileChange={onProfileChange}
      />,
    );

    await waitFor(() => {
      expect(terminalMocks.terminalCtor).toHaveBeenCalled();
    });

    fireEvent.contextMenu(screen.getByTestId("terminal-pane"));
    fireEvent.mouseEnter(await screen.findByTestId("context-menu-item-appearance"));
    fireEvent.click(await screen.findByText("Termius Dark"));

    expect(onProfileChange).toHaveBeenLastCalledWith(expect.objectContaining({
      fontSize: 16,
      theme: "termius-dark",
      fontFamily: DEFAULT_TERMINAL_PROFILE.fontFamily,
    }));
  });

  it("keeps the open terminal appearance menu in sync while changing theme and font size", async () => {
    const onProfileChange = vi.fn();
    render(
      <TerminalPanel
        visible
        terminalProfile={{ ...DEFAULT_TERMINAL_PROFILE, theme: "classic", fontSize: 14 }}
        onTerminalProfileChange={onProfileChange}
      />,
    );

    await waitFor(() => {
      expect(terminalMocks.terminalCtor).toHaveBeenCalled();
    });

    fireEvent.contextMenu(screen.getByTestId("terminal-pane"));
    fireEvent.mouseEnter(await screen.findByTestId("context-menu-item-appearance"));

    const kanagawa = await screen.findByTestId("terminal-context-theme-option-kanagawa-wave");
    fireEvent.click(kanagawa);

    expect(kanagawa).toHaveAttribute("aria-selected", "true");

    const sizeInput = screen.getByTestId("terminal-context-font-size");
    const increase = screen.getByLabelText("Increase terminal font size");
    fireEvent.click(increase);
    expect(sizeInput).toHaveValue("15");
    fireEvent.click(increase);
    expect(sizeInput).toHaveValue("16");

    expect(onProfileChange).toHaveBeenLastCalledWith(expect.objectContaining({
      theme: "kanagawa-wave",
      fontSize: 16,
    }));
  });
}
