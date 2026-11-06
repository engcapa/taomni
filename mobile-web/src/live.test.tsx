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
it("pauses after five retries and resumes the same output sequence on explicit retry", async () => {
  const frames: Frame[] = [];
  const status = vi.fn();
  const { result, unmount } = renderHook(() => useLive(instance, "/terminals/term:t/stream", frame => frames.push(frame), status));
  const first = await connect();
  act(() => {
    first.frame({ type: "replay", lines: ["retained output"], last_seq: 12 });
    first.frame({ type: "output", seq: 13, data_b64: "eA==" });
    first.close();
  });
  vi.mocked(request).mockRejectedValue(new ApiError("connection_failed"));
  await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
  expect(request).toHaveBeenCalledTimes(6);
  expect(result.current.canRetry).toBe(true);
  expect(status).toHaveBeenLastCalledWith("离线 · 自动重连已暂停，请重试");
  await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
  expect(request).toHaveBeenCalledTimes(6);
  vi.mocked(request).mockResolvedValue({ ticket: "new-ticket" });
  await act(async () => result.current.retry());
  const recovered = await connect();
  expect(new URL(recovered.url).searchParams.get("after_seq")).toBe("13");
  expect(result.current.canRetry).toBe(false);
  act(() => {
    recovered.frame({ type: "output", seq: 13, data_b64: "eA==" });
    recovered.frame({ type: "output", seq: 14, data_b64: "eQ==" });
  });
  expect(frames.filter(f => f.type === "output").map(f => f.seq)).toEqual([13, 14]);
  expect(frames[0].lines).toEqual(["retained output"]);
  unmount();
});

it("does not reset the budget for sockets that open then close without a valid frame", async () => {
  const status = vi.fn();
  const { result, unmount } = renderHook(() => useLive(instance, "/events", () => {}, status));
  let socket = await connect();
  for (const delay of [1000, 2000, 5000, 10000, 30000]) {
    act(() => socket.close());
    await act(async () => { await vi.advanceTimersByTimeAsync(delay); });
    socket = await connect();
  }
  act(() => socket.close());
  expect(result.current.canRetry).toBe(true);
  expect(status).toHaveBeenLastCalledWith("离线 · 自动重连已暂停，请重试");
  expect(Socket.all).toHaveLength(6);
  unmount();
});

it("does not request tickets offline, resumes on online, and removes the online listener on unmount", async () => {
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
  const status = vi.fn();
  const { unmount } = renderHook(() => useLive(instance, "/events", () => {}, status));
  expect(request).not.toHaveBeenCalled();
  expect(status).toHaveBeenLastCalledWith("离线 · 等待网络恢复");
  online.mockReturnValue(true);
  await act(async () => window.dispatchEvent(new Event("online")));
  await connect();
  expect(request).toHaveBeenCalledTimes(1);
  unmount();
  await act(async () => window.dispatchEvent(new Event("online")));
  expect(request).toHaveBeenCalledTimes(1);
  online.mockRestore();
});

it("marks a live stream offline immediately instead of treating retained data as fresh for 90 seconds", async () => {
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  const status = vi.fn();
  const { unmount } = renderHook(() => useLive(instance, "/events", () => {}, status));
  const socket = await connect();
  online.mockReturnValue(false);
  act(() => window.dispatchEvent(new Event("offline")));
  expect(status).toHaveBeenLastCalledWith("离线 · 等待网络恢复");
  expect(socket.readyState).toBe(3);
  await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
  expect(request).toHaveBeenCalledTimes(1);
  online.mockReturnValue(true);
  await act(async () => window.dispatchEvent(new Event("online")));
  await connect();
  expect(request).toHaveBeenCalledTimes(2);
  unmount();
  online.mockRestore();
});

it("ignores an old close arriving while online recovery is waiting for a ticket", async () => {
  const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  const { unmount } = renderHook(() => useLive(instance, "/events", () => {}, () => {}));
  const old = await connect();
  old.close = () => { old.readyState = 2; }; // Browser close events arrive asynchronously.
  let finish!: (ticket: { ticket: string }) => void;
  vi.mocked(request).mockImplementation(() => new Promise(resolve => { finish = resolve as typeof finish; }));
  online.mockReturnValue(false);
  act(() => window.dispatchEvent(new Event("offline")));
  online.mockReturnValue(true);
  act(() => window.dispatchEvent(new Event("online")));
  act(() => { old.readyState = 3; old.onclose?.({ code: 1006 }); });
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(request).toHaveBeenCalledTimes(2);
  await act(async () => finish({ ticket: "recovered" }));
  const recovered = await connect();
  expect(Socket.all).toHaveLength(2);
  unmount();
  expect(recovered.readyState).toBe(3);
  online.mockRestore();
});

it("does not open a WebSocket with an undefined ticket from a gateway response", async () => {
  vi.mocked(request).mockResolvedValue({});
  const status = vi.fn();
  const { result, unmount } = renderHook(() => useLive(instance, "/events", () => {}, status));
  await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
  expect(Socket.all).toHaveLength(0);
  expect(request).toHaveBeenCalledTimes(1);
  expect(result.current.canRetry).toBe(true);
  expect(status).toHaveBeenLastCalledWith("网关或 API 响应异常，请先完成网关登录再重试");
  vi.mocked(request).mockResolvedValue({ ticket: "valid-after-login" });
  await act(async () => result.current.retry());
  expect(Socket.all).toHaveLength(1);
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
  const { result, unmount } = renderHook(() => useLive(instance, "/events", () => {}, status));
  await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
  act(() => { result.current.retry(); window.dispatchEvent(new Event("online")); });
  expect(request).toHaveBeenCalledTimes(1);
  expect(result.current.canRetry).toBe(false);
  expect(status).toHaveBeenLastCalledWith("配对已失效，请重新配对");
  unmount();
});
