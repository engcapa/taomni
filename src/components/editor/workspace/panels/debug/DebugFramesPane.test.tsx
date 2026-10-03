import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DebugFramesPane } from "./DebugFramesPane";
import type { CodeDebugSession } from "../../useCodeDebugSession";
import { initialDebugState } from "../../dapDebugModel";

function makeSession(overrides: Partial<CodeDebugSession> = {}): CodeDebugSession {
  return {
    state: null,
    breakpoints: {},
    breakpointRuntime: {},
    functionBreakpoints: [],
    functionBreakpointRuntime: {},
    instructionBreakpoints: [],
    instructionBreakpointRuntime: {},
    dataBreakpoints: [],
    dataBreakpointRuntime: {},
    exceptionBreakpoints: [],
    exceptionBreakpointRuntime: {},
    exceptionBreakpointRules: [],
    exceptionBreakpointRuleRuntime: {},
    capabilities: {},
    availableExceptionFilters: [],
    watchExpressions: [],
    watchItems: [],
    stopEpoch: 0,
    isStepping: false,
    breakpointsMuted: false,
    setBreakpointsMuted: vi.fn(),
    removeAllBreakpoints: vi.fn(),
    frameVariables: {},
    sessions: [],
    activeSessionId: null,
    selectSession: vi.fn(),
    startDebug: vi.fn().mockResolvedValue(undefined),
    startDebugGroup: vi.fn().mockResolvedValue(undefined),
    restart: vi.fn(),
    canRestart: false,
    toggleBreakpoint: vi.fn(),
    addBreakpoint: vi.fn(),
    toggleBreakpointEnabled: vi.fn(),
    setBreakpointOptions: vi.fn(),
    setBreakpointMode: vi.fn(),
    removeBreakpoint: vi.fn(),
    addFunctionBreakpoint: vi.fn(),
    setFunctionBreakpointOptions: vi.fn(),
    removeFunctionBreakpoint: vi.fn(),
    addInstructionBreakpoint: vi.fn().mockReturnValue(true),
    setInstructionBreakpointOptions: vi.fn(),
    removeInstructionBreakpoint: vi.fn(),
    addDataBreakpoint: vi.fn().mockResolvedValue({ added: true, message: "Watching value" }),
    setDataBreakpointOptions: vi.fn(),
    removeDataBreakpoint: vi.fn(),
    setExceptionBreakpointOptions: vi.fn(),
    addExceptionBreakpointRule: vi.fn().mockReturnValue(null),
    setExceptionBreakpointRuleOptions: vi.fn(),
    removeExceptionBreakpointRule: vi.fn(),
    addWatchExpression: vi.fn(),
    removeWatchExpression: vi.fn(),
    step: vi.fn().mockResolvedValue(undefined),
    runToCursor: vi.fn(),
    selectThread: vi.fn(),
    selectFrame: vi.fn(),
    loadMoreFrames: vi.fn(async () => {}),
    restartFrame: vi.fn(),
    hotReload: vi.fn(),
    evaluate: vi.fn().mockResolvedValue({ value: "", variablesReference: 0, type: null }),
    hoverEvaluate: vi.fn().mockResolvedValue(null),
    readMemory: vi.fn().mockResolvedValue(null),
    writeMemory: vi.fn().mockResolvedValue(null),
    disassemble: vi.fn().mockResolvedValue([]),
    setVariable: vi.fn().mockResolvedValue(null),
    logConsole: vi.fn(),
    clearConsole: vi.fn(),
    consoleGeneration: 0,
    reportStartupFailure: vi.fn(),
    reportStartupProgress: vi.fn(),
    fetchVariables: vi.fn().mockResolvedValue({ variables: [] }),
    fetchScopes: vi.fn().mockResolvedValue({ scopes: [] }),
    fetchSource: vi.fn().mockResolvedValue(null),
    terminate: vi.fn(),
    currentLocation: null,
    ...overrides,
  };
}

describe("DebugFramesPane", () => {
  afterEach(cleanup);

  it("shows IDEA's thread combo and frame labels, and selects frames by mouse and keyboard", () => {
    const selectThread = vi.fn();
    const selectFrame = vi.fn();
    const onOpenFrame = vi.fn();

    const state = {
      ...initialDebugState("s1"),
      status: "stopped" as const,
      stoppedThreadId: 1,
      threads: [
        { id: 1, name: "main" },
        { id: 2, name: "worker" },
      ],
      frames: [
        { id: 101, name: "com.acme.Main.main(String[])", path: "/src/main/java/com/acme/Main.java", line: 15, column: 1, sourceReference: 0, sourceName: null },
        { id: 102, name: "com.acme.App.run()", path: "/src/main/java/com/acme/App.java", line: 42, column: 1, sourceReference: 0, sourceName: null },
      ],
      selectedThreadId: 1,
      selectedFrameId: 101,
    };

    const debug = makeSession({ state, selectThread, selectFrame });

    render(
      <DebugFramesPane
        debug={debug}
        activeRunning={true}
        stopped={true}
        onOpenFrame={onOpenFrame}
      />,
    );

    expect(screen.getByTestId("debug-thread-select")).toHaveTextContent('"main"@1: SUSPENDED');
    expect(screen.getByTestId("debug-frame-101")).toHaveTextContent("main:15, Main (com.acme)");
    expect(screen.getByTestId("debug-frame-102")).toHaveTextContent("run:42, App (com.acme)");

    // Click a frame to select and reveal it.
    fireEvent.click(screen.getByTestId("debug-frame-102"));
    expect(selectFrame).toHaveBeenCalledWith(102);
    expect(onOpenFrame).toHaveBeenCalledWith(expect.objectContaining({ id: 102 }));

    // The list follows the arrows like IDEA's frames list.
    fireEvent.keyDown(screen.getByTestId("debug-frames-list"), { key: "ArrowDown" });
    expect(selectFrame).toHaveBeenLastCalledWith(102);

    // Pick another thread from the combo.
    fireEvent.click(screen.getByTestId("debug-thread-select"));
    expect(screen.getByTestId("debug-thread-2")).toHaveTextContent('"worker"@2: RUNNING');
    fireEvent.click(screen.getByTestId("debug-thread-2"));
    expect(selectThread).toHaveBeenCalledWith(2);
  });

  it("folds library frames and loads more frames on demand", () => {
    const loadMoreFrames = vi.fn(async () => {});
    const state = {
      ...initialDebugState("s1"),
      status: "stopped" as const,
      stoppedThreadId: 1,
      threads: [{ id: 1, name: "main" }],
      frames: [
        { id: 1, name: "App.run()", path: "/repo/App.java", line: 3, column: 1, sourceReference: 0, sourceName: null },
        { id: 2, name: "java.lang.reflect.Method.invoke(Object)", path: null, line: 580, column: 1, sourceReference: 9, sourceName: "Method.java" },
        { id: 3, name: "java.lang.Thread.run()", path: null, line: 1583, column: 1, sourceReference: 9, sourceName: "Thread.java" },
      ],
      framesTotal: 12,
      selectedThreadId: 1,
      selectedFrameId: 1,
    };
    render(
      <DebugFramesPane
        debug={makeSession({ state, loadMoreFrames })}
        activeRunning={true}
        stopped={true}
        onOpenFrame={vi.fn()}
      />,
    );
    expect(screen.getByTestId("debug-frame-2")).toHaveAttribute("data-library-frame", "true");
    fireEvent.click(screen.getByTestId("debug-frames-hide-library"));
    expect(screen.queryByTestId("debug-frame-2")).toBeNull();
    expect(screen.getByTestId("debug-frames-folded-2")).toHaveTextContent("2 hidden frames");
    fireEvent.click(screen.getByTestId("debug-frames-load-more"));
    expect(loadMoreFrames).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("debug-frames-folded-2"));
    expect(screen.getByTestId("debug-frame-2")).toBeInTheDocument();
  });
});
