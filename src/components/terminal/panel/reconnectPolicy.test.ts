import { afterEach, expect, it, vi } from "vitest";
import { createReconnectPolicy } from "./reconnectPolicy";
afterEach(() => vi.useRealTimers());
it("retries only established connections, with bounded backoff and no duplicates", () => {
  vi.useFakeTimers();
  const retry = vi.fn();
  const policy = createReconnectPolicy(true, retry);
  policy.disconnected(); vi.runAllTimers(); expect(retry).not.toHaveBeenCalled();
  policy.connected(); policy.disconnected(); policy.disconnected();
  vi.advanceTimersByTime(999); expect(retry).not.toHaveBeenCalled();
  vi.advanceTimersByTime(1); expect(retry).toHaveBeenCalledTimes(1);
  for (let i = 0; i < 6; i++) { policy.disconnected(); vi.runAllTimers(); }
  expect(retry).toHaveBeenCalledTimes(5);
  policy.connected(); policy.disconnected(); vi.advanceTimersByTime(1000);
  expect(retry).toHaveBeenCalledTimes(6);
});
it("manual reconnect and terminal teardown cancel pending automatic retries", () => {
  vi.useFakeTimers(); const retry = vi.fn(); const policy = createReconnectPolicy(true, retry);
  policy.connected(); policy.disconnected(); policy.started(); vi.runAllTimers();
  expect(retry).not.toHaveBeenCalled();
  policy.disconnected(); policy.dispose(); vi.runAllTimers(); policy.disconnected(); vi.runAllTimers();
  expect(retry).not.toHaveBeenCalled();
});
it("respects an explicitly disabled policy", () => {
  vi.useFakeTimers(); const retry = vi.fn(); const policy = createReconnectPolicy(false, retry);
  policy.connected(); policy.disconnected(); vi.runAllTimers(); expect(retry).not.toHaveBeenCalled();
});
