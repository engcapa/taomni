import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodeDebugSession } from "../../useCodeDebugSession";
import { initialDebugState } from "../../dapDebugModel";
import { BreakpointPopup, GutterBreakpointMenu } from "./BreakpointPopup";
import { BreakpointsDialog } from "./BreakpointsDialog";
import { DebugToolWindowToolbar } from "./DebugToolbar";
import { EvaluateExpressionDialog } from "./EvaluateExpressionDialog";

const PATH = "/repo/src/main/java/App.java";

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
    startDebug: vi.fn(),
    startDebugGroup: vi.fn(),
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
    addInstructionBreakpoint: vi.fn(() => true),
    setInstructionBreakpointOptions: vi.fn(),
    removeInstructionBreakpoint: vi.fn(),
    addDataBreakpoint: vi.fn(async () => ({ added: false, message: "" })),
    setDataBreakpointOptions: vi.fn(),
    removeDataBreakpoint: vi.fn(),
    setExceptionBreakpointOptions: vi.fn(),
    addExceptionBreakpointRule: vi.fn(() => null),
    setExceptionBreakpointRuleOptions: vi.fn(),
    removeExceptionBreakpointRule: vi.fn(),
    addWatchExpression: vi.fn(),
    removeWatchExpression: vi.fn(),
    step: vi.fn().mockResolvedValue({ kind: "applied" }),
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
  } as CodeDebugSession;
}

afterEach(cleanup);

describe("BreakpointPopup", () => {
  it("edits Enabled, Suspend and Condition, and closes on Enter like IDEA's balloon", () => {
    const onChange = vi.fn();
    const onClose = vi.fn();
    const onMore = vi.fn();
    render(
      <BreakpointPopup
        path={PATH}
        breakpoint={{ line: 12 }}
        anchor={{ x: 10, y: 10 }}
        otherBreakpoints={[]}
        onChange={onChange}
        onMore={onMore}
        onClose={onClose}
      />,
    );
    expect(screen.getByTestId("debug-breakpoint-popup-title")).toHaveTextContent("App.java:12");
    // The compact balloon keeps the full property set for "More".
    expect(screen.queryByTestId("debug-breakpoint-popup-log-stack")).toBeNull();
    fireEvent.click(screen.getByTestId("debug-breakpoint-popup-suspend"));
    expect(onChange).toHaveBeenCalledWith({ suspend: false });
    const condition = screen.getByTestId("debug-breakpoint-popup-condition");
    expect(condition).toHaveFocus();
    fireEvent.change(condition, { target: { value: "i > 3" } });
    fireEvent.keyDown(condition, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith({ condition: "i > 3" });
    expect(onClose).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("debug-breakpoint-popup-more"));
    expect(onMore).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(screen.getByTestId("debug-breakpoint-popup"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(2);
  });

  it("offers logging, Remove once hit and the dependency when expanded", () => {
    const onChange = vi.fn();
    render(
      <BreakpointPopup
        path={PATH}
        breakpoint={{ line: 12, suspend: false, logHitMessage: true }}
        anchor={{ x: 10, y: 10 }}
        expanded
        otherBreakpoints={[{ path: PATH, line: 5 }, { path: PATH, line: 12 }]}
        onChange={onChange}
        onMore={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    expect(screen.getByTestId("debug-breakpoint-popup-log-message")).toBeChecked();
    fireEvent.click(screen.getByTestId("debug-breakpoint-popup-log-stack"));
    expect(onChange).toHaveBeenCalledWith({ logStack: true });
    fireEvent.click(screen.getByTestId("debug-breakpoint-popup-remove-once-hit"));
    expect(onChange).toHaveBeenCalledWith({ temporary: true });
    const dependsOn = screen.getByTestId("debug-breakpoint-popup-depends-on") as HTMLSelectElement;
    // A breakpoint cannot wait for itself.
    expect(Array.from(dependsOn.options).map((option) => option.textContent)).toEqual(["<None>", "App.java:5"]);
    fireEvent.change(dependsOn, { target: { value: dependsOn.options[1].value } });
    expect(onChange).toHaveBeenCalledWith({ dependsOn: { path: PATH, line: 5 } });
    const expression = screen.getByTestId("debug-breakpoint-popup-log-expression");
    fireEvent.change(expression, { target: { value: "count" } });
    fireEvent.blur(expression);
    expect(onChange).toHaveBeenCalledWith({ logExpression: "count" });
  });

  it("adds breakpoints from the empty-gutter menu", () => {
    const onAdd = vi.fn();
    render(<GutterBreakpointMenu menu={{ x: 5, y: 5 }} onAdd={onAdd} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("debug-gutter-menu-add-logging"));
    expect(onAdd).toHaveBeenCalledWith("logging");
  });
});

describe("BreakpointsDialog", () => {
  it("lists breakpoints by kind and edits, toggles, removes and opens them from the keyboard", () => {
    const debug = makeSession({
      breakpoints: { [PATH]: [{ line: 12, condition: "x" }, { line: 20, enabled: false }] },
    });
    const onOpenBreakpoint = vi.fn();
    const onClose = vi.fn();
    render(<BreakpointsDialog debug={debug} onOpenBreakpoint={onOpenBreakpoint} onClose={onClose} />);
    const tree = screen.getByTestId("debug-breakpoints-dialog-tree");
    expect(tree).toHaveFocus();
    expect(screen.getAllByTestId("debug-breakpoints-dialog-line").map((row) => row.textContent)).toEqual([
      "App.java:12x",
      "App.java:20",
    ]);
    // The first breakpoint is selected with its IDEA properties.
    expect(screen.getByTestId("debug-breakpoints-dialog-condition")).toHaveValue("x");
    fireEvent.keyDown(tree, { key: " " });
    expect(debug.toggleBreakpointEnabled).toHaveBeenCalledWith(PATH, 12);
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    expect(screen.getByTestId("debug-breakpoints-dialog-enabled-20")).not.toBeChecked();
    fireEvent.keyDown(tree, { key: "Delete" });
    expect(debug.removeBreakpoint).toHaveBeenCalledWith(PATH, 20);
    fireEvent.keyDown(tree, { key: "F4" });
    expect(onOpenBreakpoint).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("hosts function breakpoints under their group", () => {
    render(<BreakpointsDialog debug={makeSession()} onOpenBreakpoint={vi.fn()} onClose={vi.fn()} />);
    fireEvent.click(screen.getByTestId("debug-breakpoints-dialog-group-function"));
    expect(screen.getByTestId("debug-function-breakpoints")).toBeInTheDocument();
  });
});

describe("DebugToolWindowToolbar", () => {
  it("shows IDEA's toolbar order and the More actions", () => {
    const onViewBreakpoints = vi.fn();
    const onRunToCursor = vi.fn();
    const debug = makeSession({
      state: { ...initialDebugState("s"), status: "stopped", stoppedThreadId: 1 },
      canRestart: true,
    });
    render(
      <DebugToolWindowToolbar
        debug={debug}
        activeRunning
        stopped
        onViewBreakpoints={onViewBreakpoints}
        onRunToCursor={onRunToCursor}
        onShowExecutionPoint={vi.fn()}
        onEvaluateExpression={vi.fn()}
      />,
    );
    const order = Array.from(screen.getByTestId("debug-session-controls").querySelectorAll("button"))
      .map((button) => button.dataset.testid);
    expect(order).toEqual([
      "debug-restart",
      "debug-stop",
      "debug-continue",
      "debug-pause",
      "debug-step-over",
      "debug-step-in",
      "debug-step-out",
      "debug-view-breakpoints",
      "debug-toolbar-mute-breakpoints",
      "debug-toolbar-more",
    ]);
    fireEvent.click(screen.getByTestId("debug-view-breakpoints"));
    expect(onViewBreakpoints).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByTestId("debug-toolbar-mute-breakpoints"));
    expect(debug.setBreakpointsMuted).toHaveBeenCalledWith(true);
    act(() => { fireEvent.click(screen.getByTestId("debug-toolbar-more")); });
    fireEvent.click(screen.getByTestId("debug-run-to-cursor"));
    expect(onRunToCursor).toHaveBeenCalledTimes(1);
  });
});

describe("EvaluateExpressionDialog", () => {
  it("evaluates with Enter and adds the expression to the watches", async () => {
    const evaluate = vi.fn().mockResolvedValue({ value: "ArrayList@3 size=2", variablesReference: 7, type: "ArrayList" });
    const debug = makeSession({
      state: { ...initialDebugState("s"), status: "stopped", stoppedThreadId: 1 },
      evaluate,
    });
    render(<EvaluateExpressionDialog debug={debug} initialExpression="items" onClose={vi.fn()} />);
    const input = screen.getByTestId("debug-evaluate-expression");
    await act(async () => { fireEvent.keyDown(input, { key: "Enter" }); });
    expect(evaluate).toHaveBeenCalledWith("items", "repl");
    expect(screen.getByTestId("debug-evaluate-result")).toHaveTextContent("result= {ArrayList@3} size=2");
    fireEvent.click(screen.getByTestId("debug-evaluate-add-watch"));
    expect(debug.addWatchExpression).toHaveBeenCalledWith("items");
  });
});
