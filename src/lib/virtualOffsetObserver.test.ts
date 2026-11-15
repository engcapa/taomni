import { afterEach, describe, expect, it, vi } from "vitest";
import type { Virtualizer } from "@tanstack/react-virtual";
import { observeElementOffsetClean } from "./virtualOffsetObserver";

describe("observeElementOffsetClean", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("cancels pending scroll-reset timers on cleanup so no callback runs after unmount", () => {
    vi.useFakeTimers();
    const element = document.createElement("div");
    Object.defineProperty(element, "scrollTop", { value: 120, writable: true, configurable: true });
    const clearSpy = vi.spyOn(window, "clearTimeout");
    const cb = vi.fn();
    const instance = {
      scrollElement: element,
      targetWindow: window,
      options: {
        horizontal: false,
        isRtl: false,
        useScrollendEvent: false,
        isScrollingResetDelay: 150,
      },
    } as unknown as Virtualizer<HTMLDivElement, Element>;

    const unsub = observeElementOffsetClean(instance, cb);
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenLastCalledWith(120, false);

    element.scrollTop = 360;
    element.dispatchEvent(new Event("scroll"));
    expect(cb).toHaveBeenCalledTimes(2);
    expect(cb).toHaveBeenLastCalledWith(360, true);

    cb.mockClear();
    unsub?.();
    expect(clearSpy).toHaveBeenCalled();

    vi.advanceTimersByTime(500);
    expect(cb).not.toHaveBeenCalled();
  });

  it("emits idle offset callback after isScrollingResetDelay while still mounted and supports horizontal RTL", () => {
    vi.useFakeTimers();
    const element = document.createElement("div");
    Object.defineProperty(element, "scrollLeft", { value: 80, writable: true, configurable: true });
    const cb = vi.fn();
    const instance = {
      scrollElement: element,
      targetWindow: window,
      options: {
        horizontal: true,
        isRtl: true,
        useScrollendEvent: false,
        isScrollingResetDelay: 150,
      },
    } as unknown as Virtualizer<HTMLDivElement, Element>;

    const unsub = observeElementOffsetClean(instance, cb);
    element.scrollLeft = 200;
    element.dispatchEvent(new Event("scroll"));
    expect(cb).toHaveBeenLastCalledWith(-200, true);

    vi.advanceTimersByTime(150);
    expect(cb).toHaveBeenLastCalledWith(-200, false);
    unsub?.();
  });
});
