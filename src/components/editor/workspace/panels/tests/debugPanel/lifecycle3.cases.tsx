import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { DebugPanel } from "../../DebugPanel";
import { makeSession, stoppedState } from "./harness";

export function registerDebugPanelLifecycle3Cases() {

  it("reads, writes, and disassembles memory only when the adapter advertises support", async () => {
    const readMemory = vi.fn().mockResolvedValue({
      address: "0x1000",
      unreadableBytes: 0,
      data: "AAE=",
    });
    const writeMemory = vi.fn().mockResolvedValue({ bytesWritten: 2 });
    const disassemble = vi.fn().mockResolvedValue([{
      address: "0x1000",
      instructionBytes: "55",
      instruction: "push rbp",
      symbol: null,
      location: null,
      line: null,
      column: null,
      endLine: null,
      endColumn: null,
    }]);
    render(
      <DebugPanel
        debug={makeSession({
          state: stoppedState(),
          capabilities: {
            supportsReadMemoryRequest: true,
            supportsWriteMemoryRequest: true,
            supportsDisassembleRequest: true,
          },
          readMemory,
          writeMemory,
          disassemble,
        })}
        onStart={null}
        onOpenFrame={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("debug-subtab-memory"));
    fireEvent.change(screen.getByTestId("debug-memory-reference"), { target: { value: "0x1000" } });
    fireEvent.change(screen.getByTestId("debug-memory-offset"), { target: { value: "-4" } });
    fireEvent.change(screen.getByTestId("debug-memory-count"), { target: { value: "2" } });
    fireEvent.click(screen.getByTestId("debug-memory-read"));
    await waitFor(() => expect(screen.getByTestId("debug-memory-result")).toHaveTextContent("01"));
    expect(readMemory).toHaveBeenCalledWith({ memoryReference: "0x1000", offset: -4, count: 2 });

    fireEvent.change(screen.getByTestId("debug-memory-write-data"), { target: { value: "01 02" } });
    fireEvent.click(screen.getByTestId("debug-memory-write"));
    await waitFor(() => expect(screen.getByTestId("debug-memory-write-status")).toHaveTextContent("Wrote 2 bytes"));
    expect(writeMemory).toHaveBeenCalledWith({
      memoryReference: "0x1000",
      offset: -4,
      data: "AQI=",
      allowPartial: false,
    });

    fireEvent.change(screen.getByTestId("debug-disassemble-count"), { target: { value: "1" } });
    fireEvent.click(screen.getByTestId("debug-disassemble"));
    await waitFor(() => expect(screen.getByTestId("debug-disassembly-row")).toHaveTextContent("push rbp"));
    expect(disassemble).toHaveBeenCalledWith({
      memoryReference: "0x1000",
      instructionCount: 1,
      resolveSymbols: true,
    });
  });

  it("shows memory tools as unsupported when no request capability is advertised", () => {
    render(
      <DebugPanel
        debug={makeSession({ state: stoppedState() })}
        onStart={null}
        onOpenFrame={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("debug-subtab-memory"));
    expect(screen.getByTestId("debug-memory-unsupported")).toBeInTheDocument();
    expect(screen.queryByTestId("debug-memory-read")).toBeNull();
  });

  it("opens context menu on variable node and allows adding data breakpoint and watch", async () => {
    const addDataBreakpoint = vi.fn().mockResolvedValue({ added: true, message: "Watching user.name" });
    const addWatchExpression = vi.fn();
    render(
      <DebugPanel
        debug={makeSession({
          state: stoppedState(),
          capabilities: { supportsDataBreakpoints: true },
          addDataBreakpoint,
          addWatchExpression,
          fetchScopes: vi.fn().mockResolvedValue({
            scopes: [{ name: "Locals", variablesReference: 5 }],
          }),
          fetchVariables: vi.fn().mockResolvedValue({
            variables: [{ name: "user", value: "Object", variablesReference: 0 }],
          }),
        })}
        onStart={null}
        onOpenFrame={vi.fn()}
      />,
    );

    const varNode = await screen.findByText("user");
    fireEvent.contextMenu(varNode);

    const watchMenu = await screen.findByTestId("debug-variable-menu-add-watch");
    expect(watchMenu).toBeInTheDocument();
    fireEvent.click(watchMenu);
    expect(addWatchExpression).toHaveBeenCalledWith("user");

    fireEvent.contextMenu(varNode);
    const dataBpMenu = await screen.findByTestId("debug-variable-menu-data-breakpoint");
    expect(dataBpMenu).toBeInTheDocument();
    fireEvent.click(dataBpMenu);
    await waitFor(() => expect(addDataBreakpoint).toHaveBeenCalledWith(expect.objectContaining({ name: "user" })));
  });

  it("opens context menu on call stack frame and triggers restartFrame", async () => {
    const restartFrame = vi.fn();
    const state = stoppedState();
    render(
      <DebugPanel
        debug={makeSession({
          state,
          capabilities: { supportsRestartFrame: true },
          restartFrame,
        })}
        onStart={null}
        onOpenFrame={vi.fn()}
      />,
    );

    const frameEl = screen.getByTestId(`debug-frame-${state.frames[0].id}`);
    fireEvent.contextMenu(frameEl);

    const restartMenu = await screen.findByTestId("debug-frame-menu-restart-frame");
    expect(restartMenu).toBeInTheDocument();
    fireEvent.click(restartMenu);
    expect(restartFrame).toHaveBeenCalledWith(state.frames[0].id);
  });

  it("switches sub-tabs and keeps views mounted", () => {
    const onSubTabChange = vi.fn();
    const state = stoppedState();
    render(
      <DebugPanel
        debug={makeSession({ state })}
        onStart={null}
        onOpenFrame={vi.fn()}
        onSubTabChange={onSubTabChange}
      />,
    );

    // Initial sub-tab is debugger
    expect(screen.getByTestId("debug-frames-pane")).toBeInTheDocument();
    expect(screen.getByTestId("debug-variables-pane")).toBeInTheDocument();

    // Switch to Console
    fireEvent.click(screen.getByTestId("debug-subtab-console"));
    expect(onSubTabChange).toHaveBeenCalledWith("console");
    expect(screen.getByTestId("debug-console-pane")).toBeInTheDocument();

    // Switch to Breakpoints
    fireEvent.click(screen.getByTestId("debug-subtab-breakpoints"));
    expect(onSubTabChange).toHaveBeenCalledWith("breakpoints");
    expect(screen.getByTestId("debug-breakpoints-pane")).toBeInTheDocument();

    // Switch to Memory
    fireEvent.click(screen.getByTestId("debug-subtab-memory"));
    expect(onSubTabChange).toHaveBeenCalledWith("memory");
    expect(screen.getByTestId("debug-memory-pane")).toBeInTheDocument();
  });

  it("switches to breakpoints sub-tab when editingBreakpoint is provided", () => {
    const { rerender } = render(
      <DebugPanel
        debug={makeSession({
          state: stoppedState(),
          breakpoints: {
            "/repo/App.java": [{ line: 9, enabled: true }],
          },
        })}
        onStart={null}
        onOpenFrame={vi.fn()}
        editingBreakpoint={null}
      />,
    );

    rerender(
      <DebugPanel
        debug={makeSession({
          state: stoppedState(),
          breakpoints: {
            "/repo/App.java": [{ line: 9, enabled: true }],
          },
        })}
        onStart={null}
        onOpenFrame={vi.fn()}
        editingBreakpoint={{ path: "/repo/App.java", line: 9 }}
      />,
    );

    // The breakpoints sub-tab should be active and the breakpoint condition input rendered
    expect(screen.getByTestId("debug-breakpoint-condition-9")).toBeInTheDocument();
  });

  it("sizes the frames/variables split in percentages, not pixels", () => {
    // react-resizable-panels v4 reads a bare number as *pixels*: with
    // `maxSize={85}` the stack column was capped at 85px and its divider could
    // not be dragged any wider.
    render(
      <DebugPanel
        debug={makeSession({ state: stoppedState() })}
        onStart={null}
        onOpenFrame={vi.fn()}
        workspaceInstanceId="ws-1"
      />,
    );

    const frames = document.getElementById("ws-1-debug-frames");
    const variables = document.getElementById("ws-1-debug-variables");
    expect(frames?.dataset.defaultSize).toBe("45%");
    expect(frames?.dataset.minSize).toBe("15%");
    expect(frames?.dataset.maxSize).toBe("85%");
    expect(variables?.dataset.defaultSize).toBe("55%");
    expect(variables?.dataset.minSize).toBe("15%");

    // IDEA merges watches into the Variables view: no second split.
    expect(document.getElementById("ws-1-debug-watches-section")).toBeNull();
  });

  it("drops threads and frames once the session is terminated", () => {
    const { rerender } = render(
      <DebugPanel debug={makeSession({ state: stoppedState() })} onStart={null} onOpenFrame={vi.fn()} />,
    );
    expect(screen.getByTestId("debug-thread-select")).toHaveTextContent('"main"@1');
    expect(screen.getByTestId("debug-frame-10")).toBeInTheDocument();

    // What `terminate()` publishes: no threads, no frames, status terminated.
    rerender(
      <DebugPanel
        debug={makeSession({
          state: {
            ...stoppedState(),
            status: "terminated",
            stoppedThreadId: null,
            stoppedReason: null,
            threads: [],
            frames: [],
            selectedThreadId: null,
            selectedFrameId: null,
          },
        })}
        onStart={null}
        onOpenFrame={vi.fn()}
      />,
    );

    expect(screen.getByTestId("debug-thread-select")).not.toHaveTextContent('"main"@1');
    expect(screen.queryByTestId("debug-frame-10")).not.toBeInTheDocument();
    // …and it must not claim the debuggee is still running.
    expect(screen.getByText("Frames are not available")).toBeInTheDocument();
    expect(screen.queryByText("Running…")).not.toBeInTheDocument();
  });
}
