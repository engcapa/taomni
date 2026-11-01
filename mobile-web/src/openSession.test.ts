import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ApiError, request, type Instance } from "./api";
import { openSession } from "./openSession";

vi.mock("./api", async importOriginal => ({ ...await importOriginal<typeof import("./api")>(), request: vi.fn() }));
const instance: Instance = { id: "phone", endpoint: "https://pc.example", token: "t", deviceId: "d", label: "PC" };
beforeEach(() => { vi.useFakeTimers(); vi.mocked(request).mockReset(); });
afterEach(() => vi.useRealTimers());

it("polls until the desktop reports the terminal and survives a dropped poll", async () => {
  vi.mocked(request)
    .mockResolvedValueOnce({ request_id: "r1", status: "pending" })
    .mockRejectedValueOnce(new ApiError("connection_failed"))
    .mockResolvedValueOnce({ request_id: "r1", status: "pending" })
    .mockResolvedValueOnce({ request_id: "r1", status: "opened", session_id: "term:local-7" });
  const result = openSession(instance, { kind: "saved", saved_session_id: "s1" }, new AbortController().signal);
  await vi.advanceTimersByTimeAsync(3000);
  await expect(result).resolves.toBe("term:local-7");
  expect(vi.mocked(request).mock.calls[0].slice(1, 3)).toEqual(["/open-requests", { kind: "saved", saved_session_id: "s1" }]);
  expect(vi.mocked(request).mock.calls[1][1]).toBe("/open-requests/r1");
});

it("surfaces the desktop failure code", async () => {
  vi.mocked(request)
    .mockResolvedValueOnce({ request_id: "r2", status: "pending" })
    .mockResolvedValueOnce({ request_id: "r2", status: "failed", error: "open_timeout" });
  const result = openSession(instance, { kind: "local" }, new AbortController().signal);
  const settled = expect(result).rejects.toMatchObject({ code: "open_timeout" });
  await vi.advanceTimersByTimeAsync(1000);
  await settled;
});

it("stops polling when the phone gives up", async () => {
  vi.mocked(request).mockResolvedValue({ request_id: "r3", status: "pending" });
  const abort = new AbortController();
  const result = openSession(instance, { kind: "local" }, abort.signal);
  const settled = expect(result).rejects.toMatchObject({ name: "AbortError" });
  await vi.advanceTimersByTimeAsync(2500);
  abort.abort();
  await settled;
  const calls = vi.mocked(request).mock.calls.length;
  await vi.advanceTimersByTimeAsync(5000);
  expect(vi.mocked(request).mock.calls.length).toBe(calls);
});
