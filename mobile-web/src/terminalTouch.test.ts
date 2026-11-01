import { afterEach, expect, it, vi } from "vitest";
import { attachTouchGestures } from "./terminalTouch";

type Point = { clientX: number; clientY: number };
function touch(target: HTMLElement, type: string, points: Point[], timeStamp: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "touches", { value: points });
  Object.defineProperty(event, "timeStamp", { value: timeStamp });
  target.dispatchEvent(event);
  return event;
}

function setup() {
  const target = document.createElement("div");
  const screen = document.createElement("div");
  target.appendChild(screen);
  document.body.appendChild(target);
  const wheel: number[] = [];
  screen.addEventListener("wheel", event => wheel.push((event as WheelEvent).deltaY));
  const onPinch = vi.fn();
  const detach = attachTouchGestures(target, { screen: () => screen, onPinch });
  return { target, wheel, onPinch, detach };
}

afterEach(() => { document.body.innerHTML = ""; vi.useRealTimers(); });

it("turns a vertical drag into wheel scrolling and keeps the page from scrolling", () => {
  const { target, wheel, detach } = setup();
  touch(target, "touchstart", [{ clientX: 50, clientY: 300 }], 0);
  const small = touch(target, "touchmove", [{ clientX: 50, clientY: 296 }], 16);
  expect(small.defaultPrevented).toBe(false);
  expect(wheel).toEqual([]);
  const drag = touch(target, "touchmove", [{ clientX: 50, clientY: 260 }], 32);
  touch(target, "touchmove", [{ clientX: 50, clientY: 200 }], 48);
  expect(drag.defaultPrevented).toBe(true);
  // Finger moving up scrolls towards later lines (positive deltaY).
  expect(wheel.reduce((a, b) => a + b, 0)).toBe(100);
  touch(target, "touchend", [], 400);
  detach();
});

it("keeps a quick flick scrolling with decaying speed", () => {
  vi.useFakeTimers();
  const { target, wheel } = setup();
  touch(target, "touchstart", [{ clientX: 50, clientY: 400 }], 0);
  touch(target, "touchmove", [{ clientX: 50, clientY: 360 }], 10);
  touch(target, "touchmove", [{ clientX: 50, clientY: 320 }], 20);
  touch(target, "touchend", [], 25);
  const dragged = wheel.length;
  vi.advanceTimersByTime(2000);
  const momentum = wheel.slice(dragged);
  expect(momentum.length).toBeGreaterThan(3);
  expect(momentum.every(delta => delta > 0)).toBe(true);
  expect(momentum.at(-1)!).toBeLessThan(momentum[0]);
});

it("a fresh interaction outside the terminal stops momentum so latest can stay at the bottom", () => {
  vi.useFakeTimers();
  const { target, wheel, detach } = setup();
  touch(target, "touchstart", [{ clientX: 50, clientY: 400 }], 0);
  touch(target, "touchmove", [{ clientX: 50, clientY: 200 }], 20);
  touch(target, "touchend", [], 25);
  vi.advanceTimersByTime(100);
  expect(wheel.length).toBeGreaterThan(1);
  document.dispatchEvent(new Event("pointerdown"));
  const stopped = wheel.length;
  vi.advanceTimersByTime(2000);
  expect(wheel.length).toBe(stopped);
  detach();
});

it("uses the public scrollback callback without synthesizing a wheel when it handles the drag", () => {
  const target = document.createElement("div");
  const scroll = vi.fn(() => true);
  const screen = vi.fn(() => null);
  const detach = attachTouchGestures(target, { screen, onPinch: vi.fn(), onScroll: scroll });
  touch(target, "touchstart", [{ clientX: 50, clientY: 300 }], 0);
  touch(target, "touchmove", [{ clientX: 50, clientY: 200 }], 20);
  expect(scroll).toHaveBeenCalledWith(100);
  expect(screen).not.toHaveBeenCalled();
  detach();
});

it("steps the font size with a two-finger pinch", () => {
  const { target, onPinch, wheel } = setup();
  touch(target, "touchstart", [{ clientX: 100, clientY: 100 }, { clientX: 200, clientY: 100 }], 0);
  const spread = touch(target, "touchmove", [{ clientX: 80, clientY: 100 }, { clientX: 220, clientY: 100 }], 16);
  expect(spread.defaultPrevented).toBe(true);
  touch(target, "touchmove", [{ clientX: 120, clientY: 100 }, { clientX: 180, clientY: 100 }], 32);
  expect(onPinch.mock.calls.map(call => call[0])).toEqual([1, -1]);
  expect(wheel).toEqual([]);
});
