import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError, request, type Instance } from "./api";
import { useLive, type Frame } from "./live";
vi.mock("./api", async importOriginal => ({ ...await importOriginal<typeof import("./api")>(), request: vi.fn() }));
class Socket {
  static OPEN = 1;
  static all: Socket[] = [];
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) { Socket.all.push(this); }
  send = vi.fn();
  close() { this.readyState = 3; this.onclose?.({ code: 1006 }); }
  frame(value: Frame) { this.onmessage?.({ data: JSON.stringify(value) }); }
}
const instance: Instance = { id: "phone", deviceId: "d", token: "secret", label: "PC", endpoint: "https://pc.example" };
beforeEach(() => {
  vi.useFakeTimers(); Socket.all = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.mocked(request).mockReset().mockResolvedValue({ ticket: "one-use" });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
async function connect() {
  await act(async () => { await Promise.resolve(); });
  const socket = Socket.all.at(-1)!;
  act(() => socket.onopen?.());
  return socket;
}
it("resumes new events after the instance restarts its sequence", async () => {
  const frames: Frame[] = [];
  const { unmount } = renderHook(() => useLive(instance, "/events", frame => frames.push(frame), () => {}));
  const first = await connect();
  act(() => {
    first.frame({ type: "hello", instance_id: "old", event_seq: 50 });
    first.frame({ type: "task_status", seq: 51 });
    first.close();
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  const second = await connect();
  expect(new URL(second.url).searchParams.get("after_seq")).toBe("51");
  act(() => {
    second.frame({ type: "hello", instance_id: "new", event_seq: 0 });
    second.frame({ type: "resync", last_seq: 0, seq: 0 });
    second.frame({ type: "task_status", seq: 1 });
    second.frame({ type: "task_status", seq: 1 });
  });
  expect(frames.filter(f => f.type === "resync")).toHaveLength(1);
  expect(frames.filter(f => f.type === "task_status").map(f => f.seq)).toEqual([51, 1]);
  unmount();
});
it("stops requesting tickets for an exited or removed terminal", async () => {
  const { unmount } = renderHook(() => useLive(instance, "/terminals/term:t/stream", () => {}, () => {}));
  const socket = await connect();
  act(() => { socket.frame({ type: "error", code: "terminal_not_found" }); socket.close(); });
  await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
  expect(request).toHaveBeenCalledTimes(1);
  unmount();
});
it("stops retrying a revoked cross-origin credential", async () => {
  vi.mocked(request).mockRejectedValue(new ApiError("origin_denied"));
  const status = vi.fn();
  const { unmount } = renderHook(() => useLive(instance, "/events", () => {}, status));
  await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
  expect(request).toHaveBeenCalledTimes(1);
  expect(status).toHaveBeenLastCalledWith("配对已失效，请重新配对");
  unmount();
});
