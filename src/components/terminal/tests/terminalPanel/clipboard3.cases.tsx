import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { expect, it, vi } from "vitest";
import { getTerminal } from "../../../../lib/terminal/terminalRegistry";
import { TabActionSlotProvider } from "../../../tabbar/TabActionSlot";
import { TerminalPanel } from "../../TerminalPanel";
import { ipcMocks, sockscapMocks, sshInfo, terminalMocks } from "./harness";

export function registerTerminalPanelClipboard3Cases() {

  it("focuses the terminal after mounting an active tab", async () => {
    render(<TerminalPanel visible />);

    await waitFor(() => {
      expect(terminalMocks.focus).toHaveBeenCalledTimes(1);
    });
  });

  it("re-applies the workspace SDK environment for tasks after shell startup", async () => {
    ipcMocks.createLocalTerminal.mockImplementation(async (sessionId: string) => ({
      sessionId,
      shellId: "powershell",
      taskEnvironment: {
        JAVA_HOME: "C:\\Program Files\\Java\\jdk-21",
        PATH: "C:\\Program Files\\Java\\jdk-21\\bin;C:\\Windows\\System32",
      },
    }));
    render(
      <TerminalPanel
        tabId="sdk-task"
        visible
        workspaceRoot="C:\\repo"
        localShell={{ id: "powershell", name: "PowerShell" }}
      />,
    );

    await waitFor(() => expect(getTerminal("sdk-task")?.runTask).toBeTypeOf("function"));
    ipcMocks.writeTerminal.mockClear();
    act(() => {
      getTerminal("sdk-task")?.runTask?.("mvn.cmd test", {
        MAVEN_OPTS: { value: "--add-opens=java.base/java.lang=ALL-UNNAMED", mode: "append" },
      });
    });

    const encoded = (ipcMocks.writeTerminal.mock.calls as unknown[][])[0]?.[1] as string;
    const command = atob(encoded);
    expect(command).toContain("$env:JAVA_HOME='C:\\Program Files\\Java\\jdk-21'");
    expect(command).toContain("$env:PATH='C:\\Program Files\\Java\\jdk-21\\bin;C:\\Windows\\System32'");
    expect(command).toContain("$env:MAVEN_OPTS=if ([string]::IsNullOrWhiteSpace");
  });

  it("lets explicit task variables override workspace SDK defaults", async () => {
    ipcMocks.createLocalTerminal.mockImplementation(async (sessionId: string) => ({
      sessionId,
      shellId: "powershell",
      taskEnvironment: { JAVA_HOME: "C:\\sdk\\jdk-21" },
    }));
    render(
      <TerminalPanel
        tabId="sdk-task-override"
        visible
        workspaceRoot="C:\\repo"
        localShell={{ id: "powershell", name: "PowerShell" }}
      />,
    );

    await waitFor(() => expect(getTerminal("sdk-task-override")?.runTask).toBeTypeOf("function"));
    ipcMocks.writeTerminal.mockClear();
    act(() => {
      getTerminal("sdk-task-override")?.runTask?.("java -version", {
        JAVA_HOME: { value: "C:\\task\\jdk-17", mode: "replace" },
      });
    });

    const encoded = (ipcMocks.writeTerminal.mock.calls as unknown[][])[0]?.[1] as string;
    const command = atob(encoded);
    expect(command).toContain("$env:JAVA_HOME='C:\\task\\jdk-17'");
    expect(command).not.toContain("C:\\sdk\\jdk-21");
  });

  it("keeps idle-prompt readiness independent of terminal text observation", async () => {
    render(<TerminalPanel visible />);

    const term = terminalMocks.terminalCtor.mock.results[0].value;
    const lines = ["qa-output", "runner$ "].map((text) => ({
      isWrapped: false,
      translateToString: vi.fn(() => text),
    }));
    term.buffer.active = {
      type: "normal",
      length: 2,
      baseY: 0,
      cursorY: 1,
      cursorX: 8,
      viewportY: 0,
      getLine: vi.fn((index: number) => lines[index]),
    };

    act(() => terminalMocks.state.onRenderHandler?.());

    await waitFor(() => {
      expect(screen.getByTestId("terminal-pane")).toHaveAttribute("data-terminal-ready", "true");
    });
    term.buffer.active.cursorX = 12;
    lines[1].translateToString.mockReturnValue("runner$ echo");
    act(() => terminalMocks.state.onRenderHandler?.());
    expect(screen.getByTestId("terminal-pane")).not.toHaveAttribute("data-terminal-ready");
    term.buffer.active.type = "alternate";
    lines[1].translateToString.mockReturnValue("runner$ ");
    act(() => terminalMocks.state.onRenderHandler?.());
    expect(screen.getByTestId("terminal-pane")).not.toHaveAttribute("data-terminal-ready");
  });

  it.skipIf(__TAOMNI_TERMINAL_TEXT_MIRROR__)(
    "does not scan history on production render, output completion or polling, even while hidden",
    async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const { rerender, unmount } = render(<TerminalPanel tabId="no-mirror" visible />);
      // Flush connect/registry React updates explicitly: waitFor itself uses an
      // interval, which is intentionally controlled by this polling test.
      await act(async () => { });
      expect(getTerminal("no-mirror")).not.toBeNull();
      const term = terminalMocks.terminalCtor.mock.results[0].value;
      const getLine = vi.fn((index: number) => ({
        isWrapped: false,
        translateToString: () => index === 9999 ? "runner$ " : `history-${index}`,
      }));
      term.buffer.active = {
        type: "normal", length: 10000, baseY: 9999, cursorY: 0,
        cursorX: 8, viewportY: 9999, getLine,
      };
      const output = ipcMocks.createLocalTerminal.mock.calls[0][6]!;
      const bytes = new TextEncoder().encode("new-output\r\nrunner$ ");
      term.write.mockImplementation((_data: unknown, done?: () => void) => done?.());
      try {
        act(() => terminalMocks.state.onRenderHandler?.());
        expect(getLine.mock.calls.some(([row]) => row < 9999)).toBe(false);
        act(() => output(bytes));
        const outputWrite = (term.write.mock.calls as unknown[][]).at(-1)!;
        expect(new TextDecoder().decode(outputWrite[0] as Uint8Array)).toBe("new-output\r\nrunner$ ");
        expect(outputWrite[1]).toBeTypeOf("function");
        expect(getLine.mock.calls.some(([row]) => row < 9999)).toBe(false);
        getLine.mockClear();
        act(() => vi.advanceTimersByTime(500));
        expect(getLine).toHaveBeenCalled();
        expect(getLine.mock.calls.every(([row]) => row === 9999)).toBe(true);
        expect(screen.getByTestId("terminal-pane")).toHaveAttribute("data-terminal-ready", "true");
        act(() => terminalMocks.state.onDataHandler?.("echo input\r"));
        expect(ipcMocks.writeTerminal).toHaveBeenCalledWith("terminal-session", btoa("echo input\r"));
        rerender(<TerminalPanel tabId="no-mirror" visible={false} />);
        act(() => vi.advanceTimersByTime(500));
        expect(getLine.mock.calls.length).toBeGreaterThan(0); // Prompt reads remain legal.
        expect(getLine.mock.calls.every(([row]) => row === 9999)).toBe(true);
        expect(screen.getByTestId("terminal-pane")).not.toHaveAttribute("data-terminal-text");
        unmount();
        getLine.mockClear();
        act(() => vi.advanceTimersByTime(1500));
        expect(getLine).not.toHaveBeenCalled();
        expect(term.onRender.mock.results[0].value.dispose).toHaveBeenCalledOnce();
        expect(term.dispose).toHaveBeenCalledOnce();
        expect(getTerminal("no-mirror")).toBeNull();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it.skipIf(!__TAOMNI_TERMINAL_TEXT_MIRROR__)(
    "mirrors complete QA text including soft wraps, Unicode, empty rows and failure messages",
    async () => {
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      render(<TerminalPanel visible />);
      await act(async () => { });
      expect(ipcMocks.createLocalTerminal).toHaveBeenCalledOnce();
      expect(screen.getByTestId("terminal-pane")).toHaveAttribute("data-terminal-text", "");
      const term = terminalMocks.terminalCtor.mock.results[0].value;
      let rows = [
        { text: "qa-output 中文🙂", wrapped: false },
        { text: "续行", wrapped: true },
        { text: "", wrapped: false },
        { text: "runner$ ", wrapped: false },
        { text: "", wrapped: false },
        { text: "", wrapped: false },
      ];
      term.buffer.active = {
        type: "normal", length: rows.length, baseY: 0, cursorY: 3, cursorX: 8,
        viewportY: 0,
        getLine: vi.fn((index: number) => rows[index] && ({
          isWrapped: rows[index].wrapped,
          translateToString: () => rows[index].text,
        })),
      };
      const panel = screen.getByTestId("terminal-pane");
      act(() => terminalMocks.state.onRenderHandler?.());
      expect(panel).toHaveAttribute("data-terminal-text", "qa-output 中文🙂续行\n\nrunner$ ");
      rows = Array.from({ length: 620 }, (_, i) => ({ text: `完整历史-${i}`, wrapped: false }));
      term.buffer.active.length = rows.length;
      act(() => vi.advanceTimersByTime(500));
      expect(panel).toHaveAttribute("data-terminal-text", rows.map((row) => row.text).join("\n"));
      rows = [{ text: "SSH disconnected", wrapped: false }, { text: "Press Enter to retry", wrapped: false }];
      term.buffer.active.length = rows.length;
      term.write.mockImplementation((_data: unknown, done?: () => void) => done?.());
      act(() => ipcMocks.createLocalTerminal.mock.calls[0][6]?.(new TextEncoder().encode("failure")));
      expect(panel).toHaveAttribute("data-terminal-text", "SSH disconnected\nPress Enter to retry");
      try {
        rows = [];
        term.buffer.active.length = 0;
        act(() => vi.advanceTimersByTime(500));
        expect(panel).toHaveAttribute("data-terminal-text", "");
        expect(panel).not.toHaveAttribute("data-terminal-ready");
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("preserves on-demand full history, copy/export, AI tail and disconnect snapshots in either mode", async () => {
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { ...window.navigator, clipboard: { writeText } });
    const OriginalBlob = globalThis.Blob;
    const blob = vi.spyOn(globalThis, "Blob").mockImplementation(function(parts, options) {
      return new OriginalBlob(parts, options);
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => { });
    const createObjectURL = vi.fn(() => "blob:terminal-export");
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL = createObjectURL;
      static revokeObjectURL = vi.fn();
    });
    const onDetachedStateChange = vi.fn();
    try {
      const { unmount } = render(
        <TerminalPanel tabId="full-history" visible onDetachedStateChange={onDetachedStateChange} />,
      );
      await waitFor(() => expect(getTerminal("full-history")).not.toBeNull());
      const term = terminalMocks.terminalCtor.mock.results[0].value;
      const rows = [
        "FIRST-中文🙂", "wrapped-", "continuation", "",
        ...Array.from({ length: 600 }, (_, index) => `generated-${index}`),
        "LAST-标记", "runner$ ", "", "",
      ];
      term.buffer.active = {
        type: "normal", length: rows.length, baseY: rows.length - 3,
        cursorY: 0, cursorX: 8, viewportY: 0,
        getLine: vi.fn((index: number) => ({
          isWrapped: index === 2,
          translateToString: () => rows[index],
        })),
      };
      const fullText = ["FIRST-中文🙂", "wrapped-continuation", "", ...rows.slice(4, -2)].join("\n");
      const entry = getTerminal("full-history")!;
      expect(entry.getBufferText()).toBe(fullText);
      expect(entry.getLastLines(4)).toBe("LAST-标记\nrunner$ ");
      fireEvent.contextMenu(screen.getByTestId("terminal-pane"));
      fireEvent.click(await screen.findByText("Copy All"));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(fullText));
      fireEvent.contextMenu(screen.getByTestId("terminal-pane"));
      fireEvent.click(await screen.findByText("Save to file"));
      expect(blob).toHaveBeenCalledWith([fullText], { type: "text/plain" });
      expect(click).toHaveBeenCalledOnce();
      expect(createObjectURL).toHaveBeenCalledOnce();
      act(() => terminalMocks.state.customKeyEventHandler?.(new KeyboardEvent("keydown", {
        key: "s", ctrlKey: true, shiftKey: true, bubbles: true,
      })));
      expect(blob).toHaveBeenLastCalledWith([fullText], { type: "text/plain" });
      expect(click).toHaveBeenCalledTimes(2);
      act(() => ipcMocks.terminalExitHandlers.get("terminal-session")?.());
      expect(onDetachedStateChange).toHaveBeenCalledWith({ snapshotText: fullText });
      unmount();
      expect(getTerminal("full-history")).toBeNull();
    } finally {
      blob.mockRestore();
      click.mockRestore();
    }
  });

  it("hands full history and the original session back from a detached panel in either mode", async () => {
    const onReattach = vi.fn();
    const slot = document.createElement("div");
    document.body.appendChild(slot);
    const { unmount } = render(
      <TabActionSlotProvider slot={slot}>
        <TerminalPanel tabId="reattach-history" visible detachedWindowControls={{
          onReattach, onToggleOsFullscreen: vi.fn(), osFullscreen: false,
        }} />
      </TabActionSlotProvider>,
    );
    await waitFor(() => expect(getTerminal("reattach-history")).not.toBeNull());
    const term = terminalMocks.terminalCtor.mock.results[0].value;
    const rows = ["FIRST", ...Array.from({ length: 600 }, (_, i) => `row-${i}`), "LAST🙂"];
    term.buffer.active.length = rows.length;
    term.buffer.active.getLine.mockImplementation((i: number) => ({
      isWrapped: false, translateToString: () => rows[i],
    }));
    fireEvent.click(screen.getByTestId("detached-reattach"));
    expect(onReattach).toHaveBeenCalledWith({
      terminalSessionId: "terminal-session", snapshotText: rows.join("\n"),
    });
    ipcMocks.closeTerminal.mockClear();
    unmount();
    expect(ipcMocks.closeTerminal).not.toHaveBeenCalled();
    expect(getTerminal("reattach-history")).toBeNull();
    slot.remove();
  });

  it("connects SSH only once when StrictMode replays mount effects", async () => {
    const onSessionReady = vi.fn();
    render(
      <StrictMode>
        <TerminalPanel visible ssh={sshInfo} onSessionReady={onSessionReady} />
      </StrictMode>,
    );

    await waitFor(() => expect(onSessionReady).toHaveBeenCalledTimes(1));
    expect(ipcMocks.createSshTerminal).toHaveBeenCalledTimes(1);
    expect(ipcMocks.closeTerminal).not.toHaveBeenCalled();
  });

  it.each(["initial", "reconnect"])(
    "renders the %s SSH notice before output delivered during connection",
    async (mode) => {
      let finishConnect: ((sessionId: string) => void) | undefined;
      let onOutput: ((data: Uint8Array) => void) | undefined;
      ipcMocks.createSshTerminal.mockImplementation((...args: unknown[]) => {
        onOutput = args[9] as (data: Uint8Array) => void;
        return new Promise<string>((resolve) => { finishConnect = resolve; });
      });
      const onSessionReady = vi.fn();
      render(<TerminalPanel visible ssh={sshInfo} onSessionReady={onSessionReady} />);
      await waitFor(() => expect(finishConnect).toBeTypeOf("function"));
      const term = terminalMocks.terminalCtor.mock.results[0].value;

      if (mode === "reconnect") {
        await act(async () => finishConnect?.("terminal-session"));
        await waitFor(() => expect(ipcMocks.terminalExitHandlers.has("terminal-session")).toBe(true));
        act(() => ipcMocks.terminalExitHandlers.get("terminal-session")?.());
        act(() => terminalMocks.state.onDataHandler?.("\r"));
        await waitFor(() => expect(ipcMocks.createSshTerminal).toHaveBeenCalledTimes(2));
      }

      term.write.mockClear();
      const remoteOutput = new TextEncoder().encode("Welcome to OpenSSH Server\r\nrunner$ ");
      act(() => onOutput?.(remoteOutput));
      await act(async () => finishConnect?.(mode === "initial" ? "terminal-session" : "terminal-session-reconnect"));

      const writes = (term.write.mock.calls as unknown[][]).map(([data]) =>
        typeof data === "string" ? data : new TextDecoder().decode(data as Uint8Array),
      );
      const noticeIndex = writes.findIndex((text) => text.includes(
        mode === "initial" ? "Taomni SSH terminal" : "Reconnected to",
      ));
      const remoteIndex = writes.findIndex((text) => text.includes("Welcome to OpenSSH Server"));
      expect(noticeIndex).toBeGreaterThanOrEqual(0);
      expect(remoteIndex).toBeGreaterThan(noticeIndex);
      expect(writes.at(-1)).toBe("Welcome to OpenSSH Server\r\nrunner$ ");

      const laterOutput = new TextEncoder().encode("later-output\r\nrunner$ ");
      act(() => onOutput?.(laterOutput));
      const lastWrite = (term.write.mock.calls as unknown[][]).at(-1);
      expect(new TextDecoder().decode(lastWrite?.[0] as Uint8Array)).toBe("later-output\r\nrunner$ ");
      expect(lastWrite?.[1]).toBeTypeOf("function");
    },
  );

  it("synchronizes the mirrored buffer when CSI 3J arrives split across output chunks", async () => {
    let finishConnect: ((sessionId: string) => void) | undefined;
    let onOutput: ((data: Uint8Array) => void) | undefined;
    ipcMocks.createSshTerminal.mockImplementation((...args: unknown[]) => {
      onOutput = args[9] as (data: Uint8Array) => void;
      return new Promise<string>((resolve) => { finishConnect = resolve; });
    });
    render(<TerminalPanel visible ssh={sshInfo} />);
    await waitFor(() => expect(finishConnect).toBeTypeOf("function"));
    const term = terminalMocks.terminalCtor.mock.results[0].value;
    await act(async () => finishConnect?.("terminal-session"));

    act(() => onOutput?.(new Uint8Array([0x1b, 0x5b])));
    act(() => onOutput?.(new Uint8Array([0x33, 0x4a, 0x0a])));
    expect(term.clear).toHaveBeenCalledOnce();
  });

  it("keeps early SSH error output without displaying a successful connection banner", async () => {
    ipcMocks.createSshTerminal.mockImplementation(async (...args: unknown[]) => {
      (args[9] as (data: Uint8Array) => void)(new TextEncoder().encode("server-error\r\n"));
      throw new Error("SSH refused");
    });
    const onSessionReady = vi.fn();
    render(<TerminalPanel visible ssh={sshInfo} onSessionReady={onSessionReady} />);
    const term = terminalMocks.terminalCtor.mock.results[0].value;
    await waitFor(() => expect(term.write).toHaveBeenCalledWith(expect.stringContaining("SSH refused")));
    const writes = (term.write.mock.calls as unknown[][]).map(([data]) =>
      typeof data === "string" ? data : new TextDecoder().decode(data as Uint8Array),
    );
    expect(writes).toContain("server-error\r\n");
    expect(writes.some((text) => text.includes("Taomni SSH terminal"))).toBe(false);
    expect(onSessionReady).not.toHaveBeenCalled();
  });

  it("discards queued SSH output when its panel is closed before connection completes", async () => {
    let finishConnect: ((sessionId: string) => void) | undefined;
    ipcMocks.createSshTerminal.mockImplementation((...args: unknown[]) => {
      (args[9] as (data: Uint8Array) => void)(new TextEncoder().encode("early-prompt$ "));
      return new Promise<string>((resolve) => { finishConnect = resolve; });
    });
    const { unmount } = render(<TerminalPanel visible ssh={sshInfo} />);
    await waitFor(() => expect(finishConnect).toBeTypeOf("function"));
    const term = terminalMocks.terminalCtor.mock.results[0].value;
    unmount();
    term.write.mockClear();
    await act(async () => finishConnect?.("terminal-session"));
    expect(term.write).not.toHaveBeenCalled();
    expect(ipcMocks.closeTerminal).toHaveBeenCalledWith("terminal-session");
  });

  it("does not connect SSH after its initial mount is cancelled", async () => {
    const { unmount } = render(<TerminalPanel visible ssh={sshInfo} />);
    unmount();

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });
    expect(ipcMocks.createSshTerminal).not.toHaveBeenCalled();
  });

  it("launches a SocksCap TUI only once when StrictMode replays mount effects", async () => {
    render(
      <StrictMode>
        <TerminalPanel
          tabId="sockscap-tab"
          visible
          sockscapTerminal={{
            profileId: "default",
            path: "agy",
            args: [],
            launchPreparation: {
              workingDirectory: "/workspace/agy",
              preCommand: "export AGL_RUN_MODE=prepared",
            },
            terminalSessionId: "sockscap-terminal-session",
          }}
        />
      </StrictMode>,
    );

    await waitFor(() => {
      expect(sockscapMocks.sockscapLaunchTerminalApp).toHaveBeenCalledTimes(1);
    });
    expect(sockscapMocks.sockscapLaunchTerminalApp).toHaveBeenCalledWith(
      "sockscap-terminal-session",
      "default",
      "agy",
      [],
      {
        workingDirectory: "/workspace/agy",
        preCommand: "export AGL_RUN_MODE=prepared",
      },
      80,
      24,
      expect.any(Function),
    );
  });

  it("passes the workspace root when launching an SDK-aware local terminal", async () => {
    render(<TerminalPanel visible initialCwd="/repo/app" workspaceRoot="/repo" />);

    await waitFor(() => expect(ipcMocks.createLocalTerminal).toHaveBeenCalled());
    expect(ipcMocks.createLocalTerminal.mock.calls[0]?.[7]).toBe("/repo");
  });
}
