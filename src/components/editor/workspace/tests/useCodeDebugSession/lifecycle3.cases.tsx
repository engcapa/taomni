import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it } from "vitest";
import {
  dapSend,
  dapSendRequest,
  dapStartSession,
  dataBreakpointCalls,
  instructionBreakpointCalls,
  instructionBreakpointKey,
  listenDapEvents,
  startSession,
  useCodeDebugSession,
} from "./harness";

export function registeruseCodeDebugSessionLifecycle3Cases() {

  it("restores and binds adapter-scoped instruction breakpoints before configurationDone", async () => {
    window.localStorage.setItem(
      "taomni.codeWorkspace.debugInstructionBreakpoints.v1.ws-1",
      JSON.stringify([{
        adapterId: "java",
        instructionReference: "0x1000",
        offset: -4,
        condition: "ready",
        mode: "hardware",
      }]),
    );
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command === "setInstructionBreakpoints") {
        return Promise.resolve({ breakpoints: [{ id: 70, verified: true }] });
      }
      return Promise.resolve({ breakpoints: [] });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const saved = result.current.instructionBreakpoints[0];
    expect(saved).toMatchObject({ instructionReference: "0x1000", offset: -4 });

    const emit = await startSession(result.current.startDebug, {
      supportsInstructionBreakpoints: true,
      breakpointModes: [{ mode: "hardware", label: "Hardware", appliesTo: ["instruction"] }],
    });
    act(() => emit({ sessionId: "sess-1", event: "initialized", message: {} }));
    await waitFor(() => expect(result.current.instructionBreakpointRuntime[
      instructionBreakpointKey(saved)
    ]).toEqual({ status: "verified", message: null }));
    expect(instructionBreakpointCalls()).toEqual([{
      sessionId: "sess-1",
      breakpoints: [{
        instructionReference: "0x1000",
        offset: -4,
        condition: "ready",
        mode: "hardware",
      }],
    }]);
    const setIndex = dapSendRequest.mock.calls.findIndex((call) => call[1] === "setInstructionBreakpoints");
    const doneIndex = dapSend.mock.calls.findIndex((call) => call[1] === "configurationDone");
    expect(dapSendRequest.mock.invocationCallOrder[setIndex]).toBeLessThan(
      dapSend.mock.invocationCallOrder[doneIndex],
    );

    act(() => emit({
      sessionId: "sess-1",
      event: "breakpoint",
      message: {
        body: {
          reason: "changed",
          breakpoint: { id: 70, verified: false, reason: "failed", message: "code unloaded" },
        },
      },
    }));
    expect(result.current.instructionBreakpointRuntime[instructionBreakpointKey(saved)]).toEqual({
      status: "failed",
      message: "code unloaded",
    });
  });

  it("adds, normalizes, edits, and removes an instruction breakpoint for the active adapter", async () => {
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug, {
      supportsInstructionBreakpoints: true,
      breakpointModes: [
        { mode: "software", label: "Software", appliesTo: ["instruction"] },
        { mode: "hardware", label: "Hardware", appliesTo: ["instruction"] },
      ],
    });
    let added = false;
    act(() => {
      added = result.current.addInstructionBreakpoint({
        instructionReference: " 0x2000 ",
        offset: 8,
        mode: "hardware",
      });
    });
    expect(added).toBe(true);
    expect(result.current.addInstructionBreakpoint({
      instructionReference: "0x2000",
      offset: 8,
      mode: "hardware",
    })).toBe(false);
    expect(result.current.addInstructionBreakpoint({
      instructionReference: "0x3000",
      offset: Number.POSITIVE_INFINITY,
    })).toBe(false);
    const breakpoint = result.current.instructionBreakpoints[0];
    const key = instructionBreakpointKey(breakpoint);
    act(() => result.current.setInstructionBreakpointOptions(key, {
      condition: " ready ",
      hitCondition: " 3 ",
      enabled: false,
    }));
    expect(result.current.instructionBreakpoints[0]).toMatchObject({
      adapterId: "java",
      instructionReference: "0x2000",
      offset: 8,
      condition: "ready",
      hitCondition: "3",
      mode: "hardware",
      enabled: false,
    });
    expect(JSON.parse(
      window.localStorage.getItem("taomni.codeWorkspace.debugInstructionBreakpoints.v1.ws-1") ?? "[]",
    )).toEqual(result.current.instructionBreakpoints);

    act(() => emit({ sessionId: "sess-1", event: "initialized", message: {} }));
    await waitFor(() => expect(dapSend).toHaveBeenCalledWith("sess-1", "configurationDone"));
    expect(instructionBreakpointCalls().at(-1)?.breakpoints).toEqual([]);
    act(() => result.current.setInstructionBreakpointOptions(key, { enabled: true }));
    await waitFor(() => expect(instructionBreakpointCalls().at(-1)?.breakpoints).toEqual([{
      instructionReference: "0x2000",
      offset: 8,
      condition: "ready",
      hitCondition: "3",
      mode: "hardware",
    }]));
    act(() => result.current.setBreakpointsMuted(true));
    await waitFor(() => expect(instructionBreakpointCalls().at(-1)?.breakpoints).toEqual([]));
    act(() => result.current.setBreakpointsMuted(false));
    await waitFor(() => expect(instructionBreakpointCalls().at(-1)?.breakpoints).toEqual([{
      instructionReference: "0x2000",
      offset: 8,
      condition: "ready",
      hitCondition: "3",
      mode: "hardware",
    }]));
    act(() => result.current.removeInstructionBreakpoint(key));
    await waitFor(() => expect(result.current.instructionBreakpoints).toEqual([]));
    expect(instructionBreakpointCalls().at(-1)?.breakpoints).toEqual([]);
  });

  it("ignores a stale instruction-breakpoint response after a newer edit", async () => {
    window.localStorage.setItem(
      "taomni.codeWorkspace.debugInstructionBreakpoints.v1.ws-1",
      JSON.stringify([{
        adapterId: "java",
        instructionReference: "0x1000",
      }]),
    );
    const resolvers: ((body: unknown) => void)[] = [];
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command === "setInstructionBreakpoints") {
        return new Promise((resolve) => resolvers.push(resolve));
      }
      return Promise.resolve({ breakpoints: [] });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug, {
      supportsInstructionBreakpoints: true,
    });
    act(() => emit({ sessionId: "sess-1", event: "initialized", message: {} }));
    await waitFor(() => expect(resolvers).toHaveLength(1));
    const key = instructionBreakpointKey(result.current.instructionBreakpoints[0]);

    act(() => result.current.setInstructionBreakpointOptions(key, { condition: "loaded" }));
    await waitFor(() => expect(resolvers).toHaveLength(2));
    await act(async () => {
      resolvers[1]({ breakpoints: [{ id: 72, verified: true }] });
      resolvers[0]({
        breakpoints: [{ id: 71, verified: false, reason: "failed", message: "stale" }],
      });
      await Promise.resolve();
    });
    expect(result.current.instructionBreakpointRuntime[key]).toEqual({
      status: "verified",
      message: null,
    });
  });

  it("keeps saved instruction breakpoints visible when the adapter is unsupported", async () => {
    window.localStorage.setItem(
      "taomni.codeWorkspace.debugInstructionBreakpoints.v1.ws-1",
      JSON.stringify([{ adapterId: "java", instructionReference: "0x1000" }]),
    );
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    const emit = await startSession(result.current.startDebug);
    act(() => emit({ sessionId: "sess-1", event: "initialized", message: {} }));
    const key = instructionBreakpointKey(result.current.instructionBreakpoints[0]);
    await waitFor(() => expect(result.current.instructionBreakpointRuntime[key]).toEqual({
      status: "failed",
      message: "The selected debug adapter does not support instruction breakpoints",
    }));
    expect(instructionBreakpointCalls()).toEqual([]);
  });

  it("routes capability-gated memory and disassembly requests through DAP", async () => {
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command === "readMemory") return Promise.resolve({ address: "0x1000", data: "AAE=", unreadableBytes: 1 });
      if (command === "writeMemory") return Promise.resolve({ bytesWritten: 2 });
      if (command === "disassemble") return Promise.resolve({
        instructions: [{ address: "0x1000", instructionBytes: "55", instruction: "push rbp" }],
      });
      return Promise.resolve({ breakpoints: [] });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    await startSession(result.current.startDebug, {
      supportsReadMemoryRequest: true,
      supportsWriteMemoryRequest: true,
      supportsDisassembleRequest: true,
    });

    let readResult!: { address: string | null; unreadableBytes: number; data: string; } | null;
    let writeResult!: { bytesWritten: number | null; } | null;
    let disassembly!: { address: string; instruction: string; }[];
    await act(async () => {
      readResult = await result.current.readMemory({ memoryReference: " 0x1000 ", offset: -4, count: 2 });
      writeResult = await result.current.writeMemory({ memoryReference: "0x1000", offset: 1, data: "AQI=", allowPartial: false });
      disassembly = await result.current.disassemble({ memoryReference: "0x1000", instructionCount: 1, resolveSymbols: true });
    });
    expect(readResult).toEqual({ address: "0x1000", unreadableBytes: 1, data: "AAE=" });
    expect(writeResult).toEqual({ bytesWritten: 2 });
    expect(disassembly).toEqual([{
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
    expect(dapSendRequest).toHaveBeenCalledWith("sess-1", "readMemory", {
      memoryReference: "0x1000",
      offset: -4,
      count: 2,
    });
    expect(dapSendRequest).toHaveBeenCalledWith("sess-1", "writeMemory", {
      memoryReference: "0x1000",
      offset: 1,
      data: "AQI=",
      allowPartial: false,
    });
    expect(dapSendRequest).toHaveBeenCalledWith("sess-1", "disassemble", {
      memoryReference: "0x1000",
      instructionCount: 1,
      resolveSymbols: true,
    });
  });

  it("does not call memory requests when the adapter does not advertise them", async () => {
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    await startSession(result.current.startDebug);
    const before = dapSendRequest.mock.calls.length;
    await act(async () => {
      expect(await result.current.readMemory({ memoryReference: "0x1000", count: 1 })).toBeNull();
      expect(await result.current.writeMemory({ memoryReference: "0x1000", data: "AQ==" })).toBeNull();
      expect(await result.current.disassemble({ memoryReference: "0x1000", instructionCount: 1 })).toEqual([]);
    });
    expect(dapSendRequest.mock.calls.length).toBe(before);
  });

  it("drops a memory response that arrives after the owning session terminates", async () => {
    let resolveRead: ((body: unknown) => void) | null = null;
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command === "readMemory") return new Promise((resolve) => { resolveRead = resolve; });
      return Promise.resolve({ breakpoints: [] });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    await startSession(result.current.startDebug, { supportsReadMemoryRequest: true });
    let pending!: Promise<unknown>;
    act(() => {
      pending = result.current.readMemory({ memoryReference: "0x1000", count: 1 });
    });
    await waitFor(() => expect(resolveRead).not.toBeNull());
    await act(async () => result.current.terminate());
    await act(async () => {
      resolveRead?.({ address: "0x1000", data: "AA==" });
      expect(await pending).toBeNull();
    });
  });

  it("isolates identical instruction references by adapter in a compound session", async () => {
    const handlers = new Map<string, (payload: {
      sessionId: string;
      event: string;
      message: unknown;
    }) => void>();
    listenDapEvents.mockImplementation((id: string, handler: (payload: {
      sessionId: string;
      event: string;
      message: unknown;
    }) => void) => {
      handlers.set(id, handler);
      return Promise.resolve(() => handlers.delete(id));
    });
    dapStartSession.mockImplementation((adapterId: string, config: Record<string, unknown>) => Promise.resolve({
      sessionId: String(config.sessionId),
      capabilities: { supportsInstructionBreakpoints: true },
      request: "launch",
      arguments: { ...config, adapterId },
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
          { id: "native", label: "Native", adapterId: "lldb", launchConfig: { sessionId: "sess-native" } },
        ],
      });
    });
    await waitFor(() => expect(handlers.size).toBe(2));
    await act(async () => {
      handlers.get("sess-api")?.({ sessionId: "sess-api", event: "initialized", message: {} });
      handlers.get("sess-native")?.({ sessionId: "sess-native", event: "initialized", message: {} });
      await started;
    });
    await waitFor(() => expect(instructionBreakpointCalls()).toHaveLength(2));

    act(() => {
      result.current.selectSession("sess-api");
      expect(result.current.addInstructionBreakpoint({ instructionReference: "entry" })).toBe(true);
    });
    await waitFor(() => expect(instructionBreakpointCalls()).toHaveLength(3));
    expect(instructionBreakpointCalls()[2]).toEqual({
      sessionId: "sess-api",
      breakpoints: [{ instructionReference: "entry" }],
    });

    act(() => {
      result.current.selectSession("sess-native");
      expect(result.current.addInstructionBreakpoint({ instructionReference: "entry" })).toBe(true);
    });
    await waitFor(() => expect(instructionBreakpointCalls()).toHaveLength(4));
    expect(instructionBreakpointCalls()[3]).toEqual({
      sessionId: "sess-native",
      breakpoints: [{ instructionReference: "entry" }],
    });
    expect(result.current.instructionBreakpoints.map((breakpoint) => breakpoint.adapterId).sort()).toEqual([
      "java",
      "lldb",
    ]);
  });

  it("restores persisted data breakpoints before configurationDone", async () => {
    window.localStorage.setItem(
      "taomni.codeWorkspace.debugDataBreakpoints.v1.ws-1",
      JSON.stringify([{
        dataId: "field:Service.count",
        description: "Service.count",
        adapterId: "java",
        accessTypes: ["write"],
        accessType: "write",
        condition: "ready",
        canPersist: true,
      }]),
    );
    dapSendRequest.mockImplementation((_id: string, command: string) => {
      if (command === "setDataBreakpoints") {
        return Promise.resolve({ breakpoints: [{ id: 80, verified: true }] });
      }
      return Promise.resolve({ breakpoints: [] });
    });
    const { result } = renderHook(() => useCodeDebugSession("ws-1"));
    expect(result.current.dataBreakpoints).toHaveLength(1);

    const emit = await startSession(result.current.startDebug, {
      supportsDataBreakpoints: true,
      breakpointModes: [
        { mode: "software", label: "Software", appliesTo: ["data"] },
        { mode: "hardware", label: "Hardware", appliesTo: ["data"] },
      ],
    });
    act(() => emit({ sessionId: "sess-1", event: "initialized", message: {} }));

    await waitFor(() => expect(dapSend).toHaveBeenCalledWith("sess-1", "configurationDone"));
    expect(dataBreakpointCalls()).toEqual([{
      sessionId: "sess-1",
      breakpoints: [{
        dataId: "field:Service.count",
        accessType: "write",
        condition: "ready",
      }],
    }]);
    const setDataIndex = dapSendRequest.mock.calls.findIndex((call) => call[1] === "setDataBreakpoints");
    const configurationDoneIndex = dapSend.mock.calls.findIndex((call) => call[1] === "configurationDone");
    expect(dapSendRequest.mock.invocationCallOrder[setDataIndex]).toBeLessThan(
      dapSend.mock.invocationCallOrder[configurationDoneIndex],
    );
  });
}
