import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SftpFloatingButton } from "./SftpFloatingButton";

let resize: () => void;
let width = 800;
let height = 500;
beforeEach(() => {
  localStorage.clear();
  width = 800;
  height = 500;
  vi.stubGlobal("PointerEvent", class extends MouseEvent {
    pointerId: number;
    constructor(type: string, init: PointerEventInit) {
      super(type, init);
      this.pointerId = init.pointerId ?? 0;
    }
  });
  vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(() => width);
  vi.spyOn(HTMLElement.prototype, "clientHeight", "get").mockImplementation(() => height);
  vi.stubGlobal("ResizeObserver", class {
    constructor(callback: () => void) { resize = callback; }
    observe() {}
    disconnect() {}
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function button() {
  const element = screen.getByTestId("sftp-floating-button");
  element.setPointerCapture = vi.fn();
  element.hasPointerCapture = vi.fn(() => true);
  element.releasePointerCapture = vi.fn();
  return element;
}

it("opens on click and keyboard activation", () => {
  const open = vi.fn();
  render(<SftpFloatingButton onOpen={open} />);
  fireEvent.click(button(), { detail: 1 });
  fireEvent.click(button(), { detail: 0 });
  expect(open).toHaveBeenCalledTimes(2);
});

it("moves without opening, remembers the location after hiding and stays in a resized terminal", () => {
  const open = vi.fn();
  const view = render(<SftpFloatingButton onOpen={open} />);
  const entry = button();
  const originalLeft = parseFloat(entry.style.left);
  fireEvent.pointerDown(entry, { pointerId: 1, button: 0, clientX: 700, clientY: 300 });
  fireEvent.pointerMove(entry, { pointerId: 1, clientX: 450, clientY: 150 });
  fireEvent.pointerUp(entry, { pointerId: 1, clientX: 450, clientY: 150 });
  fireEvent.click(entry, { detail: 1 });
  expect(open).not.toHaveBeenCalled();
  expect(parseFloat(entry.style.left)).toBeLessThan(originalLeft - 200);
  const position = { left: entry.style.left, top: entry.style.top };
  view.unmount();
  render(<SftpFloatingButton onOpen={open} />);
  expect(button()).toHaveStyle(position);
  act(() => { width = 260; height = 180; resize(); });
  expect(parseFloat(button().style.left) + 38).toBeLessThanOrEqual(260);
  expect(parseFloat(button().style.top) + 32).toBeLessThanOrEqual(180);
  fireEvent.click(button(), { detail: 0 });
  expect(open).toHaveBeenCalledOnce();
});

it("does not activate when a pointer drag is cancelled", () => {
  const open = vi.fn();
  render(<SftpFloatingButton onOpen={open} />);
  const entry = button();
  fireEvent.pointerDown(entry, { pointerId: 2, button: 0, clientX: 700, clientY: 300 });
  fireEvent.pointerCancel(entry, { pointerId: 2 });
  fireEvent.click(entry, { detail: 1 });
  expect(open).not.toHaveBeenCalled();
  fireEvent.click(entry, { detail: 0 });
  expect(open).toHaveBeenCalledOnce();
});
