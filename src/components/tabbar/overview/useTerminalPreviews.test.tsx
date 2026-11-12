import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { registerTerminal, type TerminalRegistryEntry } from "../../../lib/terminal/terminalRegistry";
import { PREVIEW_ACTIVITY_MS, PREVIEW_BATCH_MS, useTerminalPreviews } from "./useTerminalPreviews";

const releases: (() => void)[] = [];
function terminal(id: string, legacy = false) {
  let text = "first output";
  const listeners = new Set<() => void>();
  const read = vi.fn(() => text);
  const entry: TerminalRegistryEntry = {
    tabId: id, sessionId: `${id}-session`, title: id, getBufferText: read, getLastLines: read, writeInput: vi.fn(),
    ...(!legacy ? { subscribeOutput: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; } } : {}),
  };
  releases.push(registerTerminal(entry));
  return { read, listeners, entry, output: (next: string) => { text = next; listeners.forEach((listener) => listener()); } };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); releases.splice(0).forEach((release) => release()); vi.useRealTimers(); });

it("updates parsed output in one bounded batch without flagging initial buffers", () => {
  const source = terminal("preview-a");
  const { result } = renderHook(() => useTerminalPreviews(["preview-a"]));
  expect(result.current.get("preview-a")).toEqual({ text: "first output", outputActive: false });
  const reads = source.read.mock.calls.length;
  act(() => { source.output("second"); source.output("latest"); });
  act(() => vi.advanceTimersByTime(PREVIEW_BATCH_MS - 1));
  expect(source.read).toHaveBeenCalledTimes(reads);
  act(() => vi.advanceTimersByTime(1));
  expect(result.current.get("preview-a")).toEqual({ text: "latest", outputActive: true });
  expect(source.read).toHaveBeenCalledTimes(reads + 1);
  act(() => vi.advanceTimersByTime(PREVIEW_ACTIVITY_MS + 1000));
  expect(result.current.get("preview-a")?.outputActive).toBe(false);
});

it("does not flag parsed control writes with unchanged preview text", () => {
  const source = terminal("preview-controls");
  const { result } = renderHook(() => useTerminalPreviews(["preview-controls"]));
  act(() => source.output("first output"));
  act(() => vi.advanceTimersByTime(PREVIEW_BATCH_MS));
  expect(result.current.get("preview-controls")?.outputActive).toBe(false);
});

it("discovers late registry entries and keeps a legacy fallback", () => {
  const { result } = renderHook(() => useTerminalPreviews(["preview-late"]));
  expect(result.current.get("preview-late")?.text).toBe("");
  const source = terminal("preview-late", true);
  act(() => vi.advanceTimersByTime(1000));
  expect(result.current.get("preview-late")?.text).toBe("first output");
  act(() => source.output("late output"));
  act(() => vi.advanceTimersByTime(1000));
  expect(result.current.get("preview-late")).toEqual({ text: "late output", outputActive: true });
});

it("releases replaced entries and all pending work on close", () => {
  const old = terminal("preview-replaced");
  const { result, unmount } = renderHook(() => useTerminalPreviews(["preview-replaced"]));
  expect(old.listeners.size).toBe(1);
  const next = terminal("preview-replaced");
  act(() => vi.advanceTimersByTime(1000));
  expect(old.listeners.size).toBe(0);
  expect(next.listeners.size).toBe(1);
  act(() => old.output("stale"));
  act(() => vi.advanceTimersByTime(PREVIEW_BATCH_MS));
  expect(result.current.get("preview-replaced")?.text).toBe("first output");
  act(() => next.output("pending"));
  const reads = next.read.mock.calls.length;
  unmount();
  expect(next.listeners.size).toBe(0);
  act(() => vi.advanceTimersByTime(5000));
  expect(next.read).toHaveBeenCalledTimes(reads);
});

it("bounds large output and never starts a terminal for an unknown id", () => {
  const source = terminal("preview-bounded");
  const { result } = renderHook(() => useTerminalPreviews(["preview-bounded", "no-session"]));
  act(() => source.output("x".repeat(10000)));
  act(() => vi.advanceTimersByTime(PREVIEW_BATCH_MS));
  expect(result.current.get("preview-bounded")?.text).toHaveLength(2400);
  expect(result.current.get("no-session")).toEqual({ text: "", outputActive: false });
  expect(source.entry.writeInput).not.toHaveBeenCalled();
});
