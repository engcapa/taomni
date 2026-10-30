import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { scheduleAfterEditorPaint } from "./scheduleAfterEditorPaint";

const frames = new Map<number, FrameRequestCallback>();
const cancel = new Set<() => void>();
let sequence = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++sequence, callback);
    return sequence;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
});
afterEach(() => {
  cancel.forEach((dispose) => dispose());
  cancel.clear();
  frames.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function schedule(work: () => void, ready?: () => boolean) {
  const dispose = scheduleAfterEditorPaint(work, ready);
  cancel.add(dispose);
  return dispose;
}

function paint() {
  const callbacks = [...frames.values()];
  frames.clear();
  callbacks.forEach((callback) => callback(performance.now()));
}

it("lets the editor measure and paint before optional startup work", () => {
  const work = vi.fn();
  schedule(work);
  paint();
  vi.advanceTimersByTime(0);
  expect(work).not.toHaveBeenCalled();
  paint();
  expect(work).not.toHaveBeenCalled();
  vi.advanceTimersByTime(0);
  expect(work).toHaveBeenCalledOnce();
});

it("separates language installation and workspace projections with a paint", () => {
  const order: string[] = [];
  schedule(() => {
    order.push("language");
    window.requestAnimationFrame(() => order.push("editor measurement"));
  });
  schedule(() => order.push("chrome"));
  paint(); paint();
  vi.advanceTimersByTime(0);
  expect(order).toEqual(["language"]);
  paint();
  expect(order).toEqual(["language", "editor measurement"]);
  vi.advanceTimersByTime(0);
  expect(order).toEqual(["language", "editor measurement", "chrome"]);
});

it("does not let a pending editor port block another pane's mount", () => {
  let ready = false;
  const discovery = vi.fn();
  schedule(discovery, () => ready);
  schedule(() => { ready = true; });
  paint(); paint();
  vi.advanceTimersByTime(0);
  expect(ready).toBe(true);
  expect(discovery).not.toHaveBeenCalled();
  paint(); paint();
  vi.advanceTimersByTime(0);
  expect(discovery).toHaveBeenCalledOnce();
});

it.each([0, 1, 2])("cancels before work after %i frames without keeping a scheduler alive", (count) => {
  const work = vi.fn();
  const dispose = schedule(work);
  for (let index = 0; index < count; index++) paint();
  dispose(); dispose();
  paint();
  vi.runOnlyPendingTimers();
  expect(work).not.toHaveBeenCalled();
  expect(frames.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

it("keeps another pane's task after cancellation and a throwing task", () => {
  const cancelled = vi.fn();
  const complete = vi.fn();
  schedule(() => { throw new Error("language installation failed"); });
  const dispose = schedule(cancelled);
  schedule(complete);
  paint(); paint();
  dispose();
  expect(() => vi.advanceTimersByTime(0)).toThrow("language installation failed");
  paint();
  vi.advanceTimersByTime(0);
  expect(cancelled).not.toHaveBeenCalled();
  expect(complete).toHaveBeenCalledOnce();
});
