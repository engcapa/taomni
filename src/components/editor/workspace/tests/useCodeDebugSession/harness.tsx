import { act } from "@testing-library/react";
import { vi } from "vitest";

export const dapSendRequest = vi.fn();

export const dapSend = vi.fn();

export const dapStartSession = vi.fn();

export const dapTerminate = vi.fn();

export const listenDapEvents = vi.fn();

vi.mock("../../../../../lib/editor/dap", () => ({
  dapSendRequest: (...args: unknown[]) => dapSendRequest(...args),
  dapSend: (...args: unknown[]) => dapSend(...args),
  dapStartSession: (...args: unknown[]) => dapStartSession(...args),
  dapTerminate: (...args: unknown[]) => dapTerminate(...args),
  listenDapEvents: (...args: unknown[]) => listenDapEvents(...args),
}));

export const { useCodeDebugSession } = await import("../../useCodeDebugSession");

export const { dataBreakpointKey, instructionBreakpointKey } = await import("../../dapDebugModel");

/** `setBreakpoints` payloads sent to the adapter, in call order. */
export function breakpointCalls(): {
  sessionId: string;
  path: string;
  lines: number[];
  modes: (string | undefined)[];
}[] {
  return dapSendRequest.mock.calls
    .filter((call) => call[1] === "setBreakpoints")
    .map((call) => {
      const args = call[2] as {
        source: { path: string; };
        breakpoints: { line: number; mode?: string; }[];
      };
      return {
        sessionId: String(call[0]),
        path: args.source.path,
        lines: args.breakpoints.map((bp) => bp.line),
        modes: args.breakpoints.map((bp) => bp.mode),
      };
    });
}

export function functionBreakpointCalls(): {
  sessionId: string;
  breakpoints: { name: string; condition?: string; hitCondition?: string; }[];
}[] {
  return dapSendRequest.mock.calls
    .filter((call) => call[1] === "setFunctionBreakpoints")
    .map((call) => ({
      sessionId: String(call[0]),
      breakpoints: (call[2] as {
        breakpoints: { name: string; condition?: string; hitCondition?: string; }[];
      }).breakpoints,
    }));
}

export function instructionBreakpointCalls(): {
  sessionId: string;
  breakpoints: Array<{
    instructionReference: string;
    offset?: number;
    condition?: string;
    hitCondition?: string;
    mode?: string;
  }>;
}[] {
  return dapSendRequest.mock.calls
    .filter((call) => call[1] === "setInstructionBreakpoints")
    .map((call) => ({
      sessionId: String(call[0]),
      breakpoints: (call[2] as {
        breakpoints: Array<{
          instructionReference: string;
          offset?: number;
          condition?: string;
          hitCondition?: string;
          mode?: string;
        }>;
      }).breakpoints,
    }));
}

export function dataBreakpointCalls(): {
  sessionId: string;
  breakpoints: { dataId: string; accessType?: string; condition?: string; hitCondition?: string; }[];
}[] {
  return dapSendRequest.mock.calls
    .filter((call) => call[1] === "setDataBreakpoints")
    .map((call) => ({
      sessionId: String(call[0]),
      breakpoints: (call[2] as {
        breakpoints: { dataId: string; accessType?: string; condition?: string; hitCondition?: string; }[];
      }).breakpoints,
    }));
}

export function exceptionBreakpointCalls(): {
  sessionId: string;
  filters: string[];
  filterOptions?: { filterId: string; condition?: string; mode?: string; }[];
  exceptionOptions?: Array<{
    path?: Array<{ names: string[]; negate?: boolean; }>;
    breakMode: string;
  }>;
}[] {
  return dapSendRequest.mock.calls
    .filter((call) => call[1] === "setExceptionBreakpoints")
    .map((call) => ({
      sessionId: String(call[0]),
      ...(call[2] as {
        filters: string[];
        filterOptions?: { filterId: string; condition?: string; mode?: string; }[];
        exceptionOptions?: Array<{
          path?: Array<{ names: string[]; negate?: boolean; }>;
          breakMode: string;
        }>;
      }),
    }));
}

/** Start a session and return the adapter's event handler. */
export async function startSession(
  start: (config: Record<string, unknown>) => Promise<void>,
  capabilities: Record<string, unknown> = {},
): Promise<(payload: { sessionId: string; event: string; message: unknown; }) => void> {
  let handler: ((payload: { sessionId: string; event: string; message: unknown; }) => void) | null = null;
  listenDapEvents.mockImplementation((_id: string, cb: typeof handler) => {
    handler = cb;
    return Promise.resolve(() => { });
  });
  dapStartSession.mockResolvedValue({
    sessionId: "sess-1",
    capabilities,
    request: "launch",
    arguments: { mainClass: "App" },
  });
  await act(async () => {
    await start({ filePath: "/repo/App.java" });
  });
  if (!handler) throw new Error("no event handler registered");
  return handler;
}
