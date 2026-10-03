import { fireEvent } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isCustomDragActive, startCustomDrag } from "./customDnD";

function pointer(type: string, clientX: number, clientY = 20) {
  fireEvent(window, new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY }));
}

describe("custom drag click handling", () => {
  afterEach(() => {
    fireEvent.keyDown(window, { key: "Escape" });
    pointer("pointerdown", 0);
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("suppresses the click after a long drag and allows the next ordinary click", () => {
    vi.useFakeTimers();
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => document.body });
    const onClick = vi.fn();
    document.body.addEventListener("click", onClick);
    startCustomDrag({ event: { clientX: 20, clientY: 20 }, data: { mime: "test", payload: {} }, ghostText: "drag" });
    pointer("pointermove", 30);
    vi.advanceTimersByTime(1000);
    expect(isCustomDragActive()).toBe(true);
    pointer("pointerup", 30);
    fireEvent.click(document.body);
    expect(onClick).not.toHaveBeenCalled();
    fireEvent.click(document.body);
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(isCustomDragActive()).toBe(false);
    document.body.removeEventListener("click", onClick);
  });

  it("keeps a below-threshold press clickable and removes cancellation artifacts", () => {
    vi.useFakeTimers();
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => document.body });
    const onEnd = vi.fn();
    const onCancel = vi.fn();
    startCustomDrag({ event: { clientX: 20, clientY: 20 }, data: { mime: "test", payload: {} }, ghostText: "drag", onEnd, onCancel });
    pointer("pointermove", 21);
    pointer("pointerup", 21);
    expect(fireEvent.click(document.body)).toBe(true);
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onCancel).not.toHaveBeenCalled();
    startCustomDrag({ event: { clientX: 20, clientY: 20 }, data: { mime: "test", payload: {} }, ghostText: "drag", onEnd, onCancel });
    pointer("pointermove", 30);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledTimes(2);
    expect(document.querySelector('[data-custom-drag-ghost="true"]')).toBeNull();
  });

  it("suppresses the delayed release click after Escape and allows a new pointer gesture", () => {
    vi.useFakeTimers();
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => document.body });
    const onClick = vi.fn();
    document.body.addEventListener("click", onClick);
    startCustomDrag({ event: { clientX: 20, clientY: 20 }, data: { mime: "test", payload: {} }, ghostText: "drag" });
    pointer("pointermove", 30);
    fireEvent.keyDown(window, { key: "Escape" });
    vi.advanceTimersByTime(1000);
    pointer("pointerup", 30);
    fireEvent.click(document.body);
    expect(onClick).not.toHaveBeenCalled();
    pointer("pointerdown", 30);
    fireEvent.click(document.body);
    expect(onClick).toHaveBeenCalledTimes(1);
    document.body.removeEventListener("click", onClick);
  });
});
