import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { initialDebugState } from "../../../dapDebugModel";
import { DebugPanel } from "../../DebugPanel";
import { makeSession, stoppedState } from "./harness";

export function registerDebugPanelLifecycle2Cases() {

  it("enables, disables and removes breakpoints from the breakpoints view", () => {
    const setBreakpointOptions = vi.fn();
    const removeBreakpoint = vi.fn();
    render(
      <DebugPanel
        debug={makeSession({
          breakpoints: { "/repo/A.java": [{ line: 12 }] },
          setBreakpointOptions,
          removeBreakpoint,
        })}
        onStart={null}
        onOpenFrame={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("debug-breakpoint-enabled-12"));
    expect(setBreakpointOptions).toHaveBeenCalledWith("/repo/A.java", 12, { enabled: false });
    fireEvent.click(screen.getByTestId("debug-breakpoint-remove-12"));
    expect(removeBreakpoint).toHaveBeenCalledWith("/repo/A.java", 12);
  });

  it("selects an adapter-scoped mode for a source breakpoint", () => {
    const setBreakpointMode = vi.fn();
    render(
      <DebugPanel
        debug={makeSession({
          state: { ...initialDebugState("s1"), status: "running" },
          sessions: [{
            id: "s1",
            targetId: "app",
            label: "App",
            adapterId: "java",
            status: "running",
            stoppedReason: null,
          }],
          activeSessionId: "s1",
          capabilities: {
            breakpointModes: [
              { mode: "software", label: "Software", appliesTo: ["source"] },
              { mode: "hardware", label: "Hardware", appliesTo: ["source"] },
            ],
          },
          breakpoints: { "/repo/A.java": [{ line: 12 }] },
          setBreakpointMode,
        })}
        onStart={null}
        onOpenFrame={vi.fn()}
        editingBreakpoint={{ path: "/repo/A.java", line: 12 }}
      />,
    );
    expect(screen.getByTestId("debug-breakpoint-12")).toHaveTextContent("Software");
    fireEvent.change(screen.getByTestId("debug-breakpoint-mode-12"), {
      target: { value: "hardware" },
    });
    expect(setBreakpointMode).toHaveBeenCalledWith("/repo/A.java", 12, "hardware");
  });

  it("adds, edits, disables and removes a function breakpoint", () => {
    const addFunctionBreakpoint = vi.fn();
    const setFunctionBreakpointOptions = vi.fn();
    const removeFunctionBreakpoint = vi.fn();
    render(
      <DebugPanel
        debug={makeSession({
          functionBreakpoints: [{ name: "Service.run" }],
          addFunctionBreakpoint,
          setFunctionBreakpointOptions,
          removeFunctionBreakpoint,
        })}
        onStart={null}
        onOpenFrame={vi.fn()}
      />,
    );

    const input = screen.getByTestId("debug-function-breakpoint-input");
    fireEvent.change(input, { target: { value: "Controller.handle" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(addFunctionBreakpoint).toHaveBeenCalledWith("Controller.handle");

    fireEvent.click(screen.getByTestId("debug-function-breakpoint-enabled-0"));
    expect(setFunctionBreakpointOptions).toHaveBeenCalledWith("Service.run", { enabled: false });
    fireEvent.click(screen.getByTestId("debug-function-breakpoint-edit-0"));
    const condition = screen.getByTestId("debug-function-breakpoint-condition-0");
    fireEvent.change(condition, { target: { value: "ready" } });
    fireEvent.keyDown(condition, { key: "Enter" });
    expect(setFunctionBreakpointOptions).toHaveBeenCalledWith("Service.run", { condition: "ready" });
    fireEvent.click(screen.getByTestId("debug-function-breakpoint-remove-0"));
    expect(removeFunctionBreakpoint).toHaveBeenCalledWith("Service.run");
  });

  it("surfaces an adapter that cannot arm saved function breakpoints", () => {
    render(
      <DebugPanel
        debug={makeSession({
          state: { ...initialDebugState("s1"), status: "running" },
          functionBreakpoints: [{ name: "Service.run" }],
          functionBreakpointRuntime: {
            "Service.run": { status: "failed", message: "unsupported" },
          },
        })}
        onStart={null}
        onOpenFrame={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("debug-subtab-breakpoints"));
    expect(screen.getByTestId("debug-function-breakpoint-unsupported")).toBeInTheDocument();
    expect(screen.getByTestId("debug-function-breakpoint-input")).toBeDisabled();
    expect(screen.getByTestId("debug-function-breakpoint-binding-0")).toHaveTextContent("not bound");
  });

  it("creates an instruction breakpoint with offset and adapter mode", () => {
    const addInstructionBreakpoint = vi.fn().mockReturnValue(true);
    render(
      <DebugPanel
        debug={makeSession({
          state: stoppedState(),
          sessions: [{
            id: "s1",
            targetId: "target",
            label: "Native",
            adapterId: "lldb",
            status: "stopped",
            stoppedReason: "breakpoint",
          }],
          activeSessionId: "s1",
          capabilities: {
            supportsInstructionBreakpoints: true,
            breakpointModes: [
              { mode: "software", label: "Software", appliesTo: ["instruction"] },
              { mode: "hardware", label: "Hardware", appliesTo: ["instruction"] },
            ],
          },
          addInstructionBreakpoint,
        })}
        onStart={null}
        onOpenFrame={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("debug-subtab-breakpoints"));
    fireEvent.change(screen.getByTestId("debug-instruction-breakpoint-reference"), {
      target: { value: "main:entry" },
    });
    fireEvent.change(screen.getByTestId("debug-instruction-breakpoint-offset"), {
      target: { value: "-4" },
    });
    fireEvent.change(screen.getByTestId("debug-instruction-breakpoint-mode"), {
      target: { value: "hardware" },
    });
    fireEvent.click(screen.getByTestId("debug-instruction-breakpoint-add"));
    expect(addInstructionBreakpoint).toHaveBeenCalledWith({
      instructionReference: "main:entry",
      offset: -4,
      mode: "hardware",
    });
  });

  it("validates instruction offsets before mutating the session", () => {
    const addInstructionBreakpoint = vi.fn().mockReturnValue(true);
    render(
      <DebugPanel
        debug={makeSession({
          state: stoppedState(),
          capabilities: { supportsInstructionBreakpoints: true },
          addInstructionBreakpoint,
        })}
        onStart={null}
        onOpenFrame={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("debug-subtab-breakpoints"));
    fireEvent.change(screen.getByTestId("debug-instruction-breakpoint-reference"), {
      target: { value: "0x1000" },
    });
    fireEvent.change(screen.getByTestId("debug-instruction-breakpoint-offset"), {
      target: { value: "2.5" },
    });
    fireEvent.click(screen.getByTestId("debug-instruction-breakpoint-add"));
    expect(addInstructionBreakpoint).not.toHaveBeenCalled();
    expect(screen.getByTestId("debug-instruction-breakpoint-notice")).toHaveTextContent(
      "signed decimal integer",
    );
  });

  it("edits, disables, and removes an instruction breakpoint with binding status", () => {
    const setInstructionBreakpointOptions = vi.fn();
    const removeInstructionBreakpoint = vi.fn();
    const instruction = {
      adapterId: "lldb",
      instructionReference: "0x1000",
      offset: 4,
      condition: "ready",
      mode: "hardware",
    };
    const key = JSON.stringify(["lldb", "0x1000", 4]);
    render(
      <DebugPanel
        debug={makeSession({
          state: stoppedState(),
          sessions: [{
            id: "s1",
            targetId: "target",
            label: "Native",
            adapterId: "lldb",
            status: "stopped",
            stoppedReason: "breakpoint",
          }],
          activeSessionId: "s1",
          capabilities: {
            supportsInstructionBreakpoints: true,
            breakpointModes: [
              { mode: "software", label: "Software", appliesTo: ["instruction"] },
              { mode: "hardware", label: "Hardware", appliesTo: ["instruction"] },
            ],
          },
          instructionBreakpoints: [instruction],
          instructionBreakpointRuntime: {
            [key]: { status: "failed", message: "not executable" },
          },
          setInstructionBreakpointOptions,
          removeInstructionBreakpoint,
        })}
        onStart={null}
        onOpenFrame={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("debug-subtab-breakpoints"));
    expect(screen.getByTestId("debug-instruction-breakpoint-binding-0")).toHaveTextContent("not bound");
    fireEvent.click(screen.getByTestId("debug-instruction-breakpoint-enabled-0"));
    expect(setInstructionBreakpointOptions).toHaveBeenCalledWith(key, { enabled: false });
    fireEvent.click(screen.getByTestId("debug-instruction-breakpoint-edit-0"));
    fireEvent.change(screen.getByTestId("debug-instruction-breakpoint-condition-0"), {
      target: { value: "loaded" },
    });
    fireEvent.keyDown(screen.getByTestId("debug-instruction-breakpoint-condition-0"), { key: "Enter" });
    expect(setInstructionBreakpointOptions).toHaveBeenCalledWith(key, { condition: "loaded" });
    fireEvent.change(screen.getByTestId("debug-instruction-breakpoint-row-mode-0"), {
      target: { value: "software" },
    });
    expect(setInstructionBreakpointOptions).toHaveBeenCalledWith(key, { mode: "software" });
    fireEvent.click(screen.getByTestId("debug-instruction-breakpoint-remove-0"));
    expect(removeInstructionBreakpoint).toHaveBeenCalledWith(key);
  });

  it("keeps saved instruction breakpoints visible when unsupported", () => {
    render(
      <DebugPanel
        debug={makeSession({
          state: { ...initialDebugState("s1"), status: "running" },
          instructionBreakpoints: [{
            adapterId: "java",
            instructionReference: "0x1000",
          }],
        })}
        onStart={null}
        onOpenFrame={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("debug-subtab-breakpoints"));
    expect(screen.getByTestId("debug-instruction-breakpoint-unsupported")).toBeInTheDocument();
    expect(screen.getByTestId("debug-instruction-breakpoint-reference")).toBeDisabled();
    expect(screen.getByTestId("debug-instruction-breakpoint-row")).toHaveTextContent("0x1000");
  });

  it("creates a data breakpoint from a stopped variable", async () => {
    const addDataBreakpoint = vi.fn().mockResolvedValue({
      added: true,
      message: "Watching Service.count",
    });
    render(
      <DebugPanel
        debug={makeSession({
          state: stoppedState(),
          capabilities: {
            supportsDataBreakpoints: true,
            breakpointModes: [
              { mode: "software", label: "Software", appliesTo: ["data"] },
              { mode: "hardware", label: "Hardware", appliesTo: ["data"] },
            ],
          },
          addDataBreakpoint,
          fetchScopes: vi.fn().mockResolvedValue({
            scopes: [{ name: "Locals", variablesReference: 2 }],
          }),
          fetchVariables: vi.fn().mockResolvedValue({
            variables: [{ name: "count", value: "3", variablesReference: 0 }],
          }),
        })}
        onStart={null}
        onOpenFrame={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("debug-subtab-breakpoints"));
    fireEvent.change(screen.getByTestId("debug-data-breakpoint-mode"), {
      target: { value: "hardware" },
    });
    fireEvent.click(screen.getByTestId("debug-subtab-debugger"));
    const action = await screen.findByTestId("debug-variable-data-breakpoint");
    fireEvent.click(action);
    await waitFor(() => expect(addDataBreakpoint).toHaveBeenCalledWith({
      name: "count",
      variablesReference: 2,
      frameId: undefined,
      mode: "hardware",
    }));
    expect(await screen.findByTestId("debug-data-breakpoint-notice")).toHaveTextContent(
      "Watching Service.count",
    );
  });

  it("creates an address byte-range data breakpoint from the breakpoints view", async () => {
    const addDataBreakpoint = vi.fn().mockResolvedValue({
      added: true,
      message: "Watching 0x1000 (16 bytes)",
    });
    render(
      <DebugPanel
        debug={makeSession({
          state: stoppedState(),
          capabilities: {
            supportsDataBreakpoints: true,
            supportsDataBreakpointBytes: true,
            breakpointModes: [{ mode: "hardware", label: "Hardware", appliesTo: ["data"] }],
          },
          addDataBreakpoint,
        })}
        onStart={null}
        onOpenFrame={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("debug-subtab-breakpoints"));
    fireEvent.change(screen.getByTestId("debug-data-breakpoint-target"), {
      target: { value: "0x1000" },
    });
    fireEvent.change(screen.getByTestId("debug-data-breakpoint-bytes"), {
      target: { value: "16" },
    });
    fireEvent.click(screen.getByTestId("debug-data-breakpoint-as-address"));
    fireEvent.click(screen.getByTestId("debug-data-breakpoint-add"));
    await waitFor(() => expect(addDataBreakpoint).toHaveBeenCalledWith({
      name: "0x1000",
      frameId: undefined,
      bytes: 16,
      asAddress: true,
      mode: "hardware",
    }));
    expect(await screen.findByTestId("debug-data-breakpoint-create-notice")).toHaveTextContent(
      "Watching 0x1000 (16 bytes)",
    );
  });

  it("edits, disables and removes a data watchpoint", () => {
    const setDataBreakpointOptions = vi.fn();
    const removeDataBreakpoint = vi.fn();
    render(
      <DebugPanel
        debug={makeSession({
          dataBreakpoints: [{
            dataId: "field:Service.count",
            description: "Service.count",
            adapterId: "java",
            accessTypes: ["read", "write"],
            accessType: "write",
            canPersist: true,
          }],
          setDataBreakpointOptions,
          removeDataBreakpoint,
        })}
        onStart={null}
        onOpenFrame={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByTestId("debug-data-breakpoint-enabled-0"));
    expect(setDataBreakpointOptions).toHaveBeenCalledWith(
      expect.any(String),
      { enabled: false },
    );
    fireEvent.change(screen.getByTestId("debug-data-breakpoint-access-0"), {
      target: { value: "read" },
    });
    expect(setDataBreakpointOptions).toHaveBeenCalledWith(
      expect.any(String),
      { accessType: "read" },
    );
    fireEvent.click(screen.getByTestId("debug-data-breakpoint-edit-0"));
    const condition = screen.getByTestId("debug-data-breakpoint-condition-0");
    fireEvent.change(condition, { target: { value: "ready" } });
    fireEvent.keyDown(condition, { key: "Enter" });
    expect(setDataBreakpointOptions).toHaveBeenCalledWith(
      expect.any(String),
      { condition: "ready" },
    );
    const hit = screen.getByTestId("debug-data-breakpoint-hit-0");
    fireEvent.change(hit, { target: { value: "4" } });
    fireEvent.keyDown(hit, { key: "Enter" });
    expect(setDataBreakpointOptions).toHaveBeenCalledWith(
      expect.any(String),
      { hitCondition: "4" },
    );
    fireEvent.click(screen.getByTestId("debug-data-breakpoint-remove-0"));
    expect(removeDataBreakpoint).toHaveBeenCalledWith(expect.any(String));
  });

  it("edits a breakpoint's condition inline instead of through modal prompts", () => {
    const setBreakpointOptions = vi.fn();
    render(
      <DebugPanel
        debug={makeSession({
          breakpoints: { "/repo/A.java": [{ line: 12 }] },
          setBreakpointOptions,
        })}
        onStart={null}
        onOpenFrame={vi.fn()}
        editingBreakpoint={{ path: "/repo/A.java", line: 12 }}
      />,
    );
    const condition = screen.getByTestId("debug-breakpoint-condition-12");
    fireEvent.change(condition, { target: { value: "i > 3" } });
    fireEvent.keyDown(condition, { key: "Enter" });
    expect(setBreakpointOptions).toHaveBeenCalledWith("/repo/A.java", 12, { condition: "i > 3" });
    // Hit count and log message live in the same editor.
    const hit = screen.getByTestId("debug-breakpoint-hit-12");
    fireEvent.change(hit, { target: { value: "5" } });
    fireEvent.keyDown(hit, { key: "Enter" });
    expect(setBreakpointOptions).toHaveBeenCalledWith("/repo/A.java", 12, { hitCondition: "5" });
  });

  it("mutes and clears breakpoints from the section header", () => {
    const setBreakpointsMuted = vi.fn();
    const removeAllBreakpoints = vi.fn();
    render(
      <DebugPanel
        debug={makeSession({
          breakpoints: { "/repo/A.java": [{ line: 12 }] },
          setBreakpointsMuted,
          removeAllBreakpoints,
        })}
        onStart={null}
        onOpenFrame={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("debug-mute-breakpoints"));
    expect(setBreakpointsMuted).toHaveBeenCalledWith(true);
    fireEvent.click(screen.getByTestId("debug-remove-all-breakpoints"));
    expect(removeAllBreakpoints).toHaveBeenCalledTimes(1);
  });

  it("offers remote attach only when the parent supplies it", () => {
    const onAttach = vi.fn();
    const { rerender } = render(
      <DebugPanel debug={makeSession()} onStart={null} onOpenFrame={vi.fn()} onAttach={onAttach} />,
    );
    fireEvent.click(screen.getByTestId("debug-attach"));
    expect(onAttach).toHaveBeenCalledTimes(1);
    rerender(<DebugPanel debug={makeSession()} onStart={null} onOpenFrame={vi.fn()} onAttach={null} />);
    expect(screen.queryByTestId("debug-attach")).toBeNull();
  });

  it("clears the console from the section header", () => {
    const clearConsole = vi.fn();
    render(
      <DebugPanel
        debug={makeSession({ state: stoppedState(), clearConsole })}
        onStart={null}
        onOpenFrame={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByTestId("debug-console-clear"));
    expect(clearConsole).toHaveBeenCalledTimes(1);
  });
}
