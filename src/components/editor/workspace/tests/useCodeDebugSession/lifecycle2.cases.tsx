import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { dapSend, dapSendRequest, exceptionBreakpointCalls, functionBreakpointCalls, startSession, useCodeDebugSession } from "./harness";

export function registeruseCodeDebugSessionLifecycle2Cases() {

  it("persists, binds, mutes, and removes capability-gated exception path rules", async () => {
    dapSendRequest.mockImplementation((_id: string, command: string, args?: unknown) => {
      if (command !== "setExceptionBreakpoints") return Promise.resolve({ breakpoints: [] });
      const request = args as {
        filters: string[];
        filterOptions?: unknown[];
        exceptionOptions?: unknown[];
      };
      const count = request.filters.length
        + (request.filterOptions?.length ?? 0)
        + (request.exceptionOptions?.length ?? 0);
      return Promise.resolve({
        breakpoints: Array.from({ length: count }, (_, index) => ({
          id: 90 + index,
          verified: true,
        })),
      });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug, {
      supportsExceptionOptions: true,
      exceptionBreakpointFilters: [{ filter: "all", label: "All Exceptions" }],
    });

    let ruleId: string | null = null;
    act(() => {
      ruleId = result.current.addExceptionBreakpointRule([{
        names: [" Java Exceptions ", "Java Exceptions"],
      }, {
        names: [" java.io.IOException ", "java.sql.SQLException"],
      }], "unhandled");
    });
    expect(ruleId).toEqual(expect.any(String));
    act(() => result.current.setExceptionBreakpointRuleOptions(ruleId!, {
      path: [
        { names: ["Java Exceptions"] },
        { names: ["java.io.IOException", "java.sql.SQLException"] },
        { names: ["sun.*"], negate: true },
      ],
      breakMode: "userUnhandled",
    }));
    expect(result.current.exceptionBreakpointRules).toEqual([{
      id: ruleId,
      adapterId: "java",
      path: [
        { names: ["Java Exceptions"] },
        { names: ["java.io.IOException", "java.sql.SQLException"] },
        { names: ["sun.*"], negate: true },
      ],
      breakMode: "userUnhandled",
      enabled: true,
    }]);
    expect(JSON.parse(
      window.localStorage.getItem("taomni.codeWorkspace.debugExceptionBreakpointRules.v1.ws-1") ?? "[]",
    )).toEqual(result.current.exceptionBreakpointRules);

    await act(async () => {
      emit({ sessionId: "sess-1", event: "initialized", message: {} });
      await Promise.resolve();
    });
    await waitFor(() => expect(exceptionBreakpointCalls()).toEqual([{
      sessionId: "sess-1",
      filters: [],
      exceptionOptions: [{
        path: [
          { names: ["Java Exceptions"] },
          { names: ["java.io.IOException", "java.sql.SQLException"] },
          { names: ["sun.*"], negate: true },
        ],
        breakMode: "userUnhandled",
      }],
    }]));
    expect(result.current.exceptionBreakpointRuleRuntime[ruleId!]).toEqual({
      status: "verified",
      message: null,
    });

    act(() => emit({
      sessionId: "sess-1",
      event: "breakpoint",
      message: {
        body: {
          reason: "changed",
          breakpoint: { id: 90, verified: false, reason: "failed", message: "Unknown class" },
        },
      },
    }));
    expect(result.current.exceptionBreakpointRuleRuntime[ruleId!]).toEqual({
      status: "failed",
      message: "Unknown class",
    });

    act(() => result.current.setBreakpointsMuted(true));
    await waitFor(() => expect(exceptionBreakpointCalls()).toHaveLength(2));
    expect(exceptionBreakpointCalls()[1]).toEqual({ sessionId: "sess-1", filters: [] });
    expect(result.current.exceptionBreakpointRules[0].enabled).toBe(true);

    act(() => result.current.setBreakpointsMuted(false));
    await waitFor(() => expect(exceptionBreakpointCalls()).toHaveLength(3));
    expect(exceptionBreakpointCalls()[2].exceptionOptions).toHaveLength(1);

    act(() => result.current.removeExceptionBreakpointRule(ruleId!));
    await waitFor(() => expect(exceptionBreakpointCalls()).toHaveLength(4));
    expect(exceptionBreakpointCalls()[3]).toEqual({ sessionId: "sess-1", filters: [] });
    expect(result.current.exceptionBreakpointRules).toEqual([]);
    expect(window.localStorage.getItem(
      "taomni.codeWorkspace.debugExceptionBreakpointRules.v1.ws-1",
    )).toBe("[]");
  });

  it("keeps saved exception rules visible but does not send them to unsupported adapters", async () => {
    window.localStorage.setItem(
      "taomni.codeWorkspace.debugExceptionBreakpointRules.v1.ws-1",
      JSON.stringify([
        {
          id: "io-errors",
          adapterId: "java",
          path: [{ names: ["java.io.*"] }],
          breakMode: "always",
          enabled: true,
        },
        {
          id: "corrupt-broad-rule",
          adapterId: "java",
          path: [{ names: [] }],
          breakMode: "always",
          enabled: true,
        },
      ]),
    );
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug, {
      exceptionBreakpointFilters: [{ filter: "all", label: "All Exceptions" }],
    });
    expect(result.current.addExceptionBreakpointRule([{ names: ["java.sql.*"] }])).toBeNull();
    await act(async () => {
      emit({ sessionId: "sess-1", event: "initialized", message: {} });
      await Promise.resolve();
    });
    await waitFor(() => expect(exceptionBreakpointCalls()).toEqual([{
      sessionId: "sess-1",
      filters: [],
    }]));
    expect(result.current.exceptionBreakpointRules).toHaveLength(1);
    expect(result.current.exceptionBreakpointRuleRuntime["io-errors"]).toEqual({
      status: "failed",
      message: "The selected debug adapter does not support exception path rules",
    });
  });

  it("mutes, restores, and removes exception breakpoints with the global breakpoint actions", async () => {
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug, {
      supportsExceptionOptions: true,
      exceptionBreakpointFilters: [{
        filter: "uncaught",
        label: "Uncaught",
        default: true,
      }],
    });
    act(() => {
      result.current.addExceptionBreakpointRule([{ names: ["java.io.IOException"] }]);
    });
    await act(async () => {
      emit({ sessionId: "sess-1", event: "initialized", message: {} });
      await Promise.resolve();
    });
    await waitFor(() => expect(exceptionBreakpointCalls()).toHaveLength(1));
    expect(exceptionBreakpointCalls()[0].filters).toEqual(["uncaught"]);
    expect(exceptionBreakpointCalls()[0].exceptionOptions).toHaveLength(1);

    act(() => result.current.setBreakpointsMuted(true));
    await waitFor(() => expect(exceptionBreakpointCalls()).toHaveLength(2));
    expect(exceptionBreakpointCalls()[1].filters).toEqual([]);
    expect(result.current.exceptionBreakpoints[0].enabled).toBe(true);

    act(() => result.current.setBreakpointsMuted(false));
    await waitFor(() => expect(exceptionBreakpointCalls()).toHaveLength(3));
    expect(exceptionBreakpointCalls()[2].filters).toEqual(["uncaught"]);
    expect(exceptionBreakpointCalls()[2].exceptionOptions).toHaveLength(1);

    act(() => result.current.removeAllBreakpoints());
    await waitFor(() => expect(exceptionBreakpointCalls()).toHaveLength(4));
    expect(exceptionBreakpointCalls()[3].filters).toEqual([]);
    expect(result.current.exceptionBreakpoints[0].enabled).toBe(false);
    expect(result.current.exceptionBreakpointRules).toEqual([]);
    expect(JSON.parse(
      window.localStorage.getItem("taomni.codeWorkspace.debugExceptionBreakpoints.v1.ws-1") ?? "[]",
    )[0].enabled).toBe(false);
    expect(window.localStorage.getItem(
      "taomni.codeWorkspace.debugExceptionBreakpointRules.v1.ws-1",
    )).toBe("[]");
  });

  it("ignores a stale exception-breakpoint response after a newer replacement", async () => {
    const resolvers: ((body: unknown) => void)[] = [];
    let exceptionRequestCount = 0;
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command !== "setExceptionBreakpoints") return Promise.resolve({ breakpoints: [] });
      exceptionRequestCount += 1;
      if (exceptionRequestCount === 1) {
        return Promise.resolve({ breakpoints: [{ id: 80, verified: true }] });
      }
      return new Promise((resolve) => resolvers.push(resolve));
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug, {
      exceptionBreakpointFilters: [{
        filter: "uncaught",
        label: "Uncaught",
        default: true,
      }],
    });
    await act(async () => {
      emit({ sessionId: "sess-1", event: "initialized", message: {} });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.exceptionBreakpointRuntime.uncaught).toEqual({
      status: "verified",
      message: null,
    }));

    act(() => {
      result.current.setExceptionBreakpointOptions("uncaught", { enabled: false });
      result.current.setExceptionBreakpointOptions("uncaught", { enabled: true });
    });
    await waitFor(() => expect(resolvers).toHaveLength(2));
    await act(async () => {
      resolvers[1]({ breakpoints: [{ id: 82, verified: true }] });
      resolvers[0]({ breakpoints: [] });
      await Promise.resolve();
    });
    expect(result.current.exceptionBreakpointRuntime.uncaught).toEqual({
      status: "verified",
      message: null,
    });
  });

  it("persists and binds function breakpoints before configurationDone", async () => {
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command === "setFunctionBreakpoints") {
        return Promise.resolve({ breakpoints: [{ id: 41, verified: true }] });
      }
      return Promise.resolve({ breakpoints: [] });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    act(() => result.current.addFunctionBreakpoint("Service.run"));
    act(() => result.current.setFunctionBreakpointOptions("Service.run", {
      condition: "ready",
      hitCondition: "3",
    }));
    expect(JSON.parse(
      window.localStorage.getItem("taomni.codeWorkspace.debugFunctionBreakpoints.v1.ws-1") ?? "[]",
    )).toEqual([{ name: "Service.run", condition: "ready", hitCondition: "3" }]);

    const emit = await startSession(result.current.startDebug, {
      supportsFunctionBreakpoints: true,
      exceptionBreakpointFilters: [{ filter: "uncaught", label: "Uncaught" }],
    });
    await act(async () => {
      emit({ sessionId: "sess-1", event: "initialized", message: {} });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.functionBreakpointRuntime["Service.run"]).toEqual({
      status: "verified",
      message: null,
    }));
    expect(functionBreakpointCalls()).toEqual([{
      sessionId: "sess-1",
      breakpoints: [{ name: "Service.run", condition: "ready", hitCondition: "3" }],
    }]);
    const commands = dapSendRequest.mock.calls.map((call) => call[1]);
    expect(commands.indexOf("setFunctionBreakpoints")).toBeLessThan(
      commands.indexOf("setExceptionBreakpoints"),
    );
    expect(dapSend).toHaveBeenCalledWith("sess-1", "configurationDone");

    act(() => emit({
      sessionId: "sess-1",
      event: "breakpoint",
      message: {
        body: {
          reason: "changed",
          breakpoint: {
            id: 41,
            verified: false,
            reason: "failed",
            message: "method unloaded",
          },
        },
      },
    }));
    expect(result.current.functionBreakpointRuntime["Service.run"]).toEqual({
      status: "failed",
      message: "method unloaded",
    });
  });

  it("normalizes function-breakpoint fields before storing or syncing them", () => {
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const longName = "n".repeat(1100);
    const longCondition = "c".repeat(4200);
    const longHitCondition = "7".repeat(4200);

    act(() => result.current.addFunctionBreakpoint(`  ${longName}  `));
    const name = result.current.functionBreakpoints[0].name;
    expect(name).toHaveLength(1024);
    act(() => result.current.setFunctionBreakpointOptions(name, {
      condition: `  ${longCondition}  `,
      hitCondition: `  ${longHitCondition}  `,
    }));

    expect(result.current.functionBreakpoints[0].condition).toHaveLength(4096);
    expect(result.current.functionBreakpoints[0].hitCondition).toHaveLength(4096);
    act(() => result.current.setFunctionBreakpointOptions(name, { condition: "   " }));
    expect(result.current.functionBreakpoints[0].condition).toBeUndefined();
    expect(JSON.parse(
      window.localStorage.getItem("taomni.codeWorkspace.debugFunctionBreakpoints.v1.ws-1") ?? "[]",
    )).toEqual(result.current.functionBreakpoints);
  });

  it("ignores a stale function-breakpoint response after a newer edit", async () => {
    const resolvers: ((body: unknown) => void)[] = [];
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command === "setFunctionBreakpoints") {
        return new Promise((resolve) => resolvers.push(resolve));
      }
      return Promise.resolve({ breakpoints: [] });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    act(() => result.current.addFunctionBreakpoint("Service.run"));
    const emit = await startSession(result.current.startDebug, { supportsFunctionBreakpoints: true });
    act(() => emit({ sessionId: "sess-1", event: "initialized", message: {} }));
    await waitFor(() => expect(resolvers).toHaveLength(1));

    act(() => result.current.setFunctionBreakpointOptions("Service.run", { condition: "ready" }));
    await waitFor(() => expect(resolvers).toHaveLength(2));
    await act(async () => {
      resolvers[1]({ breakpoints: [{ id: 52, verified: true }] });
      resolvers[0]({
        breakpoints: [{ id: 51, verified: false, reason: "failed", message: "stale" }],
      });
      await Promise.resolve();
    });
    expect(result.current.functionBreakpointRuntime["Service.run"]).toEqual({
      status: "verified",
      message: null,
    });
  });

  it("drops a function-breakpoint response that arrives after termination", async () => {
    let resolveFunctionBreakpoints: ((body: unknown) => void) | null = null;
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command === "setFunctionBreakpoints") {
        return new Promise((resolve) => { resolveFunctionBreakpoints = resolve; });
      }
      return Promise.resolve({ breakpoints: [] });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    act(() => result.current.addFunctionBreakpoint("Service.run"));
    const emit = await startSession(result.current.startDebug, { supportsFunctionBreakpoints: true });
    act(() => emit({ sessionId: "sess-1", event: "initialized", message: {} }));
    await waitFor(() => expect(resolveFunctionBreakpoints).not.toBeNull());
    expect(result.current.functionBreakpointRuntime["Service.run"]).toEqual({
      status: "pending",
      message: null,
    });

    await act(async () => result.current.terminate());
    await waitFor(() => expect(result.current.state?.status).toBe("terminated"));
    expect(result.current.functionBreakpointRuntime).toEqual({});
    await act(async () => {
      resolveFunctionBreakpoints?.({ breakpoints: [{ id: 61, verified: true }] });
      await Promise.resolve();
    });
    expect(result.current.functionBreakpointRuntime).toEqual({});
  });

  it("clears live threads when the session is stopped by the user", async () => {
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug);
    act(() => emit({ sessionId: "sess-1", event: "initialized", message: {} }));
    act(() => emit({
      sessionId: "sess-1",
      event: "thread",
      message: { body: { reason: "started", threadId: 3 } },
    }));
    await waitFor(() => expect(result.current.state?.threads).toEqual([{ id: 3, name: "Thread 3" }]));

    await act(async () => result.current.terminate());
    await waitFor(() => expect(result.current.state?.status).toBe("terminated"));
    // A terminated debuggee has no threads to expand into a call stack.
    expect(result.current.state?.threads).toEqual([]);
    expect(result.current.state?.frames).toEqual([]);
  });

  it("keeps saved function breakpoints visible when the adapter is unsupported", async () => {
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    act(() => result.current.addFunctionBreakpoint("Service.run"));
    const emit = await startSession(result.current.startDebug);
    await act(async () => {
      emit({ sessionId: "sess-1", event: "initialized", message: {} });
      await Promise.resolve();
    });
    await waitFor(() => expect(result.current.functionBreakpointRuntime["Service.run"]).toEqual({
      status: "failed",
      message: "The selected debug adapter does not support function breakpoints",
    }));
    expect(functionBreakpointCalls()).toEqual([]);
    expect(result.current.functionBreakpoints).toEqual([{ name: "Service.run" }]);
  });
}
