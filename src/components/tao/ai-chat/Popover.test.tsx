import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { resizeFrameHarness } from "../../../test/resizeFrameHarness";
import { TaoPopover, useTaoPopover } from "./Popover";

function Harness() {
  const owner = useTaoPopover();
  return <><button ref={owner.triggerRef} onClick={() => owner.setOpen(!owner.open)}>History</button>
    <TaoPopover owner={owner} label="History">Saved conversations</TaoPopover></>;
}

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it("positions immediately, coalesces history resizes outside RO delivery and cancels stale work", () => {
  const frame = resizeFrameHarness();
  let height = 200;
  const measure = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    return DOMRect.fromRect(this.tagName === "BUTTON"
      ? { x: 100, y: 800, width: 40, height: 30 }
      : { width: 300, height });
  });
  const view = render(<Harness />);
  fireEvent.click(screen.getByRole("button", { name: "History" }));
  expect(screen.getByRole("dialog")).toHaveStyle({ left: "100px", top: "594px" });
  act(() => frame.flush());
  measure.mockClear();
  height = 280;
  frame.observers[0].notify();
  frame.observers[0].notify();
  fireEvent.scroll(window);
  expect(measure).not.toHaveBeenCalled();
  expect(frame.frames.size).toBe(1);
  act(() => frame.flush());
  expect(screen.getByRole("dialog")).toHaveStyle({ top: "514px" });
  frame.observers[0].notify();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.getByRole("button", { name: "History" })).toHaveFocus();
  expect(frame.observers[0].disconnect).toHaveBeenCalledOnce();
  expect(frame.frames.size).toBe(0);
  frame.observers[0].notify();
  expect(frame.frames.size).toBe(0);
  fireEvent.click(screen.getByRole("button", { name: "History" }));
  expect(screen.getByRole("dialog")).toHaveStyle({ top: "514px" });
  view.unmount();
  expect(frame.observers[1].disconnect).toHaveBeenCalledOnce();
  expect(frame.frames.size).toBe(0);
});
