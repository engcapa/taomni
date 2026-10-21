import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DEFAULT_TERMINAL_PROFILE } from "../../../../lib/terminalProfile";
import { TerminalPanel } from "../../TerminalPanel";
import { encodeOsc52Text, ipcMocks, sshInfo, terminalMocks } from "./harness";

export function registerTerminalPanelClipboard6Cases() {

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

  it.each(["Enter", "Next", "Prev"])("cancels pending automatic search when navigating with %s", async (action) => {
    render(<TerminalPanel visible />);
    await waitFor(() => expect(terminalMocks.focus).toHaveBeenCalled());
    const term = terminalMocks.terminalCtor.mock.results[0].value;
    term.buffer.active.length = 2;
    term.buffer.active.getLine.mockImplementation(() => ({
      length: 6,
      getCell: (column: number) => ({ getChars: () => "marker"[column], getWidth: () => 1 }),
    }));
    fireEvent.contextMenu(screen.getByTestId("terminal-pane"));
    fireEvent.click(screen.getByTestId("context-menu-item-find"));
    const input = await screen.findByPlaceholderText("Find");

    vi.useFakeTimers();
    try {
      fireEvent.change(input, { target: { value: "marker" } });
      if (action === "Enter") fireEvent.keyDown(input, { key: "Enter" });
      else fireEvent.click(screen.getByRole("button", { name: action }));
      expect(term.select).toHaveBeenCalledTimes(1);
      const status = screen.getByText(/Match \d\/2/).textContent;
      act(() => vi.advanceTimersByTime(150));
      expect(term.select).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/Match \d\/2/)).toHaveTextContent(status!);
      fireEvent.keyDown(input, { key: "Enter" });
      expect(term.select).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps pending automatic search from replacing a manual terminal selection", async () => {
    render(<TerminalPanel visible />);
    await waitFor(() => expect(terminalMocks.focus).toHaveBeenCalled());
    const term = terminalMocks.terminalCtor.mock.results[0].value;
    term.buffer.active.length = 1;
    term.buffer.active.getLine.mockImplementation(() => ({
      length: 6,
      getCell: (column: number) => ({ getChars: () => "marker"[column], getWidth: () => 1 }),
    }));
    fireEvent.contextMenu(screen.getByTestId("terminal-pane"));
    fireEvent.click(screen.getByTestId("context-menu-item-find"));
    const input = await screen.findByPlaceholderText("Find");
    const terminalScreen = screen.getByTestId("terminal-pane").querySelector(".xterm-screen")!;

    vi.useFakeTimers();
    try {
      fireEvent.change(input, { target: { value: "marker" } });
      fireEvent.mouseDown(terminalScreen, { button: 0 });
      act(() => vi.advanceTimersByTime(150));
      expect(term.select).not.toHaveBeenCalled();
      // Further typing must still run the automatic search.
      fireEvent.change(input, { target: { value: "mark" } });
      act(() => vi.advanceTimersByTime(150));
      expect(term.select).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("refreshes search highlights after reflow without replacing a manual selection or advancing the match", async () => {
    render(<TerminalPanel visible />);
    await waitFor(() => expect(terminalMocks.focus).toHaveBeenCalled());
    const term = terminalMocks.terminalCtor.mock.results[0].value;
    let lines = ["prompt marker", "", "marker"];
    term.buffer.active.length = lines.length;
    term.buffer.active.getLine.mockImplementation((row: number) => ({
      length: lines[row]?.length ?? 0,
      getCell: (column: number) => ({ getChars: () => lines[row]?.[column] ?? "", getWidth: () => 1 }),
    }));
    const terminalScreen = screen.getByTestId("terminal-pane").querySelector(".xterm-screen")!;
    vi.spyOn(terminalScreen, "getBoundingClientRect").mockReturnValue({
      left: 0, top: 0, right: 800, bottom: 240, width: 800, height: 240,
      x: 0, y: 0, toJSON: () => ({}),
    });
    fireEvent.contextMenu(screen.getByTestId("terminal-pane"));
    fireEvent.click(screen.getByTestId("context-menu-item-find"));
    const input = await screen.findByPlaceholderText("Find");
    fireEvent.change(input, { target: { value: "marker" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByText("Match 2/2")).toBeInTheDocument();
    const activeHit = () => screen.getByTestId("terminal-pane").querySelector(".terminal-search-hit-active");
    expect(activeHit()).toHaveStyle({ top: "20px" });
    fireEvent.mouseDown(terminalScreen, { button: 0 });
    term.select.mockClear();
    term.clearSelection.mockClear();

    // A prompt gaining a wrapped row moves the output match in the buffer.
    lines = ["prompt", "marker", "", "marker"];
    term.buffer.active.length = lines.length;
    act(() => terminalMocks.state.onResizeHandler?.({ cols: 60, rows: 24 }));

    expect(activeHit()).toHaveStyle({ top: "30px" });
    expect(screen.getByText("Match 2/2")).toBeInTheDocument();
    expect(term.select).not.toHaveBeenCalled();
    expect(term.clearSelection).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Prev" }));
    expect(screen.getByText("Match 1/2")).toBeInTheDocument();
    expect(term.select).toHaveBeenCalledWith(0, 1, 6);
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
}
