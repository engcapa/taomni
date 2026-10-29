import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode, useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useWorkspacePaintQueue } from "./useWorkspacePaintQueue";

const frames = new Map<number, FrameRequestCallback>();
let sequence = 0;
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
    frames.set(++sequence, callback);
    return sequence;
  });
  vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => { frames.delete(id); });
});
afterEach(() => { cleanup(); frames.clear(); vi.restoreAllMocks(); vi.useRealTimers(); });
function paint() {
  act(() => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((callback) => callback(0));
  });
}

it("batches ordered caret projections in one render after measurement and paint", () => {
  const rendered = vi.fn();
  const { result } = renderHook(() => {
    rendered();
    const [position, setPosition] = useState(0);
    const project = useWorkspacePaintQueue();
    return { position, move: (delta: number) => project(() => setPosition((value) => value + delta)) };
  }, { wrapper: StrictMode });
  rendered.mockClear();
  act(() => { result.current.move(1); result.current.move(2); });
  expect(result.current.position).toBe(0);
  expect(rendered).not.toHaveBeenCalled();
  paint(); paint();
  expect(result.current.position).toBe(0);
  act(() => vi.advanceTimersByTime(0));
  expect(result.current.position).toBe(3);
  // StrictMode evaluates the one committed render twice.
  expect(rendered).toHaveBeenCalledTimes(2);
});

it.each([0, 1, 2])("drops pending projections when the workspace closes after %i frames", (count) => {
  const projection = vi.fn();
  const { result, unmount } = renderHook(useWorkspacePaintQueue);
  act(() => result.current(projection));
  for (let i = 0; i < count; i++) paint();
  unmount();
  paint();
  act(() => vi.runOnlyPendingTimers());
  expect(projection).not.toHaveBeenCalled();
  expect(frames.size).toBe(0);
  result.current(projection);
  expect(frames.size).toBe(0);
});
