import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_TERMINAL_PROFILE, SYSTEM_TERMINAL_THEME } from "../../../../lib/terminalProfile";
import { TerminalPanel } from "../../TerminalPanel";
import { ipcMocks, terminalMocks } from "./harness";

export function registerTerminalPanelClipboard8Cases() {

  it("offers code view themes in the terminal appearance context menu", async () => {
    const onProfileChange = vi.fn();
    render(
      <TerminalPanel
        visible
        terminalProfile={{ ...DEFAULT_TERMINAL_PROFILE, theme: "classic" }}
        onTerminalProfileChange={onProfileChange}
      />,
    );

    await waitFor(() => {
      expect(terminalMocks.terminalCtor).toHaveBeenCalled();
    });

    fireEvent.contextMenu(screen.getByTestId("terminal-pane"));
    fireEvent.mouseEnter(await screen.findByTestId("context-menu-item-appearance"));
    fireEvent.click(await screen.findByTestId("terminal-context-theme-option-dracula"));

    expect(onProfileChange).toHaveBeenLastCalledWith(expect.objectContaining({ theme: "dracula" }));
  });

  it("does not render the Git rail button inside the terminal pane", async () => {
    const onOpen = vi.fn();
    const onSessionReady = vi.fn();

    render(
      <TerminalPanel
        visible
        onSessionReady={onSessionReady}
        gitToggle={{ cwd: "/repo", onOpen }}
      />,
    );

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    expect(screen.queryByTestId("terminal-git-toggle")).not.toBeInTheDocument();
    expect(onOpen).not.toHaveBeenCalled();
  });

  it("adds a Git action to the local terminal context menu", async () => {
    const onOpen = vi.fn();
    const onSessionReady = vi.fn();

    render(
      <TerminalPanel
        visible
        onSessionReady={onSessionReady}
        gitToggle={{ cwd: "/repo", onOpen }}
      />,
    );

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    fireEvent.contextMenu(screen.getByTestId("terminal-pane"));
    fireEvent.click(await screen.findByText("Open Git Panel"));

    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it("saves the current theme as the default for new terminals", async () => {
    const onSessionReady = vi.fn();

    render(
      <TerminalPanel
        visible
        onSessionReady={onSessionReady}
        terminalProfile={{
          ...DEFAULT_TERMINAL_PROFILE,
          theme: "kanagawa-wave",
        }}
      />,
    );

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    fireEvent.contextMenu(screen.getByTestId("terminal-pane"));
    fireEvent.click(await screen.findByTestId("terminal-context-set-local-default-theme"));

    const stored = JSON.parse(window.localStorage.getItem("taomni.terminalDefaultProfile.v1") ?? "{}");
    expect(stored.theme).toBe("kanagawa-wave");
  });

  it("saves appearance changes made in the open context menu as the terminal default", async () => {
    const onSessionReady = vi.fn();

    render(
      <TerminalPanel
        visible
        onSessionReady={onSessionReady}
        terminalProfile={{
          ...DEFAULT_TERMINAL_PROFILE,
          theme: "classic",
          fontSize: 14,
        }}
      />,
    );

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    fireEvent.contextMenu(screen.getByTestId("terminal-pane"));
    fireEvent.mouseEnter(await screen.findByTestId("context-menu-item-appearance"));
    fireEvent.click(await screen.findByTestId("terminal-context-theme-option-kanagawa-wave"));
    fireEvent.click(screen.getByLabelText("Increase terminal font size"));
    fireEvent.click(await screen.findByTestId("terminal-context-set-local-default-theme"));

    const stored = JSON.parse(window.localStorage.getItem("taomni.terminalDefaultProfile.v1") ?? "{}");
    expect(stored.theme).toBe("kanagawa-wave");
    expect(stored.fontSize).toBe(15);
  });

  it("does not auto-save terminal appearance changes for future terminals", async () => {
    window.localStorage.clear();
    const onSessionReady = vi.fn();

    render(
      <TerminalPanel
        visible
        onSessionReady={onSessionReady}
        terminalProfile={{
          ...DEFAULT_TERMINAL_PROFILE,
          theme: "classic",
          fontSize: 14,
        }}
      />,
    );

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    fireEvent.contextMenu(screen.getByTestId("terminal-pane"));
    fireEvent.mouseEnter(await screen.findByTestId("context-menu-item-appearance"));
    fireEvent.click(await screen.findByTestId("terminal-context-theme-option-kanagawa-wave"));

    fireEvent.change(screen.getByTestId("terminal-context-font-size"), { target: { value: "18" } });

    expect(window.localStorage.getItem("taomni.terminalDefaultProfile.v1")).toBeNull();
  });

  it("keeps follow-system as a savable terminal default theme", async () => {
    const onSessionReady = vi.fn();

    render(
      <TerminalPanel
        visible
        onSessionReady={onSessionReady}
        terminalProfile={{
          ...DEFAULT_TERMINAL_PROFILE,
          theme: SYSTEM_TERMINAL_THEME,
        }}
      />,
    );

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    fireEvent.contextMenu(screen.getByTestId("terminal-pane"));
    fireEvent.click(await screen.findByTestId("terminal-context-set-local-default-theme"));

    const stored = JSON.parse(window.localStorage.getItem("taomni.terminalDefaultProfile.v1") ?? "{}");
    expect(stored.theme).toBe(SYSTEM_TERMINAL_THEME);
  });

  it("saves all current terminal settings as the terminal default after confirmation", async () => {
    const onSessionReady = vi.fn();

    render(
      <TerminalPanel
        visible
        onSessionReady={onSessionReady}
        terminalProfile={{
          ...DEFAULT_TERMINAL_PROFILE,
          theme: "dracula",
          readOnly: true,
          showScrollbar: false,
          copyOnSelect: true,
          scrollback: 4321,
        }}
      />,
    );

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    fireEvent.contextMenu(screen.getByTestId("terminal-pane"));
    fireEvent.click(await screen.findByTestId("terminal-context-set-local-default-profile"));
    fireEvent.click(await screen.findByRole("button", { name: "Save defaults" }));

    await waitFor(() => {
      const stored = JSON.parse(window.localStorage.getItem("taomni.terminalDefaultProfile.v1") ?? "{}");
      expect(stored).toMatchObject({
        theme: "dracula",
        readOnly: true,
        showScrollbar: false,
        copyOnSelect: true,
        scrollback: 4321,
      });
    });
  });

  it("opens the current terminal settings dialog and applies behavior changes", async () => {
    const onProfileChange = vi.fn();

    render(
      <TerminalPanel
        visible
        terminalProfile={{
          ...DEFAULT_TERMINAL_PROFILE,
          readOnly: false,
          scrollback: 10000,
        }}
        onTerminalProfileChange={onProfileChange}
      />,
    );

    await waitFor(() => {
      expect(terminalMocks.terminalCtor).toHaveBeenCalled();
    });

    fireEvent.contextMenu(screen.getByTestId("terminal-pane"));
    fireEvent.click(await screen.findByTestId("terminal-context-change-settings"));

    expect(await screen.findByTestId("terminal-current-settings-dialog")).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText("Read-only terminal"));
    expect(onProfileChange).toHaveBeenLastCalledWith(expect.objectContaining({ readOnly: true }));

    fireEvent.change(screen.getByLabelText("Scrollback lines"), { target: { value: "2222" } });
    expect(onProfileChange).toHaveBeenLastCalledWith(expect.objectContaining({
      readOnly: true,
      scrollback: 2222,
    }));
  });

  it("opens Git from the terminal shortcut", async () => {
    const onOpen = vi.fn();
    const onSessionReady = vi.fn();

    render(
      <TerminalPanel
        visible
        onSessionReady={onSessionReady}
        gitToggle={{ cwd: "/repo", onOpen }}
      />,
    );

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
      expect(terminalMocks.state.customKeyEventHandler).toBeTruthy();
    });

    const handled = terminalMocks.state.customKeyEventHandler?.(
      new KeyboardEvent("keydown", { key: "g", ctrlKey: true, shiftKey: true }),
    );

    expect(handled).toBe(false);
    expect(onOpen).toHaveBeenCalledTimes(1);
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

  describe("focus & editable target guard for shortcuts", () => {
    it("does not hijack macOS Cmd+V when focus is inside an editable input (e.g. SFTP address bar)", async () => {
      const originalPlatform = window.navigator.platform;
      const originalClipboard = window.navigator.clipboard;
      const readText = vi.fn(async () => "https://example.com/pasted");
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
        render(
          <div>
            <TerminalPanel visible onSessionReady={onSessionReady} />
            <input data-testid="sftp-address-input" defaultValue="/initial/path" />
          </div>,
        );

        await waitFor(() => {
          expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
        });

        const input = screen.getByTestId("sftp-address-input");
        input.focus();
        expect(document.activeElement).toBe(input);

        // Fire Cmd+V while focused on the input
        fireEvent.keyDown(input, { key: "v", metaKey: true });

        // Ensure writeTerminal was NOT called on the terminal session
        expect(ipcMocks.writeTerminal).not.toHaveBeenCalled();
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

    it("does not hijack Linux/Windows Ctrl+Shift+V or Shift+Insert when focus is inside an editable input", async () => {
      const onSessionReady = vi.fn();
      const readText = vi.fn(async () => "/pasted/linux/path");
      const originalClipboard = window.navigator.clipboard;
      Object.defineProperty(window.navigator, "clipboard", {
        configurable: true,
        value: { readText },
      });

      try {
        render(
          <div>
            <TerminalPanel visible onSessionReady={onSessionReady} />
            <input data-testid="sftp-local-input" defaultValue="/initial/local" />
          </div>,
        );

        await waitFor(() => {
          expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
        });

        const input = screen.getByTestId("sftp-local-input");
        input.focus();
        expect(document.activeElement).toBe(input);

        // Fire Ctrl+Shift+V on Linux/Win
        fireEvent.keyDown(input, { key: "v", ctrlKey: true, shiftKey: true });
        expect(ipcMocks.writeTerminal).not.toHaveBeenCalled();

        // Fire Shift+Insert
        fireEvent.keyDown(input, { key: "Insert", shiftKey: true });
        expect(ipcMocks.writeTerminal).not.toHaveBeenCalled();
      } finally {
        Object.defineProperty(window.navigator, "clipboard", {
          configurable: true,
          value: originalClipboard,
        });
      }
    });

    it("does not hijack shortcuts when focus is inside an external panel button/list (e.g. SFTP sidebar)", async () => {
      const onSessionReady = vi.fn();
      render(
        <div>
          <TerminalPanel visible onSessionReady={onSessionReady} />
          <div data-testid="sftp-sidebar-mock">
            <button data-testid="sftp-refresh-btn">Refresh</button>
          </div>
        </div>,
      );

      await waitFor(() => {
        expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
      });

      const btn = screen.getByTestId("sftp-refresh-btn");
      btn.focus();
      expect(document.activeElement).toBe(btn);

      // Fire Shift+Insert or Ctrl+Shift+V while button is focused
      fireEvent.keyDown(btn, { key: "Insert", shiftKey: true });
      fireEvent.keyDown(btn, { key: "v", ctrlKey: true, shiftKey: true });
      expect(ipcMocks.writeTerminal).not.toHaveBeenCalled();
    });
  });
}
