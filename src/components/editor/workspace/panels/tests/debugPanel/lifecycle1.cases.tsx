import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { initialDebugState, type DebugSessionState } from "../../../dapDebugModel";
import { DebugPanel } from "../../DebugPanel";
import { makeSession, stoppedState } from "./harness";

export function registerDebugPanelLifecycle1Cases() {

  it("shows an idle hint and a start button when no session", () => {
    const onStart = vi.fn();
    render(<DebugPanel debug={makeSession()} onStart={onStart} onOpenFrame={vi.fn()} />);
    expect(screen.getByText(/No debug session/)).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("debug-start"));
    expect(onStart).toHaveBeenCalledTimes(1);
  });

  it("selects the active Run/Debug configuration from the panel", () => {
    const onActiveConfigurationChange = vi.fn();
    render(
      <DebugPanel
        debug={makeSession()}
        onStart={vi.fn()}
        onOpenFrame={vi.fn()}
        configurations={[
          { id: "run:default", label: "Default" },
          { id: "run:local", label: "Local" },
        ]}
        activeConfigurationId="run:default"
        onActiveConfigurationChange={onActiveConfigurationChange}
      />,
    );
    fireEvent.change(screen.getByTestId("debug-active-configuration"), {
      target: { value: "run:local" },
    });
    expect(onActiveConfigurationChange).toHaveBeenCalledWith("run:local");
  });

  it("labels shared and local configuration provenance in the chooser", () => {
    render(
      <DebugPanel
        debug={makeSession()}
        onStart={vi.fn()}
        onOpenFrame={vi.fn()}
        configurations={[
          { id: "shared-run:team", label: "Team", source: "shared" },
          { id: "run:local", label: "Local", source: "local" },
        ]}
        activeConfigurationId="shared-run:team"
      />,
    );
    expect(screen.getByRole("option", { name: "Team [Shared]" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Local [Local]" })).toBeInTheDocument();
  });

  it("surfaces an unavailable configuration diagnostic without hiding the choice", () => {
    render(
      <DebugPanel
        debug={makeSession()}
        onStart={null}
        onOpenFrame={vi.fn()}
        configurations={[{
          id: "compound-debug",
          label: "All services",
          source: "shared",
          available: false,
          diagnostic: "Compound Debug requires grouped multi-session DAP support",
        }]}
        activeConfigurationId="compound-debug"
      />,
    );
    expect(screen.getByRole("option", { name: /All services \[Shared\] \[Unavailable\]/ })).toBeInTheDocument();
    expect(screen.getByTestId("debug-configuration-diagnostic")).toHaveTextContent(
      "Compound Debug requires grouped multi-session DAP support",
    );
  });

  it("explains the desktop requirement in the browser preview", () => {
    render(
      <DebugPanel
        debug={makeSession()}
        onStart={null}
        onOpenFrame={vi.fn()}
        runtimeAvailable={false}
      />,
    );
    // The empty state must say debugging is desktop-only, not the generic
    // "press start" hint that implies it would work here.
    const empty = screen.getByTestId("debug-empty-state");
    expect(empty.textContent).toMatch(/desktop app only/i);
    expect(empty.textContent).not.toMatch(/press start/i);
  });

  it("renders the call stack and dispatches step controls when stopped", () => {
    const step = vi.fn();
    const selectFrame = vi.fn();
    const onOpenFrame = vi.fn();
    render(
      <DebugPanel
        debug={makeSession({ state: stoppedState(), step, selectFrame })}
        onStart={null}
        onOpenFrame={onOpenFrame}
      />,
    );
    // Clicking a frame selects it (variables context) and reveals its source.
    fireEvent.click(screen.getByTestId("debug-frame-10"));
    expect(selectFrame).toHaveBeenCalledWith(10);
    expect(onOpenFrame).toHaveBeenCalledWith(expect.objectContaining({ id: 10, path: "/repo/App.java" }));
    // Step controls dispatch DAP actions.
    fireEvent.click(screen.getByTestId("debug-continue"));
    expect(step).toHaveBeenCalledWith("continue");
    fireEvent.click(screen.getByTestId("debug-step-over"));
    expect(step).toHaveBeenCalledWith("stepOver");
  });

  it("renders debuggee output in the console with categories", () => {
    const state = {
      ...stoppedState(),
      output: [
        { category: "stdout", text: "hello\n" },
        { category: "stderr", text: "boom\n" },
      ],
    };
    render(<DebugPanel debug={makeSession({ state })} onStart={null} onOpenFrame={vi.fn()} />);
    const console = screen.getByTestId("debug-console-output");
    expect(console.textContent).toContain("hello");
    expect(console.textContent).toContain("boom");
  });

  it("selects a thread from the threads section", () => {
    const selectThread = vi.fn();
    render(
      <DebugPanel debug={makeSession({ state: stoppedState(), selectThread })} onStart={null} onOpenFrame={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId("debug-thread-select"));
    fireEvent.click(screen.getByTestId("debug-thread-2"));
    expect(selectThread).toHaveBeenCalledWith(2);
  });

  it("shows the exception banner when stopped on an exception", () => {
    const state = {
      ...stoppedState(),
      exceptionInfo: {
        exceptionId: "java.lang.NullPointerException",
        description: "boom",
        details: "at App.main(App.java:9)",
      },
    };
    render(<DebugPanel debug={makeSession({ state })} onStart={null} onOpenFrame={vi.fn()} />);
    const banner = screen.getByTestId("debug-exception-info");
    expect(banner.textContent).toContain("NullPointerException");
    expect(banner.textContent).toContain("boom");
  });

  it("gates restart-frame on the adapter capability and restarts the frame", () => {
    const restartFrame = vi.fn();
    const { rerender } = render(
      <DebugPanel debug={makeSession({ state: stoppedState(), restartFrame })} onStart={null} onOpenFrame={vi.fn()} />,
    );
    fireEvent.contextMenu(screen.getByTestId("debug-frame-10"));
    expect(screen.queryByTestId("debug-frame-menu-restart-frame")).toBeNull();
    fireEvent.keyDown(document.body, { key: "Escape" });
    rerender(
      <DebugPanel
        debug={makeSession({
          state: stoppedState(),
          restartFrame,
          capabilities: { supportsRestartFrame: true },
        })}
        onStart={null}
        onOpenFrame={vi.fn()}
      />,
    );
    fireEvent.contextMenu(screen.getByTestId("debug-frame-10"));
    fireEvent.click(screen.getByTestId("debug-frame-menu-restart-frame"));
    expect(restartFrame).toHaveBeenCalledWith(10);
  });

  it("adds a watch expression through the session", () => {
    const addWatchExpression = vi.fn();
    render(
      <DebugPanel
        debug={makeSession({ state: stoppedState(), addWatchExpression })}
        onStart={null}
        onOpenFrame={vi.fn()}
      />,
    );
    const input = screen.getByTestId("debug-watch-input");
    fireEvent.change(input, { target: { value: "x + 1" } });
    // IDEA: Ctrl+Shift+Enter adds a watch, Enter evaluates.
    fireEvent.keyDown(input, { key: "Enter", ctrlKey: true, shiftKey: true });
    expect(addWatchExpression).toHaveBeenCalledWith("x + 1");
  });

  it("evaluates the field's expression in place with Enter", async () => {
    const evaluate = vi.fn().mockResolvedValue({ value: "App@7", variablesReference: 0, type: "App" });
    render(
      <DebugPanel debug={makeSession({ state: stoppedState(), evaluate })} onStart={null} onOpenFrame={vi.fn()} />,
    );
    const input = screen.getByTestId("debug-watch-input");
    fireEvent.change(input, { target: { value: "this" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(evaluate).toHaveBeenCalledWith("this", "repl");
    expect(await screen.findByTestId("debug-evaluate-inline-result")).toHaveTextContent("this= {App@7}");
  });

  it("offers a rerun button when a previous launch config exists", () => {
    const restart = vi.fn();
    render(
      <DebugPanel debug={makeSession({ canRestart: true, restart })} onStart={null} onOpenFrame={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId("debug-restart"));
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("renders session controls exactly once after the session terminates", () => {
    // A terminated session still has state, so both the top configuration bar
    // and the frames pane are on screen; their controls must not duplicate
    // data-testids.
    const terminated: DebugSessionState = { ...initialDebugState("s1"), status: "terminated" };
    render(
      <DebugPanel
        debug={makeSession({ state: terminated, canRestart: true })}
        onStart={vi.fn()}
        onOpenFrame={vi.fn()}
      />,
    );
    expect(screen.getAllByTestId("debug-restart")).toHaveLength(1);
    expect(screen.getAllByTestId("debug-start")).toHaveLength(1);
    expect(screen.getAllByTestId("debug-session-controls")).toHaveLength(1);
  });

  it("switches between child sessions in a compound debug launch", () => {
    const selectSession = vi.fn();
    render(
      <DebugPanel
        debug={makeSession({
          state: stoppedState(),
          sessions: [
            { id: "s1", targetId: "api", label: "API", adapterId: "java", status: "stopped", stoppedReason: "breakpoint" },
            { id: "s2", targetId: "web", label: "Web", adapterId: "node", status: "running", stoppedReason: null },
          ],
          activeSessionId: "s1",
          selectSession,
        })}
        onStart={null}
        onOpenFrame={vi.fn()}
      />,
    );
    expect(screen.getByRole("option", { name: "API [stopped: breakpoint]" })).toBeInTheDocument();
    fireEvent.change(screen.getByTestId("debug-active-session"), { target: { value: "s2" } });
    expect(selectSession).toHaveBeenCalledWith("s2");
  });

  it("configures and reports a conditional exception filter through the session", () => {
    const setExceptionBreakpointOptions = vi.fn();
    render(
      <DebugPanel
        debug={makeSession({
          state: stoppedState(),
          sessions: [
            {
              id: "s1",
              targetId: "app",
              label: "App",
              adapterId: "java",
              status: "stopped",
              stoppedReason: "breakpoint",
            },
          ],
          activeSessionId: "s1",
          capabilities: {
            supportsExceptionFilterOptions: true,
            breakpointModes: [
              { mode: "software", label: "Software", appliesTo: ["exception"] },
              { mode: "hardware", label: "Hardware", appliesTo: ["exception"] },
            ],
          },
          availableExceptionFilters: [{
            filter: "caught",
            label: "Caught Exceptions",
            description: "Pause on handled exceptions",
            default: false,
            supportsCondition: true,
            conditionDescription: "Exception class",
          }],
          exceptionBreakpoints: [{
            adapterId: "java",
            filterId: "caught",
            enabled: true,
          }],
          exceptionBreakpointRuntime: {
            caught: { status: "failed", message: "Invalid condition" },
          },
          setExceptionBreakpointOptions,
        })}
        onStart={null}
        onOpenFrame={vi.fn()}
      />,
    );
    expect(screen.getByTestId("debug-exception-breakpoints")).toBeInTheDocument();
    expect(screen.getByText("Caught Exceptions").closest("label")).toHaveAttribute(
      "title",
      "Pause on handled exceptions",
    );
    expect(screen.getByTestId("debug-exception-breakpoint-binding-0")).toHaveTextContent("not bound");
    fireEvent.click(screen.getByTestId("debug-exception-breakpoint-enabled-0"));
    expect(setExceptionBreakpointOptions).toHaveBeenCalledWith("caught", { enabled: false });
    fireEvent.change(screen.getByTestId("debug-exception-breakpoint-condition-0"), {
      target: { value: "exception instanceof IOException" },
    });
    fireEvent.keyDown(screen.getByTestId("debug-exception-breakpoint-condition-0"), { key: "Enter" });
    expect(setExceptionBreakpointOptions).toHaveBeenCalledWith("caught", {
      condition: "exception instanceof IOException",
    });
    fireEvent.change(screen.getByTestId("debug-exception-breakpoint-mode-0"), {
      target: { value: "hardware" },
    });
    expect(setExceptionBreakpointOptions).toHaveBeenCalledWith("caught", { mode: "hardware" });
  });

  it("manages capability-gated exception class and package rules", () => {
    const addExceptionBreakpointRule = vi.fn().mockReturnValue("rule-new");
    const setExceptionBreakpointRuleOptions = vi.fn();
    const removeExceptionBreakpointRule = vi.fn();
    render(
      <DebugPanel
        debug={makeSession({
          state: stoppedState(),
          sessions: [{
            id: "s1",
            targetId: "app",
            label: "App",
            adapterId: "java",
            status: "stopped",
            stoppedReason: "exception",
          }],
          activeSessionId: "s1",
          capabilities: { supportsExceptionOptions: true },
          availableExceptionFilters: [{
            filter: "all",
            label: "All Exceptions",
            default: false,
            supportsCondition: false,
          }],
          exceptionBreakpointRules: [{
            id: "rule-1",
            adapterId: "java",
            path: [
              { names: ["Java Exceptions"] },
              { names: ["java.io.IOException"] },
            ],
            breakMode: "unhandled",
            enabled: true,
          }],
          exceptionBreakpointRuleRuntime: {
            "rule-1": { status: "failed", message: "Unknown exception class" },
          },
          addExceptionBreakpointRule,
          setExceptionBreakpointRuleOptions,
          removeExceptionBreakpointRule,
        })}
        onStart={null}
        onOpenFrame={vi.fn()}
      />,
    );

    expect(screen.getByTestId("debug-exception-rules")).toBeInTheDocument();
    expect(screen.getByTestId("debug-exception-rule-row")).toHaveTextContent(
      "Java Exceptions / java.io.IOException",
    );
    expect(screen.getByTestId("debug-exception-rule-binding-0")).toHaveTextContent("not bound");

    fireEvent.change(screen.getByTestId("debug-exception-rule-input"), {
      target: { value: "java.sql.SQLException, java.net.SocketException" },
    });
    fireEvent.click(screen.getByTestId("debug-exception-rule-add"));
    expect(addExceptionBreakpointRule).toHaveBeenCalledWith([{
      names: ["java.sql.SQLException", "java.net.SocketException"],
    }]);

    fireEvent.click(screen.getByTestId("debug-exception-rule-enabled-0"));
    expect(setExceptionBreakpointRuleOptions).toHaveBeenCalledWith("rule-1", { enabled: false });
    fireEvent.change(screen.getByTestId("debug-exception-rule-mode-0"), {
      target: { value: "userUnhandled" },
    });
    expect(setExceptionBreakpointRuleOptions).toHaveBeenCalledWith("rule-1", {
      breakMode: "userUnhandled",
    });

    fireEvent.click(screen.getByTestId("debug-exception-rule-edit-0"));
    fireEvent.change(screen.getByTestId("debug-exception-rule-path-names-0-1"), {
      target: { value: "java.io.IOException, java.io.EOFException" },
    });
    fireEvent.keyDown(screen.getByTestId("debug-exception-rule-path-names-0-1"), { key: "Enter" });
    expect(setExceptionBreakpointRuleOptions).toHaveBeenCalledWith("rule-1", {
      path: [
        { names: ["Java Exceptions"] },
        { names: ["java.io.IOException", "java.io.EOFException"] },
      ],
    });

    fireEvent.click(screen.getByTestId("debug-exception-rule-path-exclude-0-0"));
    expect(setExceptionBreakpointRuleOptions).toHaveBeenCalledWith("rule-1", {
      path: [
        { names: ["Java Exceptions"], negate: true },
        { names: ["java.io.IOException"] },
      ],
    });
    fireEvent.change(screen.getByTestId("debug-exception-rule-path-input-0"), {
      target: { value: "com.example.*" },
    });
    fireEvent.click(screen.getByTestId("debug-exception-rule-path-add-0"));
    expect(setExceptionBreakpointRuleOptions).toHaveBeenCalledWith("rule-1", {
      path: [
        { names: ["Java Exceptions"] },
        { names: ["java.io.IOException"] },
        { names: ["com.example.*"] },
      ],
    });
    fireEvent.click(screen.getByTestId("debug-exception-rule-path-remove-0-1"));
    expect(setExceptionBreakpointRuleOptions).toHaveBeenCalledWith("rule-1", {
      path: [{ names: ["Java Exceptions"] }],
    });
    fireEvent.click(screen.getByTestId("debug-exception-rule-remove-0"));
    expect(removeExceptionBreakpointRule).toHaveBeenCalledWith("rule-1");
  });

  it("explains when the active adapter cannot accept exception path rules", () => {
    render(
      <DebugPanel
        debug={makeSession({
          state: stoppedState(),
          sessions: [{
            id: "s1",
            targetId: "app",
            label: "App",
            adapterId: "java",
            status: "stopped",
            stoppedReason: "breakpoint",
          }],
          activeSessionId: "s1",
          availableExceptionFilters: [{
            filter: "all",
            label: "All Exceptions",
            default: false,
            supportsCondition: false,
          }],
        })}
        onStart={null}
        onOpenFrame={vi.fn()}
      />,
    );
    expect(screen.getByTestId("debug-exception-rule-unsupported")).toHaveTextContent(
      "does not support class or package exception rules",
    );
  });

  it("lists every workspace breakpoint and reveals one on click", () => {
    const onOpenBreakpoint = vi.fn();
    render(
      <DebugPanel
        debug={makeSession({
          breakpoints: {
            "/repo/A.java": [{ line: 12, condition: "i > 3" }],
            "/repo/B.java": [{ line: 4, enabled: false }],
          },
        })}
        onStart={null}
        onOpenFrame={vi.fn()}
        onOpenBreakpoint={onOpenBreakpoint}
      />,
    );
    expect(screen.getByTestId("debug-breakpoint-12")).toHaveTextContent("A.java:12");
    expect(screen.getByTestId("debug-breakpoint-12")).toHaveTextContent("if i > 3");
    fireEvent.click(screen.getByTestId("debug-breakpoint-4"));
    expect(onOpenBreakpoint).toHaveBeenCalledWith("/repo/B.java", 4);
  });
}
