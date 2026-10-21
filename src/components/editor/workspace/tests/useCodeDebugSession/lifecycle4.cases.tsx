import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import {
  dapSendRequest,
  dapStartSession,
  dataBreakpointCalls,
  dataBreakpointKey,
  exceptionBreakpointCalls,
  listenDapEvents,
  startSession,
  useCodeDebugSession,
} from "./harness";

export function registeruseCodeDebugSessionLifecycle4Cases() {

  it("discovers, persists, arms, edits and removes a data breakpoint", async () => {
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command === "dataBreakpointInfo") {
        return Promise.resolve({
          dataId: "field:Service.count",
          description: "Service.count",
          accessTypes: ["read", "write"],
          canPersist: true,
        });
      }
      if (command === "setDataBreakpoints") {
        const args = dapSendRequest.mock.calls.at(-1)?.[2] as { breakpoints: unknown[]; };
        return Promise.resolve({
          breakpoints: args.breakpoints.map((_entry, index) => ({ id: 81 + index, verified: true })),
        });
      }
      return Promise.resolve({ breakpoints: [] });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug, {
      supportsDataBreakpoints: true,
      breakpointModes: [
        { mode: "software", label: "Software", appliesTo: ["data"] },
        { mode: "hardware", label: "Hardware", appliesTo: ["data"] },
      ],
    });
    await act(async () => {
      emit({ sessionId: "sess-1", event: "initialized", message: {} });
      await Promise.resolve();
    });
    await waitFor(() => expect(dataBreakpointCalls()).toHaveLength(1));
    expect(dataBreakpointCalls()[0].breakpoints).toEqual([]);

    act(() => emit({
      sessionId: "sess-1",
      event: "stopped",
      message: { body: { threadId: 1, reason: "breakpoint" } },
    }));
    await waitFor(() => expect(result.current.state?.status).toBe("stopped"));
    let addResult: { added: boolean; message: string; } | undefined;
    await act(async () => {
      addResult = await result.current.addDataBreakpoint({
        name: "count",
        variablesReference: 2,
        frameId: 10,
        mode: "hardware",
      });
    });
    expect(addResult?.added).toBe(true);
    await waitFor(() => expect(result.current.dataBreakpoints).toHaveLength(1));
    const breakpoint = result.current.dataBreakpoints[0];
    const key = dataBreakpointKey(breakpoint);
    expect(breakpoint.canPersist).toBe(true);
    expect(JSON.parse(
      window.localStorage.getItem("taomni.codeWorkspace.debugDataBreakpoints.v1.ws-1") ?? "[]",
    )).toEqual(result.current.dataBreakpoints);
    expect(dapSendRequest.mock.calls.some((call) => (
      call[1] === "dataBreakpointInfo"
      && (call[2] as { name: string; variablesReference?: number; }).name === "count"
      && (call[2] as { variablesReference?: number; }).variablesReference === 2
      && (call[2] as { mode?: string; }).mode === "hardware"
      && !(call[2] as { frameId?: number; }).frameId
    ))).toBe(true);
    await waitFor(() => expect(result.current.dataBreakpointRuntime[key]).toEqual({
      status: "verified",
      message: null,
    }));

    act(() => result.current.setDataBreakpointOptions(key, {
      accessType: "read",
      condition: "ready",
      hitCondition: "2",
    }));
    await waitFor(() => expect(dataBreakpointCalls().at(-1)?.breakpoints).toEqual([{
      dataId: "field:Service.count",
      accessType: "read",
      condition: "ready",
      hitCondition: "2",
    }]));
    act(() => emit({
      sessionId: "sess-1",
      event: "breakpoint",
      message: {
        body: {
          breakpoint: { id: 81, verified: false, reason: "failed", message: "field unloaded" },
        },
      },
    }));
    expect(result.current.dataBreakpointRuntime[key]).toEqual({
      status: "failed",
      message: "field unloaded",
    });
    act(() => result.current.removeDataBreakpoint(key));
    await waitFor(() => expect(result.current.dataBreakpoints).toEqual([]));
    expect(dataBreakpointCalls().at(-1)?.breakpoints).toEqual([]);
  });

  it("resolves and persists an address byte range only when the adapter advertises support", async () => {
    dapSendRequest.mockImplementation((_id: string, command: string, args?: unknown) => {
      if (command === "dataBreakpointInfo") {
        expect(args).toEqual({
          name: "0x1000",
          asAddress: true,
          bytes: 16,
        });
        return Promise.resolve({
          dataId: "address:1000/16",
          description: "0x1000 (16 bytes)",
          accessTypes: ["write"],
          canPersist: true,
        });
      }
      if (command === "setDataBreakpoints") {
        return Promise.resolve({ breakpoints: [{ id: 121, verified: true }] });
      }
      return Promise.resolve({ breakpoints: [] });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug, {
      supportsDataBreakpoints: true,
      supportsDataBreakpointBytes: true,
    });
    act(() => emit({ sessionId: "sess-1", event: "initialized", message: {} }));
    act(() => emit({
      sessionId: "sess-1",
      event: "stopped",
      message: { body: { threadId: 1, reason: "breakpoint" } },
    }));
    await waitFor(() => expect(result.current.state?.status).toBe("stopped"));
    let addResult: { added: boolean; message: string; } | undefined;
    await act(async () => {
      addResult = await result.current.addDataBreakpoint({
        name: "0x1000",
        bytes: 16,
        asAddress: true,
      });
    });
    expect(addResult?.added).toBe(true);
    expect(result.current.dataBreakpoints[0]).toMatchObject({
      bytes: 16,
      asAddress: true,
      canPersist: true,
    });
    expect(JSON.parse(
      window.localStorage.getItem("taomni.codeWorkspace.debugDataBreakpoints.v1.ws-1") ?? "[]",
    )[0]).toMatchObject({ bytes: 16, asAddress: true });
  });

  it("rejects address/range discovery when supportsDataBreakpointBytes is absent", async () => {
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug, { supportsDataBreakpoints: true });
    act(() => emit({ sessionId: "sess-1", event: "initialized", message: {} }));
    act(() => emit({
      sessionId: "sess-1",
      event: "stopped",
      message: { body: { threadId: 1, reason: "breakpoint" } },
    }));
    await waitFor(() => expect(result.current.state?.status).toBe("stopped"));
    let addResult: { added: boolean; message: string; } | undefined;
    await act(async () => {
      addResult = await result.current.addDataBreakpoint({ name: "0x1000", asAddress: true });
    });
    expect(addResult).toEqual({
      added: false,
      message: "The selected debug adapter does not support address/range data breakpoints",
    });
    expect(dapSendRequest.mock.calls.some((call) => call[1] === "dataBreakpointInfo")).toBe(false);
  });

  it("rejects a data breakpoint when execution resumes during discovery", async () => {
    let resolveInfo: ((body: unknown) => void) | null = null;
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command === "dataBreakpointInfo") {
        return new Promise((resolve) => { resolveInfo = resolve; });
      }
      return Promise.resolve({ breakpoints: [] });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug, { supportsDataBreakpoints: true });
    act(() => emit({ sessionId: "sess-1", event: "initialized", message: {} }));
    act(() => emit({
      sessionId: "sess-1",
      event: "stopped",
      message: { body: { threadId: 1, reason: "breakpoint" } },
    }));
    await waitFor(() => expect(result.current.state?.status).toBe("stopped"));

    let pending!: Promise<{ added: boolean; message: string; }>;
    act(() => {
      pending = result.current.addDataBreakpoint({ name: "count", frameId: 10 });
    });
    await waitFor(() => expect(resolveInfo).not.toBeNull());
    act(() => emit({ sessionId: "sess-1", event: "continued", message: {} }));
    expect(result.current.state?.status).toBe("running");

    let addResult: { added: boolean; message: string; } | undefined;
    await act(async () => {
      resolveInfo?.({
        dataId: "frame-local:count",
        description: "count",
        canPersist: false,
      });
      addResult = await pending;
    });
    expect(addResult).toEqual({
      added: false,
      message: "Execution resumed before the data breakpoint was resolved",
    });
    expect(result.current.dataBreakpoints).toEqual([]);
  });

  it("ignores a stale data-breakpoint response after a newer edit", async () => {
    window.localStorage.setItem(
      "taomni.codeWorkspace.debugDataBreakpoints.v1.ws-1",
      JSON.stringify([{
        dataId: "field:Service.count",
        description: "Service.count",
        adapterId: "java",
        accessTypes: ["read", "write"],
        accessType: "write",
        canPersist: true,
      }]),
    );
    const resolvers: ((body: unknown) => void)[] = [];
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command === "setDataBreakpoints") {
        return new Promise((resolve) => resolvers.push(resolve));
      }
      return Promise.resolve({ breakpoints: [] });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug, { supportsDataBreakpoints: true });
    act(() => emit({ sessionId: "sess-1", event: "initialized", message: {} }));
    await waitFor(() => expect(resolvers).toHaveLength(1));
    const key = dataBreakpointKey(result.current.dataBreakpoints[0]);

    act(() => result.current.setDataBreakpointOptions(key, { condition: "ready" }));
    await waitFor(() => expect(resolvers).toHaveLength(2));
    await act(async () => {
      resolvers[1]({ breakpoints: [{ id: 102, verified: true }] });
      resolvers[0]({
        breakpoints: [{ id: 101, verified: false, reason: "failed", message: "stale" }],
      });
      await Promise.resolve();
    });
    expect(result.current.dataBreakpointRuntime[key]).toEqual({
      status: "verified",
      message: null,
    });
  });

  it("drops a data-breakpoint response that arrives after termination", async () => {
    window.localStorage.setItem(
      "taomni.codeWorkspace.debugDataBreakpoints.v1.ws-1",
      JSON.stringify([{
        dataId: "field:Service.count",
        description: "Service.count",
        adapterId: "java",
        accessTypes: ["write"],
        accessType: "write",
        canPersist: true,
      }]),
    );
    let resolveDataBreakpoints: ((body: unknown) => void) | null = null;
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command === "setDataBreakpoints") {
        return new Promise((resolve) => { resolveDataBreakpoints = resolve; });
      }
      return Promise.resolve({ breakpoints: [] });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug, { supportsDataBreakpoints: true });
    act(() => emit({ sessionId: "sess-1", event: "initialized", message: {} }));
    await waitFor(() => expect(resolveDataBreakpoints).not.toBeNull());
    expect(Object.values(result.current.dataBreakpointRuntime)).toEqual([{
      status: "pending",
      message: null,
    }]);

    await act(async () => result.current.terminate());
    await waitFor(() => expect(result.current.state?.status).toBe("terminated"));
    expect(result.current.dataBreakpointRuntime).toEqual({});
    await act(async () => {
      resolveDataBreakpoints?.({ breakpoints: [{ id: 103, verified: true }] });
      await Promise.resolve();
    });
    expect(result.current.dataBreakpointRuntime).toEqual({});
  });

  it("keeps non-persistent data ids session-scoped and removes them on termination", async () => {
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command === "dataBreakpointInfo") {
        return Promise.resolve({ dataId: "frame-local:count", description: "count", canPersist: false });
      }
      if (command === "setDataBreakpoints") return Promise.resolve({ breakpoints: [{ id: 91, verified: true }] });
      return Promise.resolve({ breakpoints: [] });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug, { supportsDataBreakpoints: true });
    act(() => emit({ sessionId: "sess-1", event: "initialized", message: {} }));
    act(() => emit({
      sessionId: "sess-1",
      event: "stopped",
      message: { body: { threadId: 1, reason: "breakpoint" } },
    }));
    await waitFor(() => expect(result.current.state?.status).toBe("stopped"));
    await act(async () => {
      await result.current.addDataBreakpoint({ name: "count", frameId: 10 });
    });
    await waitFor(() => expect(result.current.dataBreakpoints).toHaveLength(1));
    expect(result.current.dataBreakpoints[0].canPersist).toBe(false);
    expect(result.current.dataBreakpoints[0].sessionId).toBe("sess-1");
    expect(window.localStorage.getItem("taomni.codeWorkspace.debugDataBreakpoints.v1.ws-1")).toBe("[]");

    act(() => result.current.terminate());
    await waitFor(() => expect(result.current.dataBreakpoints).toEqual([]));
  });

  it("does not send persisted data ids to an unsupported adapter", async () => {
    window.localStorage.setItem(
      "taomni.codeWorkspace.debugDataBreakpoints.v1.ws-1",
      JSON.stringify([{
        dataId: "field:count",
        description: "Service.count",
        adapterId: "java",
        accessTypes: ["write"],
        accessType: "write",
        canPersist: true,
      }]),
    );
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug);
    await act(async () => {
      emit({ sessionId: "sess-1", event: "initialized", message: {} });
      await Promise.resolve();
    });
    expect(dataBreakpointCalls()).toEqual([]);
    expect(exceptionBreakpointCalls()).toEqual([]);
    await waitFor(() => expect(result.current.dataBreakpointRuntime).toEqual({
      [dataBreakpointKey(result.current.dataBreakpoints[0])]: {
        status: "failed",
        message: "The selected debug adapter does not support data breakpoints",
      },
    }));
    expect(result.current.dataBreakpoints).toHaveLength(1);
  });

  it("surfaces a failed configuration step on the console instead of swallowing it", async () => {
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command === "setExceptionBreakpoints") return Promise.reject(new Error("adapter rejected filters"));
      return Promise.resolve({ breakpoints: [] });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug, {
      exceptionBreakpointFilters: [{ filter: "uncaught", label: "Uncaught", default: true }],
    });
    await act(async () => {
      emit({ sessionId: "sess-1", event: "initialized", message: {} });
      await Promise.resolve();
    });
    // The failure is visible in the debug console (was previously silent).
    await waitFor(() =>
      expect(result.current.state?.output.some(
        (line) => line.category === "stderr" && line.text.includes("setExceptionBreakpoints failed"),
      )).toBe(true));
  });

  it("seeds a visible terminated session when a pre-launch failure is reported", async () => {
    // A failure before any session exists (no active jdtls / no main class /
    // no debug bundle) must render in the Debug panel, not vanish — the panel
    // only shows its console when `state` is non-null.
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    expect(result.current.state).toBeNull();

    act(() => result.current.reportStartupFailure("No runnable main class found"));

    expect(result.current.state?.status).toBe("terminated");
    expect(result.current.state?.output).toEqual([
      { category: "stderr", text: "No runnable main class found\n" },
    ]);
  });

  it("shows pre-launch progress before an adapter session exists", async () => {
    // Save → build → resolve-main-class all run before `dapStartSession`, and on
    // a cold project that is tens of seconds. Without a seeded session the panel
    // shows its "no debug session" placeholder and the click looks ignored.
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    act(() => result.current.reportStartupProgress("Building project…"));
    expect(result.current.state?.status).toBe("starting");
    expect(result.current.state?.output).toEqual([
      { category: "console", text: "Building project…\n" },
    ]);

    act(() => result.current.reportStartupProgress("Resolving main class…"));
    expect(result.current.state?.output.map((line) => line.text)).toEqual([
      "Building project…\n",
      "Resolving main class…\n",
    ]);

    // The real session adopts those lines, so the console reads as one log.
    await startSession(result.current.startDebug);
    expect(result.current.state?.sessionId).toBe("sess-1");
    expect(result.current.state?.output.map((line) => line.text)).toEqual([
      "Building project…\n",
      "Resolving main class…\n",
    ]);
  });

  it("carries startup lines reported in one React batch into the adapter session", async () => {
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    let handler: ((payload: { sessionId: string; event: string; message: unknown; }) => void) | null = null;
    listenDapEvents.mockImplementation((_id: string, callback: typeof handler) => {
      handler = callback;
      return Promise.resolve(() => { });
    });
    dapStartSession.mockResolvedValue({
      sessionId: "sess-1",
      capabilities: {},
      request: "launch",
      arguments: { mainClass: "App" },
    });

    await act(async () => {
      result.current.reportStartupProgress("Starting debug for App.java");
      result.current.reportStartupProgress("Building project…");
      result.current.reportStartupProgress("Launching com.acme.App…");
      await result.current.startDebug({ filePath: "/repo/App.java" });
    });

    expect(handler).not.toBeNull();
    expect(result.current.state?.sessionId).toBe("sess-1");
    expect(result.current.state?.output.map((line) => line.text)).toEqual([
      "Starting debug for App.java\n",
      "Building project…\n",
      "Launching com.acme.App…\n",
    ]);
  });

  it("replaces a terminated run's console when the next start reports progress", () => {
    // Progress from a new attempt must not read as output of the finished one.
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    act(() => result.current.reportStartupFailure("Launch failed: boom"));
    expect(result.current.state?.status).toBe("terminated");

    act(() => result.current.reportStartupProgress("Starting debug for App.java"));
    expect(result.current.state?.status).toBe("starting");
    expect(result.current.state?.output).toEqual([
      { category: "console", text: "Starting debug for App.java\n" },
    ]);
  });

  it("surfaces a dapStartSession rejection in the debug console", async () => {
    // Adapter resolution failures reject `dapStartSession`; the panel must show
    // the reason (previously only the transient status bar did) and the call
    // must still reject so callers keep their existing error handling.
    dapStartSession.mockRejectedValue(new Error("No Java language server session is active"));
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));

    await act(async () => {
      await expect(result.current.startDebug({ filePath: "/repo/App.java" })).rejects.toThrow(
        "No Java language server session is active",
      );
    });

    expect(result.current.state?.status).toBe("terminated");
    expect(result.current.state?.output.some(
      (line) => line.category === "stderr" && line.text.includes("Debug failed to start")
        && line.text.includes("No Java language server session is active"),
    )).toBe(true);
  });
}
