import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import {
  breakpointCalls,
  dapSendRequest,
  dapStartSession,
  dapTerminate,
  exceptionBreakpointCalls,
  functionBreakpointCalls,
  listenDapEvents,
  startSession,
  useCodeDebugSession,
} from "./harness";

export function registeruseCodeDebugSessionLifecycle5Cases() {

  it("keeps the console readable after an explicit stop", async () => {
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug);
    act(() => {
      emit({
        sessionId: "sess-1",
        event: "output",
        message: { body: { category: "stdout", output: "hello\n" } },
      });
    });
    await act(async () => result.current.terminate());

    // IDEA leaves the output visible after Stop; only the next run replaces it.
    expect(result.current.state?.status).toBe("terminated");
    expect(result.current.state?.output).toEqual([{ category: "stdout", text: "hello\n" }]);
    expect(dapTerminate).toHaveBeenCalledWith("sess-1");

    act(() => result.current.clearConsole());
    expect(result.current.state?.output).toEqual([]);
  });

  it("keeps the debuggee's last output that arrives after exited/terminated, before the exit line", async () => {
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug);
    act(() => emit({ sessionId: "sess-1", event: "initialized", message: {} }));
    dapTerminate.mockClear();
    act(() => emit({ sessionId: "sess-1", event: "exited", message: { body: { exitCode: 0 } } }));
    act(() => emit({ sessionId: "sess-1", event: "terminated", message: {} }));
    // java-debug's stream reader delivers the final println after the exit events.
    act(() => emit({
      sessionId: "sess-1",
      event: "output",
      message: { body: { category: "stdout", output: "debug-value=42\n" } },
    }));
    expect(dapTerminate).not.toHaveBeenCalled();
    await waitFor(() => expect(result.current.state?.status).toBe("terminated"));
    const texts = result.current.state!.output.map((line) => line.text);
    const value = texts.indexOf("debug-value=42\n");
    expect(value).toBeGreaterThan(-1);
    expect(value).toBeLessThan(texts.findIndex((text) => text.includes("Process finished with exit code 0")));
    expect(dapTerminate).toHaveBeenCalledWith("sess-1");
  });

  it("starts parallel compound children and broadcasts breakpoints to every live session", async () => {
    const handlers = new Map<string, (payload: { sessionId: string; event: string; message: unknown; }) => void>();
    listenDapEvents.mockImplementation((id: string, handler: (payload: {
      sessionId: string; event: string; message: unknown;
    }) => void) => {
      handlers.set(id, handler);
      return Promise.resolve(() => handlers.delete(id));
    });
    dapStartSession.mockImplementation((adapterId: string, config: Record<string, unknown>) => Promise.resolve({
      sessionId: String(config.sessionId),
      capabilities: {
        supportsFunctionBreakpoints: true,
        supportsExceptionFilterOptions: true,
        supportsExceptionOptions: true,
        exceptionBreakpointFilters: adapterId === "java"
          ? [{ filter: "caught", label: "Caught", default: true, supportsCondition: true }]
          : [{ filter: "all", label: "All exceptions", default: true }],
      },
      request: "launch",
      arguments: config,
    }));
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    let started!: Promise<void>;
    act(() => {
      started = result.current.startDebugGroup({
        id: "all",
        label: "All services",
        parallel: true,
        children: [
          { id: "api", label: "API", adapterId: "java", launchConfig: { sessionId: "sess-api" } },
          { id: "web", label: "Web", adapterId: "node", launchConfig: { sessionId: "sess-web" } },
        ],
      });
    });
    await waitFor(() => expect(handlers.size).toBe(2));
    expect(dapStartSession).toHaveBeenCalledTimes(2);
    await act(async () => {
      handlers.get("sess-api")?.({ sessionId: "sess-api", event: "initialized", message: {} });
      handlers.get("sess-web")?.({ sessionId: "sess-web", event: "initialized", message: {} });
      await started;
    });
    expect(result.current.sessions.map((session) => session.label)).toEqual(["API", "Web"]);
    await waitFor(() => expect(exceptionBreakpointCalls()).toHaveLength(2));
    expect(exceptionBreakpointCalls().map((call) => [call.sessionId, call.filters]).sort()).toEqual([
      ["sess-api", ["caught"]],
      ["sess-web", ["all"]],
    ]);

    act(() => {
      result.current.selectSession("sess-api");
      result.current.setExceptionBreakpointOptions("caught", { condition: "IOException" });
    });
    await waitFor(() => expect(exceptionBreakpointCalls()).toHaveLength(3));
    expect(exceptionBreakpointCalls()[2]).toEqual({
      sessionId: "sess-api",
      filters: [],
      filterOptions: [{ filterId: "caught", condition: "IOException" }],
    });

    act(() => {
      result.current.addExceptionBreakpointRule([{ names: ["java.io.IOException"] }], "unhandled");
    });
    await waitFor(() => expect(exceptionBreakpointCalls()).toHaveLength(4));
    expect(exceptionBreakpointCalls()[3]).toEqual({
      sessionId: "sess-api",
      filters: [],
      filterOptions: [{ filterId: "caught", condition: "IOException" }],
      exceptionOptions: [{
        path: [{ names: ["java.io.IOException"] }],
        breakMode: "unhandled",
      }],
    });

    act(() => result.current.toggleBreakpoint("/repo/App.java", 12));
    await waitFor(() => expect(breakpointCalls()).toHaveLength(2));
    expect(breakpointCalls().map((call) => call.sessionId).sort()).toEqual(["sess-api", "sess-web"]);

    act(() => result.current.addFunctionBreakpoint("Service.run"));
    await waitFor(() => expect(functionBreakpointCalls()).toHaveLength(4));
    expect(functionBreakpointCalls().slice(-2).map((call) => call.sessionId).sort()).toEqual([
      "sess-api",
      "sess-web",
    ]);
    expect(functionBreakpointCalls().slice(-2).every((call) => (
      call.breakpoints[0]?.name === "Service.run"
    ))).toBe(true);

    act(() => {
      handlers.get("sess-web")?.({
        sessionId: "sess-web",
        event: "stopped",
        message: { body: { reason: "breakpoint", threadId: 7 } },
      });
    });
    await waitFor(() => expect(result.current.activeSessionId).toBe("sess-web"));
    expect(result.current.state?.status).toBe("stopped");
    act(() => result.current.setExceptionBreakpointOptions("all", { enabled: false }));
    await waitFor(() => expect(exceptionBreakpointCalls()).toHaveLength(5));
    expect(exceptionBreakpointCalls()[4]).toEqual({ sessionId: "sess-web", filters: [] });

    act(() => {
      handlers.get("sess-web")?.({ sessionId: "sess-web", event: "terminated", message: {} });
    });
    await waitFor(() => expect(result.current.activeSessionId).toBe("sess-api"));
    expect(result.current.state?.status).toBe("running");

    await act(async () => result.current.terminate());
    expect(dapTerminate).toHaveBeenCalledWith("sess-api");
    expect(dapTerminate).toHaveBeenCalledWith("sess-web");
    expect(result.current.sessions.every((session) => session.status === "terminated")).toBe(true);
  });

  it("waits for each sequential compound child before starting the next", async () => {
    const handlers = new Map<string, (payload: { sessionId: string; event: string; message: unknown; }) => void>();
    listenDapEvents.mockImplementation((id: string, handler: (payload: {
      sessionId: string; event: string; message: unknown;
    }) => void) => {
      handlers.set(id, handler);
      return Promise.resolve(() => handlers.delete(id));
    });
    dapStartSession.mockImplementation((_adapterId: string, config: Record<string, unknown>) => Promise.resolve({
      sessionId: String(config.sessionId), capabilities: {}, request: "launch", arguments: config,
    }));
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    let started!: Promise<void>;
    act(() => {
      started = result.current.startDebugGroup({
        id: "all", label: "All", children: [
          { id: "one", label: "One", adapterId: "java", launchConfig: { sessionId: "sess-1" } },
          { id: "two", label: "Two", adapterId: "java", launchConfig: { sessionId: "sess-2" } },
        ],
      });
    });
    await waitFor(() => expect(handlers.has("sess-1")).toBe(true));
    expect(dapStartSession).toHaveBeenCalledTimes(1);
    act(() => handlers.get("sess-1")?.({ sessionId: "sess-1", event: "initialized", message: {} }));
    await waitFor(() => expect(handlers.has("sess-2")).toBe(true));
    expect(dapStartSession).toHaveBeenCalledTimes(2);
    await act(async () => {
      handlers.get("sess-2")?.({ sessionId: "sess-2", event: "initialized", message: {} });
      await started;
    });
    expect(result.current.sessions.map((session) => session.targetId)).toEqual(["one", "two"]);
  });

  it("stops already-started children when a parallel compound child fails", async () => {
    const handlers = new Map<string, (payload: { sessionId: string; event: string; message: unknown; }) => void>();
    listenDapEvents.mockImplementation((id: string, handler: (payload: {
      sessionId: string; event: string; message: unknown;
    }) => void) => {
      handlers.set(id, handler);
      return Promise.resolve(() => handlers.delete(id));
    });
    dapStartSession.mockImplementation((_adapterId: string, config: Record<string, unknown>) => Promise.resolve({
      sessionId: String(config.sessionId), capabilities: {}, request: "launch", arguments: config,
    }));
    let rejectBadLaunch!: (error: Error) => void;
    dapSendRequest.mockImplementation((id: string, command: string) => {
      if (id === "sess-bad" && command === "launch") {
        return new Promise((_resolve, reject) => { rejectBadLaunch = reject; });
      }
      return Promise.resolve({ breakpoints: [] });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const started = result.current.startDebugGroup({
      id: "all", label: "All", parallel: true, children: [
        { id: "ready", label: "Ready", adapterId: "java", launchConfig: { sessionId: "sess-ready" } },
        { id: "bad", label: "Bad", adapterId: "java", launchConfig: { sessionId: "sess-bad" } },
      ],
    });
    const failed = started.then(() => null, (error: unknown) => error);
    await waitFor(() => expect(handlers.size).toBe(2));
    act(() => {
      handlers.get("sess-ready")?.({ sessionId: "sess-ready", event: "initialized", message: {} });
      rejectBadLaunch(new Error("adapter rejected launch"));
    });
    await expect(failed).resolves.toMatchObject({ message: "adapter rejected launch" });
    await waitFor(() => expect(dapTerminate).toHaveBeenCalledWith("sess-ready"));
    expect(dapTerminate).toHaveBeenCalledWith("sess-bad");
    await waitFor(() => {
      expect(result.current.sessions.every((session) => session.status === "terminated")).toBe(true);
    });
  });

  it("keeps successful children alive when compound stopOnFailure is disabled", async () => {
    const handlers = new Map<string, (payload: { sessionId: string; event: string; message: unknown; }) => void>();
    listenDapEvents.mockImplementation((id: string, handler: (payload: {
      sessionId: string; event: string; message: unknown;
    }) => void) => {
      handlers.set(id, handler);
      return Promise.resolve(() => handlers.delete(id));
    });
    dapStartSession.mockImplementation((_adapterId: string, config: Record<string, unknown>) => Promise.resolve({
      sessionId: String(config.sessionId), capabilities: {}, request: "launch", arguments: config,
    }));
    let rejectBadLaunch!: (error: Error) => void;
    dapSendRequest.mockImplementation((id: string, command: string) => {
      if (id === "sess-bad" && command === "launch") {
        return new Promise((_resolve, reject) => { rejectBadLaunch = reject; });
      }
      return Promise.resolve({ breakpoints: [] });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const started = result.current.startDebugGroup({
      id: "all", label: "All", parallel: true, stopOnFailure: false, children: [
        { id: "ready", label: "Ready", adapterId: "java", launchConfig: { sessionId: "sess-ready" } },
        { id: "bad", label: "Bad", adapterId: "java", launchConfig: { sessionId: "sess-bad" } },
      ],
    });
    const failed = started.then(() => null, (error: unknown) => error);
    await waitFor(() => expect(handlers.size).toBe(2));
    act(() => {
      handlers.get("sess-ready")?.({ sessionId: "sess-ready", event: "initialized", message: {} });
      rejectBadLaunch(new Error("adapter rejected launch"));
    });
    await expect(failed).resolves.toMatchObject({ message: "adapter rejected launch" });
    expect(dapTerminate).not.toHaveBeenCalledWith("sess-ready");
    expect(result.current.sessions.find((session) => session.id === "sess-ready")?.status).toBe("running");
    await waitFor(() => {
      expect(result.current.sessions.find((session) => session.id === "sess-bad")?.status).toBe("terminated");
    });
  });

  it("only evaluates hovers while stopped", async () => {
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug);
    // Running: no frame to evaluate against, so no tooltip and no round trip.
    await expect(result.current.hoverEvaluate("total")).resolves.toBeNull();
    expect(dapSendRequest.mock.calls.some((c) => c[1] === "evaluate")).toBe(false);

    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command === "threads") return Promise.resolve({ threads: [{ id: 1, name: "main" }] });
      if (command === "stackTrace") {
        return Promise.resolve({
          stackFrames: [{ id: 10, name: "App.main", line: 9, source: { path: "/repo/App.java" } }],
        });
      }
      if (command === "scopes") return Promise.resolve({ scopes: [{ name: "Local", variablesReference: 2 }] });
      if (command === "variables") return Promise.resolve({ variables: [{ name: "total", value: "42" }] });
      if (command === "evaluate") return Promise.resolve({ result: "42", variablesReference: 0 });
      return Promise.resolve({});
    });
    await act(async () => {
      emit({ sessionId: "sess-1", event: "stopped", message: { body: { threadId: 1, reason: "breakpoint" } } });
      await Promise.resolve();
    });
    await expect(result.current.hoverEvaluate("total")).resolves.toMatchObject({ value: "42" });
    // The stopped frame's locals feed the editor's inline values.
    await waitFor(() => expect(result.current.frameVariables).toEqual({ total: "42" }));
  });

  it("bumps consoleGeneration on clearConsole and session changes, and drops stale evaluate responses", async () => {
    let resolveEval!: (value: unknown) => void;
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command === "evaluate") {
        return new Promise((resolve) => {
          resolveEval = resolve;
        });
      }
      return Promise.resolve({});
    });

    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    await startSession(result.current.startDebug);
    const gen0 = result.current.consoleGeneration;

    // Trigger an evaluate request
    const pendingEval = result.current.evaluate("staleExpr", "repl");

    // Clear console increments generation
    act(() => {
      result.current.clearConsole();
    });
    expect(result.current.consoleGeneration).toBeGreaterThan(gen0);

    // Resolve late evaluate
    resolveEval({ result: "lateValue", variablesReference: 0 });
    const evalRes = await pendingEval;
    // Late evaluation is dropped/neutralized because generation changed
    expect(evalRes.value).toBe("");
  });

  it("enforces central step lock and returns typed DebugActionResult", async () => {
    let resolveStep!: () => void;
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command === "next" || command === "stepIn") {
        return new Promise((resolve) => {
          resolveStep = () => resolve({});
        });
      }
      return Promise.resolve({});
    });

    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    await startSession(result.current.startDebug);

    let firstStepPromise!: Promise<{ kind: string; }>;
    act(() => {
      firstStepPromise = result.current.step("stepOver");
    });
    expect(result.current.isStepping).toBe(true);

    // Concurrent step should return no-op
    let secondStepResult!: { kind: string; message?: string; };
    await act(async () => {
      secondStepResult = await result.current.step("stepIn");
    });
    expect(secondStepResult.kind).toBe("no-op");

    // Resolve first step
    await act(async () => {
      resolveStep();
      await firstStepPromise;
    });
    expect(result.current.isStepping).toBe(false);
  });

  it("manages watch expressions with stable IDs and removes only single matching expressions", async () => {
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));

    let id1: string | undefined;
    let id2: string | undefined;
    act(() => {
      id1 = result.current.addWatchExpression("count") as string;
      id2 = result.current.addWatchExpression("total") as string;
    });

    expect(result.current.watchExpressions).toEqual(["count", "total"]);
    expect(result.current.watchItems.length).toBe(2);
    expect(result.current.watchItems[0]?.id).toBe(id1);
    expect(result.current.watchItems[1]?.id).toBe(id2);

    // Remove by stable ID
    act(() => {
      result.current.removeWatchExpression(id1!);
    });
    expect(result.current.watchExpressions).toEqual(["total"]);
  });
}
