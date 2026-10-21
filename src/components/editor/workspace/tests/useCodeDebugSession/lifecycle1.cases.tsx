import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import { breakpointCalls, dapSend, dapSendRequest, exceptionBreakpointCalls, startSession, useCodeDebugSession } from "./harness";

export function registeruseCodeDebugSessionLifecycle1Cases() {

  it("sends the post-change breakpoint set when one is added mid-session", async () => {
    // Regression: the sync used to run inside the setState updater and read the
    // pre-change map, so a breakpoint added while debugging was never armed.
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    await startSession(result.current.startDebug);

    act(() => result.current.toggleBreakpoint("/repo/App.java", 12));
    await waitFor(() => expect(breakpointCalls()).toHaveLength(1));
    expect(breakpointCalls()[0].lines).toEqual([12]);

    act(() => result.current.toggleBreakpoint("/repo/App.java", 7));
    await waitFor(() => expect(breakpointCalls()).toHaveLength(2));
    // Both breakpoints, in line order — not just the one that existed before.
    expect(breakpointCalls()[1].lines).toEqual([7, 12]);

    act(() => result.current.toggleBreakpoint("/repo/App.java", 12));
    await waitFor(() => expect(breakpointCalls()).toHaveLength(3));
    expect(breakpointCalls()[2].lines).toEqual([7]);
  });

  it("removes a Remove-once-hit breakpoint after its first hit", async () => {
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command === "threads") return Promise.resolve({ threads: [{ id: 1, name: "main" }] });
      if (command === "stackTrace") {
        return Promise.resolve({
          stackFrames: [{ id: 10, name: "App.main(String[])", line: 12, source: { path: "/repo/App.java" } }],
          totalFrames: 1,
        });
      }
      return Promise.resolve({ breakpoints: [] });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug);
    act(() => result.current.addBreakpoint("/repo/App.java", 12, { temporary: true }));
    await waitFor(() => expect(breakpointCalls().at(-1)?.lines).toEqual([12]));
    act(() => emit({ sessionId: "sess-1", event: "stopped", message: { body: { reason: "breakpoint", threadId: 1 } } }));
    await waitFor(() => expect(result.current.breakpoints["/repo/App.java"]).toBeUndefined());
    expect(breakpointCalls().at(-1)?.lines).toEqual([]);
    // The stop itself stays visible: a temporary breakpoint still suspends.
    expect(result.current.state?.status).toBe("stopped");
  });

  it("runs a non-suspending stack-trace breakpoint and resumes without showing a stop", async () => {
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command === "stackTrace") {
        return Promise.resolve({
          stackFrames: [
            { id: 10, name: "com.acme.App.run()", line: 20, source: { path: "/repo/App.java" } },
            { id: 11, name: "com.acme.App.main(String[])", line: 5, source: { path: "/repo/App.java" } },
          ],
        });
      }
      return Promise.resolve({ breakpoints: [] });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug);
    act(() => result.current.addBreakpoint("/repo/App.java", 20, { suspend: false, logStack: true }));
    // The adapter still suspends: only the client can print a stack trace.
    await waitFor(() => expect(breakpointCalls().at(-1)?.lines).toEqual([20]));
    const request = dapSendRequest.mock.calls.filter((call) => call[1] === "setBreakpoints").at(-1)?.[2] as {
      breakpoints: Array<{ logMessage?: string; }>;
    };
    expect(request.breakpoints[0].logMessage).toBeUndefined();
    act(() => emit({ sessionId: "sess-1", event: "stopped", message: { body: { reason: "breakpoint", threadId: 3 } } }));
    await waitFor(() => expect(dapSendRequest.mock.calls.some((call) => call[1] === "continue")).toBe(true));
    expect(dapSendRequest.mock.calls.find((call) => call[1] === "continue")?.[2]).toEqual({ threadId: 3 });
    await waitFor(() => expect(result.current.state?.output.map((line) => line.text).join("")).toContain(
      "Breakpoint reached\n\tat com.acme.App.run(App.java:20)\n\tat com.acme.App.main(App.java:5)\n",
    ));
    expect(result.current.state?.status).not.toBe("stopped");
  });

  it("arms a dependent breakpoint only after its master is hit, then disables it again", async () => {
    let topLine = 5;
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command === "threads") return Promise.resolve({ threads: [{ id: 1, name: "main" }] });
      if (command === "stackTrace") {
        return Promise.resolve({
          stackFrames: [{ id: 10, name: "App.main(String[])", line: topLine, source: { path: "/repo/App.java" } }],
        });
      }
      return Promise.resolve({ breakpoints: [] });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug);
    act(() => result.current.addBreakpoint("/repo/App.java", 5));
    act(() => result.current.addBreakpoint("/repo/App.java", 9, { dependsOn: { path: "/repo/App.java", line: 5 } }));
    await waitFor(() => expect(breakpointCalls().at(-1)?.lines).toEqual([5]));
    act(() => emit({ sessionId: "sess-1", event: "stopped", message: { body: { reason: "breakpoint", threadId: 1 } } }));
    await waitFor(() => expect(breakpointCalls().at(-1)?.lines).toEqual([5, 9]));
    act(() => emit({ sessionId: "sess-1", event: "continued", message: { body: { threadId: 1 } } }));
    topLine = 9;
    act(() => emit({ sessionId: "sess-1", event: "stopped", message: { body: { reason: "breakpoint", threadId: 1 } } }));
    // "After hit: Disable again" (the default) waits for the master once more.
    await waitFor(() => expect(breakpointCalls().at(-1)?.lines).toEqual([5]));
  });

  it("toggles a breakpoint's enabled state without removing it", async () => {
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    await startSession(result.current.startDebug);
    act(() => result.current.addBreakpoint("/repo/App.java", 4));
    act(() => result.current.toggleBreakpointEnabled("/repo/App.java", 4));
    await waitFor(() => expect(breakpointCalls().at(-1)?.lines).toEqual([]));
    expect(result.current.breakpoints["/repo/App.java"]).toEqual([{ line: 4, enabled: false }]);
    act(() => result.current.toggleBreakpointEnabled("/repo/App.java", 4));
    await waitFor(() => expect(breakpointCalls().at(-1)?.lines).toEqual([4]));
  });

  it("loads further stack pages on demand", async () => {
    dapSendRequest.mockImplementation((_id: string, command: string, args?: { startFrame?: number; }) => {
      if (command === "threads") return Promise.resolve({ threads: [{ id: 1, name: "main" }] });
      if (command === "stackTrace") {
        const start = args?.startFrame ?? 0;
        const count = start === 0 ? 40 : 5;
        return Promise.resolve({
          stackFrames: Array.from({ length: count }, (_, index) => ({
            id: 100 + start + index,
            name: `App.f${start + index}()`,
            line: 1,
            source: { path: "/repo/App.java" },
          })),
          totalFrames: 45,
        });
      }
      return Promise.resolve({ breakpoints: [] });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug);
    act(() => emit({ sessionId: "sess-1", event: "stopped", message: { body: { reason: "pause", threadId: 1 } } }));
    await waitFor(() => expect(result.current.state?.frames).toHaveLength(40));
    expect(result.current.state?.framesTotal).toBe(45);
    await act(async () => { await result.current.loadMoreFrames(); });
    expect(result.current.state?.frames).toHaveLength(45);
    expect(dapSendRequest.mock.calls.filter((call) => call[1] === "stackTrace").at(-1)?.[2])
      .toEqual({ threadId: 1, startFrame: 40, levels: 40 });
  });

  it("persists and sends a source breakpoint mode only to the active adapter", async () => {
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug, {
      breakpointModes: [
        { mode: "software", label: "Software", appliesTo: ["source"] },
        { mode: "hardware", label: "Hardware", appliesTo: ["source"] },
      ],
    });
    await act(async () => {
      emit({ sessionId: "sess-1", event: "initialized", message: {} });
      await Promise.resolve();
    });
    act(() => result.current.toggleBreakpoint("/repo/App.java", 12));
    await waitFor(() => expect(breakpointCalls()).toHaveLength(1));
    expect(breakpointCalls()[0].modes).toEqual(["software"]);

    act(() => result.current.setBreakpointMode("/repo/App.java", 12, "hardware"));
    await waitFor(() => expect(breakpointCalls()).toHaveLength(2));
    expect(breakpointCalls()[1].modes).toEqual(["hardware"]);
    expect(result.current.breakpoints["/repo/App.java"]).toEqual([{
      line: 12,
      adapterModes: { java: "hardware" },
    }]);
    expect(JSON.parse(
      window.localStorage.getItem("taomni.codeWorkspace.debugBreakpoints.v1.ws-1") ?? "{}",
    )).toEqual(result.current.breakpoints);
  });

  it("pushes a condition as soon as it is set, without a second toggle", async () => {
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    await startSession(result.current.startDebug);
    act(() => result.current.toggleBreakpoint("/repo/App.java", 12));
    await waitFor(() => expect(breakpointCalls()).toHaveLength(1));

    act(() => result.current.setBreakpointOptions("/repo/App.java", 12, { condition: "i > 3" }));
    await waitFor(() => expect(breakpointCalls()).toHaveLength(2));
    const request = dapSendRequest.mock.calls.filter((c) => c[1] === "setBreakpoints").at(-1);
    expect((request?.[2] as { breakpoints: { condition?: string; }[]; }).breakpoints[0].condition).toBe("i > 3");
  });

  it("keeps disabled breakpoints listed but does not arm them", async () => {
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    await startSession(result.current.startDebug);
    act(() => result.current.toggleBreakpoint("/repo/App.java", 12));
    await waitFor(() => expect(breakpointCalls()).toHaveLength(1));

    act(() => result.current.setBreakpointOptions("/repo/App.java", 12, { enabled: false }));
    await waitFor(() => expect(breakpointCalls()).toHaveLength(2));
    expect(breakpointCalls()[1].lines).toEqual([]);
    expect(result.current.breakpoints["/repo/App.java"]).toEqual([{ line: 12, enabled: false }]);
  });

  it("mutes every file's breakpoints and restores them on unmute", async () => {
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    await startSession(result.current.startDebug);
    act(() => result.current.toggleBreakpoint("/repo/A.java", 3));
    act(() => result.current.toggleBreakpoint("/repo/B.java", 9));
    await waitFor(() => expect(breakpointCalls()).toHaveLength(2));

    act(() => result.current.setBreakpointsMuted(true));
    await waitFor(() => expect(breakpointCalls()).toHaveLength(4));
    expect(breakpointCalls().slice(2).every((call) => call.lines.length === 0)).toBe(true);
    expect(result.current.breakpointsMuted).toBe(true);

    act(() => result.current.setBreakpointsMuted(false));
    await waitFor(() => expect(breakpointCalls()).toHaveLength(6));
    expect(breakpointCalls().slice(4).map((c) => c.lines)).toEqual([[3], [9]]);
  });

  it("ignores a stale setBreakpoints response when a newer one is in flight", async () => {
    // Two quick toggles: the first response resolves last and must not revive
    // the set it was built from.
    const resolvers: ((body: unknown) => void)[] = [];
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command !== "setBreakpoints") return Promise.resolve({});
      return new Promise((resolve) => resolvers.push(resolve));
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    await startSession(result.current.startDebug);

    act(() => result.current.toggleBreakpoint("/repo/App.java", 12));
    act(() => result.current.toggleBreakpoint("/repo/App.java", 20));
    await waitFor(() => expect(resolvers).toHaveLength(2));

    await act(async () => {
      // Newest first, then the stale one — the adapter moved line 12 to 13.
      resolvers[1]({ breakpoints: [{ id: 2, verified: true, line: 12 }, { id: 3, verified: true, line: 20 }] });
      resolvers[0]({ breakpoints: [{ id: 1, verified: true, line: 13 }] });
      await Promise.resolve();
    });
    expect(result.current.breakpoints["/repo/App.java"]).toEqual([{ line: 12 }, { line: 20 }]);
  });

  it("adopts the line the adapter actually bound and reports verification", async () => {
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command !== "setBreakpoints") return Promise.resolve({});
      // The adapter moved the breakpoint to the next executable line.
      return Promise.resolve({ breakpoints: [{ id: 5, verified: true, line: 14 }] });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    await startSession(result.current.startDebug);
    act(() => result.current.toggleBreakpoint("/repo/App.java", 12));

    await waitFor(() => expect(result.current.breakpoints["/repo/App.java"]).toEqual([{ line: 14 }]));
    expect(result.current.breakpointRuntime["/repo/App.java"]).toEqual({
      14: { status: "verified", message: null },
    });
  });

  it("marks an unbindable breakpoint failed with the adapter's reason", async () => {
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command !== "setBreakpoints") return Promise.resolve({});
      return Promise.resolve({
        breakpoints: [{ id: 6, verified: false, line: 12, reason: "failed", message: "No executable code" }],
      });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    await startSession(result.current.startDebug);
    act(() => result.current.toggleBreakpoint("/repo/App.java", 12));

    // Unverified must NOT read as verified: it carries a failed status + reason.
    await waitFor(() => expect(result.current.breakpointRuntime["/repo/App.java"]).toEqual({
      12: { status: "failed", message: "No executable code" },
    }));
  });

  it("configures breakpoints before releasing the debuggee on `initialized`", async () => {
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    act(() => result.current.toggleBreakpoint("/repo/App.java", 4));
    const emit = await startSession(result.current.startDebug, {
      exceptionBreakpointFilters: [{ filter: "uncaught", label: "Uncaught" }],
    });

    await act(async () => {
      emit({ sessionId: "sess-1", event: "initialized", message: {} });
      await Promise.resolve();
    });
    await waitFor(() => expect(dapSend).toHaveBeenCalledWith("sess-1", "configurationDone"));
    // Order matters: an adapter that resumes on configurationDone must already
    // have the breakpoints.
    const commands = dapSendRequest.mock.calls.map((call) => call[1]);
    expect(commands.indexOf("setBreakpoints")).toBeLessThan(commands.indexOf("setExceptionBreakpoints"));
    expect(breakpointCalls()[0].lines).toEqual([4]);
  });

  it("persists adapter defaults and binds conditional exception filters before configurationDone", async () => {
    dapSendRequest.mockImplementation((_id: string, command: string, args?: unknown) => {
      if (command !== "setExceptionBreakpoints") return Promise.resolve({ breakpoints: [] });
      const request = args as {
        filters: string[];
        filterOptions?: { filterId: string; condition: string; }[];
      };
      return Promise.resolve({
        breakpoints: [
          ...request.filters,
          ...(request.filterOptions ?? []).map((option) => option.filterId),
        ].map((_filterId, index) => ({ id: 70 + index, verified: true })),
      });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug, {
      supportsExceptionFilterOptions: true,
      exceptionBreakpointFilters: [
        {
          filter: "caught",
          label: "Caught",
          default: true,
          supportsCondition: true,
          conditionDescription: "Exception class",
        },
        { filter: "uncaught", label: "Uncaught" },
      ],
    });

    expect(result.current.availableExceptionFilters[0]).toMatchObject({
      filter: "caught",
      default: true,
      supportsCondition: true,
    });
    expect(result.current.exceptionBreakpoints).toEqual([
      { adapterId: "java", filterId: "caught", enabled: true },
      { adapterId: "java", filterId: "uncaught", enabled: false },
    ]);
    act(() => result.current.setExceptionBreakpointOptions("caught", {
      condition: " exception instanceof IOException ",
    }));
    expect(JSON.parse(
      window.localStorage.getItem("taomni.codeWorkspace.debugExceptionBreakpoints.v1.ws-1") ?? "[]",
    )).toEqual([
      {
        adapterId: "java",
        filterId: "caught",
        enabled: true,
        condition: "exception instanceof IOException",
      },
      { adapterId: "java", filterId: "uncaught", enabled: false },
    ]);

    await act(async () => {
      emit({ sessionId: "sess-1", event: "initialized", message: {} });
      await Promise.resolve();
    });
    await waitFor(() => expect(exceptionBreakpointCalls()).toEqual([{
      sessionId: "sess-1",
      filters: [],
      filterOptions: [{
        filterId: "caught",
        condition: "exception instanceof IOException",
      }],
    }]));
    expect(result.current.exceptionBreakpointRuntime.caught).toEqual({
      status: "verified",
      message: null,
    });
    const exceptionCallIndex = dapSendRequest.mock.calls.findIndex(
      (call) => call[1] === "setExceptionBreakpoints",
    );
    const configurationDoneIndex = dapSend.mock.calls.findIndex(
      (call) => call[1] === "configurationDone",
    );
    expect(dapSendRequest.mock.invocationCallOrder[exceptionCallIndex]).toBeLessThan(
      dapSend.mock.invocationCallOrder[configurationDoneIndex],
    );

    act(() => emit({
      sessionId: "sess-1",
      event: "breakpoint",
      message: {
        body: {
          reason: "changed",
          breakpoint: { id: 70, verified: false, reason: "failed", message: "Invalid condition" },
        },
      },
    }));
    expect(result.current.exceptionBreakpointRuntime.caught).toEqual({
      status: "failed",
      message: "Invalid condition",
    });
  });

  it("sends a selected exception breakpoint mode through filterOptions", async () => {
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug, {
      supportsExceptionFilterOptions: true,
      breakpointModes: [
        { mode: "software", label: "Software", appliesTo: ["exception"] },
        { mode: "hardware", label: "Hardware", appliesTo: ["exception"] },
      ],
      exceptionBreakpointFilters: [{ filter: "all", label: "All", default: true }],
    });
    await act(async () => {
      emit({ sessionId: "sess-1", event: "initialized", message: {} });
      await Promise.resolve();
    });
    await waitFor(() => expect(exceptionBreakpointCalls()).toHaveLength(1));
    expect(exceptionBreakpointCalls()[0].filterOptions).toEqual([{
      filterId: "all",
      mode: "software",
    }]);
    act(() => result.current.setExceptionBreakpointOptions("all", { mode: "hardware" }));
    await waitFor(() => expect(exceptionBreakpointCalls()).toHaveLength(2));
    expect(exceptionBreakpointCalls()[1].filterOptions).toEqual([{
      filterId: "all",
      mode: "hardware",
    }]);
  });
}
