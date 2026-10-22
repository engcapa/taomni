import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { NATIVE_FILE_DROP_EVENT } from "../../../../lib/osFileDrop";
import { TerminalPanel } from "../../TerminalPanel";
import { clipboardMocks, ipcMocks, sshInfo, terminalMocks } from "./harness";

export function registerTerminalPanelClipboard5Cases() {

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

  it("prompts to upload copied file paths in an SSH shell and defaults to upload", async () => {
    clipboardMocks.readFiles.mockResolvedValue(["/home/me/a b.png"]);
    const onSessionReady = vi.fn();
    const onUploadLocalPaths = vi.fn(async () => undefined);

    render(
      <TerminalPanel
        visible
        ssh={sshInfo}
        onSessionReady={onSessionReady}
        onUploadLocalPaths={onUploadLocalPaths}
      />,
    );

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });
    terminalMocks.oscHandlers.get(7)?.("file://example.test/home/user/project");

    fireEvent.keyDown(window, { key: "Insert", shiftKey: true });

    // The dialog enters the document one commit before its autofocus effect moves
    // focus to the confirm button, so presence does not imply focus. Both facts are
    // asserted under the same gate rather than gating on the earlier one.
    await waitFor(() => {
      expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
      expect(screen.getByTestId("confirm-dialog-confirm")).toHaveFocus();
    });
    expect(screen.getByTestId("confirm-dialog-message")).toHaveTextContent("/home/user/project");

    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));

    await waitFor(() => {
      expect(onUploadLocalPaths).toHaveBeenCalledWith({
        paths: ["/home/me/a b.png"],
        cwd: "/home/user/project",
      });
    });
  });

  it("pastes copied file paths when the SSH upload prompt is declined", async () => {
    clipboardMocks.readFiles.mockResolvedValue(["/home/me/a b.png"]);
    const onSessionReady = vi.fn();
    const onUploadLocalPaths = vi.fn(async () => undefined);

    render(
      <TerminalPanel
        visible
        ssh={sshInfo}
        onSessionReady={onSessionReady}
        onUploadLocalPaths={onUploadLocalPaths}
      />,
    );

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });

    fireEvent.keyDown(window, { key: "Insert", shiftKey: true });
    await waitFor(() => {
      expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("confirm-dialog-cancel"));

    await waitFor(() => {
      expect(ipcMocks.writeTerminal).toHaveBeenCalledWith(
        "terminal-session",
        btoa("'/home/me/a b.png' "),
      );
    });
    expect(onUploadLocalPaths).not.toHaveBeenCalled();
  });

  it("prompts to upload when clipboard text contains a quoted local file path", async () => {
    const originalClipboard = window.navigator.clipboard;
    const readText = vi.fn(async () => "'/home/zhyhang/图片/2026-08-27_23-08.png'");
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { readText },
    });
    clipboardMocks.readFiles.mockResolvedValue([]);
    clipboardMocks.parseFilePaths.mockResolvedValue(["/home/zhyhang/图片/2026-08-27_23-08.png"]);

    const onSessionReady = vi.fn();
    const onUploadLocalPaths = vi.fn(async () => undefined);

    try {
      render(
        <TerminalPanel
          visible
          ssh={sshInfo}
          onSessionReady={onSessionReady}
          onUploadLocalPaths={onUploadLocalPaths}
        />,
      );

      await waitFor(() => {
        expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
      });
      terminalMocks.oscHandlers.get(7)?.("file://example.test/home/user/project");

      fireEvent.keyDown(window, { key: "Insert", shiftKey: true });

      await waitFor(() => {
        expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
      });
      expect(screen.getByTestId("confirm-dialog-message")).toHaveTextContent("/home/user/project");

      fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));

      await waitFor(() => {
        expect(onUploadLocalPaths).toHaveBeenCalledWith({
          paths: ["/home/zhyhang/图片/2026-08-27_23-08.png"],
          cwd: "/home/user/project",
        });
      });
    } finally {
      Object.defineProperty(window.navigator, "clipboard", {
        configurable: true,
        value: originalClipboard,
      });
    }
  });

  it("prompts to upload dragged file paths in an SSH shell", async () => {
    const onSessionReady = vi.fn();
    const onUploadLocalPaths = vi.fn(async () => undefined);

    render(
      <TerminalPanel
        visible
        ssh={sshInfo}
        onSessionReady={onSessionReady}
        onUploadLocalPaths={onUploadLocalPaths}
      />,
    );

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });
    terminalMocks.oscHandlers.get(7)?.("file://example.test/home/user/project");

    const dataTransfer = {
      types: ["Files", "text/uri-list"],
      files: [new File(["x"], "a b.png", { type: "image/png" })],
      dropEffect: "none",
      getData: (format: string) => (format === "text/uri-list" ? "file:///home/me/a%20b.png" : ""),
    };

    fireEvent.drop(screen.getByTestId("terminal-pane"), { dataTransfer });

    await waitFor(() => {
      expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));

    await waitFor(() => {
      expect(onUploadLocalPaths).toHaveBeenCalledWith({
        paths: ["/home/me/a b.png"],
        cwd: "/home/user/project",
      });
    });
  });

  it("prompts to upload dragged file paths even when the shell prompt is custom", async () => {
    const onSessionReady = vi.fn();
    const onUploadLocalPaths = vi.fn(async () => undefined);

    render(
      <TerminalPanel
        visible
        ssh={sshInfo}
        onSessionReady={onSessionReady}
        onUploadLocalPaths={onUploadLocalPaths}
      />,
    );

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });
    terminalMocks.oscHandlers.get(7)?.("file://example.test/home/user/project");

    const term = terminalMocks.terminalCtor.mock.results[terminalMocks.terminalCtor.mock.results.length - 1].value;
    const prompt = "[user@example.test project] λ ";
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

    const dataTransfer = {
      types: ["Files", "text/uri-list"],
      files: [new File(["x"], "a b.png", { type: "image/png" })],
      dropEffect: "none",
      getData: (format: string) => (format === "text/uri-list" ? "file:///home/me/a%20b.png" : ""),
    };

    fireEvent.drop(screen.getByTestId("terminal-pane"), { dataTransfer });

    await waitFor(() => {
      expect(screen.getByTestId("confirm-dialog")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId("confirm-dialog-confirm"));

    await waitFor(() => {
      expect(onUploadLocalPaths).toHaveBeenCalledWith({
        paths: ["/home/me/a b.png"],
        cwd: "/home/user/project",
      });
    });
  });

  it("pastes dragged file paths in an SSH alternate-screen app", async () => {
    const onSessionReady = vi.fn();
    const onUploadLocalPaths = vi.fn(async () => undefined);

    render(
      <TerminalPanel
        visible
        ssh={sshInfo}
        onSessionReady={onSessionReady}
        onUploadLocalPaths={onUploadLocalPaths}
      />,
    );

    await waitFor(() => {
      expect(onSessionReady).toHaveBeenCalledWith("terminal-session");
    });
    const term = terminalMocks.terminalCtor.mock.results[terminalMocks.terminalCtor.mock.results.length - 1].value;
    term.buffer.active.type = "alternate";

    const dataTransfer = {
      types: ["Files", "text/uri-list"],
      files: [new File(["x"], "a b.png", { type: "image/png" })],
      dropEffect: "none",
      getData: (format: string) => (format === "text/uri-list" ? "file:///home/me/a%20b.png" : ""),
    };

    fireEvent.drop(screen.getByTestId("terminal-pane"), { dataTransfer });

    await waitFor(() => {
      expect(ipcMocks.writeTerminal).toHaveBeenCalledWith(
        "terminal-session",
        btoa("'/home/me/a b.png' "),
      );
    });
    expect(screen.queryByTestId("confirm-dialog")).not.toBeInTheDocument();
    expect(onUploadLocalPaths).not.toHaveBeenCalled();
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
}
